import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  branchPath,
  OperationError,
  quote,
  Runtime,
  type SDK,
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
  const sdk: SDK = {
    project: {
      init: async () => {
        events.push("init");
        await mkdir(join(home, "test"));
        return { kind: "Initialized", layer: "L0-id" };
      },
      list_branches: async () => ({ items: branches, hasMore: false }),
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
      status: async () => ({}),
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
  const create = (c = config) =>
    new Runtime(root, c, sdk, async () => ({
      environment: {},
      filesystem: "ext4",
    }));
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
    assert.match(bundled.sdk, /vendor\/layerfs\/sdk\/js\/src\/index\.js$/);
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
test("parallel init fails busy rather than duplicating acquisition", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.home, "pi-bindings"));
    await mkdir(join(f.home, "pi-bindings/test.json.lock"));
    await assert.rejects(f.create().initialize(), /busy/);
    assert.ok(!f.events.includes("init"));
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
    f.sdk.project.init = async () => {
      calls++;
      throw new Error("unknown acquisition");
    };
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
