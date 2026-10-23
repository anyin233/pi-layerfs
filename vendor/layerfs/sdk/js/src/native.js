// Loads the native binding: LAYERFS_NATIVE, else native/layerfs.node.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// Every binding call runs on Node's worker pool, four threads unless the
// process sets UV_THREADPOOL_SIZE. A Sandbox exec holds its thread for the
// command's whole run, so with four agents' commands running every other call
// queued behind them (#352 F-017). Node reads the size when the pool first
// starts; a process that set it keeps its own value.
export const WORKERS = 64;
process.env.UV_THREADPOOL_SIZE ??= String(WORKERS);
let binding = null;

/** The loaded binding; loading is deferred to the first call. */
export function native() {
  if (!binding) {
    const path = process.env.LAYERFS_NATIVE || fileURLToPath(new URL("../native/layerfs.node", import.meta.url));
    binding = require(path);
  }
  return binding;
}
