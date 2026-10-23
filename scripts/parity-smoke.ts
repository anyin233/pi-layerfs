import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  wrapRegisteredTools,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, required } from "../src/config.js";
import { Control } from "../src/control.js";
import layerfsExtension from "../src/extension.js";
import { createRuntime, type Value } from "../src/runtime.js";

const receipts: Value[] = [];
const receipt = (step: string, value: unknown) => {
  receipts.push({ step, value });
  console.log(JSON.stringify({ step, value }));
};
const root = "/layerfs-store/fixture";
const base = await createRuntime(root, await loadConfig(root));
await base.initialize();
const control = new Control(base);
await control.ready();
const suffix = randomUUID().slice(0, 8),
  emptyName = `parity-${suffix}`,
  importName = `import-${suffix}`;
const importRoot = `/layerfs-store/import-source-${suffix}`;
await mkdir(importRoot);
await writeFile(join(importRoot, "seed.txt"), "imported\n");
async function waitJob(id: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const job = await control.job(id);
    if (job.state === "failed") throw Error(JSON.stringify(job));
    if (job.state === "ready") return job;
    await pause(100);
  }
  throw Error("Init did not settle within test deadline; inspect registry");
}
let requests = 0;
const finishToken = randomUUID();
let releaseBrowser: (() => void) | undefined;
const modelServer = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === `/finish/${finishToken}`) {
      res.end("closing");
      releaseBrowser?.();
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
    requests++;
    const user = body.messages
      .filter((m: Value) => m.role === "user")
      .map((m: Value) =>
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((part: Value) => String(part.text ?? "")).join("")
            : "",
      )
      .join("\n");
    const beta = user.includes("worker Beta"),
      file = beta ? "beta.txt" : "alpha.txt";
    const done = body.messages.some((m: Value) => m.role === "tool");
    res.setHeader("Content-Type", "text/event-stream");
    const chunk = (delta: Value, finish_reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: `local-${requests}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "deterministic", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (done) {
      chunk({ role: "assistant", content: "Completed owned Branch write." });
      chunk({}, "stop");
    } else {
      chunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `write-${requests}`,
            type: "function",
            function: {
              name: "write",
              arguments: JSON.stringify({
                path: file,
                content: beta ? "beta\n" : "alpha\n",
              }),
            },
          },
        ],
      });
      chunk({}, "tool_calls");
    }
    res.end("data: [DONE]\n\n");
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
});
await new Promise<void>((resolve) =>
  modelServer.listen(0, "127.0.0.1", resolve),
);
const port = (modelServer.address() as AddressInfo).port;
const models = await ModelRuntime.create({
  refreshOnCreate: false,
  modelsPath: null,
  credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async () => undefined,
    delete: async () => undefined,
  },
});
models.registerProvider("local-parity", {
  api: "openai-completions",
  baseUrl: `http://127.0.0.1:${port}/v1`,
  apiKey: "local-only",
  models: [
    {
      id: "deterministic",
      name: "Local deterministic test",
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      contextWindow: 32768,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ],
});
let session:
  | Awaited<ReturnType<typeof createAgentSession>>["session"]
  | undefined;
let runner: NonNullable<typeof session>["extensionRunner"] | undefined;
try {
  const emptyJob = await control.init(emptyName);
  receipt("init.empty", await waitJob(emptyJob.id));
  const importedJob = await control.init(importName, importRoot);
  receipt("init.import", await waitJob(importedJob.id));
  const imported = await control.reader(importName);
  assert.equal(
    (
      (await imported.filesystem("read", {
        ref: "main",
        path: "seed.txt",
      })) as Value
    ).text,
    "imported\n",
  );
  await control.select(emptyName);
  receipt("selected", await control.runtime.status());
  const settings = SettingsManager.inMemory({
    defaultProjectTrust: "always",
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: control.runtime.root,
    agentDir: "/layerfs-store/pi-parity-agent",
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noThemes: true,
    noPromptTemplates: true,
    extensionFactories: [
      (pi) => layerfsExtension(pi, { runtime: control.runtime }),
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const parentJournal = SessionManager.inMemory(control.runtime.root);
  ({ session } = await createAgentSession({
    cwd: control.runtime.root,
    agentDir: "/layerfs-store/pi-parity-agent",
    resourceLoader: loader,
    modelRuntime: models,
    model: required(models.getModel("local-parity", "deterministic")),
    settingsManager: settings,
    sessionManager: parentJournal,
  }));
  await session.bindExtensions({ mode: "print" });
  runner = session.extensionRunner;
  const errors: unknown[] = [];
  runner.onError((e) => errors.push(e));
  const call = async (name: string, args: Value = {}, expectError = false) => {
    const r = required(runner),
      tool = wrapRegisteredTools(r.getAllRegisteredTools(), r).find(
        (t) => t.name === name,
      );
    assert.ok(tool, name);
    const id = randomUUID(),
      gate = await r.emitToolCall({
        type: "tool_call",
        toolName: name,
        toolCallId: id,
        input: args,
      });
    assert.ok(!gate?.block);
    const result = await tool.execute(id, args);
    assert.equal(Boolean(result.isError), expectError, JSON.stringify(result));
    receipt(name, { isError: Boolean(result.isError), result: result.details });
    return result.details as Value;
  };
  const advanced = (
    tool: string,
    action: string,
    args: Value = {},
    error = false,
  ) => call(`layerfs_${tool}`, { action, args }, error);
  await advanced("fs", "mkdir", { path: "src" });
  const binding = parentJournal
    .getBranch()
    .filter((e) => e.type === "custom" && e.customType === "layerfs-project")
    .at(-1);
  assert.ok(binding?.type === "custom");
  assert.deepEqual(binding.data, {
    project: emptyName,
    volume: control.runtime.options.deployment?.VOLUME,
    branch: "pi-work",
    locked: true,
    role: "lead",
  });
  receipt("session.binding", binding.data);
  await advanced("fs", "apply", {
    changes: [
      { op: "write", path: "src/base.txt", content: "base\n" },
      { op: "cp", from: "src/base.txt", to: "copy.txt" },
      { op: "mv", from: "copy.txt", to: "moved.txt" },
    ],
  });
  await advanced("fs", "write", {
    path: "binary.bin",
    content: "AP8=",
    encoding: "base64",
  });
  assert.equal((await advanced("fs", "stat", { path: "binary.bin" })).size, 2);
  const ws = await advanced("workspace", "mount");
  const id = String(ws.id);
  await advanced("workspace", "exec", {
    id,
    command: "printf retained > retained.txt",
  });
  const background = await advanced("process", "start", {
    id,
    command: "sleep 30",
  });
  const listed = await advanced("process", "list");
  assert.ok((listed.items as Value[]).some((p) => p.id === background.process));
  await advanced("workspace", "unmount", { id }, true); // Busy, and the owned handle remains usable.
  await advanced("process", "cancel", { process: background.process });
  await advanced("workspace", "status", { id });
  await advanced("workspace", "overlay", { id });
  await advanced("workspace", "changes", { id });
  await advanced("workspace", "commit", { id, message: "retained work" });
  await advanced("workspace", "unmount", { id });
  const a = await advanced("agent", "spawn", {
    label: "Alpha",
    task: "Write alpha.txt on your assigned Branch.",
  });
  const b = await advanced("agent", "spawn", {
    label: "Beta",
    task: "Write beta.txt on your assigned Branch.",
  });
  for (let i = 0; i < 300; i++) {
    const workers = await advanced("agent", "list");
    assert.ok(Array.isArray(workers));
    const rows = workers as Value[];
    if (rows.every((w) => w.state !== "running")) {
      assert.ok(
        rows.every((w) => w.state === "completed"),
        JSON.stringify(rows),
      );
      break;
    }
    if (i === 299) throw Error("Workers did not settle");
    await pause(100);
  }
  assert.ok(
    requests >= 4,
    "Each worker used the real Pi model/tool loop through local HTTP",
  );
  await advanced("branch", "merge", {
    from: "pi-work",
    with: a.branch,
    name: "joined-alpha",
    message: "integrate Alpha",
  });
  const merge = await advanced("branch", "merge", {
    from: "joined-alpha",
    with: b.branch,
    name: "joined",
    message: "integrate Beta",
  });
  await advanced("branch", "diff_branches", {
    from: "pi-work",
    to: "joined",
    hunks: false,
    limit: 1,
  });
  const publish = await advanced("branch", "publish", { branch: "joined" });
  receipt("published", publish);
  for (const file of ["alpha.txt", "beta.txt", "retained.txt"])
    await advanced("fs", "read", { ref: "main", path: file });
  await advanced("fs", "blame", { ref: "joined", path: "alpha.txt" });
  await advanced("inspect", "file_history", {
    ref: "joined",
    path: "alpha.txt",
  });
  await advanced("inspect", "file_stats", { ref: "joined", path: "alpha.txt" });
  await advanced("branch", "fork", { name: "conflict-a", from: "joined" });
  await advanced("branch", "fork", { name: "conflict-b", from: "joined" });
  await advanced("fs", "write", {
    ref: "conflict-a",
    path: "conflict.txt",
    content: "A\n",
  });
  await advanced("fs", "write", {
    ref: "conflict-b",
    path: "conflict.txt",
    content: "B\n",
  });
  await advanced(
    "branch",
    "merge",
    { from: "conflict-a", with: "conflict-b", name: "must-conflict" },
    true,
  );
  await advanced("fs", "write", {
    ref: "conflict-b",
    path: "conflict.txt",
    content: "A\n",
  });
  await advanced("branch", "merge", {
    from: "conflict-a",
    with: "conflict-b",
    name: "resolved",
  });
  const state = await advanced("inspect", "snapshot");
  assert.equal((state.layers as Value[]).length, 2);
  assert.ok(
    (state.sandboxes as Value[]).every(
      (s) => (s.workspaces as Value[]).length === 0,
    ),
  );
  const work = await advanced("inspect", "work");
  assert.ok((work.actors as Value[]).some((x) => x.label === "Alpha"));
  assert.ok(
    (work.calls as Value[]).some(
      (x) => x.method === "branch.publish" && x.layer,
    ),
  );
  const ui = await call("layerfs_dashboard"),
    url = new URL(String(ui.url)),
    headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  for (const method of ["state", "work", "storage", "projects"]) {
    const res = await fetch(
      `${url.origin}/api?method=${method}&project=${emptyName}`,
      { headers },
    );
    assert.equal(res.status, 200);
    await res.json();
  }
  assert.equal((await fetch(`${url.origin}/api?method=state`)).status, 401);
  const binary = await (
    await fetch(`${url.origin}/api?method=read&path=binary.bin&ref=joined`, {
      headers,
    })
  ).json();
  assert.equal(binary.binary, true);
  assert.equal(binary.size, 2);
  const reopened = await createRuntime(
    control.runtime.root,
    { ...control.runtime.config, initialize: false },
    { deployment: control.runtime.options.deployment },
  );
  await reopened.initialize();
  assert.equal(reopened.initial, control.runtime.initial);
  await reopened.shutdown();
  const history = await advanced("branch", "commits", { branch: "joined" });
  assert.ok((history.items as Value[]).some((c) => c.id === merge.head));
  assert.deepEqual(errors, []);
  receipt("acceptance", {
    project: emptyName,
    importProject: importName,
    genesis: control.runtime.initial,
    publishedLayer: (publish.publishedLayer as Value)?.id,
    mergedHead: merge.head,
    workers: [a, b],
    modelRequests: requests,
    workspaces: 0,
    checks:
      "empty/import, process Busy/cancel, two real Pi worker loops, merges/conflict/publish/reopen, trace attribution, authenticated dashboard",
  });
  if (process.argv.includes("--serve")) {
    receipt("browser", {
      url: ui.url,
      project: emptyName,
      finish: `http://127.0.0.1:${port}/finish/${finishToken}`,
    });
    await new Promise<void>((resolve) => {
      releaseBrowser = resolve;
      setTimeout(resolve, 900000).unref();
    });
  }
  await required(runner).emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  session = undefined;
  control.runtime.config.branch = "pi-work";
  await control.select("pi-smoke");
  await control.remove(emptyName, emptyName, true);
  await control.remove(importName, importName, true);
  receipt("removed", {
    projects: [emptyName, importName],
    sourcePreserved:
      (await readFile(join(importRoot, "seed.txt"), "utf8")) === "imported\n",
  });
  await writeFile(
    "/layerfs-store/parity-receipt.json",
    JSON.stringify(receipts, null, 2),
  );
} finally {
  if (session) {
    await session.abort();
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  }
  await control.close();
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
}
