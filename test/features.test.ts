import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import type { Config } from "../src/config.js";
import { required } from "../src/config.js";
import { Control } from "../src/control.js";
import { Dashboard } from "../src/dashboard.js";
import { dashboardPage } from "../src/dashboard-page.js";
import { compareSaved, traceFiles, tracePage } from "../src/history.js";
import { scanSource } from "../src/import-progress.js";
import { Operations } from "../src/operations.js";
import {
  type Backend,
  type Connect,
  invoke,
  loadClient,
  type RuntimeOptions,
  withDeployment,
} from "../src/ports.js";
import { Runtime, type SDK, type Value } from "../src/runtime.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-lfs-features-")),
    root = join(dir, "source"),
    home = join(dir, "home");
  await mkdir(root);
  await mkdir(home);
  const config: Config = {
    sdk: "unused",
    project: "test",
    branch: "pi-work",
    initialize: true,
    failWhenUnavailable: true,
    timeoutSeconds: 2,
    logLevel: "silent",
  };
  const calls: { method: string; args: unknown[] }[] = [];
  const branches: Value[] = [{ name: "main", base: "L0", head: null }];
  const layers: Value[] = [{ id: "L0", parent: null }];
  let commitError: Error | undefined;
  const record =
    (method: string, value: Value = {}) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return value;
    };
  const image = `sha256:${"a".repeat(64)}`;
  const sdk: SDK = {
    project: {
      list_branches: async () => ({ items: branches, hasMore: false }),
      list_sandboxes: async () => ({ items: [], hasMore: false }),
    },
    branch: {
      fork: async (name, from) => {
        calls.push({ method: "fork", args: [name, from] });
        branches.push({ name, base: "L0", head: null });
        return { branch: name };
      },
      list_commits: async () => ({ items: [], hasMore: false }),
    },
    fs: {
      read: record("read", { text: "ok" }),
      write: record("write"),
      edit: record("edit"),
      apply: record("apply"),
      list: async () => ({ items: [], hasMore: false }),
      glob: async () => ({ items: [], hasMore: false }),
      grep: async () => ({ items: [], hasMore: false }),
    },
    sandbox: {
      create: async () => {
        calls.push({ method: "sandbox.create", args: [] });
        return { sandbox: "1", image };
      },
      list_workspaces: async () => ({ items: [], hasMore: false, version: 1 }),
    },
    workspace: {
      mount: async (sandbox, branch) => {
        calls.push({ method: "mount", args: [sandbox, branch] });
        return { sandbox, path: "/workspaces/1" };
      },
      exec: async (_ws, command, _message, sinks) => {
        const marker = command.match(/__PI_LAYERFS_EXIT_[a-f0-9-]+__/)?.[0];
        assert.ok(marker);
        sinks?.stdout?.write(Buffer.alloc(100000, 120));
        sinks?.stderr?.write(Buffer.from(`err\n${marker}:124\n`));
        return {
          exitCode: 0,
          stdout: null,
          stderr: null,
          stdoutBytes: 100000,
          stderrBytes: Buffer.byteLength(`err\n${marker}:124\n`),
        };
      },
      commit: async () => {
        if (commitError) throw commitError;
        return { kind: "Committed", head: "C1" };
      },
      unmount: record("unmount"),
    },
    close: async () => {
      calls.push({ method: "close", args: [] });
    },
  };
  Object.assign(sdk.branch, {
    merge: record("merge", { branch: "joined", head: "C2" }),
    publish: record("publish", { kind: "Published" }),
    diff_branches: record("diff_branches"),
    diff_commits: record("diff_commits"),
  });
  Object.assign(sdk.fs, {
    stat: record("stat", { size: 10 }),
    blame: record("blame"),
    mkdir: record("mkdir"),
    cp: record("cp"),
    mv: record("mv"),
    rm: record("rm"),
    diff_files: record("diff_files"),
  });
  const backend: Backend = {
    store: {
      project: {
        get_history: async () => ({ layers, branches, commits: [] }),
        get_storage: record("storage", { logical: 100 }),
        list_overwritten: record("overwritten"),
      },
    },
    daemon: {
      process: {
        start: record("start", { process: "proc_1_owned" }),
        list: record("process.list"),
        cancel: record("cancel"),
      },
      workspace: {
        status: record("status"),
        get_storage: record("overlay"),
        list_changes: record("changes"),
      },
    },
  };
  const connect: Connect = async (folder) => {
    if (folder !== undefined) {
      await mkdir(join(home, "test"));
      sdk.created = { kind: "Initialized", layer: "L0" };
    }
    return sdk;
  };
  const options = {
    agent: randomUUID(),
    label: "lead",
    settle: 0,
    deployment: {
      HOME: home,
      STORE_PATH: join(dir, "store/global/store.sqlite"),
      VOLUME: "unit-volume",
      IMAGE: image,
    },
    backend,
    progress: record("progress"),
  };
  const runtime = new Runtime(
    root,
    config,
    connect,
    async () => ({ environment: {}, filesystem: "ext4" }),
    options,
  );
  await runtime.initialize();
  const ops = new Operations(runtime);
  await ops.ready();
  return {
    dir,
    root,
    home,
    config,
    sdk,
    connect,
    backend,
    runtime,
    ops,
    calls,
    branches,
    layers,
    setCommitError(e: Error) {
      commitError = e;
    },
    async close() {
      await runtime.shutdown();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("merge/publish dispatch exact SDK contracts and workers cannot publish", async () => {
  const f = await fixture();
  try {
    await f.ops.branch("merge", {
      from: "a",
      with: "b",
      name: "joined",
      message: "join",
      units: ["src/**"],
    });
    assert.deepEqual(f.calls.at(-1), {
      method: "merge",
      args: ["a", "b", "joined", "join", ["src/**"]],
    });
    f.runtime.options.role = "worker";
    await assert.rejects(f.ops.branch("publish", {}), /Only the lead/);
    assert.ok(!f.calls.some((c) => c.method === "publish"));
    await assert.rejects(
      f.ops.branch("merge", { with: "b", name: "main" }),
      /non-main/,
    );
  } finally {
    await f.close();
  }
});
test("published main and later-layer Branches reopen with the original genesis", async () => {
  const f = await fixture();
  try {
    f.layers.push({ id: "L1", parent: "L0" });
    f.branches[0].base = "L1";
    f.branches[1].base = "L1";
    const second = new Runtime(
      f.root,
      { ...f.config },
      f.connect,
      async () => ({ environment: {}, filesystem: "ext4" }),
      f.runtime.options,
    );
    await second.initialize();
    assert.equal(second.initial, "L0");
    f.layers.shift();
    const third = new Runtime(
      f.root,
      { ...f.config },
      f.connect,
      async () => ({ environment: {}, filesystem: "ext4" }),
      f.runtime.options,
    );
    await assert.rejects(third.initialize(), /genesis/);
  } finally {
    await f.close();
  }
});
test("historical file reads are immutable and nested apply paths cannot escape", async () => {
  const f = await fixture();
  try {
    await f.ops.filesystem("read", {
      ref: "saved-commit",
      path: "a",
      line: 2,
      limit: 3,
    });
    assert.deepEqual(f.calls.at(-1), {
      method: "read",
      args: ["saved-commit", "/a", 2, 4],
    });
    await assert.rejects(
      f.ops.filesystem("apply", {
        changes: [{ op: "cp", from: "a", to: "../../outside" }],
      }),
      /escapes/,
    );
    await assert.rejects(
      f.ops.filesystem("mkdir", { ref: "main", path: "a" }),
      /publish/,
    );
    assert.ok(!f.calls.some((c) => c.method === "apply"));
  } finally {
    await f.close();
  }
});
test("retained Workspace ownership, conflict preservation and normal reserved exit", async () => {
  const f = await fixture();
  try {
    const ws = await f.ops.workspace("mount", {});
    await assert.rejects(f.ops.workspace("mount", {}), /One retained/);
    await assert.rejects(f.ops.workspace("status", { id: "foreign" }), /owned/);
    await assert.rejects(
      f.ops.workspace("exec", { id: ws.id, command: "exit 124" }),
      (e) => {
        const v = (e as { result: Value }).result.command as Value;
        assert.equal(v.exitCode, 124);
        assert.equal(v.timedOut, false);
        assert.equal(v.stderr, "err");
        assert.equal(String(v.stdout).length, 24576);
        assert.equal(v.stdoutTruncated, true);
        return true;
      },
    );
    f.setCommitError(
      Object.assign(new Error("conflict"), { code: "Conflict" }),
    );
    await assert.rejects(f.ops.workspace("commit", { id: ws.id }), /conflict/);
    assert.equal(f.runtime.owned.size, 1);
    assert.ok(!f.calls.some((c) => c.method === "unmount"));
  } finally {
    await f.close();
  }
});
test("background processes are scoped to owned Workspaces and cancelled before cleanup", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.ops.process("start", { id: "foreign", command: "sleep 1" }),
      /owned/,
    );
    const ws = await f.ops.workspace("mount", {});
    await f.ops.process("start", { id: ws.id, command: "sleep 30" });
    await assert.rejects(
      f.ops.process("cancel", { process: "foreign" }),
      /owned/,
    );
    await f.runtime.cleanup();
    const methods = f.calls.map((c) => c.method);
    assert.ok(methods.indexOf("cancel") < methods.indexOf("unmount"));
    assert.equal(f.runtime.processes.size, 0);
    assert.equal(f.runtime.owned.size, 0);
  } finally {
    await f.close();
  }
});
test("synchronous per-project deployment admission restores env even on throw", async () => {
  const before = process.env.LAYERFS_VOLUME;
  const promise = withDeployment({ VOLUME: "isolated" }, () =>
    Promise.resolve(process.env.LAYERFS_VOLUME),
  );
  assert.equal(process.env.LAYERFS_VOLUME, before);
  assert.equal(await promise, "isolated");
  assert.throws(() =>
    withDeployment({ VOLUME: "isolated" }, () => {
      throw Error("stop");
    }),
  );
  assert.equal(process.env.LAYERFS_VOLUME, before);
});
test("journal attribution survives reopen without recording filesystem contents", async () => {
  const f = await fixture();
  try {
    await f.ops.observe("call-1", "read", () =>
      f.runtime.files("read", { path: "a" }),
    );
    const work = await new Operations(f.runtime).work();
    assert.equal(work.actors[0].label, "lead");
    assert.equal(work.calls.filter((c) => c.id === "call-1").length, 2);
    const log = await readFile(join(f.ops.traceDir, "events.jsonl"), "utf8");
    assert.ok(!log.includes('"text":"ok"'));
  } finally {
    await f.close();
  }
});
test("project selection locks and incomplete/unsafe imports fail before Docker", async () => {
  const f = await fixture(),
    old = process.env.PI_LAYERFS_VOLUME_ROOT;
  try {
    const c = new Control(f.runtime);
    await c.ready();
    assert.equal((await c.projects()).length, 1);
    c.locked = true;
    await assert.rejects(c.select("other"), /fixed/);
    delete process.env.PI_LAYERFS_VOLUME_ROOT;
    await assert.rejects(c.init("empty"), /manage-projects/);
    process.env.PI_LAYERFS_VOLUME_ROOT = f.dir;
    await writeFile(join(f.root, ".env"), "SECRET=redacted");
    await assert.rejects(c.init("unsafe", f.root), /sensitive/);
    await assert.rejects(c.remove("test", "wrong"), /exact/);
    assert.equal((await c.projects()).length, 1);
  } finally {
    if (old === undefined) delete process.env.PI_LAYERFS_VOLUME_ROOT;
    else process.env.PI_LAYERFS_VOLUME_ROOT = old;
    await f.close();
  }
});
function rawStatus(url: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}
test("loopback dashboard requires bearer auth and rejects cross-origin/mutating GET", async () => {
  const f = await fixture();
  const c = new Control(f.runtime);
  await c.ready();
  const dashboard = new Dashboard(c);
  try {
    const url = new URL(await dashboard.start()),
      headers = { Authorization: `Bearer ${url.hash.slice(1)}` },
      base = url.origin;
    assert.equal((await fetch(`${base}/api?method=projects`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/api?method=projects`, {
          headers: { ...headers, Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      await rawStatus(`${base}/api?method=projects`, {
        ...headers,
        Host: "evil.example",
      }),
      403,
    );
    assert.equal(
      (await fetch(`${base}/api?method=init`, { headers })).status,
      404,
    );
    const html = await fetch(base);
    assert.match(html.headers.get("content-security-policy") ?? "", /nonce-/);
    assert.ok(!(await html.text()).includes(url.hash.slice(1)));
    const rows = await (
      await fetch(`${base}/api?method=projects`, { headers })
    ).json();
    assert.equal(rows[0].name, "test");
    assert.equal(
      (
        await fetch(`${base}/api?method=select`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: "{",
        })
      ).status,
      400,
    );
  } finally {
    await dashboard.close();
    await c.close();
    await f.close();
  }
});
test("dashboard refuses a malformed published listen address", async () => {
  const f = await fixture();
  const c = new Control(f.runtime);
  await c.ready();
  const saved = process.env.PI_LAYERFS_DASHBOARD_LISTEN;
  process.env.PI_LAYERFS_DASHBOARD_LISTEN = "47681";
  const dashboard = new Dashboard(c);
  try {
    await assert.rejects(dashboard.start(), /ADDRESS:PORT/);
  } finally {
    if (saved === undefined) delete process.env.PI_LAYERFS_DASHBOARD_LISTEN;
    else process.env.PI_LAYERFS_DASHBOARD_LISTEN = saved;
    await dashboard.close();
    await c.close();
    await f.close();
  }
});
test("browser page JavaScript parses and data rendering uses text nodes", () => {
  const script = dashboardPage.match(/<script[^>]*>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
  assert.ok(!script.includes("innerHTML"));
  assert.ok(script.includes("textContent"));
});

test("saved Layers compare only through verified equivalent Commit trees", async () => {
  const f = await fixture();
  try {
    f.backend.store.project.get_history = async () => ({
      commits: [{ id: "C1", root: "R1" }],
      layers: [
        { id: "L0", root: "empty", parent: null },
        { id: "L1", root: "R1", sourceCommit: "C1" },
        { id: "L2", root: "merged", sourceCommit: "C2" },
      ],
      branches: [{ name: "main", base: "L1" }],
    });
    assert.deepEqual(
      (await compareSaved(f.runtime, { from: "main", to: "C1" })).items,
      [],
    );
    await assert.rejects(compareSaved(f.runtime, { from: "L0", to: "C1" }), {
      code: "NotComparable",
    });
    await assert.rejects(compareSaved(f.runtime, { from: "L2", to: "C1" }), {
      code: "NotComparable",
    });
  } finally {
    await f.close();
  }
});
test("full trace paging preserves UTF-8 byte cursors and incomplete appends", async () => {
  const f = await fixture();
  try {
    await f.ops.record({ method: "first", label: "α" });
    await f.ops.record({ method: "second", label: "β" });
    const a = await tracePage(f.ops.traceDir, "events.jsonl", 0, 1);
    assert.equal(a.items[0].method, "first");
    assert.equal(a.hasMore, true);
    const b = await tracePage(f.ops.traceDir, "events.jsonl", a.nextOffset, 1);
    assert.equal(b.items[0].method, "second");
    assert.equal(b.hasMore, false);
    await appendFile(
      join(f.ops.traceDir, "events.jsonl"),
      '{"method":"pending"',
    );
    const pending = await tracePage(
      f.ops.traceDir,
      "events.jsonl",
      b.nextOffset,
    );
    assert.equal(pending.pending, true);
    assert.equal(pending.nextOffset, b.nextOffset);
    await appendFile(join(f.ops.traceDir, "events.jsonl"), "}\n");
    const c = await tracePage(f.ops.traceDir, "events.jsonl", b.nextOffset);
    assert.equal(c.items[0].method, "pending");
    assert.equal((await traceFiles(f.ops.traceDir)).items.length, 1);
    await assert.rejects(tracePage(f.ops.traceDir, "../secret"), /filename/);
    await assert.rejects(
      tracePage(f.ops.traceDir, "events.jsonl", -1),
      /cursor/,
    );
  } finally {
    await f.close();
  }
});
test("import totals count ignored files and hardlink identities without following symlinks", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "a"), "abc");
    await link(join(f.root, "a"), join(f.root, "hard"));
    await mkdir(join(f.root, ".git"));
    await writeFile(join(f.root, ".git", "data"), "xy");
    await symlink(f.dir, join(f.root, "outside"));
    assert.deepEqual(await scanSource(f.root), {
      entries: 6,
      files: 2,
      bytes: 5,
    });
  } finally {
    await f.close();
  }
});
test("management mode creates no project and does not bind on refused data access", async () => {
  const f = await fixture();
  try {
    const c = new Control(f.runtime);
    await c.ready(true);
    assert.deepEqual(await c.projects(), []);
    assert.equal(c.unbound, true);
    assert.throws(() => c.bindProject(), /Choose a project/);
    assert.equal(c.locked, false);
    await c.ready(false);
    assert.equal(c.bindProject(), f.runtime);
    assert.equal(c.locked, true);
    await c.close();
  } finally {
    await f.close();
  }
});
test("retained Workspace blocks a second Bash mount and cleanup releases the lease", async () => {
  const f = await fixture();
  try {
    await f.ops.workspace("mount", {});
    await assert.rejects(f.runtime.bash("true"), /retained Workspace/);
    await f.runtime.cleanup();
    assert.equal(f.runtime.persistent.size, 0);
    assert.equal(f.runtime.owned.size, 0);
  } finally {
    await f.close();
  }
});

test("project binding restoration preserves the lock and refuses replacement Stores", async () => {
  const f = await fixture();
  try {
    const c = new Control(f.runtime);
    await c.ready();
    const before = f.calls.length;
    await assert.rejects(
      () =>
        c.restore({ project: "test", volume: "replaced-volume", locked: true }),
      /removed\/replaced/,
    );
    assert.equal(f.calls.length, before);
    assert.equal(c.locked, false);
    await c.restore({ project: "test", volume: "unit-volume", locked: true });
    assert.equal(c.locked, true);
    await assert.rejects(() => c.select("another"), /fixed|locked|bound/i);
    await c.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("reusing a project name with a new volume does not mix old actor journals", async () => {
  const f = await fixture();
  try {
    await f.ops.record({ method: "old.message", text: "old incarnation" });
    const replacement = new Runtime(
      f.root,
      f.runtime.config,
      f.connect,
      async () => ({ environment: {}, filesystem: "ext4" }),
      {
        ...f.runtime.options,
        agent: randomUUID(),
        deployment: { ...f.runtime.options.deployment, VOLUME: "new-volume" },
      },
    );
    const next = new Operations(replacement);
    await next.ready();
    assert.notEqual(next.traceDir, f.ops.traceDir);
    assert.equal((await next.work()).calls.length, 0);
    assert.equal((await f.ops.work()).calls.length, 1);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("history rendering retains the creator and branch after a fast-forward merge", () => {
  test("dashboard discards a pending read after the project changes", async () => {
    const api = dashboardPage.match(/async function api[^\n]+/)?.[0];
    assert.ok(api);
    const pending: { resolve?: (value: Value) => void } = {};
    const context = {
      project: "old-project",
      token: "fixture-token",
      URLSearchParams,
      fetch: () =>
        new Promise<Value>((resolve) => {
          pending.resolve = resolve;
        }),
    };
    const result = new Script(`(${api})("read")`).runInNewContext(context);
    context.project = "new-project";
    assert.ok(pending.resolve);
    pending.resolve({
      ok: true,
      json: async () => ({ text: "old project data" }),
    });
    await assert.rejects(result, { name: "StaleProject" });
  });
  const graph = dashboardPage.match(/function drawGraph\(\)[\s\S]*?\n}/)?.[0];
  assert.ok(graph);
  const elements: Value[] = [];
  const widgets: Record<string, Value> = {};
  const make = () => {
    const node: Value = {
      textContent: "",
      value: "2",
      setAttribute() {},
      append() {},
      addEventListener() {},
      replaceChildren() {},
    };
    elements.push(node);
    return node;
  };
  new Script(`(${graph})()`).runInNewContext({
    document: { createElementNS: make },
    $: (id: string) => (widgets[id] ??= make()),
    short: (id: string) => id,
    snapshot: {
      commits: [{ id: "C1", parent: null, via: "fs", message: "worker write" }],
      layers: [],
      branches: [
        { name: "agent-alpha", head: "C1" },
        { name: "joined", head: "C1" },
      ],
    },
    work: {
      actors: [
        { agent: "alpha", label: "Alpha" },
        { agent: "lead", label: "Lead" },
      ],
      calls: [
        {
          method: "fs.write",
          kind: "Committed",
          commit: "C1",
          agent: "alpha",
          args: { branch: "agent-alpha" },
          time: 1000,
        },
        {
          method: "branch.merge",
          kind: "Merged",
          commit: "C1",
          agent: "lead",
          branch: "joined",
          time: 2000,
        },
      ],
    },
    extraCommits: new Map(),
    extraBranches: new Map(),
  });
  assert.ok(
    elements.some((n) =>
      /C1 · agent-alpha · Alpha/.test(String(n.textContent)),
    ),
  );
  assert.ok(!elements.some((n) => /C1.*Lead/.test(String(n.textContent))));
});

test("mounts use the lowest running Sandbox of the image with a free slot, else a new one", async () => {
  const f = await fixture();
  try {
    const image = String(f.runtime.options.deployment?.IMAGE);
    f.sdk.project.list_sandboxes = async () => ({
      items: [
        { sandbox: "1", image: `sha256:${"c".repeat(64)}`, workspaces: 0 },
        { sandbox: "2", image, workspaces: 16 },
        { sandbox: "3", image, workspaces: 4 },
        { sandbox: "4", image, workspaces: 0 },
      ],
      hasMore: false,
    });
    assert.equal((await f.runtime.mount("pi-work")).sandbox, "3");
    assert.ok(!f.calls.some((c) => c.method === "sandbox.create"));
    const mount = f.sdk.workspace.mount;
    // Sandbox 3 closed itself when idle after it was listed.
    f.sdk.workspace.mount = async (sandbox, branch) => {
      if (sandbox === "3")
        throw Object.assign(new Error("closed"), { code: "NoSuchSandbox" });
      return mount(sandbox, branch);
    };
    assert.equal((await f.runtime.mount("pi-work")).sandbox, "1");
    assert.deepEqual(
      f.calls.slice(-2).map((c) => c.method),
      ["sandbox.create", "mount"],
    );
    f.sdk.workspace.mount = async () => {
      throw Object.assign(new Error("transport"), { code: "Unknown" });
    };
    await assert.rejects(f.runtime.mount("pi-work"), /transport/);
  } finally {
    await f.close();
  }
});
test("snapshot joins Store history with live Workspaces and reports stopped Sandboxes", async () => {
  const f = await fixture();
  try {
    f.backend.store.project.get_history = async () => ({
      kind: "ok",
      version: "h1",
      layers: f.layers,
    });
    f.sdk.project.list_sandboxes = async () => ({
      items: [
        { sandbox: "1", name: "a", workspaces: 1 },
        { sandbox: "2", name: "b", workspaces: 0 },
      ],
      hasMore: false,
    });
    f.sdk.sandbox.list_workspaces = async (sandbox) => {
      if (sandbox === "2")
        throw Object.assign(new Error("gone"), {
          code: "NoSuchSandbox",
          detail: { containerGone: true },
        });
      return {
        items: [{ sandbox, path: "/workspaces/1" }],
        hasMore: false,
        version: "w7",
      };
    };
    const state = await f.ops.inspect("snapshot");
    assert.equal(state.version, "h1.w7.gone-2");
    assert.deepEqual(state.layers, f.layers);
    assert.deepEqual(state.sandboxes, [
      {
        sandbox: "1",
        name: "a",
        workspaces: [{ sandbox: "1", path: "/workspaces/1", overlay: {} }],
      },
    ]);
    assert.deepEqual(state.gone, [
      {
        sandbox: "2",
        name: "b",
        workspaces: 0,
        detail: { containerGone: true },
      },
    ]);
    assert.deepEqual(
      await f.ops.inspect("snapshot", { since: "h1.w7.gone-2" }),
      {
        kind: "unchanged",
        version: "h1.w7.gone-2",
      },
    );
  } finally {
    await f.close();
  }
});
test("clients get their deployment and trace file when made, and each call its step", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lfs-ports-"));
  try {
    const scope = join(dir, "node_modules/@layerfs");
    const files: Record<string, string> = {
      "agent/package.json": JSON.stringify({
        name: "@layerfs/agent",
        type: "module",
        exports: { ".": "./src/index.js" },
      }),
      "agent/src/index.js": `const env = (name) => process.env["LAYERFS_" + name];
const made = (project, folder) => {
  const seen = { volume: env("VOLUME"), trace: env("TRACE") };
  const client = { project: { list_branches: async () => ({ ...seen, step: env("TRACE_STEP") }) }, branch: {}, fs: {}, sandbox: {}, workspace: {}, close: async () => {} };
  if (folder) client.created = { kind: "Initialized", folder };
  return client;
};
export class LayerFS {
  static async open(project) { return made(project); }
  static async init(project, folder) { return made(project, folder); }
}`,
      "agent/src/internal.js": `export const invokeBackend = async (op, args) => ({ op, args, native: process.env.LAYERFS_NATIVE });`,
      "backend/package.json": JSON.stringify({
        name: "@layerfs/backend",
        type: "module",
        exports: { ".": "./src/index.js" },
      }),
      "backend/src/index.js": `import { LayerFS } from "@layerfs/agent";
export class LayerFSBackend {
  static of(client) { return { store: { project: { get_history: async () => ({ agent: typeof LayerFS, step: process.env.LAYERFS_TRACE_STEP }) } }, daemon: {} }; }
}`,
    };
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(scope, name, ".."), { recursive: true });
      await writeFile(join(scope, name), text);
    }
    const options: RuntimeOptions = {
      agent: randomUUID(),
      deployment: { HOME: dir, VOLUME: "v1", NATIVE: "/addon.node" },
    };
    const before = { ...process.env };
    const connect = await loadClient(
      join(scope, "agent/src/index.js"),
      "demo",
      options,
    );
    const sdk = await connect("/source");
    assert.deepEqual(sdk.created, { kind: "Initialized", folder: "/source" });
    assert.ok(!(await connect()).created);
    required(sdk.options).traceStep = "call-7";
    assert.deepEqual(await sdk.project.list_branches(), {
      volume: "v1",
      trace: options.trace,
      step: "call-7",
    });
    assert.deepEqual(
      await invoke(required(options.backend).store, "project", "get_history"),
      { agent: "function", step: options.agent },
    );
    assert.deepEqual(await required(options.progress)(), {
      op: "runtime.project.get_init",
      args: { project: "demo", home: dir },
      native: "/addon.node",
    });
    assert.deepEqual({ ...process.env }, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
