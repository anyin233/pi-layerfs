import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { environment, required } from "./config.js";
import type { SDK, Value } from "./runtime.js";

export type Methods = Record<string, (...args: unknown[]) => Promise<Value>>;
export type Surface = Record<string, Methods>;
// @layerfs/backend of an open client: Store reads and Sandbox daemon reads.
export type Backend = { store: Surface; daemon: Surface };
// Opens the project's client: LayerFS.init from `folder` when given, else LayerFS.open.
export type Connect = (folder?: string) => Promise<SDK>;
export type RuntimeOptions = {
  agent?: string;
  label?: string;
  role?: "lead" | "worker";
  deployment?: Record<string, string | undefined>;
  backend?: Backend;
  // This process's running Init of the project, read while LayerFS.init runs.
  progress?: () => Promise<Value>;
  trace?: string;
  // Minimum Sandbox age before a mount, in milliseconds.
  settle?: number;
};
export function invoke(
  target: unknown,
  group: string,
  method: string,
  args: unknown[] = [],
) {
  const object = target as Surface;
  const fn = object[group]?.[method];
  if (typeof fn !== "function")
    throw new Error(`Installed SDK lacks ${group}.${method}`);
  return fn(...args);
}
// LayerFS reads its settings from LAYERFS_* when a client is made, and
// LAYERFS_TRACE_STEP when a call starts. There is deliberately no await
// between setting, calling and restoring.
export function withDeployment<T>(
  values: Record<string, string | undefined>,
  fn: () => T,
): T {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    const key = `LAYERFS_${name}`;
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
export function traceDirectory(home: string, project: string, volume: string) {
  return join(
    home,
    "pi-traces",
    project,
    createHash("sha256").update(volume).digest("hex").slice(0, 24),
  );
}
export async function loadClient(
  sdkPath: string,
  project: string,
  options: RuntimeOptions,
): Promise<Connect> {
  const entry =
    sdkPath === "@layerfs/agent"
      ? import.meta.resolve(sdkPath)
      : pathToFileURL(sdkPath).href;
  // Resolved from the agent, so the backend shares the one loaded copy of it.
  const backendEntry = pathToFileURL(
    createRequire(fileURLToPath(entry)).resolve("@layerfs/backend"),
  ).href;
  const [{ LayerFS }, { LayerFSBackend }, { invokeBackend }] =
    await Promise.all([
      import(entry),
      import(backendEntry),
      // @layerfs/agent/internal is not public API. Init progress has no public
      // call: @layerfs/runtime reads it only for the Init jobs it runs itself.
      import(new URL("./internal.js", entry).href),
    ]);
  const deployment = options.deployment ?? {};
  const home = required(deployment.HOME ?? environment().HOME);
  const dir = traceDirectory(
    home,
    project,
    required(deployment.VOLUME ?? environment().VOLUME),
  );
  await mkdir(dir, { recursive: true, mode: 0o700 });
  options.trace ??= join(dir, `${required(options.agent)}.jsonl`);
  await mkdir(dirname(options.trace), { recursive: true, mode: 0o700 });
  options.progress = () =>
    withDeployment(deployment, () =>
      invokeBackend("runtime.project.get_init", { project, home }, {}),
    );
  return async (folder) => {
    const client = await withDeployment(
      { ...deployment, TRACE: options.trace },
      () =>
        folder === undefined
          ? LayerFS.open(project)
          : LayerFS.init(project, folder),
    );
    const step = { traceStep: options.agent };
    const labelled = (surface: Surface): Surface =>
      Object.fromEntries(
        Object.entries(surface).map(([group, methods]) => [
          group,
          Object.fromEntries(
            Object.entries(methods).map(([name, method]) => [
              name,
              (...args: unknown[]) =>
                withDeployment({ TRACE_STEP: step.traceStep }, () =>
                  method(...args),
                ),
            ]),
          ),
        ]),
      );
    const backend = LayerFSBackend.of(client);
    options.backend = {
      store: labelled(backend.store),
      daemon: labelled(backend.daemon),
    };
    return {
      ...(labelled({
        project: client.project,
        branch: client.branch,
        fs: client.fs,
        sandbox: client.sandbox,
        workspace: client.workspace,
      }) as unknown as Omit<SDK, "options" | "created" | "close">),
      options: step,
      created: client.created,
      close: () => client.close(),
    };
  };
}
