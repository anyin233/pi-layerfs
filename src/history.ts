import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { required } from "./config.js";
import { invoke } from "./ports.js";
import type { Runtime, Value } from "./runtime.js";

/** Same-tree Layer -> Commit mapping used by upstream DSH Files reads. */
export async function compareSaved(runtime: Runtime, args: Value) {
  const snapshot = await invoke(
    runtime.options.operator,
    "inspect",
    "snapshot",
  );
  const commits = snapshot.commits as Value[],
    layers = snapshot.layers as Value[],
    branches = snapshot.branches as Value[];
  const comparable = (input: unknown) => {
    const original = String(required(input));
    const branch = branches.find((b) => b.name === original);
    const ref = String(branch ? (branch.head ?? branch.base) : original);
    const commit = commits.find((c) => c.id === ref);
    if (commit) return { commit: ref, root: commit.root, check: false };
    const layer = layers.find((l) => l.id === ref);
    if (!layer) return { commit: ref, root: undefined, check: false };
    const same = commits.find((c) => c.root === layer.root);
    if (!same && !layer.sourceCommit)
      throw Object.assign(
        new Error(
          "This Layer has no same-tree Commit (for example genesis); compare a file with diff_files instead",
        ),
        { code: "NotComparable" },
      );
    return {
      commit: same?.id ?? layer.sourceCommit,
      root: layer.root,
      check: !same,
    };
  };
  const from = comparable(args.from),
    to = comparable(args.to);
  if (from.root !== undefined && from.root === to.root)
    return { items: [], hasMore: false, nextPagePos: null };
  const page = await invoke(runtime.sdk, "branch", "diff_commits", [
    from.commit,
    to.commit,
    args.limit ?? 100,
    args.page ?? 0,
    { cursor: args.cursor, hunks: false },
  ]);
  if (
    (from.check && (page.from as Value)?.root !== from.root) ||
    (to.check && (page.to as Value)?.root !== to.root)
  )
    throw Object.assign(
      new Error(
        "Published Layer differs from its source Commit; no equivalent Commit is available",
      ),
      { code: "NotComparable" },
    );
  return page;
}
const traceName = (file: string) => {
  if (!/^(events|[a-f0-9-]{36})\.jsonl$/.test(file))
    throw new Error("Invalid trace filename");
  return file;
};
export async function traceFiles(directory: string) {
  const files = [];
  for (const name of await readdir(directory)) {
    if (!/^(events|[a-f0-9-]{36})\.jsonl$/.test(name)) continue;
    const metadata = await stat(join(directory, name));
    files.push({ name, bytes: metadata.size, modified: metadata.mtimeMs });
  }
  return { items: files.sort((a, b) => a.name.localeCompare(b.name)) };
}
/** Bounded complete JSONL pages; byte cursor is stable for append-only traces. */
export async function tracePage(
  directory: string,
  file: string,
  offset = 0,
  limit = 500,
) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw new Error("Invalid trace cursor/limit");
  const handle = await open(join(directory, traceName(file)), "r");
  try {
    const size = (await handle.stat()).size;
    if (offset > size)
      throw new Error("Trace cursor exceeds file size; journal was replaced");
    const buffer = Buffer.alloc(Math.min(size - offset, 4 * 1024 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const bytes = buffer.subarray(0, bytesRead);
    const end = bytes.lastIndexOf(10);
    if (end < 0) {
      if (bytesRead === 4 * 1024 * 1024)
        throw new Error(
          "One trace record exceeds 4 MiB; inspect the retained journal on disk",
        );
      return {
        items: [],
        nextOffset: offset,
        hasMore: false,
        pending: bytesRead > 0,
        size,
      };
    }
    const items: Value[] = [];
    let consumed = 0;
    for (const line of bytes
      .subarray(0, end + 1)
      .toString("utf8")
      .split("\n")
      .slice(0, -1)) {
      consumed += Buffer.byteLength(line) + 1;
      if (!line) continue;
      try {
        items.push({
          ...JSON.parse(line),
          agent:
            file === "events.jsonl"
              ? JSON.parse(line).agent
              : file.slice(0, -6),
        });
      } catch {
        throw new Error(
          `Malformed trace record at byte ${offset + consumed}; journal retained`,
        );
      }
      if (items.length >= limit) break;
    }
    return {
      items,
      nextOffset: offset + consumed,
      hasMore: offset + consumed < size,
      size,
    };
  } finally {
    await handle.close();
  }
}
