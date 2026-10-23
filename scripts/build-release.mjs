import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const args = process.argv.slice(2);
const source = resolve(
  args.includes("--upstream")
    ? args[args.indexOf("--upstream") + 1]
    : ".build/layerfs",
);
const out = resolve("release-out");
await mkdir(out, { recursive: true });
async function run(program, argv, capture = false) {
  return new Promise((resolveRun, reject) => {
    const p = spawn(program, argv, {
      cwd: root,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    if (capture)
      p.stdout.on("data", (b) => {
        stdout += b;
      });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolveRun(stdout.trim())
        : reject(new Error(`${program} exited ${code}`)),
    );
  });
}
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function parseJSON(text, label) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`Invalid ${label}`, { cause });
  }
}
await run("npm", ["run", "build"]);
if (args.includes("--upstream"))
  await run(process.execPath, ["scripts/vendor-runtime.mjs", source]);
else await run("bash", ["scripts/build-native.sh", source]);
const info = parseJSON(
  await readFile("package.json", "utf8"),
  "package metadata",
);
assert.equal(info.version, (await readFile("VERSION", "utf8")).trim());
const packed = parseJSON(
  await run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", out],
    true,
  ),
  "npm pack response",
);
const plugin = join(out, packed[0].filename);
await run(process.execPath, ["scripts/check-package.mjs", plugin]);
const tag = `pi-layerfs:${info.version}-linux-x64`;
const sourceRevision = await run("git", ["rev-parse", "HEAD"], true);
await run("docker", [
  "build",
  "--platform",
  "linux/amd64",
  "--label",
  `org.opencontainers.image.revision=${sourceRevision}`,
  "-f",
  "container/Dockerfile",
  "-t",
  tag,
  ".",
]);
const image = await run(
  "docker",
  ["image", "inspect", "--format", "{{.Id}}", tag],
  true,
);
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const stage = await mkdtemp(join(out, ".bundle-"));
const name = `pi-layerfs-${info.version}-linux-x64`;
const bundle = join(stage, name);
await mkdir(bundle);
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "VERSION"])
  await copyFile(name, join(bundle, name));
await copyFile("release/install.sh", join(bundle, "install.sh"));
await chmod(join(bundle, "install.sh"), 0o755);
await copyFile(plugin, join(bundle, "plugin.tgz"));
await writeFile(join(bundle, "IMAGE_ID"), `${image}\n`);
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
console.log("Exporting complete runtime image (this can take a minute)...");
await run("bash", [
  "-c",
  `set -o pipefail; docker image save ${quote(image)} | gzip -1 > ${quote(join(bundle, "runtime-image.tar.gz"))}`,
]);
const manifest = {
  name: info.name,
  version: info.version,
  platform: "linux-x64",
  image,
  sourceRevision,
  layerfsRevision: "1aa56ece78e2ecd71b46cf07076100345df47239",
  piVersion: "1.4.0",
  externalRequirements: [
    "Linux x86_64",
    "Docker Engine with its Unix socket",
    "/dev/fuse",
    "plain local ext4/xfs/btrfs Docker volume",
  ],
  installDownloads: false,
  modelCredentialsBundled: false,
};
await writeFile(
  join(bundle, "release-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
const names = [
  "IMAGE_ID",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "VERSION",
  "install.sh",
  "plugin.tgz",
  "release-manifest.json",
  "runtime-image.tar.gz",
];
const sums = [];
for (const name of names)
  sums.push(`${await sha256(join(bundle, name))}  ${name}`);
await writeFile(join(bundle, "SHA256SUMS"), `${sums.join("\n")}\n`);
const archive = join(out, `${name}.tar.gz`);
await run("bash", [
  "-c",
  `set -o pipefail; tar -C ${quote(stage)} -cf - ${quote(name)} | gzip -1 > ${quote(`${archive}.tmp`)}`,
]);
await rename(`${archive}.tmp`, archive);
const artifacts = [plugin, archive];
const checksums = [];
for (const path of artifacts)
  checksums.push(`${await sha256(path)}  ${path.slice(out.length + 1)}`);
await writeFile(join(out, "SHA256SUMS"), `${checksums.join("\n")}\n`);
await writeFile(
  join(out, "release-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    plugin,
    archive,
    image,
    checksums: join(out, "SHA256SUMS"),
    extractedBundle: bundle,
  }),
);
