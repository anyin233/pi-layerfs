import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { docker } from "./docker.js";
import type { Value, Workspace } from "./runtime.js";

// A mounted Workspace outlives the Pi process that mounted it: a killed client
// (closed terminal, crashed or restarted container) leaves it mounted, dirty and
// possibly running its command in the shared Sandbox. Each mount records who
// holds it, so a later session can tell a dead holder from a live one.
export type Lease = {
  sandbox: string;
  path: string;
  branch: string;
  agent: string;
  retained: boolean;
  owner: string;
  pid: number;
  time: number;
  // When an ordinary command's own timeout has ended it, or null for retained
  // Workspaces, whose background processes have no bound.
  deadline: number | null;
  processes: string[];
};
let self: string | undefined;
// The holder's container. Host networking gives containers the Engine host's
// name, so the identity comes from Docker's per-container hostname mount.
export async function ownerIdentity() {
  if (self) return self;
  try {
    const id = (await readFile("/proc/self/mountinfo", "utf8")).match(
      /\/containers\/([0-9a-f]{64})\//,
    )?.[1];
    if (id) self = `container:${id}`;
  } catch {}
  self ??= `host:${hostname()}`;
  return self;
}
// Unknown holders count as alive: nothing is reclaimed on uncertain evidence.
export async function holderAlive(lease: Lease, me: string) {
  if (lease.owner === me) {
    try {
      process.kill(lease.pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  const id = lease.owner.match(/^container:([0-9a-f]{64})$/)?.[1];
  if (!id) return true;
  try {
    const container = await docker(`/containers/${id}/json`);
    return Boolean(
      (container.State as { Running?: boolean } | undefined)?.Running,
    );
  } catch (e) {
    return !/: 404 /.test(String((e as Error).message));
  }
}
export class Leases {
  constructor(readonly directory: string) {}
  private file(ws: { sandbox: string; path: string }) {
    const key = createHash("sha256")
      .update(`${ws.sandbox}:${ws.path}`)
      .digest("hex")
      .slice(0, 32);
    return join(this.directory, `${key}.json`);
  }
  async hold(
    ws: Workspace,
    data: Pick<Lease, "branch" | "agent" | "retained"> & { seconds?: number },
  ) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const time = Date.now();
    const lease: Lease = {
      sandbox: ws.sandbox,
      path: ws.path,
      branch: data.branch,
      agent: data.agent,
      retained: data.retained,
      owner: await ownerIdentity(),
      pid: process.pid,
      time,
      // timeout's own --kill-after=2s plus scheduling slack.
      deadline: data.seconds ? time + (data.seconds + 5) * 1000 : null,
      processes: [],
    };
    await this.write(lease);
    return lease;
  }
  async update(ws: Workspace, change: (lease: Lease) => void) {
    const lease = await this.read(ws);
    if (!lease) return;
    change(lease);
    await this.write(lease);
  }
  async release(ws: { sandbox: string; path: string }) {
    await rm(this.file(ws), { force: true });
  }
  async read(ws: { sandbox: string; path: string }) {
    try {
      return JSON.parse(await readFile(this.file(ws), "utf8")) as Lease;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }
  async list() {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const leases: Lease[] = [];
    for (const name of names.filter((n) => /^[0-9a-f]{32}\.json$/.test(n)))
      try {
        leases.push(
          JSON.parse(
            await readFile(join(this.directory, name), "utf8"),
          ) as Lease,
        );
      } catch {}
    return leases;
  }
  private async write(lease: Lease) {
    const file = this.file(lease);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(lease), { mode: 0o600 });
    await rename(temporary, file);
  }
}
export const sameLease = (a?: Lease, b?: Lease) =>
  Boolean(
    a && b && a.owner === b.owner && a.pid === b.pid && a.time === b.time,
  );
export const mountedWorkspaces = (snapshot: Value) =>
  new Set(
    ((snapshot.sandboxes as Value[] | undefined) ?? []).flatMap((s) =>
      ((s.workspaces as Value[] | undefined) ?? []).map(
        (w) => `${w.sandbox ?? s.id}:${w.path ?? w.directory}`,
      ),
    ),
  );
