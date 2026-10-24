# Verification record

Verified against Pi `1.4.0`, LayerFS `1aa56ece78e2ecd71b46cf07076100345df47239`, Linux x86_64, Docker Engine `29.5.3`, host Node `24.13.1`, runtime Node `24.21.0`, Rust `1.85.1`, and an ext4-backed plain local Docker volume.

[Machine-readable smoke receipts](smoke-receipt.json) contain the actual SDK/Pi results, branch and commit identifiers, output, expected errors, and daemon Workspace snapshots. The isolated test project is retained for inspection. No credentials or host checkout data were imported; its source contains a seed file and the plugin configuration.

## Sources checked before implementation

- [LayerFS repository](https://github.com/Ephemeral-AI-Lab/layerfs/tree/1aa56ece78e2ecd71b46cf07076100345df47239).
- [JavaScript SDK guide](https://github.com/Ephemeral-AI-Lab/layerfs/blob/1aa56ece78e2ecd71b46cf07076100345df47239/sdk/js/README.md), including the deployment environment, direct Store path, native build, refusal semantics, and operator diagnostics.
- SDK implementation: `src/index.js`, `client.js`, `project/init.js`, `project/list_branches.js`, `branch/fork.js`, `fs/read.js`, `fs/edit.js`, `fs/write.js`, `fs/apply.js`, search methods, and Workspace exec/commit/unmount wrappers.
- Rust project initialization and Workspace value conversion, including the genesis Layer, null initial Commit, `Committed`/`UpToDate`, and `Dirty`/`Busy` behavior.
- Docker topology implementation: only plain local volumes without driver options are admitted.
- Official DSH integration's Linux/Bookworm deployment instructions and pinned runtime Dockerfile. No DSH APIs are used by this plugin.
- Installed Pi's complete `docs/extensions.md`, `packages.md`, `configuration.md`, `settings.md`, `environment-variables.md`, and `sdk.md`; `examples/extensions/ssh.ts`; public declarations and implementation of tools, extension loading/runner/wrappers and session registry. Pi supports same-name tool registration and pluggable operations. LayerFS's bounded text API does not fit the full-Buffer read contract, so this plugin overrides tool definitions through public registration instead.

## Environment/build work

| Command or check | Observed result |
| --- | --- |
| `uname -s` | `Linux` |
| `node --version` | `v24.13.1` |
| `docker version` | Client and server `29.5.3`, API `1.54` |
| `findmnt -T . -o TARGET,SOURCE,FSTYPE,OPTIONS` | `/dev/nvme0n1p2`, `ext4`, read/write |
| `cargo +1.85.1 --version` | `cargo 1.85.1 (d73d2caf9 2024-12-31)` |
| `pkg-config --modversion fuse3` | `3.14.0` |
| `cargo +1.85.1 fetch --manifest-path /tmp/pi-layerfs-upstream/core/Cargo.toml --locked` | Exit 0; populated missing offline dependencies |
| `npm --prefix /tmp/pi-layerfs-upstream/sdk/js run build:native` | Exit 0; release addon built |
| Host `cargo +1.85.1 build ... --offline --locked --release -p layerfs-daemon --bins` | Exit 0; host daemon built |
| `bash scripts/prepare.sh /tmp/pi-layerfs-upstream` | Exit 0 after correcting runtime ABI; built Bookworm daemon/addon and official runtime, created dedicated volume and private generated environment |
| Runtime Store check | `/proc/self/mountinfo` identifies ext4; mount root matches Docker volume mountpoint; SDK path is the same volume's `global/store.sqlite` |

The first offline native build before cache preparation had failed with `no matching package named libproc found` (exit 101). Fetching the locked dependencies resolved it without changing the lockfile.

The first real mount using the host-built daemon failed with:

```text
/usr/local/bin/layerfs-daemon: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found (required by /usr/local/bin/layerfs-daemon)
```

LayerFS reported the failed sandbox container removed. The preparation script was corrected to use the upstream Rust Bookworm container build, and real mounting subsequently succeeded. The installed Docker runtime was not silently substituted.

## Static and unit checks

All passed on the final source:

- `npm run format`: 5 files, no further fixes.
- `npm run lint`: 5 files, no findings or warnings.
- `npm run typecheck`: exit 0.
- `npm test`: **24 passed**, zero failures or skips.
- `npm run build`: exit 0; generated JS and declarations under `dist/`.
- `bash -n scripts/prepare.sh scripts/client.sh`: exit 0.
- Active LSP probe of the three source files, smoke script, and unit tests: 5 clean, zero diagnostics, zero unsupported/unavailable files.
- `npm pack --dry-run --json`: package entry and runtime declarations are present; local environment, Store, caches, and node_modules are excluded.

The harness's shell-output wrapper initially misclassified the Biome lint script as ESLint, producing `ESLint output (JSON parse failed: EOF while parsing a value at line 1 column 0)`. Running the same npm scripts through Node `spawnSync` bypassed the output wrapper and verified the actual formatter/linter results. This was a harness reporting issue, not a linter failure. Biome's deprecated `recommended` setting was also replaced by its current `preset` setting, and guarded runtime assertions replaced non-null assertions.

## Real integration

Command:

```bash
bash scripts/client.sh .layerfs-local/env.sh npm run test:integration
```

Exit 0. The test first exercises the real SDK/native binding/daemon, then creates a real Pi `DefaultResourceLoader` and `AgentSession`, verifies the winning tool definitions, and invokes loaded tools using Pi's exported wrappers and hooks. It does not impersonate a model response or modify internal Pi state. No remote LLM or model credentials are used.

| Observation | Result |
| --- | --- |
| Project / Branch | `pi-smoke` / `pi-work` |
| Initial state | `main @ L0`; genesis `329ed569c80725ebfff2eca988f9d415441b8709a9c29fbf9abb1a8ddecd7124ab`; initial Branch head `null` |
| SDK preflight | mount → exec `printf sdk-ok` → `UpToDate` commit → `Unmounted` |
| Pi file tools | write `hello`, exact edit to `world`, read `world\n`; host source has no temporary file |
| Search tools | `ls`, `find`, and `grep` return active Branch results |
| Path escape | `/etc/passwd` refused before SDK invocation |
| Bash Workspace | Sandbox `1`, `/workspaces/2` on immutable image `sha256:0ee21e3923293d06ed3dd3d653bd513d11eab506e370ef435ee12096cc3dc936` |
| Bash output | stdout `stdout`, stderr `stderr`, exit 0; completion trailer absent from user output |
| Verified command Commit | `1203cdc0302163166b81fb46937bcf4cd591f564260f420b4ce956e443207f7841`; present in `list_commits`, `via: exec` |
| Normal exit 7 | Error result plus successful Commit; modified file readable from Branch |
| Normal exit 124 | `timedOut: false`; normal completed-command commit path |
| No-change command | `UpToDate`; Commit count unchanged |
| Timeout | `timedOut: true`; temporary file discarded; history unchanged |
| Cancellation | Waited for exec; no Commit; temporary file discarded |
| Hashline hook | `replace` blocked |
| Main isolation | Same genesis base and null main head; seed unchanged |
| Process restart | New child process loaded extension and reused exact binding; one genesis Layer remained |
| Cleanup | Temporary files removed through SDK; final head `120a64f0d59dea1c6bb61cb84f514f551e3c62d8eee46b49334941de97ca5a2edd`; all daemon Workspace lists empty |

A separate real CLI entry smoke also exited 0:

```bash
bash scripts/client.sh .layerfs-local/env.sh bash -c \
  'cd /layerfs-store/fixture && node "$PI_LAYERFS_PLUGIN/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" --no-extensions --extension "$PI_LAYERFS_PLUGIN/dist/extension.js" --print /layerfs'
```

`/layerfs` is notification-based and produces no stdout in print mode. This confirms CLI loading/command dispatch; the detailed tool acceptance is the loader/session smoke above.

## Limits of the acceptance

No remote-model conversation was tested. Arbitrary third-party tools and extension collisions are outside the clean-profile acceptance. Cancellation is deferred by the SDK foreground API. Daemon loss, a killed Pi process, or processes that outlive a command can prevent automatic unmount; manual operator inspection remains necessary in those cases. File metadata is preserved only within SDK capabilities. LayerFS is currently Disposable, with no crash or power-loss durability.

Advisor review was attempted for the implementation direction and completion; the tool returned `Advisor model not configured`. Work continued with local source verification, tests, LSP, and real integration evidence.

## Crash recovery and concurrent startup (2026-10-24)

Same host and Docker Engine as above; dev runtime image `sha256:0ee21e3923293d06ed3dd3d653bd513d11eab506e370ef435ee12096cc3dc936`. Each run used a new labelled plain local volume and a unique container prefix. All results below are from the final source.  The test volumes and their stopped Sandboxes were removed after the receipts were saved.

| Check | Command | Result |
| --- | --- | --- |
| Static | `npm run typecheck`, `npm run lint`, `npm run build` | Exit 0 |
| Unit | `npm test` | 56 passed, 0 failed |
| Recovery | `bash scripts/client.sh ENV npm run test:recovery`, fresh volume `pi-layerfs-3873c40a5559-final-1792845750` | Exit 0; [receipt](recovery-receipt.jsonl) |
| Baseline smoke | `bash scripts/client.sh ENV node_modules/.bin/tsx scripts/smoke.ts`, volume `pi-layerfs-3873c40a5559-regress-1792844661` | Exit 0, 43 receipt lines |
| Parity smoke | `bash scripts/client.sh ENV --manage-projects node_modules/.bin/tsx scripts/parity-smoke.ts`, same volume | Exit 0, 47 receipt lines; two real Pi worker loops completed; both test projects removed through the lease-based removal admission |

Recovery receipt observations:

- Four processes started sessions of one new project at once, including the first capture; all were ready on `pi-work`.
- A process holding a retained Workspace with an uncommitted, run-unique `recovered.txt` plus an ordinary Bash Workspace was killed with SIGKILL. Both stayed mounted in `inspect.snapshot`, each recorded with its Sandbox container id. A session started before expiry did not take them.
- After expiry plus the monotonic confirmation, a heartbeat of a new lead reclaimed both: the retained Workspace was `Committed` to `pi-work` with the recovery message, `recovered.txt` read back with the run's token, and no Workspace remained mounted. The Sandbox then idle-closed.

Issues found and fixed while verifying:

- The first attempt on the shared development volume failed with `Store install: Store destination exists`: that volume already holds the `pi-smoke` Store (one project per Store volume). Only the artifacts that attempt created (intent, project home, traces, fixture) were removed.
- Killing the `tsx` CLI left its node child heartbeating, so its lease was correctly not reclaimed; the script spawns node directly.
- With concurrent startup possible, two of four starters failed in `operator.inspect.snapshot` while another starter's `sandbox.list` deleted a stopped Sandbox left by an earlier run (`WireFailure … exact running container observation`). Startup verification now reads only Store history (`operator.inspect.history`), which probes no Sandbox; the rerun passed.
- An independent review found that a lease identified Workspaces only by Sandbox number and path, both of which LayerFS reuses after a container is replaced; that expiry trusted the wall clock; and that `NoSuchSandbox` on process cancel, transient commit failures, shutdown/tick races, cached scan errors, lock takeover races, unreadable leases and worker-initiated reclaim were mishandled. Each has a unit test or code change described in the README's Crash recovery section.
