import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";
import { Agents } from "./agents.js";
import {
  environment,
  loadConfig,
  required,
  validateEnvironment,
} from "./config.js";
import { Control } from "./control.js";
import { Dashboard } from "./dashboard.js";
import { name as branchName } from "./operations.js";
import { withDeployment } from "./ports.js";
import {
  createRuntime,
  errorData,
  OperationError,
  type Runtime,
  type Value,
} from "./runtime.js";

type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
export default function layerfsExtension(
  pi: ExtensionAPI,
  options: { runtime?: Runtime; worker?: boolean } = {},
) {
  let runtime: Runtime | undefined;
  let control: Control | undefined;
  let agents: Agents | undefined;
  let dashboard: Dashboard | undefined;
  let startupError: unknown;
  let rememberedProject = "";
  const manager = () => {
    if (!control || startupError)
      throw new Error(
        `LayerFS unavailable: ${errorData(startupError ?? "not initialized").message}`,
      );
    return control;
  };
  const get = () => {
    const c = manager();
    c.bindProject();
    runtime = c.runtime;
    rememberProject();
    return runtime;
  };
  const ops = () => {
    get();
    return manager().operations;
  };
  const rememberProject = () => {
    const data = {
      project: manager().runtime.config.project,
      volume: manager().runtime.options.deployment?.VOLUME,
      branch: manager().runtime.config.branch,
      locked: manager().locked,
      role: options.worker ? "worker" : "lead",
    };
    const key = JSON.stringify(data);
    if (key !== rememberedProject) {
      pi.appendEntry("layerfs-project", data);
      rememberedProject = key;
    }
  };
  const select = async (project: string) => {
    const result = await manager().select(project);
    runtime = manager().runtime;
    rememberProject();
    return result;
  };
  pi.registerFlag("layerfs-config", {
    type: "string",
    description: "Path to LayerFS JSON config (default .pi/layerfs.json)",
  });
  pi.registerFlag("layerfs-manage", {
    type: "boolean",
    description:
      "Open project management without importing or binding the configured project",
  });
  pi.registerFlag("layerfs-minimalist", {
    type: "boolean",
    description:
      "Use Bash and LayerFS workflow tools without Pi read/write/edit tools",
  });
  // Personal package installation must not replace tools in ordinary host Pi.
  // The bundled launcher supplies the deployment; SDK callers can inject it.
  if (!options.runtime && !environment().HOME) return;
  const blocked = new Set([
    "replace",
    "replace_match",
    "insert",
    "copy",
    "move",
    "undo_last_change",
    "powershell",
  ]);
  pi.on("tool_call", (event) => {
    if (blocked.has(event.toolName))
      return {
        block: true,
        reason:
          "Host filesystem tool blocked by LayerFS. Use the LayerFS-backed read/write/edit/bash tools. Hashline anchors are not supported.",
      };
  });
  async function shutdown() {
    const results = await Promise.allSettled([
      dashboard?.close(),
      agents?.close(),
    ]);
    try {
      if (control) await control.close();
      else if (runtime) await runtime.shutdown();
    } finally {
      dashboard = undefined;
      agents = undefined;
      control = undefined;
      runtime = undefined;
    }
    const failure = results.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  pi.on("session_start", async (_event, ctx) => {
    try {
      if (control || runtime) await shutdown();
      startupError = undefined;
      rememberedProject = "";
      const entry = ctx.sessionManager
        .getBranch()
        .filter(
          (e) => e.type === "custom" && e.customType === "layerfs-project",
        )
        .at(-1);
      const saved =
        entry?.type === "custom" && entry.data && typeof entry.data === "object"
          ? (entry.data as Value)
          : undefined;
      if (saved?.role === "worker" && !options.worker)
        throw new Error(
          "A worker transcript cannot be resumed as a lead; use its parent session and inspect the retained Branch",
        );
      if (options.runtime) runtime = options.runtime;
      else {
        const config = await loadConfig(
          ctx.cwd,
          pi.getFlag("layerfs-config") as string | undefined,
        );
        if (saved?.branch && !options.worker)
          config.branch = branchName(saved.branch);
        runtime = await createRuntime(ctx.cwd, config, {
          agent: ctx.sessionManager.getSessionId(),
          label: pi.getSessionName() ?? "lead",
        });
      }
      const restoring = !options.worker && typeof saved?.project === "string";
      const unbound =
        !options.worker && (Boolean(pi.getFlag("layerfs-manage")) || restoring);
      if (unbound)
        await withDeployment(runtime.options.deployment ?? {}, () =>
          validateEnvironment(ctx.cwd),
        );
      else await runtime.initialize();
      control = new Control(runtime);
      await control.ready(unbound);
      if (restoring) {
        await control.restore(saved as Value);
        runtime = control.runtime;
      }
      if (!options.worker) agents = new Agents(control);
      if (pi.getFlag("layerfs-minimalist"))
        pi.setActiveTools(
          pi
            .getAllTools()
            .map((t) => t.name)
            .filter((n) => n === "bash" || n.startsWith("layerfs_")),
        );
      runtime = control.runtime;
      ctx.ui.setStatus(
        "layerfs",
        control.unbound
          ? "Choose project: /layerfs ui"
          : `${runtime.config.project} / ${runtime.config.branch} (Disposable)`,
      );
      const recovery = runtime.recovery;
      if (recovery && runtime.config.logLevel !== "silent")
        ctx.ui.notify(
          `LayerFS reclaimed ${(recovery.reclaimed as Value[]).length} Workspace(s) of ended Pi sessions; ${(recovery.pending as Value[]).length} await their command's timeout; ${(recovery.errors as Value[]).length} need attention (layerfs_status)`,
          (recovery.errors as Value[]).length ? "warning" : "info",
        );
      if (runtime.config.logLevel === "info")
        ctx.ui.notify(
          `LayerFS ready: ${runtime.config.project}/${runtime.config.branch}`,
          "info",
        );
    } catch (e) {
      startupError = e;
      ctx.ui.setStatus(
        "layerfs",
        "LayerFS unavailable — project tools fail closed",
      );
      if (runtime?.config.logLevel !== "silent")
        ctx.ui.notify(String(errorData(e).message), "error");
      if (runtime?.config.failWhenUnavailable !== false) {
        ctx.shutdown();
        throw e;
      }
    }
  });
  pi.on("session_shutdown", shutdown);
  pi.on("before_agent_start", () => ({
    message: {
      customType: "layerfs-context",
      display: false,
      content: `LayerFS project ${control?.unbound ? "not selected (choose a project first)" : runtime?.config.project}, Branch ${runtime?.config.branch}, role ${options.worker ? "worker" : "lead"}. Project tools read/write/edit/bash/grep/find/ls use SDK Branch state. Use project-relative paths. edit takes oldText/newText (exactly one match); no hashline anchors or binary reads. Bash mounts/commits/unmounts a fresh Workspace each call. Use layerfs_workspace mount/exec/commit/unmount for a retained Workspace (one per agent); resolve conflicts there before committing, unmount after use. layerfs_process controls background jobs only in an owned retained Workspace. layerfs_branch forks, switches, merges INTO A NEW NAMED BRANCH, compares and publishes; only the lead publishes. Workers use their own Branches and report Commit ids. Never retry Unknown/Failed operations blindly. Inspect partial diagnostics and resolve conflicts explicitly. layerfs_fs supports apply/mkdir/cp/mv and historical text/list/stat/blame/diffs; refs can be Branches or saved Commit/Layer ids. layerfs_inspect shows history, storage and per-file revisions. layerfs_project selects before first project operation or starts an import job. /layerfs ui opens Work, History/Files, Storage and recorded-call playback. Cancellation waits for foreground exec; detached jobs require explicit process control. Other extensions and host control-plane reads can bypass this integration. Disposable Store has no crash/power-loss durability; it is not a security sandbox.`,
    },
  }));
  function tool<T extends TSchema>(
    name: string,
    description: string,
    parameters: T,
    action: (
      input: Static<T>,
      signal: AbortSignal | undefined,
      ctx: ExtensionContext,
    ) => Promise<unknown>,
  ) {
    pi.registerTool({
      name,
      label: `LayerFS ${name}`,
      description,
      parameters,
      outputSchema: Type.Unknown(),
      executionMode: "sequential",
      async execute(id, input, signal, _update, ctx) {
        try {
          if (signal?.aborted) throw new Error("Cancelled before operation");
          const run = () => action(input, signal, ctx);
          const result = control
            ? await control.operations.observe(id, name, run)
            : await run();
          if (name === "layerfs_branch" && (input as Value).action === "switch")
            rememberProject();
          const value = JSON.parse(JSON.stringify(result) ?? "null") as Json;
          try {
            pi.appendEntry("layerfs-call", {
              step: id,
              method: name,
              project: runtime?.config.project,
              agent: runtime?.options.agent,
              ok: true,
            });
          } catch {
            /* diagnostic only */
          }
          return {
            content: [{ type: "text", text: JSON.stringify(value) }],
            details: value,
            structuredContent: value,
          };
        } catch (e) {
          const failure =
            e instanceof OperationError
              ? { ...e.result, operation: e.operation, errors: e.errors }
              : { errors: [errorData(e)] };
          const value = JSON.parse(JSON.stringify(failure)) as Json;
          return {
            content: [{ type: "text", text: JSON.stringify(value) }],
            details: value,
            structuredContent: value,
            isError: true,
          };
        }
      },
    });
  }
  const path = Type.String({
    description: "Project-relative path; never a host path outside the project",
  });
  const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 }));
  const page = Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "Advance SDK page position by items.length while hasMore",
    }),
  );
  tool(
    "read",
    "Read UTF-8 text through LayerFS SDK on active branch. Bounded text and truncation metadata; no binary/images.",
    Type.Object({
      path,
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit,
    }),
    (a) => get().files("read", a),
  );
  tool(
    "write",
    "Write UTF-8 through LayerFS SDK; one Branch Commit. No host fallback.",
    Type.Object({ path, content: Type.String() }),
    (a) => get().files("write", a),
  );
  tool(
    "edit",
    "LayerFS exact single-match oldText/newText replacement, without hashline anchors.",
    Type.Object({ path, oldText: Type.String(), newText: Type.String() }),
    (a) => get().files("edit", a),
  );
  tool(
    "bash",
    "Mount active Branch, execute with timeout, commit even on ordinary nonzero exit, then unmount. Cancellation/timeout discard after exec ends.",
    Type.Object({
      command: Type.String(),
      timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400 })),
    }),
    (a, signal) => get().bash(a.command, signal, a.timeout),
  );
  tool(
    "ls",
    "List active Branch through LayerFS SDK; paginated.",
    Type.Object({ path: Type.Optional(path), limit, page }),
    (a) => get().files("list", { ...a, path: a.path ?? "." }),
  );
  for (const [name, op] of [
    ["find", "glob"],
    ["grep", "grep"],
  ] as const)
    tool(
      name,
      `Search active Branch through SDK fs.${op}; pagination, no host access.`,
      Type.Object({
        pattern: Type.String(),
        path: Type.Optional(path),
        limit,
        page,
      }),
      (a) => get().files(op, { ...a, path: a.path ?? "." }),
    );
  tool(
    "layerfs_status",
    "Project/Branch/genesis/head, owned Workspaces and redacted deployment diagnostics.",
    Type.Object({}),
    async () =>
      control
        ? control.runtime.status()
        : { ready: false, failure: errorData(startupError) },
  );
  tool(
    "layerfs_commits",
    "List active Branch Commits newest first.",
    Type.Object({ limit, page }),
    (a) => get().commits(a.limit, a.page),
  );
  tool(
    "layerfs_remove",
    "Remove a file/directory via SDK fs.apply.",
    Type.Object({ path }),
    (a) => get().files("rm", a),
  );
  tool(
    "layerfs_cleanup",
    "Cancel owned background processes and discard/unmount owned Workspaces, then (lead only) reclaim Workspaces of Pi sessions that died or whose heartbeat expired; report failures.",
    Type.Object({}),
    async () => {
      await get().cleanup();
      if (!options.worker) await get().reclaim();
      return get().status();
    },
  );
  const actions = (values: string[]) =>
    Type.Object({
      action: Type.Union(values.map((v) => Type.Literal(v))),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    });
  tool(
    "layerfs_branch",
    "Branch workflow. list/commits {branch?,limit?,page?}; fork {name,from?}; switch {name}; merge {from?,with,name,message?,units?} creates NEW Branch; publish {branch?,commit?} lead only; diff_branches/diff_commits {from,to,limit?,page?,cursor?,hunks?}.",
    actions([
      "list",
      "commits",
      "fork",
      "switch",
      "merge",
      "publish",
      "diff_branches",
      "diff_commits",
    ]),
    (a) => ops().branch(a.action, a.args ?? {}),
  );
  tool(
    "layerfs_fs",
    "SDK filesystem/history. read/list/stat/blame {ref?,path,line?,limit?,page?}; diff_files {ref?,path,to,toPath?}; write {ref?,path,content,encoding?:utf8|base64,message?}; edit {ref?,path,oldText,newText}; mkdir/rm {ref?,path}; cp/mv {ref?,from,to}; apply {ref?,changes:[{op:write|edit|mkdir|rm|cp|mv,...}],message?}. main is read-only. Paths are project-relative; reads expose truncation.",
    actions([
      "read",
      "list",
      "stat",
      "blame",
      "diff_files",
      "mkdir",
      "rm",
      "cp",
      "mv",
      "apply",
      "write",
      "edit",
      "grep",
      "glob",
    ]),
    (a) => ops().filesystem(a.action, a.args ?? {}),
  );
  tool(
    "layerfs_workspace",
    "Retained Workspace, one per agent. mount {branch?} returns id; exec {id,command,timeout?}; status/overlay {id}; changes {id,limit?,page?}; commit {id,message?}; unmount {id,discard?}. Failed exec/commit retains state for explicit resolution. Busy/Dirty refusals are preserved.",
    actions([
      "mount",
      "exec",
      "status",
      "overlay",
      "changes",
      "commit",
      "unmount",
    ]),
    (a, signal) => ops().workspace(a.action, a.args ?? {}, signal),
  );
  tool(
    "layerfs_process",
    "Native background processes. start {id:ownedWorkspaceId,command}; list {}; cancel {process}. May only cancel processes started by this agent. Workspace stays mounted until processes end.",
    actions(["start", "list", "cancel"]),
    (a) => ops().process(a.action, a.args ?? {}),
  );
  tool(
    "layerfs_inspect",
    "Read native state: snapshot {since?}, storage, sandboxes, progress, file_stats/file_history {ref?,path,limit?,page?}, overwritten {layer,limit?,page?}; changes {from,to,limit?,page?} compares saved states; trace_files and trace_read {file,offset?,limit?} page full journals; work returns agent-labelled call journal. Partial flags are authoritative.",
    actions([
      "snapshot",
      "storage",
      "sandboxes",
      "progress",
      "file_stats",
      "file_history",
      "overwritten",
      "changes",
      "trace_files",
      "trace_read",
      "work",
    ]),
    (a) =>
      a.action === "work"
        ? ops().work()
        : ops().inspect(a.action, a.args ?? {}),
  );
  if (!options.worker) {
    tool(
      "layerfs_project",
      "Projects: list; select {name} before first project operation; init {name,source?} starts import (no source = empty), requires --manage-projects; job {id}; remove {name,confirmation,stopSandboxes?} requires exact name, no live agents/Workspaces, dedicated owned Store.",
      actions(["list", "select", "init", "job", "remove"]),
      async (a) => {
        const c = manager(),
          args = a.args ?? {};
        switch (a.action) {
          case "list":
            return c.projects();
          case "select":
            return select(String(args.name));
          case "init":
            return c.init(
              String(args.name),
              args.source ? String(args.source) : undefined,
            );
          case "job":
            return c.job(String(args.id));
          case "remove":
            return c.remove(
              String(args.name),
              String(args.confirmation),
              args.stopSandboxes === true,
            );
        }
      },
    );
    tool(
      "layerfs_agent",
      "Lead-owned Pi worker sessions. spawn {label,task}: inherits parent model/auth through public adapter, creates an independent Branch, runs asynchronously; list; message {id,message}; cancel {id}. Workers cannot publish or spawn workers. Parent/session shutdown waits for cleanup.",
      actions(["spawn", "list", "message", "cancel"]),
      async (a, _signal, ctx) => {
        const manager = required(agents),
          args = a.args ?? {};
        if (a.action === "list") return manager.list();
        if (a.action === "spawn") {
          get();
          return manager.spawn(
            String(args.label ?? "worker"),
            String(required(args.task)),
            ctx,
          );
        }
        return manager.action(
          a.action,
          String(args.id),
          args.message as string | undefined,
        );
      },
    );
    tool(
      "layerfs_dashboard",
      "Start authenticated loopback Work/History/Files/Storage page. Returns a private local URL; closes with this Pi session.",
      Type.Object({}),
      async () => {
        dashboard ??= new Dashboard(manager());
        dashboard.onSelect = select;
        return { url: await dashboard.start() };
      },
    );
  }
  pi.registerCommand("layerfs", {
    description:
      "LayerFS: status | ui | projects | use NAME | init NAME [SOURCE] | session NAME | minimalist",
    handler: async (args, ctx) => {
      const [command = "status", project, ...rest] = args
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const newSession = async (target: string) => {
        const record = await manager().project(target);
        await ctx.newSession({
          setup: async (session) => {
            session.appendCustomEntry("layerfs-project", {
              project: target,
              volume: record.volume,
              locked: false,
              role: "lead",
            });
          },
        });
      };
      if (command === "ui") {
        if (options.worker)
          throw new Error("Workers cannot open project management");
        dashboard ??= new Dashboard(manager());
        dashboard.onSelect = select;
        dashboard.onSession = newSession;
        ctx.ui.notify(await dashboard.start(), "info");
      } else if (command === "projects")
        ctx.ui.notify(JSON.stringify(await manager().projects()), "info");
      else if (command === "use") {
        if (options.worker) throw new Error("Worker project is fixed");
        ctx.ui.notify(JSON.stringify(await select(required(project))), "info");
      } else if (command === "init") {
        if (options.worker) throw new Error("Workers cannot import projects");
        ctx.ui.notify(
          JSON.stringify(
            await manager().init(
              required(project),
              rest.length ? rest.join(" ") : undefined,
            ),
          ),
          "info",
        );
      } else if (command === "session") {
        if (options.worker)
          throw new Error("Workers cannot create lead sessions");
        await newSession(required(project));
      } else if (command === "minimalist") {
        pi.setActiveTools(
          pi
            .getAllTools()
            .map((t) => t.name)
            .filter((n) => n === "bash" || n.startsWith("layerfs_")),
        );
        ctx.ui.notify("LayerFS minimalist tools active", "info");
      } else
        ctx.ui.notify(JSON.stringify(await manager().runtime.status()), "info");
    },
  });
  pi.on("user_bash", () => ({
    operations: {
      exec: async (command, _cwd, { onData, signal, timeout }) => {
        const c = manager();
        c.bindProject();
        const value = await c.operations.observe(
          `user-bash-${Date.now()}`,
          "user_bash",
          () => get().bash(command, signal, timeout),
        );
        onData(
          Buffer.from(
            `${value.command?.stdout ?? ""}${value.command?.stderr ?? ""}\n${JSON.stringify({ commit: value.commit, workspace: value.workspace })}`,
          ),
        );
        return { exitCode: Number(value.command?.exitCode ?? 0) };
      },
    },
  }));
}
