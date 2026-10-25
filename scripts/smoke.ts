import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  wrapRegisteredTools,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, required } from "../src/config.js";
import { snapshot } from "../src/history.js";
import { createRuntime, type Value, type Workspace } from "../src/runtime.js";

const plugin = process.env.PI_LAYERFS_PLUGIN ?? process.cwd();
const upstream = process.env.PI_LAYERFS_UPSTREAM;
assert.ok(
  upstream,
  "Run through scripts/client.sh with a prepared environment",
);
const root = "/layerfs-store/fixture";
const agentDir = "/layerfs-store/pi-test-agent";
await mkdir(join(root, ".pi"), { recursive: true });
await mkdir(agentDir, { recursive: true });
const configFile = join(root, ".pi/layerfs.json");
const config = {
  sdk: join(upstream, "api/agent/sdk/src/index.js"),
  project: "pi-smoke",
  branch: "pi-work",
  initialize: true,
  timeoutSeconds: 5,
  logLevel: "silent",
};
await writeFile(configFile, JSON.stringify(config));
try {
  await readFile(join(root, "seed.txt"));
} catch {
  await writeFile(join(root, "seed.txt"), "initial\n");
}
const receipt = (step: string, value: unknown) =>
  console.log(JSON.stringify({ step, value }));
const reopen = process.argv.includes("--reopen");
if (!reopen) {
  const runtime = await createRuntime(root, await loadConfig(root));
  await runtime.initialize();
  receipt("sdk.initial", await runtime.status());
  // Exercise the real native binding + daemon before invoking Pi tools.
  let ws: Workspace | undefined;
  try {
    ws = await runtime.mount(config.branch);
    receipt("sdk.mount", ws);
    const command = await runtime.sdk.workspace.exec(ws, "printf sdk-ok");
    receipt("sdk.exec", command);
    assert.equal(command.exitCode, 0);
    assert.equal(command.stdout, "sdk-ok");
    receipt(
      "sdk.commit",
      await runtime.sdk.workspace.commit(ws, "SDK preflight"),
    );
  } finally {
    if (ws)
      receipt("sdk.unmount", await runtime.sdk.workspace.unmount(ws, true));
    await runtime.shutdown();
  }
}
// Real Pi package entry loaded by its public resource loader and run through
// exported ExtensionRunner/wrappers; no LLM or provider credentials are needed.
const loader = new DefaultResourceLoader({
  cwd: root,
  agentDir,
  settingsManager: SettingsManager.inMemory({ defaultProjectTrust: "always" }),
  additionalExtensionPaths: [resolve(plugin, "dist/extension.js")],
  noContextFiles: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
});
await loader.reload();
const loaded = loader.getExtensions();
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const models = await ModelRuntime.create({
  credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async () => undefined,
    delete: async () => undefined,
  },
  modelsPath: null,
  refreshOnCreate: false,
  allowModelNetwork: false,
});
const { session } = await createAgentSession({
  cwd: root,
  agentDir,
  resourceLoader: loader,
  modelRuntime: models,
  sessionManager: SessionManager.inMemory(root),
  settingsManager: SettingsManager.inMemory({ defaultProjectTrust: "always" }),
});
const runner = session.extensionRunner;
const lifecycleErrors: unknown[] = [];
runner.onError((e) => lifecycleErrors.push(e));
const call = async (
  name: string,
  args: Value,
  expectError = false,
  signal?: AbortSignal,
) => {
  assert.ok(session.getToolDefinition(name), `Pi registered ${name}`);
  const tool = wrapRegisteredTools(runner.getAllRegisteredTools(), runner).find(
    (t) => t.name === name,
  );
  assert.ok(tool, `Missing registered extension tool: ${name}`);
  const gate = await runner.emitToolCall({
    type: "tool_call",
    toolName: name,
    toolCallId: `smoke-${name}`,
    input: args,
  });
  assert.ok(!gate?.block, `${name} unexpectedly blocked`);
  const result = await tool.execute(`smoke-${name}`, args, signal);
  receipt(`pi.${name}`, {
    isError: Boolean(result.isError),
    data: result.details,
  });
  assert.equal(
    Boolean(result.isError),
    expectError,
    `${name}: ${JSON.stringify(result)}`,
  );
  return result.details as Value;
};
try {
  await session.bindExtensions({ onError: (e) => lifecycleErrors.push(e) });
  receipt(
    "pi.registry",
    session
      .getAllTools()
      .map((t) => ({ name: t.name, description: t.description })),
  );
  assert.match(
    required(session.getToolDefinition("read")).description,
    /LayerFS SDK/,
  );
  assert.deepEqual(lifecycleErrors, []);
  const status = await call("layerfs_status", {});
  assert.equal(status.ready, true);
  assert.equal((status.initial as Value).ref, "main @ L0");
  assert.equal(status.head !== undefined, true);
  if (!reopen) {
    const before = (await call("layerfs_commits", {})).items as Value[];
    await call("write", { path: "temporary.txt", content: "hello\n" });
    await call("edit", {
      path: "temporary.txt",
      oldText: "hello",
      newText: "world",
    });
    assert.equal(
      (await call("read", { path: "temporary.txt" })).text,
      "world\n",
    );
    // No host checkout mutation: writes only exist on the active branch.
    await assert.rejects(readFile(join(root, "temporary.txt")), {
      code: "ENOENT",
    });
    await call("ls", {});
    await call("find", { pattern: "*.txt" });
    await call("grep", { pattern: "world" });
    await call("read", { path: "/etc/passwd" }, true);
    const bash = await call("bash", {
      command:
        "printf 'from bash\\n' > command.txt; printf stdout; printf stderr >&2",
    });
    assert.equal((bash.command as Value).stdout, "stdout");
    assert.equal((bash.command as Value).stderr, "stderr");
    assert.equal((bash.commit as Value).kind, "Committed");
    const commits = (await call("layerfs_commits", {})).items as Value[];
    assert.notEqual(commits[0]?.id, before[0]?.id);
    assert.ok(commits.some((c) => c.id === (bash.commit as Value).head));
    await call(
      "bash",
      { command: "printf changed > nonzero.txt; exit 7" },
      true,
    );
    assert.equal((await call("read", { path: "nonzero.txt" })).text, "changed");
    const reserved = await call("bash", { command: "exit 124" }, true);
    assert.equal((reserved.command as Value).exitCode, 124);
    assert.equal((reserved.command as Value).timedOut, false);
    const countBeforeNoop = (
      (await call("layerfs_commits", {})).items as Value[]
    ).length;
    const noop = await call("bash", { command: "true" });
    assert.equal((noop.commit as Value).kind, "UpToDate");
    assert.equal(
      ((await call("layerfs_commits", {})).items as Value[]).length,
      countBeforeNoop,
    );
    const countBeforeTimeout = (
      (await call("layerfs_commits", {})).items as Value[]
    ).length;
    await call(
      "bash",
      { command: "printf transient > timeout.txt; sleep 3", timeout: 1 },
      true,
    );
    assert.equal(
      ((await call("layerfs_commits", {})).items as Value[]).length,
      countBeforeTimeout,
    );
    await call("read", { path: "timeout.txt" }, true);
    const controller = new AbortController();
    const cancellation = call(
      "bash",
      { command: "printf transient > cancel.txt; sleep 1" },
      true,
      controller.signal,
    );
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await cancellation;
    } finally {
      clearTimeout(timer);
    }
    await call("read", { path: "cancel.txt" }, true);
    const gate = await runner.emitToolCall({
      type: "tool_call",
      toolName: "replace",
      toolCallId: "blocked",
      input: {},
    });
    assert.equal(gate?.block, true);
    receipt("pi.hashline-block", gate);
    for (const path of ["temporary.txt", "command.txt", "nonzero.txt"])
      await call("layerfs_remove", { path });
  }
  const final = await call("layerfs_status", {});
  assert.deepEqual(final.mounted, []);
  const inspector = await createRuntime(root, await loadConfig(root));
  await inspector.initialize();
  try {
    const branches = await inspector.sdk.project.list_branches();
    receipt("sdk.branches", branches);
    const main = required(branches.items.find((b) => b.name === "main"));
    assert.equal(main.head, null);
    assert.equal(main.base, (final.initial as Value).layer);
    assert.equal(
      (await inspector.sdk.fs.read("main", "/seed.txt")).text,
      "initial\n",
    );
    const state = await snapshot(inspector);
    receipt("snapshot", state);
    assert.equal(
      (state.layers as Value[]).length,
      1,
      "only the genesis Layer exists",
    );
    assert.ok(
      (state.sandboxes as Value[]).every(
        (s) => (s.workspaces as Value[]).length === 0,
      ),
      "daemon confirms no mounted Workspace",
    );
  } finally {
    await inspector.shutdown();
  }
} finally {
  await runner.emit({ type: "session_shutdown", reason: "quit" });
  assert.deepEqual(lifecycleErrors, []);
  session.dispose();
}
if (!reopen) {
  const bindingBefore = await readFile(
    join(required(process.env.LAYERFS_HOME), "pi-bindings/pi-smoke.json"),
    "utf8",
  );
  await new Promise<void>((resolveChild, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve(plugin, "scripts/smoke.ts"), "--reopen"],
      { stdio: "inherit", env: process.env },
    );
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolveChild()
        : reject(new Error(`Pi reopen subprocess exited ${code}`)),
    );
  });
  assert.equal(
    await readFile(
      join(required(process.env.LAYERFS_HOME), "pi-bindings/pi-smoke.json"),
      "utf8",
    ),
    bindingBefore,
  );
}
receipt("complete", { reopen, passed: true });
