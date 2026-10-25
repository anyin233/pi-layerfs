import { constants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const bundledSDK = fileURLToPath(
  new URL(
    "../vendor/layerfs/node_modules/@layerfs/agent/src/index.js",
    import.meta.url,
  ),
);
export function required<T>(value: T | null | undefined, name = "value"): T {
  if (value === null || value === undefined)
    throw new Error(`Required ${name} is unavailable`);
  return value;
}
export type Config = {
  sdk: string;
  project: string;
  branch: string;
  initialize: boolean;
  failWhenUnavailable: boolean;
  timeoutSeconds: number;
  logLevel: "silent" | "error" | "info";
};
export const environmentNames = [
  "HOME",
  "DOCKER",
  "IMAGE",
  "VOLUME",
  "DAEMON",
  "STORE_PATH",
  "NATIVE",
  "CONTAINER_PREFIX",
  "DAEMON_HOST",
] as const;
export function environment(env: NodeJS.ProcessEnv = process.env) {
  return Object.fromEntries(
    environmentNames.map((key) => [
      key,
      env[`LAYERFS_${key}`] ||
        env[`DSH_LAYERFS_${key}`] ||
        (key === "DOCKER" ? "/var/run/docker.sock" : undefined),
    ]),
  ) as Record<(typeof environmentNames)[number], string | undefined>;
}
export async function loadConfig(
  cwd: string,
  file = resolve(cwd, ".pi/layerfs.json"),
): Promise<Config> {
  file = resolve(cwd, file);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (cause) {
    throw new Error(`Cannot read LayerFS configuration ${file}`, { cause });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("LayerFS config must be an object");
  const c = raw as Record<string, unknown>;
  const allowed = new Set([
    "sdk",
    "project",
    "branch",
    "initialize",
    "failWhenUnavailable",
    "timeoutSeconds",
    "logLevel",
  ]);
  for (const key of Object.keys(c))
    if (!allowed.has(key))
      throw new Error(`Unknown LayerFS config field: ${key}`);
  if (typeof c.project !== "string" || !c.project)
    throw new Error("LayerFS config requires project");
  if (c.sdk !== undefined && (typeof c.sdk !== "string" || !c.sdk))
    throw new Error("LayerFS sdk must be a nonempty string when supplied");
  const config = {
    sdk: bundledSDK,
    branch: "pi-work",
    initialize: false,
    failWhenUnavailable: true,
    timeoutSeconds: 60,
    logLevel: "error",
    ...c,
  } as Config;
  if (!/^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/.test(config.project))
    throw new Error("Invalid LayerFS project name");
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(config.branch) ||
    config.branch === "main"
  )
    throw new Error("Working branch must be a non-main simple name");
  if (
    typeof config.initialize !== "boolean" ||
    typeof config.failWhenUnavailable !== "boolean"
  )
    throw new Error("initialize/failWhenUnavailable must be booleans");
  if (
    !Number.isSafeInteger(config.timeoutSeconds) ||
    config.timeoutSeconds < 1 ||
    config.timeoutSeconds > 86400
  )
    throw new Error("timeoutSeconds must be 1..86400");
  if (!["silent", "error", "info"].includes(config.logLevel))
    throw new Error("Invalid logLevel");
  if (config.sdk !== "@layerfs/agent")
    config.sdk = resolve(dirname(file), config.sdk);
  return config;
}
export function inside(root: string, path: string) {
  const delta = relative(root, resolve(path));
  return (
    delta === "" ||
    (!delta.startsWith("../") && delta !== ".." && !isAbsolute(delta))
  );
}
export function checkPlatform(
  platform = process.platform,
  version = process.versions.node,
) {
  if (platform !== "linux")
    throw new Error(`LayerFS requires Linux; got ${platform}`);
  const [major, minor] = version.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19))
    throw new Error(`Pi 1.4 requires Node >=22.19; got ${version}`);
}
export function verifyStoreMount(
  mountInfo: string,
  storeRoot: string,
  dockerMountpoint: string,
) {
  const decode = (s: string) =>
    s.replace(/\\([0-7]{3})/g, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
  const mounts = mountInfo
    .trim()
    .split("\n")
    .map((line) => {
      const [left, right] = line.split(" - ");
      const fields = left.split(" ");
      return {
        root: decode(fields[3] ?? ""),
        target: decode(fields[4] ?? ""),
        fs: right?.split(" ")[0],
      };
    })
    .filter((m) => m.target && inside(m.target, storeRoot))
    .sort((a, b) => b.target.length - a.target.length);
  const mount = mounts[0];
  if (!mount || !["ext4", "xfs", "btrfs"].includes(mount.fs ?? ""))
    throw new Error(`Unsupported Store filesystem: ${mount?.fs ?? "unknown"}`);
  if (
    storeRoot !== dockerMountpoint &&
    !(mount.target === storeRoot && mount.root === dockerMountpoint)
  )
    throw new Error(
      "LAYERFS_STORE_PATH does not resolve to the configured Docker volume root; SDK and daemon must share one Store",
    );
  return required(mount.fs);
}
export async function validateEnvironment(root: string) {
  checkPlatform();
  const env = environment();
  for (const key of [
    "HOME",
    "IMAGE",
    "VOLUME",
    "DAEMON",
    "STORE_PATH",
  ] as const)
    if (!env[key]) throw new Error(`Missing LAYERFS_${key}`);
  for (const key of ["HOME", "DOCKER", "DAEMON", "STORE_PATH"] as const)
    if (!isAbsolute(required(env[key])))
      throw new Error(`LAYERFS_${key} must be absolute`);
  if (!/^sha256:[a-f0-9]{64}$/.test(required(env.IMAGE)))
    throw new Error("LAYERFS_IMAGE must be an immutable local image ID");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(required(env.VOLUME)))
    throw new Error("Invalid LAYERFS_VOLUME");
  if (process.getuid?.() !== 0)
    throw new Error(
      "LayerFS Store installation requires uid 0; use the documented client container",
    );
  const canonicalRoot = await realpath(root);
  for (const key of ["HOME", "STORE_PATH"] as const)
    if (inside(canonicalRoot, required(env[key])))
      throw new Error(
        `LAYERFS_${key} must be outside the captured project tree`,
      );
  await access(required(env.DAEMON), constants.X_OK);
  const socket = await lstat(required(env.DOCKER));
  if (!socket.isSocket())
    throw new Error("LAYERFS_DOCKER must name a local Engine Unix socket");
  const home = await lstat(required(env.HOME));
  if (
    !home.isDirectory() ||
    home.isSymbolicLink() ||
    home.uid !== process.getuid?.() ||
    home.mode & 0o077
  )
    throw new Error("LAYERFS_HOME must be a private owned 0700 directory");
  if (inside(canonicalRoot, await realpath(required(env.HOME))))
    throw new Error("LAYERFS_HOME resolves inside the captured project tree");
  const storeRoot = await realpath(dirname(dirname(required(env.STORE_PATH))));
  if (inside(canonicalRoot, storeRoot))
    throw new Error("Store resolves inside source tree");
  await access(storeRoot, constants.W_OK);
  // Docker API checks use its documented local HTTP interface, via Node's http module.
  const { request } = await import("node:http");
  const get = (path: string) =>
    new Promise<unknown>((resolve, reject) => {
      const req = request(
        { socketPath: env.DOCKER, path, timeout: 10000 },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            try {
              if (res.statusCode !== 200)
                throw new Error(`Docker ${path}: HTTP ${res.statusCode}`);
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("Docker check timed out")));
      req.end();
    });
  await get("/version");
  const volume = (await get(
    `/volumes/${encodeURIComponent(required(env.VOLUME))}`,
  )) as {
    Mountpoint: string;
    Driver: string;
    Scope: string;
    Options: Record<string, string> | null;
  };
  if (
    volume.Driver !== "local" ||
    volume.Scope !== "local" ||
    (volume.Options && Object.keys(volume.Options).length)
  )
    throw new Error(
      "LayerFS requires an existing plain local Docker volume without options",
    );
  if (
    resolve(required(env.STORE_PATH)) !==
    resolve(storeRoot, "global/store.sqlite")
  )
    throw new Error(
      "LAYERFS_STORE_PATH must be <volume-root>/global/store.sqlite",
    );
  const fs = verifyStoreMount(
    await readFile("/proc/self/mountinfo", "utf8"),
    storeRoot,
    volume.Mountpoint,
  );
  await get(`/images/${env.IMAGE}/json`);
  await stat(required(env.DAEMON));
  return {
    environment: Object.fromEntries(
      environmentNames.map((k) => [`LAYERFS_${k}`, env[k] ? "set" : "unset"]),
    ),
    filesystem: fs,
  };
}
