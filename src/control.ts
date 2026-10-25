import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { environment, required } from "./config.js";
import { docker } from "./docker.js";
import { type Counts, scanSource } from "./import-progress.js";
import { CONFIRM_MS, leaseHolders } from "./lease.js";
import { Operations } from "./operations.js";
import { loadClient } from "./ports.js";
import {
  createRuntime,
  errorData,
  Runtime,
  sensitiveFiles,
  type Value,
} from "./runtime.js";

export type Project = {
  name: string;
  root: string;
  volume: string;
  store: string;
  created: number;
  state: "importing" | "ready" | "failed";
  owned: boolean;
  initial?: string;
  failure?: Value;
};
export type InitJob = {
  id: string;
  project: string;
  state: string;
  started: number;
  progress?: Value;
  totals?: Counts;
  scanned?: Counts;
  error?: Value;
};
const validProject = (value: string) => {
  if (!/^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/.test(value))
    throw new Error("Invalid project name");
  return value;
};
export class Control {
  readonly directory: string;
  readonly owner: string;
  readonly jobs = new Map<string, InitJob>();
  readonly readers = new Map<string, Operations>();
  private readerOpening = new Map<string, Promise<Operations>>();
  locked = false;
  private stopped = false;
  unbound = false;
  private selecting = false;
  bindProject() {
    if (this.stopped || this.selecting)
      throw new Error("Project selection or shutdown is in progress");
    if (this.unbound)
      throw new Error(
        "Choose a project with layerfs_project select or /layerfs use first",
      );
    this.locked = true;
    return this.runtime;
  }
  private pending = new Set<Promise<unknown>>();
  operations: Operations;
  constructor(public runtime: Runtime) {
    this.directory = join(
      required(runtime.options.deployment?.HOME ?? environment().HOME),
      "pi-projects",
    );
    this.owner = createHash("sha256")
      .update(`${this.directory}:${process.env.PI_LAYERFS_INSTANCE ?? "host"}`)
      .digest("hex")
      .slice(0, 16);
    this.operations = new Operations(runtime);
  }
  async ready(unbound = false) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.unbound = unbound;
    if (unbound) return;
    await this.operations.ready();
    const r = this.runtime;
    const record: Project = {
      name: r.config.project,
      root: r.root,
      volume: required(r.options.deployment?.VOLUME ?? environment().VOLUME),
      store: required(
        r.options.deployment?.STORE_PATH ?? environment().STORE_PATH,
      ),
      state: "ready",
      created: Date.now(),
      owned: false,
      initial: required(r.initial),
    };
    try {
      const file = await open(this.file(record.name), "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(record));
      } finally {
        await file.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  private file(project: string) {
    return join(this.directory, `${validProject(project)}.json`);
  }
  private async admission<T>(
    project: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const lock = `${this.file(project)}.remove-lock`;
    await mkdir(lock, { mode: 0o700 });
    try {
      return await action();
    } finally {
      await rm(lock, { recursive: true });
    }
  }
  private async save(record: Project) {
    const temporary = `${this.file(record.name)}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, this.file(record.name));
  }
  async projects() {
    const result: Project[] = [];
    for (const file of await readdir(this.directory)) {
      if (!file.endsWith(".json")) continue;
      try {
        result.push(
          JSON.parse(await readFile(join(this.directory, file), "utf8")),
        );
      } catch (e) {
        throw new Error(
          `Unreadable project record ${file}; inspect registry before recovery`,
          { cause: e },
        );
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  async project(project: string): Promise<Project> {
    try {
      return JSON.parse(await readFile(this.file(project), "utf8"));
    } catch (e) {
      throw new Error(`Cannot open registered project ${project}`, {
        cause: e,
      });
    }
  }
  private async createReader(record: Project, label = "viewer") {
    if (record.state !== "ready")
      throw new Error("Project Init has not completed; inspect jobs");
    const options = {
      agent: randomUUID(),
      role: "worker" as const,
      label,
      deployment: {
        ...this.runtime.options.deployment,
        VOLUME: record.volume,
        STORE_PATH: record.store,
      },
    };
    const connect = await loadClient(
      this.runtime.config.sdk,
      record.name,
      options,
    );
    const r = new Runtime(
      record.root,
      {
        ...this.runtime.config,
        project: record.name,
        branch: "main",
        initialize: false,
      },
      connect,
      undefined,
      options,
    );
    await r.open();
    const ops = new Operations(r);
    await ops.ready();
    // Viewers hold no Workspace, but their lease keeps removal from
    // pulling the Store out from under another live process.
    await r.lease.write();
    r.lease.start();
    return ops;
  }
  private async closeReader(ops: Operations) {
    await ops.runtime.lease.release();
    await ops.runtime.sdk.close();
    await ops.actor("closed");
  }
  async reader(project: string) {
    const cached = this.readers.get(project);
    if (cached) return cached;
    let opening = this.readerOpening.get(project);
    if (!opening) {
      opening = this.admission(project, async () => {
        const ops = await this.createReader(await this.project(project));
        this.readers.set(project, ops);
        return ops;
      }).finally(() => this.readerOpening.delete(project));
      this.readerOpening.set(project, opening);
    }
    return opening;
  }
  async restore(saved: Value) {
    if (typeof saved.project !== "string")
      throw new Error("Session binding has no project");
    const record = await this.project(saved.project);
    if (record.volume !== saved.volume)
      throw new Error(
        "Bound project was removed/replaced, or binding has no volume identity; start a new session and select explicitly",
      );
    await this.select(record.name);
    this.locked = saved.locked === true;
  }
  async select(project: string) {
    if (this.stopped || this.selecting)
      throw new Error("Project selection or shutdown is in progress");
    if (this.locked)
      throw new Error(
        "Session project is fixed after its first project operation; start a new Pi session",
      );
    if (project === this.runtime.config.project && !this.unbound)
      return this.runtime.status();
    this.selecting = true;
    try {
      return await this.admission(project, async () => {
        const record = await this.project(project);
        if (record.state !== "ready") throw new Error("Project is not ready");
        const runtime = await createRuntime(
          record.root,
          { ...this.runtime.config, project, initialize: false },
          {
            label: this.runtime.options.label,
            role: this.runtime.options.role,
            deployment: {
              ...this.runtime.options.deployment,
              VOLUME: record.volume,
              STORE_PATH: record.store,
            },
          },
        );
        const ops = new Operations(runtime);
        try {
          await ops.ready();
          await runtime.initialize();
          await this.runtime.shutdown();
          await this.operations.actor("closed");
        } catch (error) {
          await runtime.shutdown();
          await ops.actor("closed");
          throw error;
        }
        this.runtime = runtime;
        this.operations = ops;
        this.unbound = false;
        return runtime.status();
      });
    } finally {
      this.selecting = false;
    }
  }
  async init(name: string, source?: string) {
    if (this.stopped) throw new Error("Controller is shut down");
    validProject(name);
    // Multi-project provisioning is opt-in in client.sh --manage-projects.
    const volumes = process.env.PI_LAYERFS_VOLUME_ROOT;
    if (!volumes)
      throw new Error(
        "Start client.sh with --manage-projects to create dedicated project volumes",
      );
    await access(volumes, constants.R_OK | constants.W_OK | constants.X_OK);
    let root: string;
    if (source) root = await realpath(resolve(source));
    else {
      const seeds = join(this.directory, "empty");
      await mkdir(seeds, { recursive: true, mode: 0o700 });
      root = await mkdtemp(join(seeds, `${name}-`));
    }
    const sensitive = await sensitiveFiles(root);
    if (sensitive.length)
      throw new Error(
        `Refusing import of potentially sensitive files: ${sensitive.join(", ")}; ignored files are captured`,
      );
    const record: Project = {
      name,
      root,
      volume: `pi-layerfs-${this.owner}-${name}-${randomUUID().replaceAll("-", "")}`,
      store: "",
      state: "importing",
      created: Date.now(),
      owned: true,
    };
    const claim = await open(this.file(name), "wx", 0o600);
    try {
      await claim.writeFile(JSON.stringify(record));
    } finally {
      await claim.close();
    }
    const job: InitJob = {
      id: randomUUID(),
      project: name,
      state: "starting",
      started: Date.now(),
    };
    this.jobs.set(job.id, job);
    const work = this.runInit(record, job)
      .catch((error) => {
        job.state = "failed";
        job.error = errorData(error);
      })
      .finally(() => this.pending.delete(work));
    this.pending.add(work);
    // runInit records its outcome; there is no unobserved rejection or replay.
    return job;
  }
  private async runInit(record: Project, job: InitJob) {
    let ops: Operations | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling: Promise<void> = Promise.resolve();
    try {
      job.state = "scanning";
      job.totals = await scanSource(record.root, (counts) => {
        job.scanned = counts;
      });
      job.state = "starting";
      const volume = await docker("/volumes/create", "POST", {
        Name: record.volume,
        Labels: {
          "pi-layerfs.owner": this.owner,
          "pi-layerfs.project": record.name,
        },
      });
      record.store = join(String(volume.Mountpoint), "global/store.sqlite");
      await realpath(String(volume.Mountpoint)); // Must be visible, not a substitute filesystem.
      await this.save(record);
      const runtime = await createRuntime(
        record.root,
        {
          ...this.runtime.config,
          project: record.name,
          branch: "pi-work",
          initialize: true,
        },
        {
          label: "import",
          deployment: {
            ...this.runtime.options.deployment,
            VOLUME: record.volume,
            STORE_PATH: record.store,
          },
        },
      );
      ops = new Operations(runtime);
      await ops.ready();
      job.state = "importing";
      const progress = async () => {
        try {
          job.progress = await required(ops).inspect("progress");
        } catch (e) {
          job.progress = { unavailable: errorData(e) };
        }
        if (job.state === "importing")
          timer = setTimeout(() => {
            polling = progress();
          }, 250);
      };
      timer = setTimeout(() => {
        polling = progress();
      }, 250);
      await runtime.initialize();
      record.initial = required(runtime.initial);
      record.state = "ready";
      job.state = "ready";
      await this.save(record);
    } catch (e) {
      record.state = "failed";
      record.failure = errorData(e);
      job.state = "failed";
      job.error = record.failure;
      // Retain admission, volume and discovery evidence even for unknown outcomes.
      await this.save(record);
    } finally {
      if (timer) clearTimeout(timer);
      await polling;
      if (timer) clearTimeout(timer);
      if (ops) {
        await ops.runtime.shutdown();
        await ops.actor("closed");
      }
      await writeFile(
        join(this.directory, `job-${job.id}.receipt`),
        JSON.stringify(job),
        { mode: 0o600 },
      );
    }
  }
  async job(id: string) {
    const job = this.jobs.get(id);
    if (job) return job;
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid job id");
    try {
      return JSON.parse(
        await readFile(join(this.directory, `job-${id}.receipt`), "utf8"),
      );
    } catch (e) {
      throw new Error(
        "Job not found; interrupted imports remain in the project registry",
        { cause: e },
      );
    }
  }
  async remove(project: string, confirmation: string, stopSandboxes = false) {
    if (confirmation !== project)
      throw new Error("Confirm removal with the exact project name");
    if (project === this.runtime.config.project && !this.unbound)
      throw new Error("Cannot remove the project of this active session");
    const record = await this.project(project);
    if (!record.owned)
      throw new Error(
        "Legacy/base volume is not owned by the project manager; removal refused",
      );
    if (record.state === "importing")
      throw new Error(
        "Init is active or interrupted; reconcile before removal",
      );
    const lock = `${this.file(project)}.remove-lock`;
    await mkdir(lock, { mode: 0o700 });
    try {
      const volume = await docker(
        `/volumes/${encodeURIComponent(record.volume)}`,
      );
      if (
        (volume.Labels as Value)?.["pi-layerfs.owner"] !== this.owner ||
        (volume.Labels as Value)?.["pi-layerfs.project"] !== project
      )
        throw new Error("Volume ownership mismatch");
      const ops =
        this.readers.get(project) ?? (await this.createReader(record));
      this.readers.set(project, ops);
      // Crashed sessions never write "closed"; their lease decides. An
      // expired lease is taken only after a confirmation interval.
      const holders = async () => {
        const recovery = await ops.runtime.reclaim();
        if ((recovery.errors as Value[]).length)
          throw new Error(
            `Workspaces of expired sessions could not be reclaimed: ${JSON.stringify(recovery.errors)}`,
          );
        const agents = await leaseHolders(ops.runtime.lease.dir);
        agents.delete(required(ops.runtime.options.agent));
        return agents;
      };
      if ([...(await holders()).values()].some(Boolean))
        await sleep(CONFIRM_MS + 1000);
      const live = await holders();
      if (live.size)
        throw new Error(
          `Project has live sessions in other processes (${[...live.keys()].join(", ")}); close them first`,
        );
      const state = await ops.inspect("snapshot");
      if (!("sandboxes" in state) || !Array.isArray(state.sandboxes))
        throw new Error(
          "Cannot verify project Workspace state; removal refused",
        );
      if (
        (state.sandboxes as Value[]).some(
          (s) => (s.workspaces as Value[]).length,
        )
      )
        throw new Error("Project still has mounted Workspaces");
      const rows = await docker(
        `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ volume: [record.volume] }))}`,
      );
      if (!Array.isArray(rows))
        throw new Error("Invalid Docker container listing");
      const containers = rows as Value[];
      if (containers.some((c) => c.State === "running") && !stopSandboxes)
        throw new Error(
          "Sandbox is still running; wait for its 2-minute idle close or explicitly stop empty Sandboxes",
        );
      for (const c of containers) {
        if ((c.Labels as Value)?.["layerfs.project"] !== project)
          throw new Error("Unowned container uses this volume");
        await docker(
          `/containers/${encodeURIComponent(String(c.Id))}?force=${stopSandboxes ? 1 : 0}`,
          "DELETE",
        );
      }
      await this.closeReader(ops);
      this.readers.delete(project);
      await docker(`/volumes/${encodeURIComponent(record.volume)}`, "DELETE");
      await rm(join(required(this.runtime.options.deployment?.HOME), project), {
        recursive: true,
        force: true,
      });
      await rm(
        join(
          required(this.runtime.options.deployment?.HOME),
          "pi-bindings",
          `${project}.json`,
        ),
        { force: true },
      );
      await rm(this.file(project));
      return {
        removed: project,
        volume: record.volume,
        sourcePreserved: true,
        journalPreserved: true,
      };
    } finally {
      await rm(lock, { recursive: true });
    }
  }
  async close() {
    this.stopped = true;
    await Promise.allSettled([...this.pending]);
    await Promise.allSettled([...this.readerOpening.values()]);
    const results = await Promise.allSettled([
      this.runtime.shutdown(),
      ...[...this.readers.values()].map((o) => this.closeReader(o)),
    ]);
    const failure = results.find((r) => r.status === "rejected");
    await this.operations.actor(failure ? "cleanup_failed" : "closed");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
