import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const root = "/opt/pi-layerfs";
const args = process.argv.slice(2);
const privateHome = process.env.LAYERFS_HOME;
if (!privateHome)
  throw new Error("Start Pi with the installed pi-layerfs launcher.");
await mkdir(privateHome, { recursive: true, mode: 0o700 });
let configured = args.some(
  (a) => a === "--layerfs-config" || a.startsWith("--layerfs-config="),
);
try {
  await access(join(process.cwd(), ".pi/layerfs.json"));
  configured = true;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (
  !configured &&
  !args.some((a) => ["--help", "-h", "--version", "-v"].includes(a))
) {
  const identity = createHash("sha256")
    .update(process.cwd())
    .digest("hex")
    .slice(0, 12);
  const label =
    basename(process.cwd())
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 30)
      .replace(/^-+|-+$/g, "") || "project";
  const directory = "/layerfs-store/pi-launch-config";
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${identity}.json`);
  // Kept outside the source: launching Pi never writes a configuration into
  // the host project, and reopening uses the same deterministic binding.
  try {
    await writeFile(
      file,
      JSON.stringify(
        {
          project: `${label}-${identity}`,
          branch: "pi-work",
          initialize: true,
          logLevel: "info",
        },
        null,
        2,
      ),
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    JSON.parse(await readFile(file, "utf8"));
  }
  args.unshift("--layerfs-config", file);
}
const child = spawn(
  process.execPath,
  [
    "/opt/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    "--no-extensions",
    "--extension",
    `${root}/dist/extension.js`,
    ...args,
  ],
  { stdio: "inherit", env: process.env },
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
});
