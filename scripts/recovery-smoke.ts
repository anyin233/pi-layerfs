// Real LayerFS acceptance for crash recovery and concurrent session startup.
// Run through scripts/client.sh with a prepared environment.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig, required } from "../src/config.js";
import { snapshot } from "../src/history.js";
import { Operations } from "../src/operations.js";
import { createRuntime, type Value } from "../src/runtime.js";

const plugin = required(process.env.PI_LAYERFS_PLUGIN, "PI_LAYERFS_PLUGIN");
const upstream = required(
  process.env.PI_LAYERFS_UPSTREAM,
  "PI_LAYERFS_UPSTREAM",
);
const root = "/layerfs-store/recovery-fixture";
const mode = process.argv[2] ?? "main";
const receipt = (step: string, value: unknown) =>
  console.log(JSON.stringify({ step, value }));
const open = async (label: string, role?: "worker") => {
  const config = await loadConfig(root);
  return createRuntime(root, config, { label, role });
};

if (mode === "hold") {
  // Simulates a Pi process killed mid-work: one retained Workspace with
  // uncommitted changes and one in-flight ordinary Bash Workspace.
  const runtime = await open("crashing-session");
  await runtime.initialize();
  const ops = new Operations(runtime);
  const retained = (await ops.workspace("mount", {})) as Value;
  const exec = await runtime.sdk.workspace.exec(
    { sandbox: String(retained.sandbox), path: String(retained.path) },
    `printf 'kept after crash %s\\n' ${process.argv[3]} > recovered.txt`,
  );
  assert.equal(exec.exitCode, 0);
  const bash = await runtime.mount(runtime.config.branch);
  await runtime.hold(bash, false);
  console.log(JSON.stringify({ held: [...runtime.owned.values()] }));
  setInterval(() => undefined, 1 << 30);
} else if (mode === "start") {
  const runtime = await open(`concurrent-${process.pid}`);
  await runtime.initialize();
  const status = await runtime.status();
  await runtime.shutdown();
  console.log(JSON.stringify({ ready: status.ready, branch: status.branch }));
} else {
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(
    join(root, ".pi/layerfs.json"),
    JSON.stringify({
      sdk: join(upstream, "api/agent/sdk/src/index.js"),
      project: "pi-recovery",
      branch: "pi-work",
      initialize: true,
      timeoutSeconds: 10,
      logLevel: "silent",
    }),
  );
  await writeFile(join(root, "seed.txt"), "seed\n");
  const script = join(plugin, "scripts/recovery-smoke.ts");
  // node itself, not the tsx CLI, so SIGKILL ends the process holding the lease.
  const token = String(Date.now());
  const child = (arg: string) =>
    spawn(process.execPath, ["--import", "tsx", script, arg, token], {
      cwd: plugin,
      stdio: ["ignore", "pipe", "inherit"],
    });
  const firstLine = (c: ReturnType<typeof child>) =>
    new Promise<Value>((resolve, reject) => {
      createInterface({ input: required(c.stdout) }).once("line", (line) =>
        resolve(JSON.parse(line)),
      );
      c.once("exit", (code) => reject(new Error(`child exited ${code}`)));
    });

  // 1. Four processes start sessions of one project at the same time,
  // including the first capture.
  const starts = await Promise.all(
    [1, 2, 3, 4].map((n) => firstLine(child("start")).then((v) => [n, v])),
  );
  receipt("concurrent.start", starts);
  for (const [, value] of starts) assert.equal((value as Value).ready, true);

  // 2. A session holding Workspaces is killed without cleanup.
  const holder = child("hold");
  const held = (await firstLine(holder)).held as Value[];
  const exited = new Promise((resolve) => holder.once("exit", resolve));
  holder.kill("SIGKILL");
  await exited;
  receipt("crash.held", held);
  const observer = await open("observer", "worker");
  await observer.initialize();
  const mounted = async () => {
    const state = await snapshot(observer);
    return (state.sandboxes as Value[]).flatMap((s) =>
      (s.workspaces as Value[]).map((w) => `${w.sandbox}:${w.path}`),
    );
  };
  const orphans = held.map((w) => `${w.sandbox}:${w.path}`);
  const before = await mounted();
  for (const key of orphans) assert.ok(before.includes(key), key);
  receipt("crash.orphans", before);

  // 3. The holder is provably dead, so the next session's initialization
  // reclaims at once instead of waiting for its lease to expire.
  const recovering = await open("recovering-session");
  await recovering.initialize();
  const recovery = required(recovering.recovery);
  receipt("recovery", recovery);
  assert.deepEqual(recovery.errors, []);
  // Earlier interrupted runs on this Store may add their own orphans.
  const reclaimed = (recovery.reclaimed as Value[]).map(
    (w) => `${w.sandbox}:${w.path}`,
  );
  for (const key of orphans) assert.ok(reclaimed.includes(key), key);
  const after = await mounted();
  for (const key of orphans) assert.ok(!after.includes(key), key);
  const kept = await recovering.files("read", { path: "recovered.txt" });
  receipt("recovery.preserved", kept);
  assert.equal((kept as Value).text, `kept after crash ${token}\n`);
  await recovering.shutdown();
  await observer.shutdown();
  receipt("result", { ok: true, remainingMounts: after });
}
