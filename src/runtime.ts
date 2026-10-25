import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Config,
  environment,
  inside,
  required,
  validateEnvironment,
} from "./config.js";
import {
  claimExpired,
  heartbeatOf,
  Lease,
  Watch,
  workspaceGone,
  workspaceKey,
} from "./lease.js";
import {
  type Connect,
  invoke,
  loadClient,
  type RuntimeOptions,
  traceDirectory,
  withDeployment,
} from "./ports.js";

export type Value = Record<string, unknown>;
export type Page = { items: Value[]; hasMore: boolean };
export type Workspace = {
  sandbox: string;
  path: string;
  [key: string]: unknown;
};
export interface SDK {
  options?: { traceStep?: string };
  // Init's answer, on a client LayerFS.init made.
  created?: Value;
  project: {
    list_branches(size?: number, pos?: number): Promise<Page>;
    list_sandboxes(size?: number, pos?: number): Promise<Page>;
  };
  branch: {
    fork(name: string, from?: string): Promise<Value>;
    list_commits(name: string, size?: number, pos?: number): Promise<Page>;
  };
  fs: {
    read(
      ref: string,
      path: string,
      start?: number,
      end?: number,
    ): Promise<Value>;
    write(branch: string, path: string, text: string): Promise<Value>;
    edit(
      branch: string,
      path: string,
      oldText: string,
      newText: string,
    ): Promise<Value>;
    apply(branch: string, changes: Value[], message?: string): Promise<Value>;
    list(ref: string, path: string, size?: number, pos?: number): Promise<Page>;
    glob(
      ref: string,
      pattern: string,
      path: string,
      size?: number,
      pos?: number,
    ): Promise<Page>;
    grep(
      ref: string,
      pattern: string,
      path: string,
      size?: number,
      pos?: number,
    ): Promise<Page>;
  };
  sandbox: {
    create(options?: { image?: string }): Promise<Value & { sandbox: string }>;
    list_workspaces(
      sandbox: string,
      size?: number,
      pos?: number,
    ): Promise<Page & { version?: unknown }>;
  };
  workspace: {
    mount(sandbox: string, branch: string): Promise<Workspace>;
    exec(
      ws: Workspace,
      command: string,
      message?: string,
      sinks?: { stdout?: Writable; stderr?: Writable },
    ): Promise<Value>;
    commit(ws: Workspace, message?: string, force?: boolean): Promise<Value>;
    unmount(ws: Workspace, discard?: boolean): Promise<Value>;
  };
  close(): Promise<void>;
}
class Capture extends Writable {
  private chunks: Buffer[] = [];
  tail = Buffer.alloc(0);
  bytes = 0;
  private kept = 0;
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.bytes += chunk.length;
    this.tail = Buffer.from(Buffer.concat([this.tail, chunk]).subarray(-256));
    const part = chunk.subarray(0, Math.max(0, 24 * 1024 - this.kept));
    if (part.length) {
      this.chunks.push(Buffer.from(part));
      this.kept += part.length;
    }
    callback();
  }
  prefix(bytes: number) {
    return Buffer.concat(this.chunks).subarray(0, bytes).toString("utf8");
  }
  get text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
  get truncated() {
    return this.bytes > this.kept;
  }
}
export function errorData(error: unknown): Value {
  const e = error as {
    code?: string;
    message?: string;
    cause?: unknown;
    detail?: unknown;
  };
  return {
    code: e?.code,
    detail: e?.detail,
    message: e?.message ?? String(error),
  };
}
export class OperationError extends Error {
  constructor(
    public operation: string,
    public errors: Value[],
    public result?: Value,
  ) {
    super(
      `${operation}: ${errors.map((e) => `${e.phase}: ${e.message}`).join("; ")}`,
    );
  }
}
export const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export function branchPath(root: string, path: string) {
  if (path.includes("\0")) throw new Error("NUL is not a valid path");
  const absolute = resolve(root, path);
  if (!inside(root, absolute))
    throw new Error(
      `Path escapes active LayerFS project: ${path}. Use project-relative paths.`,
    );
  return `/${relative(root, absolute)}`;
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
// Capture preflight is shared with the project import controller. Imports
// store symlinks as links, so only regular files are inspected. Certificate
// bundles (certifi's cacert.pem) and Keynote files are public; a .pem/.key is
// refused only when it holds a private key, and env templates are allowed.
const secretName =
  /^(\.env(?!\.(?:example|sample|template|dist)$)(?:\..*)?|auth\.json|credentials(?:\.json)?|id_(rsa|ed25519|ecdsa|dsa)|store\.sqlite(?:-.*)?)$/i;
const keyFile = /\.(pem|key)$/i;
async function holdsPrivateKey(path: string) {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    if (size > 4 * 1024 * 1024) return true; // Not scanned; fail closed.
    return (await file.readFile("latin1")).includes("PRIVATE KEY-----");
  } finally {
    await file.close();
  }
}
export async function sensitiveFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (
        entry.isFile() &&
        (secretName.test(entry.name) ||
          (keyFile.test(entry.name) && (await holdsPrivateKey(path))))
      )
        found.push(relative(root, path));
      if (entry.isDirectory() && found.length < 20) await visit(path);
    }
  }
  await visit(root);
  return found;
}

export type { RuntimeOptions } from "./ports.js";

async function lockOwner(lock: string) {
  try {
    return await readFile(join(lock, "owner"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

// Workspaces one Sandbox holds (LayerFS 1.1.0 agent guide).
const SANDBOX_CAPACITY = 16;
type Binding = {
  version: 1;
  root: string;
  store: string;
  initial: string | null;
};
export class Runtime {
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private failure: unknown;
  private stopped = false;
  readonly owned = new Map<string, Workspace>();
  readonly persistent = new Set<string>();
  readonly processes = new Set<string>();
  initial: string | null = null;
  diagnostics: unknown;
  readonly traceDir: string;
  readonly lease: Lease;
  recovery: Value | undefined;
  watch = new Watch();
  private reclaiming: Promise<Value> | undefined;
  // Opened by initialize, or by open for a reader of an existing project.
  sdk!: SDK;
  constructor(
    readonly root: string,
    readonly config: Config,
    private connect: Connect,
    private validate = validateEnvironment,
    readonly options: RuntimeOptions = {},
  ) {
    const env = { ...environment(), ...options.deployment };
    this.traceDir = traceDirectory(
      required(env.HOME),
      config.project,
      required(env.VOLUME),
    );
    this.lease = new Lease(join(this.traceDir, "leases"), () => ({
      agent: options.agent ?? this.lease.id,
      label: options.label ?? "lead",
      branch: config.branch,
      workspaces: [...this.owned].map(([key, ws]) => ({
        sandbox: ws.sandbox,
        path: ws.path,
        container: String(ws.container ?? ""),
        retained: this.persistent.has(key),
      })),
      processes: [...this.processes],
    }));
  }
  get backend() {
    return required(this.options.backend, "LayerFS backend");
  }
  async open() {
    this.sdk = await this.connect();
  }
  // LayerFS places no Workspace: use the lowest-numbered running
  // Sandbox of the image with a free slot, else start one. A listed Sandbox
  // may close itself when idle, or fill up, before the mount reaches it.
  async mount(
    branch: string,
    image = required({ ...environment(), ...this.options.deployment }.IMAGE),
  ) {
    const { items } = await this.sdk.project.list_sandboxes(1000, 0);
    const free = items.find(
      (s) => s.image === image && Number(s.workspaces) < SANDBOX_CAPACITY,
    );
    if (free)
      try {
        return await this.sdk.workspace.mount(String(free.sandbox), branch);
      } catch (e) {
        const code = (e as { code?: unknown })?.code;
        if (code !== "NoSuchSandbox" && code !== "Capacity") throw e;
      }
    const { sandbox } = await this.sdk.sandbox.create({ image });
    return this.sdk.workspace.mount(sandbox, branch);
  }
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
  // Ownership is persisted before the caller relies on it, so a crash at any
  // later point leaves the Workspace reclaimable. The Sandbox's container id,
  // from LayerFS's shared discovery records, makes the identity unique.
  async hold(ws: Workspace, retained: boolean) {
    const key = workspaceKey(ws);
    ws.container = await this.container(ws.sandbox);
    this.owned.set(key, ws);
    if (retained) this.persistent.add(key);
    await this.lease.write();
    return key;
  }
  async release(key: string) {
    this.owned.delete(key);
    this.persistent.delete(key);
    await this.lease.write();
  }
  private async container(sandbox: string) {
    const file = join(
      required({ ...environment(), ...this.options.deployment }.HOME),
      this.config.project,
      "sandboxes",
      sandbox,
      "container",
    );
    try {
      return (await readFile(file, "utf8")).trim();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }
  async initialize() {
    return this.serial(async () => {
      if (this.initialized) return;
      if (this.failure) throw this.failure;
      const reclaims = this.options.role !== "worker";
      try {
        await this.lease.write();
        this.lease.start(
          reclaims ? async () => void (await this.reclaim()) : undefined,
        );
        await this.initializeOnce();
        this.initialized = true;
      } catch (e) {
        this.failure = e;
        await this.lease.release();
        throw e;
      }
      if (reclaims) await this.reclaim();
    });
  }
  // Takes over Workspaces and processes of Pi processes of this Store whose
  // heartbeat expired. Retained Workspaces are committed to their own Branch
  // first. A conflict cannot be resolved without its owner, so it is reported
  // and the overlay discarded; any other failure keeps the claim for a retry.
  reclaim(): Promise<Value> {
    // Before the client is open, a later heartbeat or initialize reclaims.
    if (this.stopped || this.failure || !this.sdk)
      return Promise.resolve({ reclaimed: [], errors: [] });
    this.reclaiming ??= this.reclaimOnce().finally(() => {
      this.reclaiming = undefined;
    });
    return this.reclaiming;
  }
  private async reclaimOnce() {
    const reclaimed: Value[] = [],
      errors: Value[] = [];
    try {
      const scan = await claimExpired(
        this.lease.dir,
        this.lease.id,
        this.watch,
      );
      errors.push(...scan.errors);
      for (const { file, record } of scan.claims) {
        const failed = errors.length;
        const owner = { agent: record.agent, label: record.label };
        for (const id of record.processes) {
          try {
            await invoke(this.backend.daemon, "process", "cancel", [id]);
          } catch (e) {
            const code = (e as { code?: unknown })?.code;
            if (code !== "NoSuchProcess" && !workspaceGone(e))
              errors.push({
                phase: "cancel",
                ...owner,
                process: id,
                ...errorData(e),
              });
          }
        }
        for (const ws of record.workspaces) {
          const entry: Value = { ...owner, ...ws };
          // A replaced container lost the mount; its number and path may now
          // name another session's Workspace, which must not be touched.
          if (
            !ws.container ||
            (await this.container(ws.sandbox)) !== ws.container
          ) {
            reclaimed.push({ ...entry, gone: true });
            continue;
          }
          try {
            if (ws.retained) {
              try {
                entry.commit = await this.sdk.workspace.commit(
                  ws,
                  `Recovered uncommitted changes of expired Pi session ${record.label}`,
                );
              } catch (e) {
                const code = (e as { code?: unknown })?.code;
                if (code !== "Conflict" && code !== "HeadMoved") throw e;
                entry.discarded = errorData(e);
              }
            }
            await this.sdk.workspace.unmount(ws, true);
            reclaimed.push(entry);
          } catch (e) {
            if (workspaceGone(e)) reclaimed.push({ ...entry, gone: true });
            else errors.push({ phase: "reclaim", ...entry, ...errorData(e) });
          }
        }
        // A claim with failures stays owned by this lease and is retried.
        if (errors.length === failed) await rm(file, { force: true });
      }
    } catch (e) {
      errors.push({ phase: "scan", ...errorData(e) });
    }
    const pass = { time: Date.now(), reclaimed, errors };
    if (reclaimed.length || errors.length) this.recovery = pass;
    return pass;
  }
  // Only the first capture needs exclusion. A lock whose owner's lease expired
  // is taken over only when no capture began (no binding was written), since
  // an interrupted LayerFS.init has an unknown outcome. The capture's intent
  // is created exclusively, so even a racing takeover runs one LayerFS.init.
  private async lockBinding(lock: string, file: string) {
    const owner = join(lock, "owner");
    const watch = new Watch(this.watch.confirmMs);
    for (const deadline = Date.now() + 60_000; ; await sleep(250)) {
      try {
        await mkdir(lock, { mode: 0o700 });
        await writeFile(owner, this.lease.id, { mode: 0o600 });
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const holder = await lockOwner(lock);
      const expired = holder
        ? watch.expired(holder, await heartbeatOf(this.lease.dir, holder))
        : Date.now() >= deadline;
      if (!expired) continue;
      if (await exists(file))
        throw new Error(
          "LayerFS initialization was interrupted; inspect pi-bindings and the Store before explicit recovery",
        );
      const stale = `${lock}.stale-${randomUUID()}`;
      try {
        await rename(lock, stale);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      await rm(stale, { recursive: true });
    }
  }
  private async initializeOnce() {
    this.diagnostics = await this.validate(this.root);
    const env = { ...environment(), ...this.options.deployment };
    const home = required(env.HOME);
    const store = required(env.STORE_PATH);
    const bindings = join(home, "pi-bindings");
    await mkdir(bindings, { recursive: true, mode: 0o700 });
    const file = join(bindings, `${this.config.project}.json`);
    const lock = `${file}.lock`;
    const load = async () => {
      if (!(await exists(file))) return undefined;
      try {
        return JSON.parse(await readFile(file, "utf8")) as Binding;
      } catch (cause) {
        throw new Error("Invalid persistent LayerFS project binding", {
          cause,
        });
      }
    };
    // A complete binding is replaced only atomically, so sessions and workers
    // verify it concurrently without the initialization lock.
    let binding = await load();
    if (!binding?.initial) {
      await this.lockBinding(lock, file);
      try {
        binding = await load();
        if (!binding) binding = await this.capture(file, home, store);
      } finally {
        // Remove only this runtime's own lock, never one taken over meanwhile.
        if ((await lockOwner(lock)) === this.lease.id)
          await rm(lock, { recursive: true });
      }
    }
    if (
      binding.version !== 1 ||
      binding.root !== this.root ||
      binding.store !== store
    )
      throw new Error(
        "LayerFS project binding belongs to another source or Store",
      );
    if (!(await exists(join(home, this.config.project))))
      throw new Error(
        "Project binding exists but LayerFS project is missing; explicit recovery required",
      );
    if (!binding.initial)
      throw new Error(
        "Incomplete initialization intent; inspect LayerFS before explicit recovery (no automatic replay)",
      );
    this.initial = binding.initial;
    if (!this.sdk) await this.open();
    await this.verifyBranches(binding.initial);
  }
  private async capture(file: string, home: string, store: string) {
    const binding: Binding = {
      version: 1,
      root: this.root,
      store,
      initial: null,
    };
    const save = async () => {
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(binding)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, file);
    };
    if (await exists(join(home, this.config.project)))
      throw new Error(
        "Existing LayerFS project has no Pi binding; explicit adoption is unsupported",
      );
    if (!this.config.initialize)
      throw new Error(
        "Project is uninitialized; set initialize:true to capture the complete source tree",
      );
    const sensitive = await sensitiveFiles(this.root);
    if (sensitive.length)
      throw new Error(
        `Refusing initial capture: potentially sensitive files: ${sensitive.join(", ")}. Remove them from the source or use a credential-free fixture; ignored files are captured.`,
      );
    // Intent survives a crash/unknown SDK outcome; never silently reacquire.
    const intent = `${file}.${randomUUID()}.tmp`;
    await writeFile(intent, `${JSON.stringify(binding)}\n`, { mode: 0o600 });
    try {
      await link(intent, file);
    } finally {
      await rm(intent);
    }
    this.sdk = await this.connect(this.root);
    const init = required(this.sdk.created);
    if (init.kind !== "Initialized" || typeof init.layer !== "string")
      throw new Error("Unexpected LayerFS.init result");
    binding.initial = init.layer;
    await save();
    return binding;
  }
  private async verifyBranches(initial: string) {
    const branches: Value[] = [];
    for (let pos = 0; ; ) {
      const page = await this.sdk.project.list_branches(1000, pos);
      branches.push(...page.items);
      if (!page.hasMore) break;
      if (!page.items.length)
        throw new Error("LayerFS branch page made no progress");
      pos += page.items.length;
    }
    const main = branches.find((b) => b.name === "main");
    const layers = new Set([initial]);
    if (this.options.backend) {
      const history = await invoke(
        this.options.backend.store,
        "project",
        "get_history",
      );
      for (const layer of history.layers as Value[])
        layers.add(String(layer.id));
      if (!(history.layers as Value[]).some((l) => l.id === initial))
        throw new Error(
          "Recorded genesis is absent from LayerFS history; reconcile this binding",
        );
    }
    if (!main || !layers.has(String(main.base)))
      throw new Error(
        "main has moved away from recorded L0; explicit project reconciliation required",
      );
    const working = branches.find((b) => b.name === this.config.branch);
    if (working && !layers.has(String(working.base)))
      throw new Error("Configured working branch has an unknown base Layer");
    if (!working) {
      try {
        await this.sdk.branch.fork(this.config.branch, "main");
      } catch (e) {
        // Another session of this Store created it first; that is the same Branch.
        if ((e as { code?: unknown })?.code !== "NameTaken") throw e;
      }
    }
  }
  private async active() {
    if (this.stopped) throw new Error("LayerFS runtime is shut down");
    if (!this.lease.healthy)
      throw new Error(
        `LayerFS lease is not current (${this.lease.error?.message ?? "heartbeat overdue"}); another process may reclaim this session's Workspaces. Start a new session.`,
      );
    if (!this.initialized)
      throw new Error(
        `LayerFS unavailable: ${this.failure ? errorData(this.failure).message : "session initialization has not completed"}`,
      );
    if ([...this.owned.keys()].some((key) => !this.persistent.has(key)))
      throw new Error(
        "A Workspace requires recovery; inspect layerfs_status and layerfs_cleanup before more operations",
      );
  }
  async files(
    op: "read" | "write" | "edit" | "list" | "glob" | "grep" | "rm",
    args: {
      path: string;
      content?: string;
      oldText?: string;
      newText?: string;
      pattern?: string;
      offset?: number;
      limit?: number;
      page?: number;
    },
  ) {
    return this.serial(async () => {
      await this.active();
      const path = branchPath(this.root, args.path);
      const b = this.config.branch;
      try {
        if (op === "read")
          return await this.sdk.fs.read(
            b,
            path,
            args.offset ?? 1,
            (args.offset ?? 1) + (args.limit ?? 200) - 1,
          );
        if (op === "write")
          return await this.sdk.fs.write(b, path, required(args.content));
        if (op === "edit")
          return await this.sdk.fs.edit(
            b,
            path,
            required(args.oldText),
            required(args.newText),
          );
        if (op === "rm")
          return await this.sdk.fs.apply(b, [{ op: "rm", path }]);
        if (op === "list")
          return await this.sdk.fs.list(
            b,
            path,
            args.limit ?? 100,
            args.page ?? 0,
          );
        return await this.sdk.fs[op](
          b,
          required(args.pattern),
          path,
          args.limit ?? 100,
          args.page ?? 0,
        );
      } catch (e) {
        throw new OperationError(`fs.${op} ${b}:${path}`, [
          { phase: "sdk", ...errorData(e) },
        ]);
      }
    });
  }
  async bash(
    command: string,
    signal?: AbortSignal,
    seconds = this.config.timeoutSeconds,
  ) {
    return this.serial(async () => {
      await this.active();
      if (this.persistent.size)
        throw new Error(
          "Use layerfs_workspace exec for the retained Workspace, or unmount it before Bash",
        );
      if (
        !Number.isSafeInteger(seconds) ||
        seconds < 1 ||
        seconds > this.config.timeoutSeconds
      )
        throw new Error(
          "Command timeout must be a positive integer no greater than configured timeoutSeconds",
        );
      if (signal?.aborted) throw new Error("Command cancelled before mount");
      const errors: Value[] = [];
      let ws: Workspace | undefined;
      let key = "";
      let result: Value | undefined;
      let commit: Value | undefined;
      try {
        ws = await this.mount(this.config.branch);
        key = workspaceKey(ws);
        await this.hold(ws, false);
        // Foreground SDK exec has no cancellation port. Wait for timeout+kill and
        // its confirmed result before touching the overlay. Never Promise.race it.
        const stdout = new Capture();
        const stderr = new Capture();
        const marker = `__PI_LAYERFS_EXIT_${randomUUID()}__`;
        // A normal child exit (including 124/137) is distinct from timeout's
        // own exit code. The random stderr trailer is removed before returning.
        const wrapped = `bash -c ${quote(command)}; _pi_exit=$?; printf '\\n${marker}:%s\\n' "$_pi_exit" >&2; exit 0`;
        result = await this.sdk.workspace.exec(
          ws,
          `timeout --signal=TERM --kill-after=2s ${seconds}s bash -c ${quote(wrapped)}`,
          "Pi command",
          { stdout, stderr },
        );
        const timedOut = [124, 137].includes(Number(result.exitCode));
        let actualExit = Number(result.exitCode);
        let stderrBytes = Number(
          result.stderrBytes ?? Buffer.byteLength(String(result.stderr ?? "")),
        );
        if (!timedOut) {
          const tail =
            typeof result.stderr === "string"
              ? result.stderr
              : stderr.tail.toString("utf8");
          const match = tail.match(new RegExp(`\\n${marker}:(\\d{1,3})\\n$`));
          if (actualExit !== 0 || !match || Number(match[1]) > 255)
            throw new Error(
              "Command completion could not be confirmed; no commit attempted",
            );
          actualExit = Number(match[1]);
          stderrBytes -= Buffer.byteLength(match[0]);
          if (stderrBytes < 0)
            throw new Error("Invalid command stderr byte count");
        }
        result = {
          ...result,
          exitCode: actualExit,
          kind: `exit:${actualExit}`,
          stdout: result.stdout ?? stdout.text,
          stderr:
            typeof result.stderr === "string"
              ? Buffer.from(result.stderr)
                  .subarray(0, stderrBytes)
                  .toString("utf8")
              : stderr.prefix(stderrBytes),
          stderrBytes,
          timedOut,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderrBytes > 24 * 1024,
        };
        if (signal?.aborted)
          errors.push({
            phase: "execute",
            code: "Cancelled",
            message:
              "Cancelled; waited for command termination, changes discarded",
          });
        else if (timedOut)
          errors.push({
            phase: "execute",
            code: "Timeout",
            message: "Command timed out; changes discarded",
          });
        else {
          if (Number(result.exitCode) !== 0)
            errors.push({
              phase: "execute",
              code: "ExitCode",
              message: `Command exited ${result.exitCode}`,
            });
          try {
            commit = await this.sdk.workspace.commit(ws, "Pi command changes");
          } catch (e) {
            errors.push({ phase: "commit", ...errorData(e) });
          }
        }
      } catch (e) {
        errors.push({ phase: ws ? "execute" : "mount", ...errorData(e) });
      } finally {
        if (ws) {
          try {
            await this.sdk.workspace.unmount(ws, !commit);
            await this.release(key);
          } catch (e) {
            errors.push({ phase: "unmount", ...errorData(e) });
            if (workspaceGone(e)) await this.release(key);
          }
        }
      }
      const details = {
        branch: this.config.branch,
        workspace: ws,
        command: result,
        commit,
        cancelled: signal?.aborted ?? false,
        errors,
      };
      if (errors.length) throw new OperationError("bash", errors, details);
      return details;
    });
  }
  status() {
    return this.serial(async () => {
      let head: unknown = null;
      let headError: Value | undefined;
      if (this.initialized && !this.stopped) {
        try {
          head =
            (await this.sdk.branch.list_commits(this.config.branch, 1, 0))
              .items[0]?.id ?? null;
        } catch (e) {
          headError = errorData(e);
        }
      }
      return {
        project: this.config.project,
        branch: this.config.branch,
        initial: { ref: "main @ L0", layer: this.initial, commit: null },
        head,
        headError,
        mounted: [...this.owned.values()],
        lease: { id: this.lease.id, heartbeatError: this.lease.error },
        recovery: this.recovery,
        ready:
          this.initialized &&
          !this.stopped &&
          !headError &&
          [...this.owned.keys()].every((key) => this.persistent.has(key)),
        failure: this.failure ? errorData(this.failure) : null,
        diagnostics: this.diagnostics,
        durability: "Disposable: no crash/power-loss durability",
        coverage:
          "read/write/edit/bash/grep/find/ls; known hashline mutators and powershell blocked; other extensions and host control plane are outside coverage",
      };
    });
  }
  commits(size = 50, pos = 0) {
    return this.serial(async () => {
      await this.active();
      return this.sdk.branch.list_commits(this.config.branch, size, pos);
    });
  }
  cleanup() {
    return this.serial(async () => {
      const errors: Value[] = [];
      for (const id of this.processes) {
        try {
          await invoke(this.backend.daemon, "process", "cancel", [id]);
          this.processes.delete(id);
        } catch (e) {
          if ((e as { code?: unknown })?.code === "NoSuchProcess")
            this.processes.delete(id);
          else errors.push({ phase: "cancel", process: id, ...errorData(e) });
        }
      }
      for (const [key, ws] of this.owned) {
        try {
          await this.sdk.workspace.unmount(ws, true);
          await this.release(key);
        } catch (e) {
          if (workspaceGone(e)) await this.release(key);
          else
            errors.push({ phase: "unmount", workspace: ws, ...errorData(e) });
        }
      }
      await this.lease.write();
      if (errors.length) throw new OperationError("cleanup", errors);
    });
  }
  async shutdown() {
    await this.serial(async () => {
      this.stopped = true;
    });
    this.lease.stop();
    await this.reclaiming;
    const errors: Value[] = [];
    try {
      await this.cleanup();
      await this.lease.release();
    } catch (e) {
      // The expiring lease hands what is still held to the next live process.
      if (e instanceof OperationError) errors.push(...e.errors);
      else errors.push({ phase: "cleanup", ...errorData(e) });
    }
    try {
      if (this.sdk) await this.sdk.close();
    } catch (e) {
      errors.push({ phase: "close", ...errorData(e) });
    }
    if (errors.length) throw new OperationError("shutdown", errors);
  }
}
export async function createRuntime(
  root: string,
  config: Config,
  options: RuntimeOptions = {},
) {
  const canonical = await realpath(root);
  options.agent ??= randomUUID();
  options.deployment = { ...environment(), ...options.deployment };
  const connect = await loadClient(config.sdk, config.project, options);
  return new Runtime(
    canonical,
    config,
    connect,
    (root) =>
      withDeployment(options.deployment ?? {}, () => validateEnvironment(root)),
    options,
  );
}
