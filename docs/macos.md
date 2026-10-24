# macOS

pi-layerfs runs on macOS through the Linux VM of **OrbStack** or **Docker
Desktop**. The plugin, SDK, native binding and daemon always run in Linux
containers on that VM; nothing LayerFS-specific runs on macOS itself. FUSE comes
from the VM kernel, and Stores live in ordinary Docker volumes on the VM's own
disk (btrfs on OrbStack, ext4 on Docker Desktop), never on APFS.

| Mac | Engine architecture | Release archive |
| --- | --- | --- |
| Apple Silicon | `linux/arm64` | `pi-layerfs-<version>-linux-arm64.tar.gz` |
| Intel | `linux/amd64` | `pi-layerfs-<version>-linux-x64.tar.gz` |

The launcher and installer refuse a bundle whose image architecture differs
from the Engine's, rather than running under emulation.

## Build and install from source

Only Docker, Node 22.19+ and git are needed on the Mac. The pinned
`rust:1.85.1-bookworm` builder produces the native artifacts for the Engine's
architecture, so no host Rust toolchain is used:

```bash
npm ci
npm run release:build            # fetches LayerFS at the pinned revision
tar -xzf release-out/pi-layerfs-*-linux-arm64.tar.gz -C /tmp
bash /tmp/pi-layerfs-*-linux-arm64/install.sh
pi-layerfs --self-test
```

`PI_LAYERFS_PLATFORM=linux/amd64` builds the other architecture. The scripts
work with macOS's stock Bash 3.2 and BSD userland.

## Networking

The launcher uses host networking on every platform. The Pi container joins
the VM's network namespace, where each Sandbox daemon publishes its port on
`127.0.0.1`, the same topology as on Linux.

- **OrbStack** forwards host-network loopback listeners to macOS, so the
  `/layerfs ui` URL opens directly in a Mac browser.
- **Docker Desktop** forwards them only when *Settings → Resources → Network →
  Enable host networking* is on (Docker Desktop 4.34+). The daemons do not need
  it; only the dashboard does.

`PI_LAYERFS_NETWORK=bridge` is an opt-in alternative for Engines without host
networking. The daemons are then dialed through `host.docker.internal`, and the
dashboard listens on the container interface; Docker publishes it on the Mac's
`127.0.0.1` and the plugin reads back the assigned port, so the reported URL
works from both the Mac and the container. **Do not use bridge mode on
OrbStack.** OrbStack sets up those forwarded ports asynchronously and the SDK
dials a new daemon exactly once, so 16 of 30 fresh Sandbox creations were
refused (`ConnectionRefused` at `Connect`). Host networking had 0 of 30.

Model endpoints on the Mac (for example a local model server on
`localhost`) are reached as `host.docker.internal` from the container.

## Source directories

The project directory is bind-mounted read-only at its macOS path. OrbStack
shares every path. Docker Desktop shares `/Users`, `/Volumes`, `/private`,
`/tmp` and `/var/folders` by default; add other locations under *Settings →
Resources → File sharing*. On OrbStack, a host file rewritten in place can keep its previous size in
path-based `stat` inside containers for minutes, even across a host `touch`.
Opening the file usually revalidates it, but not always. In five
reproductions where path `stat` was stale for 5 of 6 rewritten files, the
LayerFS capture through the launcher stored all of them at their current size.
Still, let editors and builds finish writing before you import a directory.
Development runs through `scripts/client.sh` can hit the same effect when tsx
loads a just-edited source file ("Unexpected end of file"); rerun after a short
pause.

## Verification on macOS

Recorded on 2026-10-24: macOS 27.0 (Darwin 27.0.0, Apple Silicon), OrbStack
with Docker Engine 29.8.2 `linux/arm64`, Store volume on btrfs. The host's
`/bin/bash` 3.2 ran the installer and launcher.

| Check | Result |
| --- | --- |
| `bash scripts/build-native.sh` | aarch64 ELF daemon and binding, 142 licensed crates, about 60 s |
| `npm run release:build -- --upstream .build/layerfs` | `pi-layerfs-0.1.0-linux-arm64.tar.gz` |
| `install.sh` (stock Bash 3.2) | Checksums verified, Engine FUSE checked, installed |
| Unmodified plugin (before the port) | Self-test failed 20 of 20: the Store check rejected OrbStack's btrfs subvolume mount |
| `pi-layerfs --self-test` | Passed 5 of 6 in the final run: four isolated developer Branches, integration, reopen; the failure is the upstream issue below |
| `npm test` on the Mac | 46 passed |
| `npm run test:integration` through `scripts/client.sh` | Passed, including reopen |
| `npm run test:parity` with `--manage-projects` | Passed in every host-network run: two real Pi worker loops, merges, conflict, publish, project create/import/remove, authenticated dashboard |
| Real macOS directory through the launcher | Imported read-only, committed, reopened with history; host files unchanged |
| `docker kill` of Pi during a 15 s command | Next session reported the Workspace `pending` (its command still running), reclaimed it when the timeout ended, discarded the partial write and kept working |
| Pi killed with a retained Workspace running `sleep 1000` in the background | Reported in `recovery.orphaned` with its process; `layerfs_cleanup {orphans:true}` stopped the process and unmounted it |

### Known upstream issue

About 1 in 15 to 25 self-tests on this Mac fail at their final retained
Workspace `unmount`, after `node --test` and a successful commit. The daemon
reports `Retained(TeardownCustody { stage: Join, … loops_exited: 0 })` and then
keeps the Workspace in terminal custody, refusing later attach, unmount and
forced unmount. The plugin code from before the macOS port, with only the Store
mount fix applied, fails the same way (1 of 25), so this is the pinned LayerFS
revision's teardown race, not a plugin regression. The commit has already
landed when it happens; restarting the Pi session releases the plugin's side.

### Disk use with parallel workers

One project tree of 15,129 files / 296 MB (a `node_modules` tree), the lead
Branch plus 8 worker Branches, each worker editing the tree and committing in
parallel:

| Measure | Bytes |
| --- | --- |
| Nine independent copies (worktree or `cp` per agent) | 2.67 GB |
| LayerFS Store after import | 107 MB (2.7× compression of canonical content) |
| LayerFS Store after all 8 workers committed | 108 MB, about 130 KB per worker |
| Shared Sandbox writable layer | 11 MB, one container for all workers |

All eight commands committed, in 0.8 s total. The Store reported 2.66 GB of
logical content held in 102 MB of stored data.
