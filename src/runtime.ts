import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Writable } from "node:stream";
import {
  type Config,
  environment,
  inside,
  required,
  validateEnvironment,
} from "./config.js";
import {
  holderAlive,
  type Lease,
  Leases,
  mountedWorkspaces,
  ownerIdentity,
  sameLease,
} from "./leases.js";
import {
  invoke,
  loadClient,
  type RuntimeOptions,
  withDeployment,
} from "./ports.js";

export type Value = Record<string, unknown>;
export type Page = { items: Value[]; hasMore: boolean };
export type Workspace = {
  sandbox: string;
  path: string;
  [key: string]: unknown;
};
export interface SDK {
  options?: { traceStep?: string };
  project: {
    init(path: string): Promise<Value>;
    list_branches(size?: number, pos?: number): Promise<Page>;
  };
  branch: {
    fork(name: string, from?: string): Promise<Value>;
    list_commits(name: string, size?: number, pos?: number): Promise<Page>;
  };
  fs: {
    read(
      ref: string,
      path: string,
      start?: number,
      end?: number,
    ): Promise<Value>;
    write(branch: string, path: string, text: string): Promise<Value>;
    edit(
      branch: string,
      path: string,
      oldText: string,
      newText: string,
    ): Promise<Value>;
    apply(branch: string, changes: Value[], message?: string): Promise<Value>;
    list(ref: string, path: string, size?: number, pos?: number): Promise<Page>;
    glob(
      ref: string,
      pattern: string,
      path: string,
      size?: number,
      pos?: number,
    ): Promise<Page>;
    grep(
      ref: string,
      pattern: string,
      path: string,
      size?: number,
      pos?: number,
    ): Promise<Page>;
  };
  workspace: {
    mount(branch: string, options?: { image?: string }): Promise<Workspace>;
    exec(
      ws: Workspace,
      command: string,
      message?: string,
      sinks?: { stdout?: Writable; stderr?: Writable },
    ): Promise<Value>;
    status(ws: Workspace): Promise<Value>;
    commit(ws: Workspace, message?: string, force?: boolean): Promise<Value>;
    unmount(ws: Workspace, discard?: boolean): Promise<Value>;
  };
  close(): Promise<void>;
}
class Capture extends Writable {
  private chunks: Buffer[] = [];
  tail = Buffer.alloc(0);
  bytes = 0;
  private kept = 0;
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.bytes += chunk.length;
    this.tail = Buffer.from(Buffer.concat([this.tail, chunk]).subarray(-256));
    const part = chunk.subarray(0, Math.max(0, 24 * 1024 - this.kept));
    if (part.length) {
      this.chunks.push(Buffer.from(part));
      this.kept += part.length;
    }
    callback();
  }
  prefix(bytes: number) {
    return Buffer.concat(this.chunks).subarray(0, bytes).toString("utf8");
  }
  get text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
  get truncated() {
    return this.bytes > this.kept;
  }
}
export function errorData(error: unknown): Value {
  const e = error as {
    code?: string;
    message?: string;
    cause?: unknown;
    detail?: unknown;
  };
  return {
    code: e?.code,
    detail: e?.detail,
    message: e?.message ?? String(error),
  };
}
export class OperationError extends Error {
  constructor(
    public operation: string,
    public errors: Value[],
    public result?: Value,
  ) {
    super(
      `${operation}: ${errors.map((e) => `${e.phase}: ${e.message}`).join("; ")}`,
    );
  }
}
export const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export function branchPath(root: string, path: string) {
  if (path.includes("\0")) throw new Error("NUL is not a valid path");
  const absolute = resolve(root, path);
  if (!inside(root, absolute))
    throw new Error(
      `Path escapes active LayerFS project: ${path}. Use project-relative paths.`,
    );
  return `/${relative(root, absolute)}`;
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
// Capture preflight is shared with the project import controller.
export async function sensitiveFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (
        /^(\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|id_(rsa|ed25519)|.*\.(pem|key)|store\.sqlite(?:-.*)?)$/i.test(
          entry.name,
        )
      )
        found.push(relative(root, path));
      if (entry.isDirectory() && found.length < 20) await visit(path);
    }
  }
  await visit(root);
  return found;
}

export type { RuntimeOptions } from "./ports.js";

type Binding = {
  version: 1;
  root: string;
  store: string;
  initial: string | null;
};
export class Runtime {
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private failure: unknown;
  private stopped = false;
  readonly owned = new Map<string, Workspace>();
  readonly persistent = new Set<string>();
  readonly processes = new Set<string>();
  initial: string | null = null;
  diagnostics: unknown;
  leases?: Leases;
  // Workspaces left by dead sessions: reclaimed, reported, or awaiting the
  // end of their command's own timeout.
  recovery: {
    reclaimed: string[];
    orphaned: Lease[];
    pending: Lease[];
    errors: Value[];
  } = { reclaimed: [], orphaned: [], pending: [], errors: [] };
  private retry?: NodeJS.Timeout;
  constructor(
    readonly root: string,
    readonly config: Config,
    readonly sdk: SDK,
    private validate = validateEnvironment,
    readonly options: RuntimeOptions = {},
  ) {}
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
  async initialize() {
    return this.serial(async () => {
      if (this.initialized) return;
      if (this.failure) throw this.failure;
      try {
        await this.initializeOnce();
        this.initialized = true;
      } catch (e) {
        this.failure = e;
        throw e;
      }
    });
  }
  private async initializeOnce() {
    this.diagnostics = await this.validate(this.root);
    const env = { ...environment(), ...this.options.deployment };
    const home = required(env.HOME);
    const store = required(env.STORE_PATH);
    this.leases = new Leases(join(home, "pi-leases", this.config.project));
    const bindings = join(home, "pi-bindings");
    await mkdir(bindings, { recursive: true, mode: 0o700 });
    const file = join(bindings, `${this.config.project}.json`);
    const lock = `${file}.lock`;
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (cause) {
      throw new Error(
        "LayerFS initialization is busy or has a stale lock; inspect pi-bindings before recovery",
        { cause },
      );
    }
    try {
      let binding: Binding;
      const save = async () => {
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(binding)}\n`, {
          mode: 0o600,
        });
        await rename(temporary, file);
      };
      if (await exists(file)) {
        try {
          binding = JSON.parse(await readFile(file, "utf8")) as Binding;
        } catch (cause) {
          throw new Error("Invalid persistent LayerFS project binding", {
            cause,
          });
        }
        if (
          binding.version !== 1 ||
          binding.root !== this.root ||
          binding.store !== store
        )
          throw new Error(
            "LayerFS project binding belongs to another source or Store",
          );
        if (!(await exists(join(home, this.config.project))))
          throw new Error(
            "Project binding exists but LayerFS project is missing; explicit recovery required",
          );
      } else {
        if (await exists(join(home, this.config.project)))
          throw new Error(
            "Existing LayerFS project has no Pi binding; explicit adoption is unsupported",
          );
        if (!this.config.initialize)
          throw new Error(
            "Project is uninitialized; set initialize:true to capture the complete source tree",
          );
        const sensitive = await sensitiveFiles(this.root);
        if (sensitive.length)
          throw new Error(
            `Refusing initial capture: potentially sensitive files: ${sensitive.join(", ")}. Remove them from the source or use a credential-free fixture; ignored files are captured.`,
          );
        binding = { version: 1, root: this.root, store, initial: null };
        await save(); // Intent survives a crash/unknown SDK outcome; never silently reacquire.
        const init = await this.sdk.project.init(this.root);
        if (init.kind !== "Initialized" || typeof init.layer !== "string")
          throw new Error("Unexpected project.init result");
        binding.initial = init.layer;
        await save();
      }
      if (!binding.initial)
        throw new Error(
          "Incomplete initialization intent; inspect LayerFS before explicit recovery (no automatic replay)",
        );
      this.initial = binding.initial;
      const branches: Value[] = [];
      for (let pos = 0; ; ) {
        const page = await this.sdk.project.list_branches(1000, pos);
        branches.push(...page.items);
        if (!page.hasMore) break;
        if (!page.items.length)
          throw new Error("LayerFS branch page made no progress");
        pos += page.items.length;
      }
      const main = branches.find((b) => b.name === "main");
      const layers = new Set([binding.initial]);
      let snapshot: Value | undefined;
      const observed = Date.now();
      if (this.options.operator) {
        snapshot = await invoke(this.options.operator, "inspect", "snapshot");
        for (const layer of snapshot.layers as Value[])
          layers.add(String(layer.id));
        if (!(snapshot.layers as Value[]).some((l) => l.id === binding.initial))
          throw new Error(
            "Recorded genesis is absent from LayerFS history; reconcile this binding",
          );
      }
      if (!main || !layers.has(String(main.base)))
        throw new Error(
          "main has moved away from recorded L0; explicit project reconciliation required",
        );
      const working = branches.find((b) => b.name === this.config.branch);
      if (working && !layers.has(String(working.base)))
        throw new Error("Configured working branch has an unknown base Layer");
      if (!working) await this.sdk.branch.fork(this.config.branch, "main");
      // Under the initialization lock, so concurrent sessions never reclaim
      // the same Workspace twice.
      if (snapshot) await this.reclaim(snapshot, observed);
    } finally {
      await rm(lock, { recursive: true });
    }
  }
  // Ordinary command Workspaces of dead holders are discarded, as their
  // timeout/cancellation would have done. Retained Workspaces hold explicit
  // uncommitted work: they are reported, and discarded only through
  // discardOrphans. Live and unknown holders are never touched.
  private async reclaim(snapshot: Value, observed: number) {
    const leases = required(this.leases);
    const mounted = mountedWorkspaces(snapshot);
    const me = await ownerIdentity();
    const recovery: Runtime["recovery"] = {
      reclaimed: this.recovery.reclaimed,
      orphaned: [],
      pending: [],
      errors: [],
    };
    for (const lease of await leases.list()) {
      const key = `${lease.sandbox}:${lease.path}`;
      try {
        if (!mounted.has(key)) {
          // Unmounted after its holder recorded it: nothing remains to free.
          // A lease newer than the snapshot names a mount it cannot show.
          if (
            lease.time < observed &&
            sameLease(await leases.read(lease), lease)
          )
            await leases.release(lease);
          continue;
        }
        if (await holderAlive(lease, me)) continue;
        if (lease.retained) {
          recovery.orphaned.push(lease);
          continue;
        }
        if (!sameLease(await leases.read(lease), lease)) continue;
        await this.sdk.workspace.unmount(
          { sandbox: lease.sandbox, path: lease.path },
          true,
        );
        await leases.release(lease);
        recovery.reclaimed.push(key);
      } catch (e) {
        // Busy: the dead session's command still runs until its timeout.
        if (errorData(e).code === "Busy") recovery.pending.push(lease);
        else recovery.errors.push({ workspace: key, ...errorData(e) });
      }
    }
    this.recovery = recovery;
    const due = Math.max(
      0,
      ...recovery.pending.map((l) => (l.deadline ?? 0) - Date.now()),
    );
    clearTimeout(this.retry);
    this.retry = undefined;
    if (recovery.pending.some((l) => l.deadline && l.deadline > Date.now()))
      this.retry = setTimeout(() => {
        this.retry = undefined;
        this.serial(async () => {
          if (this.stopped || !this.initialized) return;
          const observed = Date.now();
          await this.reclaim(
            await invoke(this.options.operator, "inspect", "snapshot"),
            observed,
          );
        }).catch((e) => {
          this.recovery.errors.push({ phase: "reclaim", ...errorData(e) });
        });
      }, due + 1000).unref();
  }
  discardOrphans() {
    return this.serial(async () => {
      await this.active();
      const leases = required(this.leases);
      const discarded: string[] = [];
      const errors: Value[] = [];
      const running = this.recovery.orphaned.length
        ? (((await invoke(this.options.operator, "process", "list")).items as
            | Value[]
            | undefined) ?? [])
        : [];
      for (const lease of this.recovery.orphaned) {
        const key = `${lease.sandbox}:${lease.path}`;
        try {
          if (!sameLease(await leases.read(lease), lease)) continue;
          // Recorded processes, plus any still running in that Workspace.
          const ids = new Set(lease.processes);
          for (const p of running)
            if (
              p.sandbox === lease.sandbox &&
              p.path === lease.path &&
              p.status === "running"
            )
              ids.add(String(p.id));
          for (const id of ids)
            await invoke(this.options.operator, "process", "cancel", [
              id,
            ]).catch((e) => {
              if (errorData(e).code !== "NotFound") throw e;
            });
          await this.sdk.workspace.unmount(
            { sandbox: lease.sandbox, path: lease.path },
            true,
          );
          await leases.release(lease);
          discarded.push(key);
        } catch (e) {
          errors.push({ workspace: key, ...errorData(e) });
        }
      }
      this.recovery.orphaned = this.recovery.orphaned.filter(
        (l) => !discarded.includes(`${l.sandbox}:${l.path}`),
      );
      if (errors.length)
        throw new OperationError("discard orphans", errors, { discarded });
      return { discarded };
    });
  }
  private async active() {
    if (this.stopped) throw new Error("LayerFS runtime is shut down");
    if (!this.initialized)
      throw new Error(
        `LayerFS unavailable: ${this.failure ? errorData(this.failure).message : "session initialization has not completed"}`,
      );
    if ([...this.owned.keys()].some((key) => !this.persistent.has(key)))
      throw new Error(
        "A Workspace requires recovery; inspect layerfs_status and layerfs_cleanup before more operations",
      );
  }
  async files(
    op: "read" | "write" | "edit" | "list" | "glob" | "grep" | "rm",
    args: {
      path: string;
      content?: string;
      oldText?: string;
      newText?: string;
      pattern?: string;
      offset?: number;
      limit?: number;
      page?: number;
    },
  ) {
    return this.serial(async () => {
      await this.active();
      const path = branchPath(this.root, args.path);
      const b = this.config.branch;
      try {
        if (op === "read")
          return await this.sdk.fs.read(
            b,
            path,
            args.offset ?? 1,
            (args.offset ?? 1) + (args.limit ?? 200) - 1,
          );
        if (op === "write")
          return await this.sdk.fs.write(b, path, required(args.content));
        if (op === "edit")
          return await this.sdk.fs.edit(
            b,
            path,
            required(args.oldText),
            required(args.newText),
          );
        if (op === "rm")
          return await this.sdk.fs.apply(b, [{ op: "rm", path }]);
        if (op === "list")
          return await this.sdk.fs.list(
            b,
            path,
            args.limit ?? 100,
            args.page ?? 0,
          );
        return await this.sdk.fs[op](
          b,
          required(args.pattern),
          path,
          args.limit ?? 100,
          args.page ?? 0,
        );
      } catch (e) {
        throw new OperationError(`fs.${op} ${b}:${path}`, [
          { phase: "sdk", ...errorData(e) },
        ]);
      }
    });
  }
  async bash(
    command: string,
    signal?: AbortSignal,
    seconds = this.config.timeoutSeconds,
  ) {
    return this.serial(async () => {
      await this.active();
      if (this.persistent.size)
        throw new Error(
          "Use layerfs_workspace exec for the retained Workspace, or unmount it before Bash",
        );
      if (
        !Number.isSafeInteger(seconds) ||
        seconds < 1 ||
        seconds > this.config.timeoutSeconds
      )
        throw new Error(
          "Command timeout must be a positive integer no greater than configured timeoutSeconds",
        );
      if (signal?.aborted) throw new Error("Command cancelled before mount");
      const errors: Value[] = [];
      let ws: Workspace | undefined;
      let result: Value | undefined;
      let commit: Value | undefined;
      try {
        ws = await this.sdk.workspace.mount(this.config.branch);
        this.owned.set(`${ws.sandbox}:${ws.path}`, ws);
        await this.leases?.hold(ws, {
          branch: this.config.branch,
          agent: String(this.options.agent),
          retained: false,
          seconds,
        });
        // Foreground SDK exec has no cancellation port. Wait for timeout+kill and
        // its confirmed result before touching the overlay. Never Promise.race it.
        const stdout = new Capture();
        const stderr = new Capture();
        const marker = `__PI_LAYERFS_EXIT_${randomUUID()}__`;
        // A normal child exit (including 124/137) is distinct from timeout's
        // own exit code. The random stderr trailer is removed before returning.
        const wrapped = `bash -c ${quote(command)}; _pi_exit=$?; printf '\\n${marker}:%s\\n' "$_pi_exit" >&2; exit 0`;
        result = await this.sdk.workspace.exec(
          ws,
          `timeout --signal=TERM --kill-after=2s ${seconds}s bash -c ${quote(wrapped)}`,
          "Pi command",
          { stdout, stderr },
        );
        const timedOut = [124, 137].includes(Number(result.exitCode));
        let actualExit = Number(result.exitCode);
        let stderrBytes = Number(
          result.stderrBytes ?? Buffer.byteLength(String(result.stderr ?? "")),
        );
        if (!timedOut) {
          const tail =
            typeof result.stderr === "string"
              ? result.stderr
              : stderr.tail.toString("utf8");
          const match = tail.match(new RegExp(`\\n${marker}:(\\d{1,3})\\n$`));
          if (actualExit !== 0 || !match || Number(match[1]) > 255)
            throw new Error(
              "Command completion could not be confirmed; no commit attempted",
            );
          actualExit = Number(match[1]);
          stderrBytes -= Buffer.byteLength(match[0]);
          if (stderrBytes < 0)
            throw new Error("Invalid command stderr byte count");
        }
        result = {
          ...result,
          exitCode: actualExit,
          kind: `exit:${actualExit}`,
          stdout: result.stdout ?? stdout.text,
          stderr:
            typeof result.stderr === "string"
              ? Buffer.from(result.stderr)
                  .subarray(0, stderrBytes)
                  .toString("utf8")
              : stderr.prefix(stderrBytes),
          stderrBytes,
          timedOut,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderrBytes > 24 * 1024,
        };
        if (signal?.aborted)
          errors.push({
            phase: "execute",
            code: "Cancelled",
            message:
              "Cancelled; waited for command termination, changes discarded",
          });
        else if (timedOut)
          errors.push({
            phase: "execute",
            code: "Timeout",
            message: "Command timed out; changes discarded",
          });
        else {
          if (Number(result.exitCode) !== 0)
            errors.push({
              phase: "execute",
              code: "ExitCode",
              message: `Command exited ${result.exitCode}`,
            });
          try {
            commit = await this.sdk.workspace.commit(ws, "Pi command changes");
          } catch (e) {
            errors.push({ phase: "commit", ...errorData(e) });
          }
        }
      } catch (e) {
        errors.push({ phase: ws ? "execute" : "mount", ...errorData(e) });
      } finally {
        if (ws) {
          try {
            await this.sdk.workspace.unmount(ws, !commit);
            this.owned.delete(`${ws.sandbox}:${ws.path}`);
            // A lease left behind is removed by the next reclaim.
            await this.leases?.release(ws).catch(() => undefined);
          } catch (e) {
            errors.push({ phase: "unmount", ...errorData(e) });
          }
        }
      }
      const details = {
        branch: this.config.branch,
        workspace: ws,
        command: result,
        commit,
        cancelled: signal?.aborted ?? false,
        errors,
      };
      if (errors.length) throw new OperationError("bash", errors, details);
      return details;
    });
  }
  status() {
    return this.serial(async () => {
      let head: unknown = null;
      let headError: Value | undefined;
      if (this.initialized && !this.stopped) {
        try {
          head =
            (await this.sdk.branch.list_commits(this.config.branch, 1, 0))
              .items[0]?.id ?? null;
        } catch (e) {
          headError = errorData(e);
        }
      }
      return {
        project: this.config.project,
        branch: this.config.branch,
        initial: { ref: "main @ L0", layer: this.initial, commit: null },
        head,
        headError,
        mounted: [...this.owned.values()],
        recovery: this.recovery,
        ready:
          this.initialized &&
          !this.stopped &&
          !headError &&
          [...this.owned.keys()].every((key) => this.persistent.has(key)),
        failure: this.failure ? errorData(this.failure) : null,
        diagnostics: this.diagnostics,
        durability: "Disposable: no crash/power-loss durability",
        coverage:
          "read/write/edit/bash/grep/find/ls; known hashline mutators and powershell blocked; other extensions and host control plane are outside coverage",
      };
    });
  }
  commits(size = 50, pos = 0) {
    return this.serial(async () => {
      await this.active();
      return this.sdk.branch.list_commits(this.config.branch, size, pos);
    });
  }
  cleanup() {
    return this.serial(async () => {
      const errors: Value[] = [];
      for (const id of this.processes) {
        try {
          await invoke(this.options.operator, "process", "cancel", [id]);
          this.processes.delete(id);
        } catch (e) {
          errors.push({ phase: "cancel", process: id, ...errorData(e) });
        }
      }
      for (const [key, ws] of this.owned) {
        try {
          await this.sdk.workspace.unmount(ws, true);
          this.owned.delete(key);
          this.persistent.delete(key);
          await this.leases?.release(ws).catch(() => undefined);
        } catch (e) {
          errors.push({ phase: "unmount", workspace: ws, ...errorData(e) });
        }
      }
      if (errors.length) throw new OperationError("cleanup", errors);
    });
  }
  async shutdown() {
    await this.serial(async () => {
      this.stopped = true;
      clearTimeout(this.retry);
    });
    const errors: Value[] = [];
    try {
      await this.cleanup();
    } catch (e) {
      if (e instanceof OperationError) errors.push(...e.errors);
      else errors.push({ phase: "cleanup", ...errorData(e) });
    }
    try {
      await this.sdk.close();
    } catch (e) {
      errors.push({ phase: "close", ...errorData(e) });
    }
    if (errors.length) throw new OperationError("shutdown", errors);
  }
}
export async function createRuntime(
  root: string,
  config: Config,
  options: RuntimeOptions = {},
) {
  const canonical = await realpath(root);
  options.agent ??= randomUUID();
  options.deployment = { ...environment(), ...options.deployment };
  const sdk = await loadClient(config.sdk, config.project, options);
  return new Runtime(
    canonical,
    config,
    sdk,
    (root) =>
      withDeployment(options.deployment ?? {}, () => validateEnvironment(root)),
    options,
  );
}
