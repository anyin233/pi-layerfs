import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  wrapRegisteredTools,
} from "@earendil-works/pi-coding-agent";
import { bundledSDK } from "../dist/config.js";
import extension from "../dist/extension.js";
import { Operations } from "../dist/operations.js";
import { createRuntime } from "../dist/runtime.js";

const suffix = randomUUID().slice(0, 8);
const root = `/layerfs-store/self-test-source/${suffix}`;
await mkdir(`${root}/tests`, { recursive: true });
await writeFile(
  `${root}/math.mjs`,
  "export const square = value => value * value;\n",
);
const config = {
  sdk: bundledSDK,
  project: `self-test-${suffix}`,
  branch: "pi-work",
  initialize: true,
  failWhenUnavailable: true,
  timeoutSeconds: 30,
  logLevel: "silent",
};
const models = await ModelRuntime.create({
  modelsPath: null,
  refreshOnCreate: false,
  allowModelNetwork: false,
  credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async () => undefined,
    delete: async () => undefined,
  },
});
const settings = SettingsManager.inMemory({
  defaultProjectTrust: "always",
  retry: { enabled: false },
});
async function sessionFor(runtime) {
  const errors = [];
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: "/layerfs-store/self-test-agent",
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
    extensionFactories: [
      (pi) =>
        extension(pi, { runtime, worker: runtime.options.role === "worker" }),
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: "/layerfs-store/self-test-agent",
    resourceLoader: loader,
    modelRuntime: models,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(root),
  });
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  const runner = session.extensionRunner;
  const tools = wrapRegisteredTools(runner.getAllRegisteredTools(), runner);
  return {
    async call(name, args) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, name);
      const id = `release-${randomUUID()}`;
      const gate = await runner.emitToolCall({
        type: "tool_call",
        toolName: name,
        toolCallId: id,
        input: args,
      });
      assert.ok(!gate?.block);
      const result = await tool.execute(id, args);
      assert.ok(!result.isError, JSON.stringify(result));
      assert.deepEqual(errors, []);
      return result.details;
    },
    async close() {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      assert.deepEqual(errors, []);
    },
  };
}
const lead = await createRuntime(root, config);
await lead.initialize();
const ops = new Operations(lead);
await ops.ready();
const workers = [];
let parent;
const started = Date.now();
try {
  parent = await sessionFor(lead);
  for (let i = 0; i < 4; i++) {
    const branch = `developer-${i}`;
    await ops.branch("fork", { name: branch });
    const runtime = await createRuntime(
      root,
      { ...config, branch, initialize: false },
      { role: "worker", label: branch },
    );
    // Current binding admission is exclusive; commands still run concurrently.
    await runtime.initialize();
    workers.push({ branch, pi: await sessionFor(runtime) });
  }
  const commands = await Promise.all(
    workers.map(async (worker, i) => {
      await worker.pi.call("read", { path: "math.mjs" });
      await worker.pi.call("write", {
        path: `tests/square_${i}.test.mjs`,
        content: `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { square } from '../math.mjs';\ntest('square ${i}', () => { assert.equal(square(${i + 2}), ${(i + 2) ** 2}); assert.equal(square(-${i + 2}), ${(i + 2) ** 2}); });\n`,
      });
      const result = await worker.pi.call("bash", {
        command: `node --test tests/square_${i}.test.mjs`,
      });
      assert.equal(result.command.exitCode, 0);
      return {
        branch: worker.branch,
        commit: result.commit,
        stdout: result.command.stdout,
      };
    }),
  );
  await assert.rejects(access(`${root}/tests/square_0.test.mjs`), {
    code: "ENOENT",
  });
  await assert.rejects(
    lead.sdk.fs.read(workers[0].branch, "/tests/square_1.test.mjs"),
  );
  let from = "pi-work";
  for (let i = 0; i < workers.length; i++) {
    const name = `integrated-${i}`;
    await parent.call("layerfs_branch", {
      action: "merge",
      args: { from, with: workers[i].branch, name },
    });
    from = name;
  }
  await parent.call("layerfs_branch", {
    action: "switch",
    args: { name: from },
  });
  const workspace = await parent.call("layerfs_workspace", {
    action: "mount",
    args: {},
  });
  const integration = await parent.call("layerfs_workspace", {
    action: "exec",
    args: { id: workspace.id, command: "node --test tests/*.test.mjs" },
  });
  await parent.call("layerfs_workspace", {
    action: "commit",
    args: { id: workspace.id },
  });
  await parent.call("layerfs_workspace", {
    action: "unmount",
    args: { id: workspace.id },
  });
  await parent.call("layerfs_branch", {
    action: "publish",
    args: { branch: from },
  });
  const stored = await ops.filesystem("read", {
    ref: "main",
    path: "tests/square_3.test.mjs",
  });
  assert.match(stored.text, /square 3/);
  const storage = await parent.call("layerfs_inspect", {
    action: "storage",
    args: {},
  });
  for (const worker of workers) await worker.pi.close();
  workers.length = 0;
  await parent.close();
  parent = undefined;
  const reopened = await createRuntime(root, {
    ...config,
    branch: from,
    initialize: false,
  });
  try {
    await reopened.initialize();
    assert.equal((await reopened.status()).ready, true);
  } finally {
    await reopened.shutdown();
  }
  const receipt = {
    ok: true,
    version: (await readFile("/opt/pi-layerfs/VERSION", "utf8")).trim(),
    project: config.project,
    branch: from,
    workers: commands,
    integration: integration.stdout,
    storage,
    isolatedHostSource: true,
    isolatedBranches: true,
    reopened: true,
    sdk: bundledSDK,
    image: process.env.LAYERFS_IMAGE,
    seconds: (Date.now() - started) / 1000,
  };
  const directory = "/layerfs-store/release-verification";
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    `${directory}/${suffix}.json`,
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  for (const worker of workers) await worker.pi.close();
  if (parent) await parent.close();
  await lead.shutdown();
}
