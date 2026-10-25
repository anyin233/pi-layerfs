import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  wrapRegisteredTools,
} from "@earendil-works/pi-coding-agent";
import extension from "../dist/extension.js";
import { createRuntime } from "../dist/runtime.js";

const directory = "/tmp/pi-layerfs-kernelagentir-HSOK3zhe";
let bridge;
try {
  bridge = JSON.parse(await readFile(`${directory}/bridge.json`, "utf8"));
} catch (cause) {
  throw new Error("Cannot load private model bridge configuration", { cause });
}
const { port, token } = bridge;
const source = "/layerfs-store/benchmark/source/source-only";
const runtime = await createRuntime(source, {
  sdk: `${process.env.PI_LAYERFS_UPSTREAM}/api/agent/sdk/src/index.js`,
  project: "bench-source-hsok3zhe",
  branch: "pi-work",
  initialize: false,
  failWhenUnavailable: true,
  timeoutSeconds: 120,
  logLevel: "silent",
});
const settings = SettingsManager.inMemory({
  defaultProjectTrust: "always",
  retry: { enabled: false },
});
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
models.registerProvider("real-development", {
  api: "openai-completions",
  baseUrl: `http://127.0.0.1:${port}`,
  apiKey: "host-bridge",
  models: [
    {
      id: "deepseek-v4.1-flash",
      name: "Host configured DeepSeek v4.1 Flash",
      api: "openai-completions",
      reasoning: true,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ],
  streamSimple: (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    (async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/stream`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ context }),
          signal: options?.signal,
        });
        if (!response.ok || !response.body)
          throw Error(`Bridge response ${response.status}`);
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          while (buffer.includes("\n")) {
            const newline = buffer.indexOf("\n");
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line) stream.push(JSON.parse(line));
          }
        }
        stream.end();
      } catch (error) {
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            api: "openai-completions",
            provider: "real-development",
            model: "deepseek-v4.1-flash",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "error",
            errorMessage: String(error),
            timestamp: Date.now(),
          },
        });
        stream.end();
      }
    })();
    return stream;
  },
});
const loader = new DefaultResourceLoader({
  cwd: source,
  agentDir: "/layerfs-store/real-development",
  settingsManager: settings,
  noExtensions: true,
  noSkills: true,
  noThemes: true,
  noPromptTemplates: true,
  noContextFiles: true,
  extensionFactories: [(pi) => extension(pi, { runtime })],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({
  cwd: source,
  model: models.getModel("real-development", "deepseek-v4.1-flash"),
  agentDir: "/layerfs-store/real-development",
  modelRuntime: models,
  settingsManager: settings,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(source),
});
await session.bindExtensions({ mode: "print" });
const runner = session.extensionRunner;
const tools = wrapRegisteredTools(runner.getAllRegisteredTools(), runner);
async function call(name, args) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool);
  const result = await tool.execute(`real-${name}`, args);
  assert.ok(!result.isError, JSON.stringify(result));
  return result.details;
}
const jobs = [
  "PEAddr retains its mapping and hash after the caller mutates the original dict and the exported as_dict() result. Read core.py lines 220-310 and tests/test_pe_addr.py for API conventions.",
  "BankRegion.overlaps handles adjacent half-open extents and a strict containment case symmetrically. Read core.py lines 1020-1075 for API conventions.",
  "All three subbyte dtypes (int4, fp4_e2m1, fp4_e3m0) pack 32 elements in 16 bytes, and enum values round-trip. Read core.py lines 30-100 for API conventions.",
  "Region.join and meet preserve two distinct adjacent BankRegion extents. Read tests/test_region_lattice.py and tests/test_region_order.py for constructor conventions.",
];
const start = Date.now();
try {
  for (let i = 0; i < jobs.length; i++) {
    const result = await call("layerfs_agent", {
      action: "spawn",
      args: {
        label: `Real developer ${i}`,
        task: `Add one meaningful regression test for this behavior: ${jobs[i]} Work in your own Branch, create ONLY tests/test_real_parallel_${i}.py; do not edit existing files. Read only the relevant small source ranges. Run your test using bash with this exact command prefix: PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:/opt/bench-deps PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 /home/yanweiye/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu/bin/python3.12 -m pytest -o cache_dir=/tmp/real-pytest-${i} tests/test_real_parallel_${i}.py . Do not append a separate dot argument; run only that file. Use the plugin write tool to create the file. One passing test is enough. LayerFS writes already create commits; no git commands needed. Report the test result and final LayerFS Commit. Do not read unrelated files or use inspect storage. Finish in at most 8 tool calls.`,
      },
    });
    console.log(JSON.stringify({ spawned: result }));
  }
  let workers;
  for (let attempt = 0; attempt < 900; attempt++) {
    workers = await call("layerfs_agent", { action: "list" });
    if (workers.every((w) => w.state !== "running" && w.state !== "cancelling"))
      break;
    await pause(200);
  }
  console.log(
    JSON.stringify({ workers, seconds: (Date.now() - start) / 1000 }),
  );
  assert.equal(workers.length, 4);
  for (const worker of workers)
    assert.equal(worker.state, "completed", JSON.stringify(worker));
  let from = "pi-work";
  for (let i = 0; i < workers.length; i++) {
    const name = `real-development-merged-${i}`;
    await call("layerfs_branch", {
      action: "merge",
      args: { from, with: workers[i].branch, name },
    });
    from = name;
  }
  await call("layerfs_branch", { action: "switch", args: { name: from } });
  const validation = await call("bash", {
    command:
      "PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:/opt/bench-deps PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 /home/yanweiye/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu/bin/python3.12 -m pytest -o cache_dir=/tmp/real-integrated tests/test_real_parallel_*.py",
  });
  const receipt = {
    model: "magpie/auto/deepseek-v4.1-flash",
    workers,
    validation,
    seconds: (Date.now() - start) / 1000,
    branch: from,
    note: "Actual LLM acceptance, excluded from deterministic performance measurements",
  };
  await writeFile(
    "/layerfs-store/benchmark/source/real-development.json",
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify({ success: receipt }));
} finally {
  await runner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
