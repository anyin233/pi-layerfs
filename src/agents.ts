import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { required } from "./config.js";
import type { Control } from "./control.js";
import layerfsExtension from "./extension.js";
import { name, Operations } from "./operations.js";
import {
  createRuntime,
  errorData,
  type Runtime,
  type Value,
} from "./runtime.js";

type Worker = {
  id: string;
  label: string;
  branch: string;
  state: string;
  result?: string;
  error?: Value;
  session: AgentSession;
  runtime: Runtime;
  done: Promise<void>;
};
export class Agents {
  readonly workers = new Map<string, Worker>();
  private stopped = false;
  constructor(private control: Control) {}
  list() {
    return [...this.workers.values()].map(
      ({ id, label, branch, state, result, error }) => ({
        id,
        label,
        branch,
        state,
        result,
        error,
      }),
    );
  }
  async spawn(label: string, task: string, ctx: ExtensionContext) {
    if (this.stopped) throw new Error("Agent manager is closing");
    if (this.control.runtime.options.role === "worker")
      throw new Error("Only the lead spawns workers");
    if (this.workers.size >= 16)
      throw new Error("At most 16 workers per lead session");
    if (!label || label.length > 100 || !task || task.length > 100000)
      throw new Error("Worker label/task length is invalid");
    const model = required(ctx.model, "parent model");
    if (!ctx.modelRegistry.hasConfiguredAuth(model))
      throw new Error("Parent model has no configured authentication");
    const id = randomUUID(),
      branch = name(`agent-${id.slice(0, 12)}`);
    const parent = this.control.bindProject();
    await this.control.operations.branch("fork", {
      name: branch,
      from: parent.config.branch,
    });
    const runtime = await createRuntime(
      parent.root,
      { ...parent.config, branch, initialize: false },
      {
        agent: id,
        label,
        role: "worker",
        deployment: parent.options.deployment,
      },
    );
    let session: AgentSession | undefined;
    try {
      await runtime.initialize();
      const dir = join(this.control.directory, "sessions");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const settings = SettingsManager.inMemory({ retry: { enabled: false } });
      const loader = new DefaultResourceLoader({
        cwd: parent.root,
        agentDir: dir,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          (pi) => layerfsExtension(pi, { runtime, worker: true }),
        ],
      });
      await loader.reload();
      // Public provider adapter: parent resolves credentials on every request.
      // No credentials are serialized into configs, traces, or worker messages.
      const models = await ModelRuntime.create({
        refreshOnCreate: false,
        modelsPath: null,
      });
      models.registerProvider(model.provider, {
        api: model.api,
        baseUrl: model.baseUrl,
        apiKey: "delegated-in-memory",
        models: [{ ...model, input: [...model.input] }],
        streamSimple: (_model, context, options) =>
          ctx.modelRegistry.streamSimple(model, context, options),
      });
      ({ session } = await createAgentSession({
        cwd: parent.root,
        agentDir: dir,
        model,
        modelRuntime: models,
        settingsManager: settings,
        sessionManager: SessionManager.create(parent.root, dir),
        resourceLoader: loader,
        tools: [
          "read",
          "write",
          "edit",
          "bash",
          "ls",
          "find",
          "grep",
          "layerfs_branch",
          "layerfs_fs",
          "layerfs_workspace",
          "layerfs_process",
          "layerfs_inspect",
          "layerfs_commits",
          "layerfs_status",
          "layerfs_cleanup",
        ],
      }));
      await session.bindExtensions({ mode: "print" });
      const worker: Worker = {
        id,
        label,
        branch,
        state: "running",
        session,
        runtime,
        done: Promise.resolve(),
      };
      this.workers.set(id, worker);
      const operations = new Operations(runtime);
      session.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        )
          return operations.record({
            method: "agent.text",
            text: event.assistantMessageEvent.delta.slice(0, 4096),
          });
      });
      worker.done = (async () => {
        try {
          await required(session).prompt(
            `You are worker ${label} on Branch ${branch}. Work only on your Branch. Never publish. Commit useful results; close owned Workspaces. Report your final Commit and checks.\n\n${task}`,
          );
          const last = [...required(session).messages]
            .reverse()
            .find((message) => message.role === "assistant");
          if (
            last?.role === "assistant" &&
            (last.stopReason === "error" || last.stopReason === "aborted")
          )
            throw new Error(
              last.errorMessage ?? `Worker ended with ${last.stopReason}`,
            );
          worker.result = required(session).getLastAssistantText();
          worker.state = "completed";
        } catch (e) {
          worker.error = errorData(e);
          worker.state = worker.state === "cancelling" ? "cancelled" : "failed";
        } finally {
          required(session).dispose();
          try {
            await runtime.shutdown();
            await operations.actor("closed");
          } catch (e) {
            worker.error = errorData(e);
            worker.state = "cleanup_failed";
            await operations.actor("cleanup_failed");
          }
          await operations.record({
            method: "agent.end",
            state: worker.state,
            result: worker.result?.slice(0, 12000),
            error: worker.error,
          });
        }
      })();
      return { id, label, branch, state: worker.state };
    } catch (e) {
      session?.dispose();
      await runtime.shutdown();
      throw e;
    }
  }
  async action(action: string, id: string, message?: string) {
    const worker = this.workers.get(id);
    if (!worker) throw new Error("Worker is not owned by this lead session");
    if (action === "message") {
      if (worker.state !== "running") throw new Error("Worker is not running");
      await worker.session.prompt(required(message), {
        streamingBehavior: "steer",
      });
      return { id, queued: true };
    }
    if (action === "cancel") {
      if (worker.state === "running") worker.state = "cancelling";
      await worker.session.abort();
      await worker.done;
      return this.list().find((w) => w.id === id);
    }
    if (action === "compact") {
      if (worker.state !== "running" || !worker.session.isIdle)
        throw new Error("Compaction requires an idle active worker");
      return worker.session.compact(message);
    }
    throw new Error("Unknown worker action");
  }
  async close() {
    this.stopped = true;
    const results = await Promise.allSettled(
      [...this.workers.values()].map(async (w) => {
        if (w.state === "running") {
          w.state = "cancelling";
          await w.session.abort();
        }
        return w.done;
      }),
    );
    const error = results.find((r) => r.status === "rejected");
    if (error?.status === "rejected") throw error.reason;
    const dirty = [...this.workers.values()].filter(
      (w) => w.state === "cleanup_failed",
    );
    if (dirty.length)
      throw new Error(
        `Worker cleanup failed: ${dirty.map((w) => w.id).join(", ")}; inspect layerfs_inspect before explicit recovery`,
      );
  }
}
