import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { runWorkspace } from "./commands.js";
import { required } from "./config.js";
import { compareSaved, snapshot, traceFiles, tracePage } from "./history.js";
import { workspaceGone } from "./lease.js";
import { invoke } from "./ports.js";
import {
  branchPath,
  errorData,
  OperationError,
  type Runtime,
  type Value,
} from "./runtime.js";

export function name(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(value) ||
    value === "main"
  )
    throw new Error("A non-main Branch name is required");
  return value;
}
export class Operations {
  readonly traceDir: string;
  constructor(readonly runtime: Runtime) {
    this.traceDir = runtime.traceDir;
  }
  async ready() {
    await mkdir(this.traceDir, { recursive: true, mode: 0o700 });
    await this.actor("active");
  }
  async actor(state: string) {
    const file = join(
      this.traceDir,
      `actor-${required(this.runtime.options.agent)}.json`,
    );
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        agent: this.runtime.options.agent,
        label: this.runtime.options.label ?? "lead",
        role: this.runtime.options.role ?? "lead",
        branch: this.runtime.config.branch,
        state,
        time: Date.now(),
      }),
      { mode: 0o600 },
    );
    await rename(temporary, file);
  }
  async record(event: Value) {
    try {
      await appendFile(
        join(this.traceDir, "events.jsonl"),
        `${JSON.stringify({ time: Date.now(), agent: this.runtime.options.agent, label: this.runtime.options.label ?? "lead", branch: this.runtime.config.branch, ...event })}\n`,
        { mode: 0o600 },
      );
    } catch {
      /* Diagnostics never replay or change an SDK outcome. */
    }
  }
  async observe<T>(
    id: string,
    method: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const options = this.runtime.sdk.options;
    if (options) options.traceStep = id;
    await this.record({ id, method, phase: "start" });
    try {
      const value = await fn();
      const result = value as Value | undefined;
      await this.record({
        id,
        method,
        phase: "end",
        ok: true,
        command: result?.command,
        commit: result?.commit,
        workspace: result?.workspace,
      });
      return value;
    } catch (e) {
      await this.record({
        id,
        method,
        phase: "end",
        ok: false,
        error: { code: errorData(e).code, message: errorData(e).message },
        ...(e instanceof OperationError
          ? {
              command: e.result?.command,
              errors: e.errors.map(({ phase, code, message }) => ({
                phase,
                code,
                message,
              })),
            }
          : {}),
      });
      throw e;
    }
  }
  branch(action: string, a: Value) {
    return this.runtime.serial(async () => {
      const r = this.runtime;
      switch (action) {
        case "list":
          return r.sdk.project.list_branches(
            Number(a.limit ?? 100),
            Number(a.page ?? 0),
          );
        case "fork":
          return r.sdk.branch.fork(
            name(a.name),
            String(a.from ?? r.config.branch),
          );
        case "switch": {
          if (r.owned.size)
            throw new Error("Unmount owned Workspaces before switching Branch");
          const target = name(a.name);
          if (r.options.role === "worker" && target !== r.config.branch)
            throw new Error(
              "Workers keep their assigned Branch; ask the lead to integrate experiments",
            );
          let found = false;
          for (let pos = 0; ; ) {
            const page = await r.sdk.project.list_branches(1000, pos);
            found ||= page.items.some((b) => b.name === target);
            if (found || !page.hasMore) break;
            if (!page.items.length)
              throw new Error("Branch page made no progress");
            pos += page.items.length;
          }
          if (!found)
            throw new Error("Branch does not exist; fork explicitly first");
          r.config.branch = target;
          await this.actor("active");
          return { branch: target };
        }
        case "merge":
          return invoke(r.sdk, "branch", "merge", [
            String(a.from ?? r.config.branch),
            required(a.with, "with"),
            name(a.name),
            a.message,
            a.units,
          ]);
        case "publish": {
          if (r.options.role === "worker")
            throw new Error("Only the lead agent publishes");
          if (r.owned.size)
            throw new Error(
              "Commit and unmount owned Workspaces before publish",
            );
          return invoke(r.sdk, "branch", "publish", [
            String(a.branch ?? r.config.branch),
            a.commit,
          ]);
        }
        case "commits":
          return r.sdk.branch.list_commits(
            String(a.branch ?? r.config.branch),
            Number(a.limit ?? 100),
            Number(a.page ?? 0),
          );
        case "diff_commits":
        case "diff_branches":
          return invoke(r.sdk, "branch", action, [
            required(a.from, "from"),
            required(a.to, "to"),
            a.limit ?? 100,
            a.page ?? 0,
            { cursor: a.cursor, hunks: a.hunks },
          ]);
        default:
          throw new Error(`Unknown Branch action: ${action}`);
      }
    });
  }
  filesystem(action: string, a: Value) {
    return this.runtime.serial(async () => {
      const r = this.runtime,
        ref = String(a.ref ?? r.config.branch);
      const path = (p: unknown) => branchPath(r.root, String(p ?? "."));
      const mutations = ["mkdir", "cp", "mv", "apply", "write", "edit", "rm"];
      if (mutations.includes(action) && ref === "main")
        throw new Error("main changes only through publish");
      if (
        mutations.includes(action) &&
        r.options.role === "worker" &&
        ref !== r.config.branch
      )
        throw new Error("Workers write only their active Branch");
      switch (action) {
        case "write": {
          const content = String(required(a.content, "content"));
          let body: string | Buffer = content;
          if (a.encoding === "base64") {
            body = Buffer.from(content, "base64");
            if (body.toString("base64") !== content)
              throw new Error("Expected canonical base64");
          } else if (a.encoding !== undefined && a.encoding !== "utf8")
            throw new Error("encoding must be utf8 or base64");
          return invoke(r.sdk, "fs", "write", [
            ref,
            path(a.path),
            body,
            a.message,
          ]);
        }
        case "edit":
          return invoke(r.sdk, "fs", "edit", [
            ref,
            path(a.path),
            required(a.oldText),
            required(a.newText),
            a.message,
          ]);
        case "stat":
          return invoke(r.sdk, "fs", action, [ref, path(a.path)]);
        case "blame":
          return invoke(r.sdk, "fs", action, [ref, path(a.path), a.line ?? 1]);
        case "read":
          return r.sdk.fs.read(
            ref,
            path(a.path),
            Number(a.line ?? 1),
            Number(a.line ?? 1) + Number(a.limit ?? 200) - 1,
          );
        case "list":
          return r.sdk.fs.list(
            ref,
            path(a.path),
            Number(a.limit ?? 100),
            Number(a.page ?? 0),
          );
        case "grep":
        case "glob":
          return r.sdk.fs[action](
            ref,
            String(a.pattern),
            path(a.path),
            Number(a.limit ?? 100),
            Number(a.page ?? 0),
          );
        case "diff_files":
          return invoke(r.sdk, "fs", action, [
            ref,
            path(a.path),
            required(a.to, "to ref"),
            path(a.toPath ?? a.path),
          ]);
        case "mkdir":
        case "rm":
          return invoke(r.sdk, "fs", action, [ref, path(a.path), a.message]);
        case "cp":
        case "mv":
          return invoke(r.sdk, "fs", action, [
            ref,
            path(a.from),
            path(a.to),
            a.message,
          ]);
        case "apply": {
          if (!Array.isArray(a.changes) || a.changes.length > 1000)
            throw new Error("changes must be an array of at most 1000 changes");
          const changes = a.changes.map((c: Value) => {
            if (
              !["write", "edit", "mkdir", "rm", "cp", "mv"].includes(
                String(c.op),
              )
            )
              throw new Error("Invalid apply operation");
            const value = { ...c };
            for (const key of ["path", "from", "to"])
              if (key in c) value[key] = path(c[key]);
            return value;
          });
          return r.sdk.fs.apply(ref, changes, a.message as string | undefined);
        }
        default:
          throw new Error(`Unknown filesystem action: ${action}`);
      }
    });
  }
  workspace(action: string, a: Value, signal?: AbortSignal) {
    return this.runtime.serial(async () => {
      const r = this.runtime;
      if (action === "mount") {
        if (r.owned.size)
          throw new Error(
            "One retained Workspace per agent; unmount the existing one first",
          );
        const image = a.image === undefined ? undefined : String(a.image);
        if (image && !/^sha256:[a-f0-9]{64}$/.test(image))
          throw new Error("Expected immutable image ID");
        const branch = name(a.branch ?? r.config.branch);
        if (r.options.role === "worker" && branch !== r.config.branch)
          throw new Error("Workers mount only their active Branch");
        const ws = await r.mount(branch, image || undefined);
        ws.branch = branch;
        const id = await r.hold(ws, true);
        await this.record({ method: "workspace.mount", workspace: ws });
        return { id, ...ws };
      }
      const id = String(a.id),
        ws = r.owned.get(id);
      if (!ws || !r.persistent.has(id))
        throw new Error("Workspace is not owned by this agent");
      switch (action) {
        case "exec": {
          const seconds = Number(a.timeout ?? r.config.timeoutSeconds);
          if (
            !Number.isInteger(seconds) ||
            seconds < 1 ||
            seconds > r.config.timeoutSeconds
          )
            throw new Error("Invalid command timeout");
          const result = await runWorkspace(
            r.sdk,
            ws,
            String(required(a.command)),
            seconds,
            signal,
          );
          await this.record({
            method: "workspace.exec",
            workspace: ws,
            command: result,
          });
          if (result.cancelled || result.timedOut || result.exitCode !== 0)
            throw new OperationError(
              "workspace.exec",
              [
                {
                  phase: "execute",
                  message:
                    "Command did not succeed; retained Workspace requires explicit commit or discard",
                },
              ],
              { command: result, workspace: ws },
            );
          return result;
        }
        case "status":
          return invoke(r.backend.daemon, "workspace", "status", [ws]);
        case "commit":
          return r.sdk.workspace.commit(
            ws,
            a.message as string | undefined,
            a.force === true,
          );
        case "unmount": {
          let result: Value;
          try {
            result = await r.sdk.workspace.unmount(ws, a.discard === true);
          } catch (e) {
            if (!workspaceGone(e)) throw e;
            result = { kind: "Gone", ...errorData(e) };
          }
          r.processes.clear();
          await r.release(id);
          return result;
        }
        case "overlay":
        case "changes":
          return invoke(
            r.backend.daemon,
            "workspace",
            action === "overlay" ? "get_storage" : "list_changes",
            [ws, a.limit ?? 100, a.page ?? 0],
          );
        default:
          throw new Error(`Unknown Workspace action: ${action}`);
      }
    });
  }
  process(action: string, a: Value) {
    return this.runtime.serial(async () => {
      const r = this.runtime;
      if (action === "list") return invoke(r.backend.daemon, "process", "list");
      if (action === "start") {
        const ws = r.owned.get(String(a.id));
        if (!ws || !r.persistent.has(String(a.id)))
          throw new Error("Start requires an owned retained Workspace");
        const value = await invoke(r.backend.daemon, "process", "start", [
          ws,
          String(required(a.command)),
        ]);
        r.processes.add(String(value.process));
        await r.lease.write();
        await this.record({
          method: "process.start",
          workspace: ws,
          process: value.process,
        });
        return value;
      }
      if (action === "cancel") {
        const id = String(a.process);
        if (!r.processes.has(id))
          throw new Error("Process is not owned by this agent");
        const value = await invoke(r.backend.daemon, "process", "cancel", [id]);
        r.processes.delete(id);
        await r.lease.write();
        return value;
      }
      throw new Error("Unknown process action");
    });
  }
  inspect(action: string, a: Value = {}): Promise<Value> {
    const store = () => this.runtime.backend.store;
    switch (action) {
      case "changes":
        return compareSaved(this.runtime, a);
      case "trace_files":
        return traceFiles(this.traceDir);
      case "trace_read":
        return tracePage(
          this.traceDir,
          String(required(a.file)),
          Number(a.offset ?? 0),
          Number(a.limit ?? 500),
        );
      case "snapshot":
        return snapshot(this.runtime, a.since);
      case "storage":
        return invoke(store(), "project", "get_storage");
      case "progress":
        return required(this.runtime.options.progress)();
      case "sandboxes":
        return this.runtime.sdk.project.list_sandboxes(1000, 0);
      case "file_stats":
      case "file_history":
        return invoke(
          store(),
          "fs",
          action === "file_stats" ? "get_storage" : "list_revisions",
          [
            a.ref ?? this.runtime.config.branch,
            branchPath(this.runtime.root, String(a.path ?? ".")),
            a.limit ?? 100,
            a.page ?? 0,
          ],
        );
      case "overwritten":
        return invoke(store(), "project", "list_overwritten", [
          required(a.layer),
          a.limit ?? 100,
          a.page ?? 0,
        ]);
      default:
        throw new Error(`Unknown inspection action: ${action}`);
    }
  }
  async work() {
    const files = await readdir(this.traceDir);
    const actors: Value[] = [],
      calls: Value[] = [];
    for (const file of files.filter((f) =>
      /^actor-[a-f0-9-]+\.json$/.test(f),
    )) {
      try {
        actors.push(
          JSON.parse(await readFile(join(this.traceDir, file), "utf8")),
        );
      } catch (error) {
        actors.push({ file, state: "unreadable", error: errorData(error) });
      }
    }
    for (const file of files.filter((f) => f.endsWith(".jsonl")).slice(-128)) {
      const handle = await open(join(this.traceDir, file), "r");
      try {
        const size = (await handle.stat()).size,
          start = Math.max(0, size - 1024 * 1024);
        const buffer = Buffer.alloc(Math.min(size, 1024 * 1024));
        await handle.read(buffer, 0, buffer.length, start);
        const lines = buffer.toString("utf8").split("\n");
        if (start) lines.shift();
        for (const line of lines) {
          if (!line) continue;
          try {
            calls.push({
              ...JSON.parse(line),
              agent:
                file === "events.jsonl"
                  ? JSON.parse(line).agent
                  : file.slice(0, -6),
            });
          } catch {
            /* concurrent partial append */
          }
        }
      } finally {
        await handle.close();
      }
    }
    calls.sort(
      (a, b) =>
        Number(a.time ?? Date.parse(String(a.start))) -
        Number(b.time ?? Date.parse(String(b.start))),
    );
    return {
      actors,
      calls: calls.slice(-2000),
      partial: calls.length > 2000 || files.length > 128,
      retention:
        "tail: 1 MiB per trace, last 2000 records; full JSONL retained on disk",
    };
  }
}
