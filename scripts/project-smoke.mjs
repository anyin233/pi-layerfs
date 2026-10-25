import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bundledSDK } from "../dist/config.js";
import { createRuntime } from "../dist/runtime.js";

// Run through the installed --exec launcher in a disposable host fixture.
// Unlike release-smoke, this checks a real host bind, including APFS sharing.
const root = process.cwd();
const source = await readFile(join(root, "README.md"), "utf8");
assert.match(source, /^pi-layerfs host fixture /);
const project = `host-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
const config = {
  sdk: bundledSDK,
  project,
  branch: "host-work",
  initialize: true,
  failWhenUnavailable: true,
  timeoutSeconds: 30,
  logLevel: "silent",
};
const runtime = await createRuntime(root, config);
let workspace;
try {
  await runtime.initialize();
  await assert.rejects(writeFile(join(root, "must-not-exist.txt"), "blocked"), {
    code: "EROFS",
  });
  await assert.rejects(access(join(root, ".pi")), { code: "ENOENT" });
  assert.equal(
    (await runtime.sdk.fs.read(config.branch, "/README.md")).text,
    source,
  );
  workspace = await runtime.mount(config.branch);
  const result = await runtime.sdk.workspace.exec(
    workspace,
    "printf 'saved in LayerFS\\n' > generated.txt; node -e 'if (6 * 7 !== 42) process.exit(1)'",
    "host fixture test",
  );
  assert.equal(result.exitCode, 0);
  await runtime.sdk.workspace.commit(workspace, "host fixture commit");
  await runtime.sdk.workspace.unmount(workspace);
  workspace = undefined;
} finally {
  if (workspace) await runtime.sdk.workspace.unmount(workspace, true);
  await runtime.shutdown();
}
const reopened = await createRuntime(root, { ...config, initialize: false });
try {
  await reopened.initialize();
  assert.equal(
    (await reopened.sdk.fs.read(config.branch, "/generated.txt")).text,
    "saved in LayerFS\n",
  );
  assert.equal(await readFile(join(root, "README.md"), "utf8"), source);
  await assert.rejects(access(join(root, "generated.txt")), { code: "ENOENT" });
  console.log(
    JSON.stringify({
      ok: true,
      project,
      source: root,
      volume: process.env.LAYERFS_VOLUME,
      readOnlyHost: true,
      sourceUnchanged: true,
      reopened: true,
    }),
  );
} finally {
  await reopened.shutdown();
}
