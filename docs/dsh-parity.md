# DSH capability mapping and implementation contracts

Scope: the production capabilities described by https://layerfs.ai/docs/integrations/dsh/, checked against LayerFS source `ad78914e36b258b360daf13aec164b5655814689` (1.1.0) and installed Pi 1.4.0. The DSH tab now lives in the separate dsh-layerfs repository. DSH-specific layout slots are represented by a local browser dashboard and Pi commands. The original Linux/local-filesystem and no-host-project-fallback requirements remain in force.

| DSH capability | Pi implementation / acceptance target |
| --- | --- |
| New empty project / import a folder | `layerfs_project init`, `/layerfs init`, dashboard form; dedicated labelled Docker volume per project, async job and native Init progress (`runtime.project.get_init`) |
| Project picker, choice fixed at first call | `/layerfs use`, project tool/dashboard; bind after first project operation; persist `layerfs-project` session entry |
| Return to projects / new session | Project registry and dashboard selector; `/layerfs session NAME` via public `ctx.newSession`, session entry restores choice |
| Remove project with name confirmation | Owned-project removal, exact name, live-agent/Workspace refusal, labelled volume/container checks, base volume protected |
| SDK file operations and history | Current tools plus `layerfs_fs`: stat, mkdir, cp, mv, apply, historical read/list/blame/diff_files; SDK pagination and truncation preserved |
| Branches, merges, publishes | `layerfs_branch`; merge always creates the SDK's new named Branch; lead-only publish; reopen after published Layers |
| One Workspace per agent / retained conflict state | `layerfs_workspace`; owned handles, explicit commit/unmount, Busy/Dirty/Conflict preserved |
| Background jobs | `layerfs_process` using `@layerfs/backend` `daemon.process.start/list/cancel`; ownership enforced by the plugin |
| Subagents with labels and independent Branches | `layerfs_agent` creates Pi SDK AgentSessions, asynchronous tasks, status/message/cancel; workers cannot publish/spawn children through these tools |
| Parent model/auth and compaction | Public ModelRuntime provider adapter routes each worker request through the parent ModelRegistry; worker session compaction retained, SDK retries disabled |
| Minimalist preset | `--layerfs-minimalist` or `/layerfs minimalist`; expose Bash plus LayerFS workflow tools, without ordinary read/write/edit names |
| SDK trace and per-agent call records | Native SDK trace per actor, tool-call start/end journal, Pi custom call entries, agent lifecycle records |
| Work terminals, Branch/agent filters, Follow | Local dashboard Work view, stdout/stderr/exit/Commit metadata, native call summaries, Sandboxes and Workspaces |
| Branch/Commit/Layer History | Store history (`backend.store.project.get_history`) with live Sandbox Workspaces rendered as a graph; merge parents, publish links, agent attribution from actual traces; older Branch/Commit pages |
| Play history | Read-only recorded-call playback and cursor; no SDK mutations or command replay |
| Files at any saved node | Click graph id, SDK read/list/stat/blame and paginated comparisons; binary metadata and explicit partial flags |
| Storage | Native Store stats, logical/canonical/stored/metadata/SQLite fields, ratios and per-Commit additions; file revision diagnostics |

The disabled DSH demo/mock-model bundle is explicitly not part of its production release. This plugin does not copy its demos, avatar art, simulator, DSH UI patches, WSL adapter, or private harness APIs. A deterministic local test model may drive acceptance; it is not a runtime fallback. The production Store always remains real LayerFS.

Verified API sources:

- [`api/how-to-use/agent.md`](https://github.com/Ephemeral-AI-Lab/layerfs/blob/ad78914e36b258b360daf13aec164b5655814689/api/how-to-use/agent.md) and [`backend.md`](https://github.com/Ephemeral-AI-Lab/layerfs/blob/ad78914e36b258b360daf13aec164b5655814689/api/how-to-use/backend.md): factories, positional method table, explicit Sandboxes, refusals, backend reads, tracing and limits; [1.1.0 release notes](https://github.com/Ephemeral-AI-Lab/layerfs/blob/ad78914e36b258b360daf13aec164b5655814689/docs/release-notes/1.1.0/README.md) for the changes in 1.1.0.
- `api/agent/sdk/src/branch/{merge,publish,diff_branches,diff_commits}.js`: merge `(a,b,name,message,units)`, publish `(branch,commit?)`, cursor-based diffs.
- `api/agent/sdk/src/fs/index.js` and individual wrappers: seven reads, seven writes; mutations never target main.
- `api/agent/sdk/src/{sandbox,workspace}/*.js` and `project/list_sandboxes.js`: `sandbox.create`, `workspace.mount(sandbox, branch)` with no placement, `NoSuchSandbox`/`Capacity` refusals, per-Sandbox Workspace listings with a daemon `version`.
- `api/backend/src/**` and `api/agent/sdk/src/names.js`: backend groups and the `RENAMED_METHODS` map from the former operator names.
- `api/agent/sdk/src/trace.js`: content omitted/byte-counted; command/path summaries may contain user data; results identify Commit/Layer/Workspace/process without extra calls.
- `dsh/packages/host/src/{layerfs-client,init,remove,reads,storage,env}.js`: per-project environment captured in a synchronous constructor bracket; separate project volumes; source count/import progress; remove ownership; saved-state file reads and Storage semantics.
- Installed Pi `docs/sdk.md`, public declarations for `DefaultResourceLoader.extensionFactories`, `createAgentSession`, `ModelRuntime.registerProvider`, `ModelRegistry.streamSimple`, `AgentSession.bindExtensions/prompt/abort/dispose`, `SessionManager.create/appendCustomEntry`, and extension `registerTool`, `appendEntry`, `setActiveTools`, `newSession`.

Publication changes the original L0-only startup invariant: genesis stays recorded, while current main and Branch bases may reference later Layers verified in the native history. A missing genesis in a bounded snapshot is an explicit reconciliation error, never a reimport. Viewer clients do not fork Branches.

Dashboard data requires a per-process random bearer token, listens on loopback only, refuses foreign Host/Origin, has no CORS, uses CSP and text nodes, and never places tokens in URLs sent to the server. It is a control-plane surface with the same authority as the Pi process. The management launcher explicitly adds access to the local Docker volume directory; normal one-project launch remains available.
