import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { docker } from "./docker.js";
import type { Value, Workspace } from "./runtime.js";

// Workspaces live in Sandbox daemons, not in this process. A Pi process that
// dies keeps its overlays mounted, so its Sandbox never idles out and its disk
// is never returned. Every Runtime therefore records what it holds in a
// heartbeat file that any live process of the same Store can take over.
export const HEARTBEAT_MS = 10_000;
export const EXPIRY_MS = 60_000;
// Wall time jumps over a host suspend while timers do not. An expired lease is
// taken only after the reclaimer itself saw it unchanged for this long on the
// monotonic clock, which gives a resumed owner time to beat again.
export const CONFIRM_MS = 2 * HEARTBEAT_MS;

// The container id makes a Workspace identity unique: Sandbox numbers are
// reused after LayerFS reclaims a stopped container, and each new daemon
// numbers Workspace paths from 1 again.
export type Held = {
  sandbox: string;
  path: string;
  container: string;
  retained: boolean;
};
export type LeaseRecord = {
  incarnation: string;
  // The holding process, so a dead holder is recognized before expiry.
  owner: string;
  pid: number;
  agent: string;
  label: string;
  branch: string;
  heartbeat: number;
  workspaces: Held[];
  processes: string[];
};
export type Claim = { file: string; record: LeaseRecord };

// NotMounted and NoSuchSandbox are final: the daemon never reuses a Workspace
// directory, and a gone or stopped container lost every mount and process.
export const workspaceGone = (error: unknown) =>
  ["NotMounted", "NoSuchSandbox"].includes(
    String((error as { code?: unknown })?.code),
  );

// Leases beating in this process are never claimed by its own reclaimer.
const beating = new Set<string>();

export class Lease {
  readonly id = randomUUID();
  private timer: ReturnType<typeof setInterval> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private written = false;
  private beat = 0;
  private released = false;
  lost = false;
  error: Value | undefined;
  constructor(
    readonly dir: string,
    private describe: () => Omit<
      LeaseRecord,
      "incarnation" | "owner" | "pid" | "heartbeat"
    >,
  ) {}
  get file() {
    return join(this.dir, `${this.id}.json`);
  }
  // Writes are chained so a heartbeat never replaces a newer holding list. A
  // lease that vanished was taken over: recreating it would give two
  // processes the same Workspaces.
  write() {
    const next = this.writing.then(async () => {
      if (this.released) return;
      if (this.lost) throw new Error("LayerFS lease was taken over");
      if (this.written && !(await present(this.file))) {
        this.lost = true;
        throw new Error(
          "LayerFS lease was taken over by another process after this one stalled; start a new session",
        );
      }
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      const record: LeaseRecord = {
        incarnation: this.id,
        owner: await ownerIdentity(),
        pid: process.pid,
        heartbeat: Date.now(),
        ...this.describe(),
      };
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await rename(temporary, this.file);
      this.written = true;
      this.beat = performance.now();
    });
    this.writing = next.catch(() => undefined);
    return next;
  }
  // Holdings are trustworthy only while the lease cannot have expired.
  get healthy() {
    return (
      !this.lost &&
      (!this.written || performance.now() - this.beat < EXPIRY_MS / 2)
    );
  }
  start(tick?: () => Promise<void>) {
    if (this.timer) return;
    beating.add(this.id);
    this.timer = setInterval(() => {
      this.write().then(
        () => {
          this.error = undefined;
          if (this.timer) return tick?.();
        },
        (e) => {
          // A missed heartbeat lets others reclaim after EXPIRY_MS; report it.
          this.error = { message: String((e as Error)?.message ?? e) };
        },
      );
    }, HEARTBEAT_MS);
    this.timer.unref();
  }
  // Leaves the file to expire so another process reclaims what is still held.
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    beating.delete(this.id);
  }
  async release() {
    this.stop();
    this.released = true;
    await this.writing;
    await rm(this.file, { force: true });
  }
}

async function present(file: string) {
  try {
    await stat(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
async function names(dir: string) {
  try {
    return await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
// A record, undefined when absent, or "unreadable" for a torn write.
async function readRecord(
  file: string,
): Promise<LeaseRecord | "unreadable" | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    return JSON.parse(text) as LeaseRecord;
  } catch {
    return "unreadable";
  }
}

let identity: Promise<string> | undefined;
// This process's container. Host networking gives containers the Engine
// host's name, so the identity comes from Docker's per-container hostname
// mount; a process outside any container is named by its host.
export function ownerIdentity() {
  identity ??= readFile("/proc/self/mountinfo", "utf8")
    .then(
      (info) => info.match(/\/containers\/([0-9a-f]{64})\//)?.[1],
      (e) => {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      },
    )
    .then((id) => (id ? `container:${id}` : `host:${hostname()}`));
  return identity;
}
// Only positive evidence counts: the holder's process is gone from this
// container, or its container is removed or stopped. A holder elsewhere, or a
// reused pid, waits for expiry instead.
async function holderDead(record: LeaseRecord) {
  if (record.owner === (await ownerIdentity())) {
    try {
      process.kill(record.pid, 0);
      return false;
    } catch (e) {
      // EPERM: the pid exists under another user.
      return (e as NodeJS.ErrnoException).code === "ESRCH";
    }
  }
  const id = record.owner?.match(/^container:([0-9a-f]{64})$/)?.[1];
  if (!id) return false;
  try {
    const container = await docker(`/containers/${id}/json`);
    return !(container.State as { Running?: boolean } | undefined)?.Running;
  } catch (e) {
    if (/: 404 /.test((e as Error).message)) return true;
    throw e;
  }
}

// Whether an incarnation's lease may be taken: its holder is provably dead,
// or it released, lost or stopped beating its lease and this process confirmed
// that. A torn lease file falls back to its modification time.
export async function stale(dir: string, incarnation: string, watch: Watch) {
  const file = join(dir, `${incarnation}.json`);
  const record = await readRecord(file);
  if (record !== "unreadable") {
    if (record && (await holderDead(record))) return true;
    return watch.expired(incarnation, record?.heartbeat);
  }
  let beat: number | undefined;
  try {
    beat = (await stat(file)).mtimeMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return watch.expired(incarnation, beat);
}

// Remembers when this process first saw each owner's current heartbeat.
export class Watch {
  private seen = new Map<string, { beat: number | undefined; at: number }>();
  constructor(readonly confirmMs = CONFIRM_MS) {}
  expired(owner: string, beat: number | undefined, wall = Date.now()) {
    if (beat !== undefined && wall - beat < EXPIRY_MS) {
      this.seen.delete(owner);
      return false;
    }
    const now = performance.now();
    const prior = this.seen.get(owner);
    if (!prior || prior.beat !== beat) {
      this.seen.set(owner, { beat, at: now });
      return false;
    }
    return now - prior.at >= this.confirmMs;
  }
}

// Takes every lease whose owner died or stopped beating, and claims left by a
// reclaimer that died, by an atomic rename that only one process wins.
export async function claimExpired(dir: string, self: string, watch: Watch) {
  const claims: Claim[] = [],
    errors: Value[] = [];
  for (const name of await names(dir)) {
    const own = name.match(/^([a-f0-9-]{36})\.json$/);
    const taken = name.match(/^claim-([a-f0-9-]{36})-([a-f0-9-]{36})\.json$/);
    if (!own && !taken) continue;
    const owner = own?.[1] ?? taken?.[1] ?? "";
    const original = own?.[1] ?? taken?.[2] ?? "";
    // Own claims are retried; leases of this process are alive by definition.
    if (owner === self ? !taken : beating.has(owner)) continue;
    if (owner !== self && !(await stale(dir, owner, watch))) continue;
    const file = join(dir, `claim-${self}-${original}.json`);
    if (name !== `claim-${self}-${original}.json`) {
      try {
        await rename(join(dir, name), file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
    }
    const record = await readRecord(file);
    if (record === "unreadable") {
      // Its holdings are unknown; keep the evidence out of the scan.
      const evidence = join(dir, `unreadable-${original}.json`);
      await rename(file, evidence);
      errors.push({
        phase: "scan",
        file: evidence,
        message: "Unreadable lease; its Workspaces are unknown",
      });
    } else if (record) claims.push({ file, record });
  }
  return { claims, errors };
}

// Agents of every lease present on this Store, and whether it looks expired.
export async function leaseHolders(dir: string, wall = Date.now()) {
  const agents = new Map<string, boolean>();
  for (const name of await names(dir)) {
    if (!/^(claim-[a-f0-9-]{36}-)?[a-f0-9-]{36}\.json$/.test(name)) continue;
    const record = await readRecord(join(dir, name));
    if (record === "unreadable") agents.set(`unreadable:${name}`, true);
    else if (record)
      agents.set(record.agent, wall - record.heartbeat >= EXPIRY_MS);
  }
  return agents;
}

export const workspaceKey = (ws: Pick<Workspace, "sandbox" | "path">) =>
  `${ws.sandbox}:${ws.path}`;
