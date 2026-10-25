import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type Config,
  checkPlatform,
  environment,
  loadConfig,
  required,
  validateEnvironment,
  verifyStoreMount,
} from "../src/config.js";
import { leaseHolders, Watch } from "../src/lease.js";
import type { Connect } from "../src/ports.js";
import {
  branchPath,
  OperationError,
  quote,
  Runtime,
  type RuntimeOptions,
  type SDK,
  sensitiveFiles,
  type Value,
} from "../src/runtime.js";

const config: Config = {
  sdk: "unused",
  project: "test",
  branch: "pi-work",
  initialize: true,
  failWhenUnavailable: true,
  timeoutSeconds: 3,
  logLevel: "silent",
};
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-layerfs-unit-"));
  const root = join(dir, "source");
  const home = join(dir, "home");
  await mkdir(root);
  await mkdir(home);
  const before = { ...process.env };
  process.env.LAYERFS_HOME = home;
  process.env.LAYERFS_STORE_PATH = join(dir, "store/global/store.sqlite");
  process.env.LAYERFS_VOLUME = "test-volume";
  process.env.LAYERFS_IMAGE = `sha256:${"b".repeat(64)}`;
  const events: string[] = [];
  const branches: Value[] = [{ name: "main", base: "L0-id", head: null }];
  const files = new Map<string, string>();
  let exec: () => Promise<Value> = async () => ({
    exitCode: 0,
    stdout: "out",
    stderr: "err",
  });
  let unmountError: Error | undefined;
  let commitError: Error | undefined;
  let init = async (): Promise<Value> => {
    events.push("init");
    await mkdir(join(home, "test"));
    return { kind: "Initialized", layer: "L0-id" };
  };
  const sdk: SDK = {
    project: {
      list_branches: async () => ({ items: branches, hasMore: false }),
      list_sandboxes: async () => ({ items: [], hasMore: false }),
    },
    branch: {
      fork: async (name, from) => {
        events.push(`fork:${name}:${from}`);
        branches.push({ name, base: "L0-id", head: null });
        return {};
      },
      list_commits: async () => ({ items: [], hasMore: false }),
    },
    fs: {
      read: async (b, p, start, end) => {
        events.push(`read:${b}:${p}:${start}:${end}`);
        return { text: files.get(`${b}:${p}`) };
      },
      write: async (b, p, text) => {
        events.push(`write:${b}:${p}`);
        files.set(`${b}:${p}`, text);
        return { kind: "Committed" };
      },
      edit: async (b, p, oldText, newText) => {
        events.push(`edit:${b}:${p}`);
        const text = required(files.get(`${b}:${p}`));
        if (!text.includes(oldText))
          throw Object.assign(new Error("missing text"), { code: "NoMatch" });
        files.set(`${b}:${p}`, text.replace(oldText, newText));
        return { kind: "Committed" };
      },
      apply: async () => ({}),
      list: async () => ({ items: [], hasMore: false }),
      glob: async () => ({ items: [], hasMore: false }),
      grep: async () => ({ items: [], hasMore: false }),
    },
    sandbox: {
      create: async () => ({ sandbox: "1" }),
      list_workspaces: async () => ({ items: [], hasMore: false }),
    },
    workspace: {
      mount: async () => {
        events.push("mount");
        return { sandbox: "1", path: "/workspaces/1" };
      },
      exec: async (_ws, command) => {
        events.push("exec");
        assert.ok(
          command.startsWith(
            "timeout --signal=TERM --kill-after=2s 3s bash -c '",
          ),
        );
        const value = await exec();
        if (value.timedOut) return value;
        const marker = command.match(/__PI_LAYERFS_EXIT_[a-z0-9-]+__/)?.[0];
        assert.ok(marker);
        return {
          ...value,
          exitCode: 0,
          stderr: `${value.stderr ?? ""}\n${marker}:${value.exitCode}\n`,
        };
      },
      commit: async () => {
        events.push("commit");
        if (commitError) throw commitError;
        return { kind: "UpToDate" };
      },
      unmount: async (_ws, discard) => {
        events.push(`unmount:${discard}`);
        if (unmountError) throw unmountError;
        return {};
      },
    },
    close: async () => {
      events.push("close");
    },
  };
  const connect: Connect = async (folder) => {
    if (folder !== undefined) sdk.created = await init();
    return sdk;
  };
  const create = (c = config, options: RuntimeOptions = {}) =>
    new Runtime(
      root,
      c,
      connect,
      async () => ({
        environment: {},
        filesystem: "ext4",
      }),
      options,
    );
  return {
    root,
    home,
    events,
    sdk,
    create,
    setExec: (fn: typeof exec) => {
      exec = fn;
    },
    setUnmount: (e?: Error) => {
      unmountError = e;
    },
    setInit: (fn: typeof init) => {
      init = fn;
    },
    setCommit: (e?: Error) => {
      commitError = e;
    },
    async cleanup() {
      process.env = before;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("host platform, Node and environment are validated without fallback", async () => {
  assert.throws(() => checkPlatform("darwin"), /Linux/);
  assert.throws(() => checkPlatform("linux", "20.0.0"), /Node/);
  checkPlatform("linux", "24.13.1");
  assert.equal(environment({}).DOCKER, "/var/run/docker.sock");
  assert.equal(environment({ DSH_LAYERFS_HOME: "/private" }).HOME, "/private");
  const before = { ...process.env };
  try {
    for (const k of Object.keys(process.env))
      if (k.startsWith("LAYERFS_") || k.startsWith("DSH_LAYERFS_"))
        delete process.env[k];
    await assert.rejects(validateEnvironment("/tmp"), /Missing LAYERFS_HOME/);
  } finally {
    process.env = before;
  }
});
test("configuration validates names, defaults, timeout, unknown fields and malformed JSON", async () => {
  const f = await fixture();
  try {
    const file = join(f.root, "config.json");
    await writeFile(file, JSON.stringify({ sdk: "sdk.js", project: "demo" }));
    assert.equal((await loadConfig(f.root, file)).branch, "pi-work");
    await writeFile(file, JSON.stringify({ project: "demo" }));
    const bundled = await loadConfig(f.root, file);
    assert.match(
      bundled.sdk,
      /vendor\/layerfs\/node_modules\/@layerfs\/agent\/src\/index\.js$/,
    );
    assert.match(await readFile(bundled.sdk, "utf8"), /export class LayerFS/);
    for (const invalid of [
      { sdk: "" },
      { sdk: null },
      { branch: "main" },
      { timeoutSeconds: 0 },
      { initialize: "yes" },
      { project: "../bad" },
      { typo: true },
    ]) {
      await writeFile(
        file,
        JSON.stringify({ sdk: "sdk.js", project: "demo", ...invalid }),
      );
      await assert.rejects(loadConfig(f.root, file));
    }
    await writeFile(file, "{");
    await assert.rejects(loadConfig(f.root, file), /configuration/);
  } finally {
    await f.cleanup();
  }
});
test("initialization persists once across runtime instances and branch reuse", async () => {
  const f = await fixture();
  try {
    const first = f.create();
    await first.initialize();
    await first.initialize();
    await first.shutdown();
    const next = f.create();
    await next.initialize();
    assert.equal(f.events.filter((e) => e === "init").length, 1);
    assert.equal(f.events.filter((e) => e.startsWith("fork:")).length, 1);
    assert.equal((await next.status()).initial.layer, "L0-id");
    await next.shutdown();
  } finally {
    await f.cleanup();
  }
});
test("first capture waits for a live initializer and takes over only a lock that never began capture", async () => {
  const f = await fixture();
  try {
    const lock = join(f.home, "pi-bindings/test.json.lock");
    const holder = f.create();
    await holder.lease.write();
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner"), holder.lease.id);
    const waiting = f.create().initialize();
    let settled = false;
    waiting.finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(settled, false, "a live owner's lock is waited for");
    await holder.lease.release(); // owner died before writing any binding
    await waiting;
    assert.equal(f.events.filter((e) => e === "init").length, 1);
    await assert.rejects(stat(lock), /ENOENT/);
  } finally {
    await f.cleanup();
  }
});
test("an interrupted capture under an expired lock is never replayed", async () => {
  const f = await fixture();
  try {
    const bindings = join(f.home, "pi-bindings");
    await mkdir(join(bindings, "test.json.lock"), { recursive: true });
    await writeFile(
      join(bindings, "test.json.lock/owner"),
      "00000000-0000-4000-8000-000000000000",
    );
    await writeFile(
      join(bindings, "test.json"),
      JSON.stringify({
        version: 1,
        root: f.root,
        store: process.env.LAYERFS_STORE_PATH,
        initial: null,
      }),
    );
    await assert.rejects(f.create().initialize(), /interrupted/);
    assert.ok(!f.events.includes("init"));
  } finally {
    await f.cleanup();
  }
});
test("sessions of an initialized project start concurrently and share a racing Branch fork", async () => {
  const f = await fixture();
  try {
    await f.create({ ...config, branch: "seed" }).initialize();
    // A held lock no longer blocks verification of a complete binding.
    await mkdir(join(f.home, "pi-bindings/test.json.lock"));
    const fork = f.sdk.branch.fork;
    f.sdk.branch.fork = async (name, from) => {
      await fork(name, from);
      throw Object.assign(new Error("taken"), { code: "NameTaken" });
    };
    const runtimes = [f.create(), f.create(), f.create()];
    await Promise.all(runtimes.map((r) => r.initialize()));
    assert.equal(f.events.filter((e) => e === "init").length, 1);
    for (const r of runtimes) assert.equal((await r.status()).ready, true);
  } finally {
    await f.cleanup();
  }
});
test("incomplete intent, missing project and changed source binding fail closed", async () => {
  const f = await fixture();
  try {
    await f.create().initialize();
    const file = join(f.home, "pi-bindings/test.json");
    const binding = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...binding, initial: null }));
    await assert.rejects(f.create().initialize(), /Incomplete/);
    await writeFile(file, JSON.stringify({ ...binding, root: "/other" }));
    await assert.rejects(f.create().initialize(), /another source/);
    assert.equal(f.events.filter((e) => e === "init").length, 1);
  } finally {
    await f.cleanup();
  }
});
test("initialization is explicit and obvious credentials are refused", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.create({ ...config, initialize: false }).initialize(),
      /uninitialized/,
    );
    await writeFile(join(f.root, ".env"), "SECRET=test");
    await assert.rejects(f.create().initialize(), /sensitive files/);
    assert.ok(!f.events.includes("init"));
  } finally {
    await f.cleanup();
  }
});
test("SDK reads/writes/edits use working branch, preserve exact text and surface errors", async () => {
  const f = await fixture();
  try {
    const r = f.create();
    await r.initialize();
    await r.files("write", { path: "a", content: "hello\r\n" });
    await r.files("edit", { path: "a", oldText: "hello", newText: "world" });
    assert.equal(
      ((await r.files("read", { path: "a" })) as Value).text,
      "world\r\n",
    );
    assert.equal((await f.sdk.fs.read("main", "/a")).text, undefined);
    await assert.rejects(
      r.files("edit", { path: "a", oldText: "missing", newText: "x" }),
      /fs.edit.*NoMatch|fs.edit.*missing text/,
    );
    assert.ok(f.events.includes("read:pi-work:/a:1:200"));
  } finally {
    await f.cleanup();
  }
});
test("paths reject host escape and preserve Linux backslashes and shell quoting", () => {
  assert.equal(branchPath("/project", "src/a"), "/src/a");
  assert.equal(branchPath("/project", "/project/a"), "/a");
  assert.throws(() => branchPath("/project", "../outside"), /escapes/);
  assert.throws(() => branchPath("/project", "/etc/passwd"), /escapes/);
  assert.throws(() => branchPath("/project", "x\0y"), /NUL/);
  assert.equal(quote("a'b$(x)"), "'a'\\''b$(x)'");
});
for (const mode of [
  "success",
  "nonzero",
  "throw",
  "cleanup-error",
  "commit-error",
  "timeout",
  "cancel",
] as const)
  test(`command lifecycle: ${mode}`, async () => {
    const f = await fixture();
    try {
      const r = f.create();
      await r.initialize();
      f.events.length = 0;
      const controller = new AbortController();
      if (mode === "nonzero")
        f.setExec(async () => ({
          exitCode: 7,
          stdout: "partial",
          stderr: "failed",
        }));
      if (mode === "throw" || mode === "cleanup-error")
        f.setExec(async () => {
          throw new Error("exec original");
        });
      if (mode === "cleanup-error")
        f.setUnmount(new Error("cleanup secondary"));
      if (mode === "commit-error") f.setCommit(new Error("commit failed"));
      if (mode === "timeout")
        f.setExec(async () => ({ exitCode: 124, timedOut: true }));
      if (mode === "cancel")
        f.setExec(async () => {
          controller.abort();
          return { exitCode: 0 };
        });
      if (mode === "success")
        assert.equal((await r.bash("true")).commit?.kind, "UpToDate");
      else
        await assert.rejects(r.bash("command", controller.signal), (e) => {
          assert.ok(e instanceof OperationError);
          if (mode === "cleanup-error") {
            assert.match(e.message, /exec original.*cleanup secondary/);
            assert.equal(e.errors.length, 2);
          }
          return true;
        });
      assert.deepEqual(f.events.slice(0, 2), ["mount", "exec"]);
      assert.equal(
        f.events.includes("commit"),
        ["success", "nonzero", "commit-error"].includes(mode),
      );
      assert.equal(r.owned.size, mode === "cleanup-error" ? 1 : 0);
      if (mode === "cleanup-error") {
        await assert.rejects(r.files("read", { path: "a" }), /recovery/);
        f.setUnmount();
        await r.cleanup();
        assert.equal(r.owned.size, 0);
      }
      await r.shutdown();
      await r.shutdown();
    } finally {
      await f.cleanup();
    }
  });
test("same runtime mutations are serialized and cancellation before mount has no effect", async () => {
  const f = await fixture();
  try {
    const r = f.create();
    await r.initialize();
    f.events.length = 0;
    await Promise.all([
      r.bash("one"),
      r.bash("two"),
      r.files("write", { path: "x", content: "v" }),
    ]);
    assert.deepEqual(f.events, [
      "mount",
      "exec",
      "commit",
      "unmount:false",
      "mount",
      "exec",
      "commit",
      "unmount:false",
      "write:pi-work:/x",
    ]);
    const controller = new AbortController();
    controller.abort();
    const count = f.events.length;
    await assert.rejects(r.bash("never", controller.signal), /before mount/);
    assert.equal(f.events.length, count);
    await assert.rejects(r.bash("bad", undefined, 4), /timeout/);
  } finally {
    await f.cleanup();
  }
});

test("Store filesystem and Docker volume identity must match", () => {
  const mounts =
    "1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 8:1 /var/lib/docker/volumes/test/_data /layerfs-store rw - ext4 /dev/root rw";
  assert.equal(
    verifyStoreMount(
      mounts,
      "/layerfs-store",
      "/var/lib/docker/volumes/test/_data",
    ),
    "ext4",
  );
  assert.throws(
    () =>
      verifyStoreMount(
        mounts.replaceAll("ext4", "nfs"),
        "/layerfs-store",
        "/var/lib/docker/volumes/test/_data",
      ),
    /Unsupported/,
  );
  assert.throws(
    () =>
      verifyStoreMount(mounts, "/other", "/var/lib/docker/volumes/test/_data"),
    /share one Store/,
  );
  assert.throws(
    () =>
      verifyStoreMount(
        mounts.replaceAll("ext4", "ext3"),
        "/layerfs-store",
        "/var/lib/docker/volumes/test/_data",
      ),
    /Unsupported/,
  );
});
test("cancel waits for exec completion before discard and cleanup", async () => {
  const f = await fixture();
  try {
    const r = f.create();
    await r.initialize();
    f.events.length = 0;
    let complete!: (v: Value) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.setExec(() => {
      started();
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const controller = new AbortController();
    const running = r.bash("still writing", controller.signal);
    const checked = assert.rejects(running, /Cancelled/);
    await ready;
    controller.abort();
    await Promise.resolve();
    assert.deepEqual(f.events, ["mount", "exec"]);
    complete({ exitCode: 0 });
    await checked;
    assert.deepEqual(f.events, ["mount", "exec", "unmount:true"]);
  } finally {
    await f.cleanup();
  }
});
test("mount failure does not exec or unmount an unowned Workspace", async () => {
  const f = await fixture();
  try {
    const r = f.create();
    await r.initialize();
    f.events.length = 0;
    f.sdk.workspace.mount = async () => {
      throw new Error("daemon unavailable");
    };
    await assert.rejects(r.bash("never"), /mount: daemon unavailable/);
    assert.deepEqual(f.events, []);
    assert.equal(r.owned.size, 0);
  } finally {
    await f.cleanup();
  }
});
test("streamed command output is bounded and truncation is explicit", async () => {
  const f = await fixture();
  try {
    const r = f.create();
    await r.initialize();
    f.sdk.workspace.exec = async (_ws, _command, _message, sinks) => {
      const chunk = Buffer.alloc(100000, "x");
      await new Promise<void>((resolve, reject) =>
        required(required(sinks).stdout).write(chunk, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      const marker = required(
        _command.match(/__PI_LAYERFS_EXIT_[a-z0-9-]+__/),
      )[0];
      const trailer = `\n${marker}:0\n`;
      await new Promise<void>((resolve, reject) =>
        required(required(sinks).stderr).write(trailer, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      return {
        exitCode: 0,
        stdout: null,
        stderr: null,
        stdoutBytes: chunk.length,
        stderrBytes: Buffer.byteLength(trailer),
      };
    };
    const result = await r.bash("large output");
    assert.equal((required(result.command).stdout as string).length, 24 * 1024);
    assert.equal(required(result.command).stdoutTruncated, true);
    assert.equal(required(result.command).stdoutBytes, 100000);
  } finally {
    await f.cleanup();
  }
});
for (const exitCode of [124, 137])
  test(`normal reserved exit ${exitCode} still commits and preserves stderr`, async () => {
    const f = await fixture();
    try {
      const r = f.create();
      await r.initialize();
      f.events.length = 0;
      f.setExec(async () => ({ exitCode, stderr: "exact stderr\n" }));
      await assert.rejects(r.bash("exit reserved"), (e) => {
        assert.ok(e instanceof OperationError);
        assert.equal((required(e.result).command as Value).exitCode, exitCode);
        assert.equal(
          (required(e.result).command as Value).stderr,
          "exact stderr\n",
        );
        assert.equal((required(e.result).command as Value).timedOut, false);
        return true;
      });
      assert.ok(f.events.includes("commit"));
    } finally {
      await f.cleanup();
    }
  });
test("initialization failure is not silently retried", async () => {
  const f = await fixture();
  try {
    const r = f.create();
    let calls = 0;
    f.setInit(async () => {
      calls++;
      throw new Error("unknown acquisition");
    });
    await assert.rejects(r.initialize(), /unknown acquisition/);
    await assert.rejects(r.initialize(), /unknown acquisition/);
    assert.equal(calls, 1);
    assert.equal((await r.status()).ready, false);
  } finally {
    await f.cleanup();
  }
});
test("independent configured branches do not share file updates", async () => {
  const f = await fixture();
  try {
    const a = f.create();
    await a.initialize();
    const b = f.create({ ...config, branch: "another" });
    await b.initialize();
    await Promise.all([
      a.files("write", { path: "x", content: "A" }),
      b.files("write", { path: "x", content: "B" }),
    ]);
    assert.equal(((await a.files("read", { path: "x" })) as Value).text, "A");
    assert.equal(((await b.files("read", { path: "x" })) as Value).text, "B");
  } finally {
    await f.cleanup();
  }
});
const leases = (r: Runtime) => r.lease.dir;
async function leaseRecords(r: Runtime) {
  const names = await readdir(leases(r)).catch(() => [] as string[]);
  return Promise.all(
    names.map(async (name) => ({
      name,
      ...JSON.parse(await readFile(join(leases(r), name), "utf8")),
    })),
  );
}
async function sandboxRecord(home: string, sandbox: string, container: string) {
  await mkdir(join(home, "test/sandboxes", sandbox), { recursive: true });
  await writeFile(
    join(home, "test/sandboxes", sandbox, "container"),
    container,
  );
}
async function writeLease(
  r: Runtime,
  id: string,
  heartbeat: number,
  workspaces: Value[],
  processes: string[] = [],
) {
  await mkdir(r.lease.dir, { recursive: true });
  await writeFile(
    join(r.lease.dir, `${id}.json`),
    JSON.stringify({
      incarnation: id,
      agent: id,
      label: "crashed",
      branch: "pi-work",
      heartbeat,
      workspaces,
      processes,
    }),
  );
}
const DEAD = "11111111-1111-4111-8111-111111111111";
test("Workspace ownership, with its container, is persisted while held and released on shutdown", async () => {
  const f = await fixture();
  try {
    const r = f.create();
    await r.initialize();
    await sandboxRecord(f.home, "1", "c-1");
    let during: Value[] = [];
    f.setExec(async () => {
      during = await leaseRecords(r);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await r.bash("true");
    assert.deepEqual(during[0].workspaces, [
      {
        sandbox: "1",
        path: "/workspaces/1",
        container: "c-1",
        retained: false,
      },
    ]);
    assert.deepEqual((await leaseRecords(r))[0].workspaces, []);
    await r.shutdown();
    assert.deepEqual(await leaseRecords(r), []);
  } finally {
    await f.cleanup();
  }
});
test("expired leases are reclaimed only after confirmation: retained work committed, overlays discarded, replaced Sandboxes untouched", async () => {
  const f = await fixture();
  try {
    const cancelled: string[] = [];
    const daemon = {
      process: {
        cancel: async (id: unknown) => {
          cancelled.push(String(id));
          if (id === "p-gone")
            throw Object.assign(new Error("gone"), { code: "NoSuchProcess" });
          if (id === "p-sandbox")
            throw Object.assign(new Error("gone"), { code: "NoSuchSandbox" });
          return {};
        },
      },
    };
    const r = f.create(config, {
      backend: {
        daemon,
        store: {
          project: {
            get_history: async () => ({ layers: [{ id: "L0-id" }] }),
          },
        },
      },
      agent: "lead",
    });
    r.watch = new Watch(0);
    const live = "22222222-2222-4222-8222-222222222222";
    await writeLease(
      r,
      DEAD,
      Date.now() - 120_000,
      [
        {
          sandbox: "2",
          path: "/workspaces/9",
          container: "c-2",
          retained: true,
        },
        {
          sandbox: "3",
          path: "/workspaces/1",
          container: "c-3",
          retained: false,
        },
        {
          sandbox: "4",
          path: "/workspaces/2",
          container: "c-4",
          retained: false,
        },
        // Sandbox 6 was replaced: the same number and path are someone else's.
        {
          sandbox: "6",
          path: "/workspaces/1",
          container: "c-6-old",
          retained: true,
        },
      ],
      ["p1", "p-gone", "p-sandbox"],
    );
    await writeLease(r, live, Date.now(), [
      { sandbox: "5", path: "/workspaces/1", container: "c-5", retained: true },
    ]);
    const touched: string[] = [];
    f.sdk.workspace.commit = async (ws) => {
      touched.push(`commit:${ws.sandbox}`);
      return { kind: "Committed", head: "c1" };
    };
    f.sdk.workspace.unmount = async (ws, discard) => {
      touched.push(`unmount:${ws.sandbox}:${discard}`);
      if (ws.sandbox === "4")
        throw Object.assign(new Error("gone"), {
          code: "NoSuchSandbox",
          detail: { containerGone: true },
        });
      return { kind: "Unmounted" };
    };
    await r.initialize();
    await sandboxRecord(f.home, "2", "c-2");
    await sandboxRecord(f.home, "3", "c-3");
    await sandboxRecord(f.home, "4", "c-4");
    await sandboxRecord(f.home, "6", "c-6-new");
    // First sighting only: a resumed owner gets time to beat again.
    assert.deepEqual(touched, []);
    assert.equal(r.recovery, undefined);
    await r.reclaim();
    assert.deepEqual(cancelled, ["p1", "p-gone", "p-sandbox"]);
    assert.deepEqual(touched, [
      "commit:2",
      "unmount:2:true",
      "unmount:3:true",
      "unmount:4:true",
    ]);
    const recovery = required((await r.status()).recovery);
    assert.deepEqual(recovery.errors, []);
    const reclaimed = recovery.reclaimed as Value[];
    assert.deepEqual(
      reclaimed.map((w) => [w.sandbox, Boolean(w.gone)]),
      [
        ["2", false],
        ["3", false],
        ["4", true],
        ["6", true],
      ],
    );
    assert.equal((reclaimed[0].commit as Value).head, "c1");
    const remaining = (await leaseRecords(r)).map((l) => l.incarnation).sort();
    assert.deepEqual(remaining, [live, r.lease.id].sort());
  } finally {
    await f.cleanup();
  }
});
test("a refused reclamation stays claimed by the live reclaimer; only a conflict discards", async () => {
  const f = await fixture();
  try {
    const r = f.create();
    r.watch = new Watch(0);
    await writeLease(r, DEAD, 0, [
      { sandbox: "2", path: "/workspaces/1", container: "c-2", retained: true },
    ]);
    let commitError: Value = { code: "Failed" };
    const unmounts: boolean[] = [];
    f.sdk.workspace.commit = async () => {
      throw Object.assign(new Error("refused"), commitError);
    };
    let busy = true;
    f.sdk.workspace.unmount = async (_ws, discard) => {
      unmounts.push(Boolean(discard));
      if (busy) throw Object.assign(new Error("busy"), { code: "Busy" });
      return { kind: "Unmounted" };
    };
    await r.initialize();
    await sandboxRecord(f.home, "2", "c-2");
    // A transient commit failure keeps the work: nothing is discarded.
    const first = await r.reclaim();
    assert.equal((first.errors as Value[])[0].code, "Failed");
    assert.deepEqual(unmounts, []);
    const claimed = `claim-${r.lease.id}-${DEAD}.json`;
    assert.ok((await readdir(r.lease.dir)).includes(claimed));
    // Another live process does not steal a claim whose reclaimer is alive.
    const other = f.create();
    other.watch = new Watch(0);
    await other.lease.write();
    await other.reclaim();
    await other.reclaim();
    assert.ok((await readdir(r.lease.dir)).includes(claimed));
    commitError = { code: "Conflict", detail: { conflicts: ["a"] } };
    assert.equal(((await r.reclaim()).errors as Value[])[0].code, "Busy");
    busy = false;
    const last = await r.reclaim();
    assert.deepEqual(last.errors, []);
    const entry = (last.reclaimed as Value[])[0];
    assert.equal((entry.discarded as Value).code, "Conflict");
    assert.ok(!(await readdir(r.lease.dir)).includes(claimed));
  } finally {
    await f.cleanup();
  }
});
test("a lease that was taken over makes its runtime refuse instead of re-owning", async () => {
  const f = await fixture();
  try {
    const victim = f.create();
    await victim.initialize();
    const reclaimer = f.create();
    reclaimer.watch = new Watch(0);
    await reclaimer.initialize();
    // Simulate a stalled victim whose lease another process claimed.
    victim.lease.stop();
    const record = JSON.parse(await readFile(victim.lease.file, "utf8"));
    await writeFile(
      victim.lease.file,
      JSON.stringify({ ...record, heartbeat: 1 }),
    );
    await reclaimer.reclaim();
    await reclaimer.reclaim();
    await assert.rejects(victim.lease.write(), /taken over/);
    assert.equal(victim.lease.lost, true);
    await assert.rejects(victim.files("read", { path: "a" }), /lease/);
    assert.ok(
      !(await readdir(victim.lease.dir)).includes(`${victim.lease.id}.json`),
    );
  } finally {
    await f.cleanup();
  }
});
test("expiry needs the reclaimer's own monotonic confirmation, and leases of this process are never claimed", async () => {
  const watch = new Watch(50);
  const stale = Date.now() - 120_000;
  assert.equal(watch.expired("a", stale), false);
  assert.equal(watch.expired("a", stale), false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(watch.expired("a", stale), true);
  // A heartbeat that moved restarts the confirmation; a fresh one is live.
  assert.equal(watch.expired("a", stale + 1), false);
  assert.equal(watch.expired("a", Date.now()), false);
  const f = await fixture();
  try {
    const worker = f.create(config, { role: "worker" });
    await worker.initialize();
    const record = JSON.parse(await readFile(worker.lease.file, "utf8"));
    await writeFile(
      worker.lease.file,
      JSON.stringify({ ...record, heartbeat: 1 }),
    );
    const lead = f.create();
    lead.watch = new Watch(0);
    await lead.initialize();
    await lead.reclaim();
    assert.ok(
      (await readdir(lead.lease.dir)).includes(`${worker.lease.id}.json`),
    );
  } finally {
    await f.cleanup();
  }
});
test("a Workspace whose Sandbox vanished no longer blocks the runtime", async () => {
  const f = await fixture();
  try {
    const r = f.create();
    await r.initialize();
    f.setExec(async () => {
      throw Object.assign(new Error("lost"), { code: "NoSuchSandbox" });
    });
    f.setUnmount(
      Object.assign(new Error("gone"), {
        code: "NoSuchSandbox",
        detail: { containerGone: true },
      }),
    );
    await assert.rejects(r.bash("true"), OperationError);
    const status = await r.status();
    assert.equal(status.ready, true);
    assert.deepEqual(status.mounted, []);
    f.setExec(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    f.setUnmount();
    assert.equal((await r.bash("true")).commit?.kind, "UpToDate");
    // A transport failure, by contrast, keeps the Workspace for recovery.
    f.setUnmount(new Error("transport"));
    await assert.rejects(r.bash("true"), OperationError);
    assert.equal((await r.status()).ready, false);
    f.setUnmount(Object.assign(new Error("gone"), { code: "NotMounted" }));
    await r.cleanup();
    assert.equal((await r.status()).ready, true);
  } finally {
    await f.cleanup();
  }
});
test("credential preflight refuses private keys but admits public bundles in environments", async () => {
  const f = await fixture();
  try {
    const site = join(f.root, ".venv/lib/python3.12/site-packages");
    await mkdir(join(site, "certifi"), { recursive: true });
    await mkdir(join(site, "pyright/stubs/google/auth/credentials"), {
      recursive: true,
    });
    await writeFile(
      join(site, "certifi/cacert.pem"),
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
    );
    await writeFile(join(f.root, ".env.example"), "TOKEN=\n");
    await writeFile(join(f.root, "slides.key"), "PK\u0003\u0004keynote");
    assert.deepEqual(await sensitiveFiles(f.root), []);
    await writeFile(
      join(f.root, "server.pem"),
      "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n-----BEGIN EC PRIVATE KEY-----\ny\n",
    );
    await writeFile(join(f.root, ".env.local"), "TOKEN=x\n");
    await mkdir(join(f.root, "home/.ssh"), { recursive: true });
    await writeFile(join(f.root, "home/.ssh/id_ecdsa"), "x");
    assert.deepEqual((await sensitiveFiles(f.root)).sort(), [
      ".env.local",
      "home/.ssh/id_ecdsa",
      "server.pem",
    ]);
  } finally {
    await f.cleanup();
  }
});
test("removal sees every lease holder and which ones look expired", async () => {
  const f = await fixture();
  try {
    const a = f.create(config, { agent: "a" });
    await a.lease.write();
    await writeLease(a, DEAD, 1, []);
    await writeFile(
      join(a.lease.dir, "33333333-3333-4333-8333-333333333333.json"),
      "{",
    );
    assert.deepEqual([...(await leaseHolders(a.lease.dir))].sort(), [
      [DEAD, true],
      ["a", false],
      ["unreadable:33333333-3333-4333-8333-333333333333.json", true],
    ]);
  } finally {
    await f.cleanup();
  }
});
