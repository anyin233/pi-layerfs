import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { environment, required } from "./config.js";
import type { SDK, Value } from "./runtime.js";

export type Methods = Record<string, (...args: unknown[]) => Promise<Value>>;
export type Surface = Record<string, Methods>;
export type RuntimeOptions = {
  agent?: string;
  label?: string;
  role?: "lead" | "worker";
  deployment?: Record<string, string | undefined>;
  operator?: Surface;
  trace?: string;
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
// Upstream DSH clientFor uses exactly this synchronous environment admission.
// There is deliberately no await between setting, constructing and restoring.
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
) {
  const entry =
    sdkPath === "@layerfs/sdk"
      ? import.meta.resolve(sdkPath)
      : pathToFileURL(sdkPath).href;
  const operatorEntry =
    sdkPath === "@layerfs/sdk"
      ? import.meta.resolve("@layerfs/sdk/operator")
      : new URL("../operator/index.js", entry).href;
  const [{ LayerFS }, { LayerFSOperator }] = await Promise.all([
    import(entry),
    import(operatorEntry),
  ]);
  const home = required(options.deployment?.HOME ?? environment().HOME);
  const dir = traceDirectory(
    home,
    project,
    required(options.deployment?.VOLUME ?? environment().VOLUME),
  );
  await mkdir(dir, { recursive: true, mode: 0o700 });
  options.trace ??= join(dir, `${required(options.agent)}.jsonl`);
  await mkdir(dirname(options.trace), { recursive: true, mode: 0o700 });
  const sdk: SDK = withDeployment(
    options.deployment ?? {},
    () =>
      new LayerFS(project, { trace: options.trace, traceStep: options.agent }),
  );
  options.operator = new LayerFSOperator(sdk);
  return sdk;
}
