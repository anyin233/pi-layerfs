# pi-layerfs

A Pi extension for persistent, branchable LayerFS projects, with project management, independent worker agents, retained Workspaces, background processes, and a local Work / History / Files / Storage dashboard.

Qualified against **Pi 1.4.0** and LayerFS revision **`ad78914e36b258b360daf13aec164b5655814689`** (LayerFS 1.1.0: `@layerfs/agent` and `@layerfs/backend` source). It uses public extension and AgentSession APIs without modifying Pi core. See the [DSH capability mapping](docs/dsh-parity.md) and [verification record](docs/verification.md).

## Install the self-contained release

Each release archive includes the plugin, pinned LayerFS SDK, native binding, daemon, Pi 1.4.0 and a complete Docker runtime image for one Engine architecture: `linux-x64` (Linux x86_64, Intel Macs) or `linux-arm64` (Linux arm64, Apple Silicon). Installing the archive performs **no network downloads** and needs no host Rust, Node, npm, private SDK package or LayerFS checkout. A Docker Engine reached through its Unix socket, `/dev/fuse` in the Engine's Linux kernel, Bash/tar/gzip and plain local Docker volumes on **ext4, xfs or btrfs** are required. Model credentials are configured separately.

**macOS** is supported through OrbStack or Docker Desktop, whose Linux VM provides FUSE and the volume filesystem; macOS itself needs no macFUSE, Node, Rust or LayerFS checkout. macOS has not yet been verified with LayerFS 1.1.0, and no macOS archive is part of the v0.1.0 release. See [macOS](docs/macos.md) for building the arm64 archive, Docker contexts, networking and dashboard notes, and the real-host acceptance procedure.

Download the full archive and checksums from [GitHub Releases](https://github.com/anyin233/pi-layerfs/releases/latest):

```bash
curl -fLO https://github.com/anyin233/pi-layerfs/releases/download/v0.1.0/pi-layerfs-0.1.0-linux-x64.tar.gz
curl -fLO https://github.com/anyin233/pi-layerfs/releases/download/v0.1.0/SHA256SUMS
grep "  pi-layerfs-0.1.0-linux-x64.tar.gz$" SHA256SUMS | sha256sum -c -
tar -xzf pi-layerfs-0.1.0-linux-x64.tar.gz
cd pi-layerfs-0.1.0-linux-x64
bash install.sh
pi-layerfs --self-test
```

The installer defaults to `~/.local/share/pi-layerfs` and `~/.local/bin/pi-layerfs`; pass `--prefix DIR`, `--bin-dir DIR` or `--skip-register` to customize it. If host Pi is installed, the installer also registers the local plugin package. A normal host Pi session remains untouched; `pi-layerfs` explicitly loads the extension in the bundled container. Add `~/.local/bin` to PATH if needed.

Start from a disposable project copy:

```bash
cd /path/to/project-copy
pi-layerfs
```

The launcher mounts the host source read-only, automatically creates a deterministic project/Branch configuration outside it and assigns a dedicated Store volume to each canonical project directory. No `.pi` file is written into the host source. Reopening the same directory reuses its Store and history. Model credentials and Pi settings share a separate private control volume; use Pi's `/login` normally. Existing host credentials are not copied into projects or the image.

An optional `.pi/layerfs.json` overrides the generated configuration; `sdk` defaults to the bundled SDK:

```json
{
  "project": "my-project",
  "branch": "pi-work",
  "initialize": true,
  "timeoutSeconds": 60
}
```

The separate `pi-layerfs-0.1.0.tgz` release asset contains the plugin, SDK/native/daemon and license notices for host-Pi package integration. It does not contain the Docker image; use the full archive for a complete deployment. Host peers remain supplied by Pi. The release has not been published to the npm registry.

See [third-party notices](THIRD_PARTY_NOTICES.md), the [four-worker benchmark](docs/kernelagentir-benchmark.md) and [release verification](docs/release-verification.md).

LayerFS currently uses **Disposable Store**, with WAL and `synchronous=OFF`. Persistent history across normal sessions does **not** provide crash or power-loss durability. Keep another copy of irreplaceable source data.

## Projects and dashboard

Open the project manager without importing the current source directory:

```bash
pi-layerfs --manage-projects
```

This explicitly permits the manager to create dedicated project volumes. It uses the installation's control deployment and its project registry. Directory-based launches have separate Store registries; the manager lists projects created in its own deployment.

Run `/layerfs ui` in Pi and open the URL reported by the command. The dashboard runs on `127.0.0.1` with a random fragment token. It has project selection/creation/import/removal and four inspection areas (History and Files share a tab):

- **Work:** per-actor command and SDK-call records, worker text, stdout/stderr and Commit metadata, agent/Branch filters, follow mode, and live Sandbox/Workspace snapshots.
- **History:** Branches, Commits, merge parents and published Layers; creator attribution comes from creation calls, so a fast-forward merge does not overwrite the original author. Select a node to inspect its saved files. Playback changes the recorded-call cursor and never re-executes commands.
- **Files:** saved-state list/read windows, blame, file revisions and comparisons. The SDK's pagination/truncation information is retained. Layers compare only through verified equivalent Commit trees; unsupported comparisons return `NotComparable`.
- **Storage:** native logical/canonical/stored/metadata/SQLite metrics, ratios and per-Commit additions. Unavailable physical attribution remains unavailable.

The dashboard can return to a project's saved state without changing the active session's project. Selecting the session project remains possible until its first project operation, including spawning a worker; then the choice is fixed. `/layerfs session NAME` starts a fresh Pi session. Session entries retain the project volume identity, Branch and binding lock. Resuming after a project was removed/replaced refuses silent attachment to its replacement. Worker transcripts cannot be reopened as lead sessions.

Commands:

```text
/layerfs                     status
/layerfs ui                  open management URL
/layerfs projects            list projects
/layerfs use NAME            select before project use
/layerfs init NAME [SOURCE]  create empty project or import folder
/layerfs session NAME        create a new Pi session
/layerfs minimalist          keep Bash and LayerFS workflow tools
```

Project initialization is asynchronous. Inspect its job ID or dashboard progress. The preliminary metadata scan counts ignored entries and hardlinked byte identities without traversing symlinks. Native Init progress describes completed work, not guaranteed totals. Imports capture the SDK-supported complete tree, including ignored files; credential files are refused rather than silently excluded. The preflight inspects regular files only (imports store symlinks as links): `.env*` except `.env.example/.sample/.template/.dist`, `auth.json`, `credentials[.json]`, `id_rsa/ed25519/ecdsa/dsa`, Store files, and `.pem`/`.key` files that contain a private key. Public certificate bundles such as certifi's `cacert.pem` and directories named `credentials` no longer block importing a complete `.venv`. Sources, Stores and private state must remain separate.

New projects receive separate labelled Docker volumes. Removal requires exact name confirmation, an owned volume, no lease of another process on the project (expired leases are reclaimed first, waiting one 20-second confirmation interval if any looks expired) and no mounted Workspaces; stopping empty Sandboxes requires `stopSandboxes`. Viewing, selecting and removing share admission locks. Source folders and session/call journals are preserved. The original deployment volume is protected. Uncertain imports retain their registry/home/volume evidence for inspection instead of being automatically replayed or deleted.

## Tools and workflow

All managed project operations use real LayerFS; unavailable access fails closed.

| Tool | Capability |
| --- | --- |
| `read`, `write`, `edit`, `bash`, `ls`, `find`, `grep` | SDK-backed replacements for Pi's ordinary project tools |
| `layerfs_status`, `layerfs_commits`, `layerfs_remove`, `layerfs_cleanup` | Status, active-Branch history, file removal and owned-Workspace cleanup |
| `layerfs_branch` | List/fork/switch, merge into a new named Branch, lead-only publish, Branch/Commit differences |
| `layerfs_fs` | Historical read/list/stat/blame/diff, text/base64 writes, edit, mkdir/cp/mv/rm/apply |
| `layerfs_workspace` | Mount one retained Workspace, execute, commit, unmount; inspect retained changes/conflicts |
| `layerfs_process` | Start/list/cancel background processes through `@layerfs/backend` |
| `layerfs_inspect` | Native snapshot/storage/file/Workspace diagnostics, call journals and byte-cursor history pages |
| `layerfs_project` | `list`, `select`, `init`, `job`, `remove` |
| `layerfs_agent` | `spawn`, `list`, `message`, `cancel` for lead-owned Pi workers |
| `layerfs_dashboard` | Start/report the local dashboard |

Workflow tools use `{action, args}`; their registered descriptions specify argument fields. For example:

```json
{"action":"spawn","args":{"label":"Tests","task":"Inspect the project and add focused tests on your assigned Branch."}}
```

Workers use public Pi AgentSessions, inherit the selected model/auth through a provider adapter, receive independent Branches and persist their own transcripts. The lead can inspect their states, send messages, cancel, merge their work and publish. Workers cannot change their assigned Branch, publish, manage projects or spawn further workers through these tools. SDK retries are disabled; compaction uses Pi's supported session machinery. Parent shutdown waits for child cleanup and reports failed cleanup.

The ordinary file tool schemas are `read {path,offset?,limit?}`, `write {path,content}`, `edit {path,oldText,newText}` and `bash {command,timeout?}`. `edit` differs from Pi's `edits[]`; there are no hashline anchors. `read` is bounded UTF-8 text, not a Buffer/image/binary API. Long-line truncation cannot be reconstructed through within-line pagination. Binary writes use canonical base64 through `layerfs_fs`; binary processing/readback can use a Workspace command.

Paths are project-relative or host absolute paths lexically contained in the canonical source root. Use `README.md`, not `/README.md`; `/etc/passwd` is refused. Symlinks resolve inside LayerFS. Search returns SDK pages and explicit partial metadata.

Each ordinary Bash command mounts the active Branch, runs with GNU timeout, captures up to **24 KiB per stdout/stderr stream**, commits a confirmed completed command and unmounts in `finally`. Normal nonzero exits, including 124/137, still commit valid modifications. Timeout/cancellation waits for execution to finish, then discards. `UpToDate` does not add a Commit. Command and cleanup failures remain separate. A failed completed-command commit is reported; its uncommitted overlay is discarded if cleanup unmount succeeds.

Use `layerfs_workspace` for state retained between commands and `layerfs_process` for tracked background work. A retained Workspace blocks ordinary Bash's second mount on the agent. Commit/unmount refuses live processes and preserves Busy/Dirty/Conflict state for explicit resolution. Shutdown cancels owned processes before cleanup. These retained operations require an explicit commit or discard; they are not automatically published.

## Configuration and private state

`.pi/layerfs.json` is extension-owned configuration. `--layerfs-config` resolves relative to Pi's cwd; relative SDK paths resolve from the config file. See [examples/layerfs.json](examples/layerfs.json).

| Key | Default | Meaning |
| --- | --- | --- |
| `sdk` | Bundled SDK | Optional installed `@layerfs/agent` or explicit path to its `src/index.js`; `@layerfs/backend` must resolve from there |
| `project` | Required | Initial deployment project; management can select another registered project |
| `branch` | `pi-work` | Deterministic writable Branch; `main` is refused; session switches persist |
| `initialize` | `false` | Permission for initial complete-tree capture; existing bindings need no reimport |
| `failWhenUnavailable` | `true` | Request orderly Pi shutdown on startup failure; false leaves diagnosis available with project tools blocked |
| `timeoutSeconds` | `60` | Positive command bound, maximum 86400; tool timeout can shorten it |
| `logLevel` | `error` | `silent`, `error`, or `info` lifecycle notifications |

Required deployment settings are `LAYERFS_HOME`, `LAYERFS_IMAGE`, `LAYERFS_VOLUME`, `LAYERFS_DAEMON` and `LAYERFS_STORE_PATH`. The Store path must be `<volume-root>/global/store.sqlite`; mount identity and its ext4/xfs/btrfs filesystem are checked, including VM Engines whose data root is a subvolume. `LAYERFS_DOCKER` defaults to `/var/run/docker.sock`. Preparation also exports `LAYERFS_NATIVE` and an instance-specific `LAYERFS_CONTAINER_PREFIX`; optional `LAYERFS_DAEMON_HOST` defaults to `127.0.0.1`. The launcher uses host networking; `PI_LAYERFS_NETWORK=bridge` dials daemons through `host.docker.internal` and publishes the dashboard on the host loopback instead (see [macOS](docs/macos.md#networking)). Documented `DSH_LAYERFS_*` fallbacks are accepted. Change deployment settings in a fresh runtime.

The management launcher explicitly mounts the Docker volume directory and sets `PI_LAYERFS_VOLUME_ROOT`; `PI_LAYERFS_INSTANCE` separates deployment ownership labels. It defaults `UV_THREADPOOL_SIZE` to 64, which can be overridden when launching the client. Model credentials, project data and SDK/daemon control paths are distinct.

Private state under `LAYERFS_HOME` includes:

- `pi-bindings/<project>.json`: canonical source, Store and immutable recorded genesis; directory lock/intent for initialization.
- `pi-projects/`: project registry and asynchronous import jobs, with ownership and removal admission locks.
- `pi-traces/<project>/<volume-hash>/`: native SDK call traces, actor records and lifecycle/tool/text journals. Recreating a project name with a new volume does not mix old journals into its views.
- `pi-traces/<project>/<volume-hash>/leases/`: one heartbeat lease per live runtime listing the Workspaces and background processes it holds; `claim-*` files are leases being reclaimed.

Tracing is enabled by the plugin. Native traces summarize file payloads, but command text/output and recorded model text can contain user data; protect the private state and session journals accordingly. Dashboard authentication persists in that browser tab's session storage and is process-specific. Host/Origin checks, CSP and text-node rendering apply. The dashboard has the Pi process's authority; it is not a separate security boundary.

Initialization is once per source/Store binding. `main` begins at L0; after publishing, later main/Branch bases are accepted only when native history verifies them and the recorded genesis is still present. A missing genesis in a bounded snapshot requires reconciliation, not reimport.

## Limits and recovery

Pi's known hashline mutators (`replace`, `replace_match`, `insert`, `copy`, `move`, `undo_last_change`) and `powershell` are blocked through `tool_call`. Other extensions, unregistered tools and direct host APIs can bypass this integration. A Workspace is not a security sandbox. File tools preserve only metadata supported by the SDK; use Workspace commands for other supported filesystem work.

Foreground `workspace.exec` has no public AbortSignal or foreground process handle. Cancellation is deferred until execution/GNU timeout returns, with a 2-second TERM-to-KILL grace. An abort after commit begins cannot roll it back. Do not daemonize through ordinary Bash; use the process tool. Interrupted workers are not automatically replayed.

### Crash recovery

Workspaces live in Sandbox daemons, not in the Pi process, so a killed Pi process would otherwise keep its overlays mounted and its Sandbox running indefinitely, holding disk that is never returned. Every runtime (lead, worker, viewer) therefore writes a lease that it refreshes every 10 seconds and that names its holder (container and pid) and lists the Workspaces it holds, each with its Sandbox's container id, and its background processes. Ownership is recorded right after `mount` returns, before the Workspace is used.

A lease is taken at once when its holder is provably dead: its pid is gone from the reclaimer's own container, or Docker reports its container removed or stopped. Otherwise it is expired only when its heartbeat is more than 60 seconds old **and** the reclaiming process has itself seen it unchanged for 20 seconds on its monotonic clock, so a host suspend or wall-clock jump gives a resumed owner time to beat again; a holder in another, running container or a reused pid waits for expiry. Leases of the same Pi process are never claimed by it. A lead's initialization and each of its heartbeats, `layerfs_cleanup` and project removal take such leases over with an atomic rename that only one process wins, then:

- cancel the recorded background processes;
- skip a Workspace whose Sandbox now has a different container (its mounts died with the old container, and the reused number and path may name another session's Workspace);
- commit a retained Workspace's uncommitted changes to that Workspace's own Branch (`Recovered uncommitted changes of expired Pi session …`); only a `Conflict`/`HeadMoved` refusal, which needs the absent owner, is reported and the overlay discarded;
- discard ordinary Bash Workspaces, whose command never confirmed completion;
- treat `NotMounted` and `NoSuchSandbox` as already gone, because the daemon never reuses a Workspace directory and a stopped container lost its mounts.

A Workspace still `Busy` with the dead session's foreground command is reported in `recovery.pending` until that command's own timeout ends. It and any other failure keep the claim with the reclaimer, which retries it on its next heartbeat; if that reclaimer dies too, its claims expire with its lease. An unreadable lease file is set aside as `unreadable-*.json` and reported. Results appear in `layerfs_status.recovery`. A Workspace whose Sandbox vanished no longer blocks its own runtime. Other unmount failures, such as a lost daemon connection, still keep the Workspace and block project operations until `layerfs_cleanup` succeeds. A runtime whose heartbeat has been failing for 30 seconds, or whose lease another process took over after it stalled (for example while suspended with Ctrl-Z), refuses further project operations rather than re-owning reclaimed Workspaces; start a new session. A process killed between `mount` returning and its lease write falls outside this recovery.

SDK snapshots, comparisons and storage diagnostics have explicit bounds. History pages use UTF-8-safe byte cursors and retain incomplete appends. Interactive full-history loading is capped at 100000 calls, and terminal rendering at 500 calls around the cursor; full journals remain on disk. Playback shows recorded activity, not a simulated re-execution or a PTY. Missing traces remain unattributed, and old saved nodes beyond the native snapshot bounds can be unavailable. SDK file revision diagnostics currently bound revision scans to 1000; unavailable per-file physical attribution is left null.

Sessions and workers of an initialized project verify its binding without a lock, reading only Store history (no Sandbox probes), so any number start concurrently. Only the first capture is exclusive: a concurrent starter waits while the capturing process's lease is live, takes over a lock whose owner died or expired only when no capture began, and otherwise reports the interrupted capture without replaying it. The capture intent is created exclusively, so at most one `project.init` runs. Removal locks have no automatic stale takeover. After a crash, inspect the binding/intent, project entry, Docker volume labels, native snapshot and running processes before manual reconciliation. Unknown imports and failed cleanup retain evidence. Do not delete a Store merely because a reply was lost. A missing or replaced volume, incomplete intent, unrecognized project or missing genesis is reported rather than silently adopted.

For build failures check the locked Cargo cache in `.build/cargo-home`; native builds run in the pinned `rust:1.85.1-bookworm` container for the Engine's architecture, which also avoids host/runtime glibc mismatches. For daemon launch failures check `/dev/fuse` in the Engine, the immutable local image, plain volume, socket and image/Engine architecture. Use `layerfs_status`, `layerfs_inspect` and the preserved phase errors before recovery.

## Build from source

Source builds require Node 22.19+, Git and Docker, on Linux or macOS. Rust **1.85.1** runs in its pinned builder container, so no host toolchain is needed; native artifacts and the image target the Docker Engine's architecture (`PI_LAYERFS_PLATFORM=linux/amd64|linux/arm64` overrides it). The upstream source is public MIT and locked to the qualified revision.

```bash
npm ci
npm run typecheck
npm test
npm run release:build
```

The builder fetches the pinned LayerFS source into ignored `.build/`, builds the native addon/daemon in `rust:1.85.1-bookworm`, collects licenses for all locked Rust packages, builds the runtime image and creates versioned archives plus `SHA256SUMS` under `release-out/`. It audits the actual npm tarball and loads it from a clean directory without local `node_modules`. To reuse an already qualified Bookworm build, pass `npm run release:build -- --upstream /path/to/qualified/layerfs`.

For development against an existing checkout, `scripts/prepare.sh` and `scripts/client.sh` remain available, e.g. `bash scripts/prepare.sh "$PWD/.build/layerfs"` then `bash scripts/client.sh .layerfs-local/env.sh npm run test:integration`. On macOS the client keeps a Linux `node_modules` in its own volume. They are optional developer tools, not release installation requirements.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run lint
bash -n bin/pi-layerfs release/install.sh scripts/build-native.sh
npm run test:release
pi-layerfs --self-test
```

The original real smoke verifies SDK/daemon/Store operations, Pi extension loading/session registration, normal/nonzero/timeout/cancel command lifecycle, branch isolation and cross-process initialization reuse. The parity smoke adds empty/imported project creation, persistent session identity, retained Workspace/process controls, two real Pi worker tool loops against a credential-free deterministic local model endpoint, merges/conflict resolution/publish/reopen, history/storage, authenticated HTTP inspection and project cleanup. It uses real LayerFS throughout.

The recovery smoke (`npm run test:recovery` through the client, on a dedicated volume) starts four processes on one new project at once, including the first capture; SIGKILLs a process holding a retained Workspace with uncommitted changes plus an in-flight Bash Workspace; and checks that the next session's initialization reclaims both at once, keeps the retained change on its Branch and leaves no mounts. [Its receipt](docs/recovery-receipt.jsonl) records the earlier, expiry-only version of this smoke.

For browser acceptance run `scripts/parity-smoke.ts --serve` through the client. It reports a private dashboard URL and test finish URL, retains fixtures for at most 15 minutes, then removes the dedicated project volumes while preserving source/journals. Use the finish URL when inspection completes. See [docs/verification.md](docs/verification.md) and the parity evidence linked there for actual identifiers, commands and acceptance boundaries.
