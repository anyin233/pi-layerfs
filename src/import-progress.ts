import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";

export type Counts = { entries: number; files: number; bytes: number };
/** Metadata-only scan matching Init: no ignores, no symlink traversal. */
export async function scanSource(
  root: string,
  report: (counts: Counts) => void = () => {},
) {
  const counts: Counts = { entries: 1, files: 0, bytes: 0 },
    hardlinks = new Set<string>();
  async function visit(directory: string) {
    for await (const entry of await opendir(directory)) {
      counts.entries++;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const info = await lstat(path);
        const id = `${info.dev}:${info.ino}`;
        if (info.nlink <= 1 || !hardlinks.has(id)) {
          counts.files++;
          counts.bytes += info.size;
          if (info.nlink > 1) hardlinks.add(id);
        }
      }
      if (counts.entries % 100 === 0) report({ ...counts });
    }
    report({ ...counts });
  }
  await visit(root);
  return counts;
}
