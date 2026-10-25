import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createAgentSession,
  createBashTool,
  createReadTool,
  createWriteTool,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  wrapRegisteredTools,
} from "@earendil-works/pi-coding-agent";
import { docker } from "../src/docker.js";
import extension from "../src/extension.js";
import { Operations } from "../src/operations.js";
import {
  createRuntime,
  quote,
  type Runtime,
  type Value,
} from "../src/runtime.js";

const python =
  "/home/yanweiye/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu/bin/python3.12";

// Deterministic development replay: real Pi sessions/tools, Git, FUSE, tests,
// commits and merges. No synthetic large files, model requests or GPU work.
const input = process.argv[2];
assert.ok(input, "Pass a disposable source-copy directory, mounted read-only");
process.env.GIT_CONFIG_COUNT = "2";
process.env.GIT_CONFIG_KEY_0 = "safe.directory";
process.env.GIT_CONFIG_VALUE_0 = input;
process.env.GIT_CONFIG_KEY_1 = "safe.directory";
process.env.GIT_CONFIG_VALUE_1 = `${input}/.git`;
const full = process.argv.includes("--full");
const hardlinkOnly = process.argv.includes("--hardlink-only");
const root = `/layerfs-store/benchmark/${hardlinkOnly ? "full-hardlink-v2" : full ? "full" : "source"}`;
await mkdir(root, { recursive: true });
await mkdir("/layerfs-store/home", { recursive: true, mode: 0o700 });
const sdk = `${process.env.PI_LAYERFS_UPSTREAM}/api/agent/sdk/src/index.js`;
const receipts: unknown[] = [];
const log = (step: string, value: unknown) => {
  const entry = { step, time: new Date().toISOString(), value };
  receipts.push(entry);
  console.log(JSON.stringify(entry));
};
async function command(cmd: string, cwd = root) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn("bash", ["-lc", cmd], { cwd });
    let stdout = "",
      stderr = "";
    p.stdout.on("data", (b) => {
      stdout += b;
    });
    p.stderr.on("data", (b) => {
      stderr += b;
    });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(Error(`${cmd}: ${code}\n${stdout}\n${stderr}`)),
    );
  });
}
async function timed<T>(fn: () => Promise<T>) {
  const start = performance.now();
  const result = await fn();
  return { seconds: (performance.now() - start) / 1000, result };
}
async function du(path: string) {
  return Number((await command(`du -s -B1 -- ${quote(path)}`)).split(/\s/)[0]);
}
async function storage() {
  const paths = (await readdir("/layerfs-store")).filter(
    (n) => n !== "benchmark" && n !== "pi-agent",
  );
  const entries = await Promise.all(
    paths.map(async (n) => [n, await du(`/layerfs-store/${n}`)]),
  );
  const filter = encodeURIComponent(
    JSON.stringify({ name: [process.env.LAYERFS_CONTAINER_PREFIX] }),
  );
  const containers = await docker(`/containers/json?all=1&filters=${filter}`);
  assert.ok(
    Array.isArray(containers),
    "Docker containers endpoint returns an array",
  );
  let dockerWritable = 0;
  for (const item of containers) {
    const inspect = await docker(`/containers/${item.Id}/json?size=true`);
    dockerWritable += Number(inspect.SizeRw ?? 0);
  }
  return {
    entries,
    volumeBytes: entries.reduce((n, p) => n + Number(p[1]), 0),
    dockerWritable,
  };
}
const specs = [
  {
    suite: "tests/test_pe_addr.py",
    source: "kernel_agent_ir/core.py",
    content: `from kernel_agent_ir import Index, PEAddr\n\ndef test_constructor_detaches_input_and_exported_mapping():\n    source = {"host": Index(1)}\n    address = PEAddr.of(source)\n    saved_hash = hash(address)\n    source["host"] = Index(9)\n    exported = address.as_dict()\n    exported.clear()\n    assert address["host"] == Index(1)\n    assert hash(address) == saved_hash\n`,
  },
  {
    suite: "tests/test_region_lattice.py",
    source: "kernel_agent_ir/core.py",
    content: `from kernel_agent_ir import BankRegion, Index, PEAddr, Region\n\ndef test_join_preserves_both_memory_extents():\n    pe = PEAddr.of({"host": Index(0)})\n    def region(extent):\n        return Region(pes=frozenset({pe}), comp_slots={}, elements={}, memory={(pe, "smem"): frozenset({extent})})\n    a, b = BankRegion(0, 16), BankRegion(16, 16)\n    left, right = region(a), region(b)\n    joined = left | right\n    assert joined.memory[(pe, "smem")] == frozenset({a, b})\n    assert joined & left == left\n    assert joined & right == right\n`,
  },
  {
    suite: "tests/test_region_order.py",
    source: "kernel_agent_ir/core.py",
    content: `from kernel_agent_ir import BankRegion\n\ndef test_half_open_adjacent_and_contained_extents():\n    first, adjacent, inside = BankRegion(0, 16), BankRegion(16, 16), BankRegion(4, 8)\n    assert not first.overlaps(adjacent)\n    assert not adjacent.overlaps(first)\n    assert first.overlaps(inside) and inside.overlaps(first)\n    assert first.end == adjacent.offset_bytes\n`,
  },
  {
    suite: "tests/test_congestion.py",
    source: "kernel_agent_ir/core.py",
    content: `from kernel_agent_ir import Dtype\n\ndef test_subbyte_dtypes_preserve_packed_storage_size():\n    for dtype in (Dtype.int4, Dtype.fp4_e2m1, Dtype.fp4_e3m0):\n        assert dtype.size_bytes * 32 == 16\n        assert Dtype(dtype.value) is dtype\n    assert Dtype.fp8_e8m0.size_bytes == 1\n    assert Dtype.bf16.size_bytes == 2\n`,
  },
];
const settings = SettingsManager.inMemory({
  defaultProjectTrust: "always",
  retry: { enabled: false },
});
const models = await ModelRuntime.create({
  refreshOnCreate: false,
  modelsPath: null,
  allowModelNetwork: false,
  credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async () => undefined,
    delete: async () => undefined,
  },
});
async function piSession(cwd: string, runtime?: Runtime) {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: `${root}/agent`,
    settingsManager: settings,
    noExtensions: true,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: runtime
      ? [(pi) => extension(pi, { runtime, worker: true })]
      : [],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd,
    agentDir: `${root}/agent`,
    settingsManager: settings,
    resourceLoader: loader,
    modelRuntime: models,
    sessionManager: SessionManager.inMemory(cwd),
  });
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (e) => errors.push(e) });
  const runner = session.extensionRunner;
  const tools = runtime
    ? wrapRegisteredTools(runner.getAllRegisteredTools(), runner)
    : [createReadTool(cwd), createWriteTool(cwd), createBashTool(cwd)];
  async function call(name: string, args: Value) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, name);
    const gate = await runner.emitToolCall({
      type: "tool_call",
      toolName: name,
      toolCallId: `bench-${name}`,
      input: args,
    });
    assert.ok(!gate?.block, JSON.stringify(gate));
    const result = await tool.execute(`bench-${name}`, args, undefined);
    assert.ok(!result.isError, JSON.stringify(result));
    assert.deepEqual(errors, []);
    return result;
  }
  return {
    call,
    session,
    close: async () => {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      assert.deepEqual(errors, []);
    },
  };
}
const seed = `${root}/git-main`;
const sourceSeed = `${root}/source-only`;
await command(
  `git config --global --add safe.directory ${quote(`${input}/.git`)}`,
);
await command(`git clone --no-local ${quote(input)} ${quote(seed)}`);
await command(`git -C ${quote(seed)} config user.email bench@localhost`);
await command(`git -C ${quote(seed)} config user.name 'Pi LayerFS Benchmark'`);
await command(`git clone --no-local ${quote(seed)} ${quote(sourceSeed)}`);
log("environment", {
  input,
  node: process.version,
  python: await command(`${python} --version`),
  revision: await command(`git -C ${quote(seed)} rev-parse HEAD`),
  workers: 4,
  gitMainBytes: await du(seed),
  sourceAllocatedBytes: await du(input),
  method:
    "warm page cache, 3 measured rounds, alternating backend order; identical scripted Pi tool calls; no model inference",
});
const source = full ? input : sourceSeed;
const prefix = full ? "full" : "source";
const config = {
  sdk,
  project: `bench-${prefix}-hsok3zhe`,
  branch: "pi-work",
  initialize: true,
  failWhenUnavailable: true,
  timeoutSeconds: 180,
  logLevel: "silent" as const,
};
const beforeImport = await storage();
const init = await timed(async () => {
  const runtime = await createRuntime(source, config);
  await runtime.initialize();
  return runtime;
});
const lead = init.result;
const operations = new Operations(lead);
await operations.ready();
// The plugin's conservative PEM preflight refuses the public certifi CA bundle.
// It is moved out of the disposable import tree and restored on the writable
// baseline Branch through the plugin, before any worker is forked.
if (full && !hardlinkOnly) {
  const cert = await readFile(`${input}/../public-ca.crt`, "utf8");
  await operations.filesystem("write", {
    path: ".venv/lib/python3.12/site-packages/certifi/cacert.pem",
    content: cert,
  });
  const stubs =
    ".venv/lib/python3.12/site-packages/pyright/dist/dist/typeshed-fallback/stubs/docker/docker/";
  await operations.filesystem("mv", {
    from: `${stubs}credentials-stubs`,
    to: `${stubs}credentials`,
  });
}
const afterImport = await storage();
log("layerfs.import", {
  seconds: init.seconds,
  beforeImport,
  afterImport,
  deltaBytes: afterImport.volumeBytes - beforeImport.volumeBytes,
  native: await operations.inspect("storage"),
});
if (hardlinkOnly) {
  const prepared = await timed(() =>
    command(
      `cp -a --reflink=never ${quote(`${input}/.venv`)} ${quote(`${root}/shared-venv`)}`,
    ),
  );
  log("git.shared-environment", {
    seconds: prepared.seconds,
    bytes: await du(`${root}/shared-venv`),
  });
}
const results: Value[] = [];
async function run(backend: string, round: number) {
  const count = 4;
  const runId = `${prefix}-${backend}-${round}`;
  const startStorage = await storage();
  const gitBefore = await du(seed);
  const holders: {
    path: string;
    branch: string;
    pi?: Awaited<ReturnType<typeof piSession>>;
    runtime?: Runtime;
  }[] = [];
  const setup = await timed(async () => {
    for (let i = 0; i < count; i++) {
      const branch = `${runId}-${i}`;
      const path = `${root}/${branch}`;
      if (backend.startsWith("git")) {
        await command(
          `git -C ${quote(seed)} worktree add -b ${quote(branch)} ${quote(path)} HEAD`,
        );
      } else {
        await operations.branch("fork", { name: branch });
      }
      holders.push({ path, branch });
    }
    // Real worktrees need their own ignored environment; use physical copies,
    // not hardlinks or reflinks. A shared-environment baseline is a separate lane.
    if (backend.startsWith("git") && full) {
      await Promise.all(
        holders.map((h) =>
          command(
            `cp ${backend === "git-hardlink" ? "-al" : "-a --reflink=never"} ${quote(backend === "git-hardlink" ? `${root}/shared-venv` : `${input}/.venv`)} ${quote(`${h.path}/.venv`)}`,
          ),
        ),
      );
      await Promise.all(
        holders.map((h) =>
          command(
            `cp ${quote(`${input}/../public-ca.crt`)} ${quote(`${h.path}/.venv/lib/python3.12/site-packages/certifi/cacert.pem`)}`,
          ),
        ),
      );
      await Promise.all(
        holders.map((h) =>
          command(
            `mv ${quote(`${h.path}/.venv/lib/python3.12/site-packages/pyright/dist/dist/typeshed-fallback/stubs/docker/docker/credentials-stubs`)} ${quote(`${h.path}/.venv/lib/python3.12/site-packages/pyright/dist/dist/typeshed-fallback/stubs/docker/docker/credentials`)}`,
          ),
        ),
      );
    }
  });
  const sessions = await timed(async () => {
    // Current plugin refuses concurrent binding admission. Initialize workers
    // sequentially (the actual development commands below remain parallel).
    for (const h of holders) {
      if (!backend.startsWith("git")) {
        h.runtime = await createRuntime(
          source,
          { ...config, branch: h.branch, initialize: false },
          { role: "worker", label: h.branch },
        );
        await h.runtime.initialize();
      }
      h.pi = await piSession(
        backend.startsWith("git") ? h.path : source,
        h.runtime,
      );
    }
  });
  const prepDisk = await storage();
  const work = await timed(async () =>
    Promise.all(
      holders.map(async (h, i) => {
        assert.ok(h.pi);
        const pi = h.pi;
        const spec = specs[i];
        const file = `tests/test_parallel_regression_${i}.py`;
        const read = await pi.call("read", { path: spec.source, limit: 80 });
        assert.ok(read.content.length);
        await pi.call("write", { path: file, content: spec.content });
        const env = full ? ".venv/bin/python" : python;
        const test = `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=${full ? "." : ".:/opt/bench-deps"} PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 HYPOTHESIS_STORAGE_DIRECTORY=/tmp/hypothesis-${runId}-${i} ${env} -m pytest -o cache_dir=/tmp/pytest-${runId}-${i} ${spec.suite} ${file}`;
        let output: unknown;
        if (backend === "layerfs-retained") {
          const mount = await pi.call("layerfs_workspace", {
            action: "mount",
            args: {},
          });
          const id = (mount.details as Value).id;
          output = await pi.call("layerfs_workspace", {
            action: "exec",
            args: { id, command: test },
          });
          await pi.call("layerfs_workspace", {
            action: "commit",
            args: { id, message: "Regression tests passed" },
          });
          await pi.call("layerfs_workspace", {
            action: "unmount",
            args: { id },
          });
        } else {
          output = await pi.call("bash", { command: test, timeout: 180 });
        }
        if (backend.startsWith("git")) {
          await command(`git add -- ${quote(file)}`, h.path);
          await command(
            `git -c user.name=Benchmark -c user.email=bench@localhost commit -m 'test: add parallel regression coverage'`,
            h.path,
          );
        }
        log("worker.passed", { runId, worker: i, branch: h.branch, output });
        return { file, content: spec.content };
      }),
    ),
  );
  const afterWork = await storage();
  const worktreeBytes = backend.startsWith("git")
    ? (
        await command(
          `du -s -B1 -- ${[...(backend === "git-hardlink" ? [`${root}/shared-venv`] : []), ...holders.map((h) => h.path)].map(quote).join(" ")}`,
        )
      )
        .split("\n")
        .reduce((total, row) => total + Number(row.split(/\s/)[0]), 0)
    : null;
  const gitMetadataDelta = backend.startsWith("git")
    ? (await du(seed)) - gitBefore
    : null;
  const merge = await timed(async () => {
    let current = "pi-work";
    if (backend.startsWith("git")) {
      await command(
        `git checkout -b ${quote(`${runId}-integrated`)} HEAD`,
        seed,
      );
      for (const h of holders)
        await command(`git merge --no-edit ${quote(h.branch)}`, seed);
    } else {
      for (let i = 0; i < holders.length; i++) {
        const merged = `${runId}-merge-${i}`;
        await operations.branch("merge", {
          from: current,
          with: holders[i].branch,
          name: merged,
        });
        current = merged;
      }
    }
    for (const spec of work.result) {
      const actual = backend.startsWith("git")
        ? await readFile(join(seed, spec.file), "utf8")
        : (
            (await operations.filesystem("read", {
              ref: current,
              path: spec.file,
            })) as Value
          ).text;
      assert.equal(actual, spec.content);
    }
    if (backend.startsWith("git")) {
      // Return to the immutable original base before the next measured round.
      await command(
        `git checkout --detach ${quote(await command(`git -C ${quote(sourceSeed)} rev-parse HEAD`))}`,
        seed,
      );
    }
  });
  const endStorage = await storage();
  const result = {
    lane: prefix,
    backend,
    round,
    workers: count,
    setupSeconds: setup.seconds,
    sessionSeconds: sessions.seconds,
    workSeconds: work.seconds,
    mergeSeconds: merge.seconds,
    totalSeconds:
      setup.seconds + sessions.seconds + work.seconds + merge.seconds,
    worktreeBytes,
    gitMetadataDelta,
    layerfsSteadyDeltaBytes: backend.startsWith("git")
      ? null
      : endStorage.volumeBytes - startStorage.volumeBytes,
    layerfsImportBytes: afterImport.volumeBytes - beforeImport.volumeBytes,
    prepDisk,
    afterWork,
    endStorage,
  };
  results.push(result);
  log("round", result);
  for (const h of holders) {
    assert.ok(h.pi);
    await h.pi.close();
  }
  if (backend.startsWith("git")) {
    for (const h of holders)
      await command(
        `git -C ${quote(seed)} worktree remove --force ${quote(h.path)}`,
      );
  }
  await writeFile(
    `${root}/results-${prefix}.json`,
    JSON.stringify(
      { init: { seconds: init.seconds, beforeImport, afterImport }, results },
      null,
      2,
    ),
  );
}
try {
  for (let round = 0; round < 3; round++) {
    const backends = hardlinkOnly
      ? ["git-hardlink"]
      : round % 2 === 0
        ? ["git", "layerfs-bash", "layerfs-retained"]
        : ["layerfs-retained", "layerfs-bash", "git"];
    for (const backend of backends) await run(backend, round);
  }
  log("complete", { results, storage: await operations.inspect("storage") });
} finally {
  await lead.shutdown();
  await writeFile(
    `${root}/receipts-${prefix}.json`,
    JSON.stringify(receipts, null, 2),
  );
}
