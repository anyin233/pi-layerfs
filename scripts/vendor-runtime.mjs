import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(process.argv[2] ?? ".build/layerfs");
const revision = "ad78914e36b258b360daf13aec164b5655814689";
function run(program, args) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${program}: ${result.stderr}`);
  return result.stdout.trim();
}
assert.equal(run("git", ["-C", source, "rev-parse", "HEAD"]), revision);
assert.equal(
  run("git", ["-C", source, "status", "--porcelain", "--untracked-files=no"]),
  "",
  "Upstream source must match the qualified revision",
);
// Unmodified packages, side by side as npm installs them, so @layerfs/backend
// resolves its bare @layerfs/agent import to the one copy this package loads.
for (const [from, to] of [
  ["api/agent/sdk", "vendor/layerfs/node_modules/@layerfs/agent"],
  ["api/backend", "vendor/layerfs/node_modules/@layerfs/backend"],
]) {
  await rm(join(root, to), { recursive: true, force: true });
  for (const name of ["package.json", "src"])
    await cp(join(source, from, name), join(root, to, name), {
      recursive: true,
    });
}
const destinations = [
  [
    "core/target/pi-bookworm/release/layerfs-daemon",
    "vendor/layerfs/bin/layerfs-daemon",
  ],
  [
    // Where @layerfs/agent's default addon path (<package>/../../binding) resolves.
    "core/target/pi-bookworm/layerfs.node",
    "vendor/layerfs/node_modules/binding/layerfs.node",
  ],
];
const artifacts = [];
for (const [from, to] of destinations) {
  const input = join(source, from),
    output = join(root, to);
  await access(input);
  await mkdir(dirname(output), { recursive: true });
  await copyFile(input, output);
  await chmod(output, 0o755);
  artifacts.push({
    path: to.replace("vendor/layerfs/", ""),
    sha256: createHash("sha256")
      .update(await readFile(output))
      .digest("hex"),
  });
}
// Cargo's locked metadata names the complete dependency set, including its
// locally patched fuser crate. Preserve license texts, not registry credentials.
let metadata;
try {
  metadata = JSON.parse(
    run("cargo", [
      "+1.85.1",
      "metadata",
      "--manifest-path",
      join(source, "core/Cargo.toml"),
      "--format-version",
      "1",
      "--locked",
      "--offline",
    ]),
  );
} catch (cause) {
  throw new Error("Cannot read locked Cargo dependency metadata", { cause });
}
const licensesRoot = join(root, "vendor/layerfs/licenses");
await rm(licensesRoot, { recursive: true, force: true });
await mkdir(licensesRoot, { recursive: true });
const index = [];
async function licenseFiles(directory, depth = 0) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["target", ".git", "node_modules"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (
      entry.isFile() &&
      /^(licen[cs]e|copying|notice|copyright|authors)(?:[.\-_].*)?$/i.test(
        entry.name,
      )
    )
      files.push(path);
    else if (entry.isDirectory() && depth < 5)
      files.push(...(await licenseFiles(path, depth + 1)));
  }
  return files;
}
for (const pkg of metadata.packages) {
  let directory = dirname(pkg.manifest_path);
  let files = await licenseFiles(directory);
  if (!files.length && pkg.name.startsWith("layerfs-")) {
    directory = source;
    files = [join(source, "LICENSE")];
  } else if (
    !files.length &&
    (pkg.name.startsWith("napi") || pkg.name === "rsqlite-vfs")
  ) {
    directory = join(root, "vendor/layerfs/supplemental-licenses");
    files = [
      join(
        directory,
        pkg.name.startsWith("napi") ? "napi-rs-LICENSE" : "rsqlite-vfs-LICENSE",
      ),
    ];
  } else if (!files.length && pkg.name.startsWith("winapi-")) {
    const winapi = metadata.packages.find(
      (candidate) => candidate.name === "winapi",
    );
    assert.ok(winapi);
    directory = dirname(winapi.manifest_path);
    files = await licenseFiles(directory);
  }
  assert.ok(
    files.length,
    `Missing license text for ${pkg.name}@${pkg.version}`,
  );
  const names = [];
  for (const file of files) {
    const name = `${pkg.name}-${pkg.version}/${relative(directory, file)}`;
    const output = join(licensesRoot, name);
    await mkdir(dirname(output), { recursive: true });
    await copyFile(file, output);
    names.push(name);
  }
  index.push({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    repository: pkg.repository,
    licenseFiles: names,
  });
}
const sysroot = run("rustc", ["+1.85.1", "--print", "sysroot"]);
const rustLicense = join(sysroot, "share/doc/rust");
for (const name of ["COPYRIGHT", "LICENSE-APACHE", "LICENSE-MIT"]) {
  await copyFile(
    join(rustLicense, name),
    join(licensesRoot, `Rust-1.85.1-${name}`),
  );
}
await writeFile(
  join(licensesRoot, "INDEX.json"),
  `${JSON.stringify(index, null, 2)}\n`,
);
await writeFile(
  join(root, "vendor/layerfs/ARTIFACTS.json"),
  `${JSON.stringify({ upstream: revision, platform: "linux-x64", build: "Rust 1.85.1 / Debian Bookworm", glibcMinimum: "2.36", artifacts, rustDependencies: index.length }, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    nativeArtifacts: artifacts.length,
    licensedPackages: index.length,
    packagesWithoutLicenseFiles: index
      .filter((p) => !p.licenseFiles.length)
      .map((p) => `${p.name}@${p.version}`),
  }),
);
