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
import { Control } from "../src/control.js";
import { Dashboard } from "../src/dashboard.js";
import { dashboardPage } from "../src/dashboard-page.js";
import { compareSaved, traceFiles, tracePage } from "../src/history.js";
import { scanSource } from "../src/import-progress.js";
import { Operations } from "../src/operations.js";
import { type Surface, withDeployment } from "../src/ports.js";
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
  const sdk: SDK = {
    project: {
      init: async () => {
        await mkdir(join(home, "test"));
        return { kind: "Initialized", layer: "L0" };
      },
      list_branches: async () => ({ items: branches, hasMore: false }),
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
    workspace: {
      mount: async () => {
        calls.push({ method: "mount", args: [] });
        return { sandbox: "1", path: "/workspaces/1" };
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
      status: record("status"),
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
  const operator: Surface = {
    inspect: {
      snapshot: async () => ({ layers, branches, sandboxes: [], commits: [] }),
    },
    store: {
      stats: record("storage", { logical: 100 }),
      overwritten: record("overwritten"),
    },
    process: {
      start: record("start", { process: "proc_1_owned" }),
      list: record("process.list"),
      cancel: record("cancel"),
    },
    workspace: { overlay: record("overlay"), changes: record("changes") },
    project: { progress: record("progress") },
  };
  const options = {
    agent: randomUUID(),
    label: "lead",
    deployment: {
      HOME: home,
      STORE_PATH: join(dir, "store/global/store.sqlite"),
      VOLUME: "unit-volume",
    },
    operator,
    history: async () => ({ layers }),
  };
  const runtime = new Runtime(
    root,
    config,
    sdk,
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
    operator,
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
      f.sdk,
      async () => ({ environment: {}, filesystem: "ext4" }),
      f.runtime.options,
    );
    await second.initialize();
    assert.equal(second.initial, "L0");
    f.layers.shift();
    const third = new Runtime(
      f.root,
      { ...f.config },
      f.sdk,
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
    f.operator.inspect.snapshot = async () => ({
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
      f.runtime.sdk,
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
