import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const file = resolve(process.argv[2] ?? "release-out/pi-layerfs-0.1.0.tgz");
const listing = spawnSync("tar", ["-tzf", file], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
assert.equal(listing.status, 0, listing.stderr);
const names = listing.stdout.trim().split("\n");
for (const name of [
  "dist/extension.js",
  "bin/pi-layerfs",
  "scripts/container-entry.mjs",
  "scripts/release-smoke.mjs",
  "scripts/host-platform.sh",
  "scripts/project-smoke.mjs",
  "vendor/layerfs/node_modules/@layerfs/agent/src/index.js",
  "vendor/layerfs/node_modules/@layerfs/backend/src/index.js",
  "vendor/layerfs/node_modules/binding/layerfs.node",
  "vendor/layerfs/bin/layerfs-daemon",
  "vendor/layerfs/ARTIFACTS.json",
  "vendor/layerfs/licenses/INDEX.json",
  "vendor/layerfs/LICENSE",
  "LICENSE",
]) {
  assert.ok(
    names.includes(`package/${name}`),
    `Missing self-contained artifact ${name}`,
  );
}
assert.ok(
  names.every((name) => name.startsWith("package/") && !name.includes("/../")),
);
// The vendored LayerFS packages are the only node_modules shipped.
assert.ok(
  names.every(
    (name) =>
      !/(?:^|\/)(?:node_modules|\.git|\.layerfs-local|\.env|auth\.json|credentials\.json)(?:\/|$)/.test(
        name.replace(/^package\/vendor\/layerfs\/node_modules\//, ""),
      ),
  ),
  "Package contains private state or duplicated host peers",
);
const directory = await mkdtemp(join(tmpdir(), "pi-layerfs-pack-check-"));
const saved = { ...process.env };
try {
  const extract = spawnSync("tar", ["-xzf", file, "-C", directory], {
    encoding: "utf8",
  });
  assert.equal(extract.status, 0, extract.stderr);
  const root = join(directory, "package");
  const native = await readFile(
    join(root, "vendor/layerfs/node_modules/binding/layerfs.node"),
  );
  assert.equal(native.subarray(0, 4).toString("hex"), "7f454c46");
  const sdk = await import(
    pathToFileURL(
      join(root, "vendor/layerfs/node_modules/@layerfs/agent/src/index.js"),
    ).href
  );
  assert.equal(typeof sdk.LayerFS, "function");
  const backend = await import(
    pathToFileURL(
      join(root, "vendor/layerfs/node_modules/@layerfs/backend/src/index.js"),
    ).href
  );
  assert.equal(typeof backend.LayerFSBackend, "function");
  for (const name of Object.keys(process.env))
    if (name.startsWith("LAYERFS_") || name.startsWith("DSH_LAYERFS_"))
      delete process.env[name];
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: join(directory, "agent"),
    settingsManager: SettingsManager.inMemory({
      defaultProjectTrust: "always",
    }),
    noExtensions: true,
    noContextFiles: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    additionalExtensionPaths: [root],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  assert.equal(
    loader.getExtensions().extensions[0].tools.size,
    0,
    "Host-only install must leave ordinary Pi tools intact",
  );
  console.log(
    JSON.stringify({
      ok: true,
      package: file,
      files: names.length,
      extractedWithoutNodeModules: true,
      hostPiLoads: true,
      nativeELF: true,
    }),
  );
} finally {
  process.env = saved;
  await rm(directory, { recursive: true, force: true });
}
