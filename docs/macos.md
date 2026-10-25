# macOS

pi-layerfs runs on macOS through the Linux VM of **OrbStack** or **Docker
Desktop**. The plugin, SDK, native binding and daemon always run in Linux
containers on that VM; nothing LayerFS-specific runs on macOS itself, so no
macFUSE, host Node/npm/Rust or LayerFS checkout is needed to install. FUSE
comes from the VM kernel, and Stores live in ordinary Docker volumes on the
VM's own disk (btrfs on OrbStack, ext4 on Docker Desktop), never on APFS.

**Status:** macOS has not been verified with LayerFS 1.1.0, and no macOS
archive is part of the v0.1.0 release. Results recorded with the previous
LayerFS revision are not carried over; run the acceptance procedure below on a
real Mac before relying on it. A passing Linux run, or a simulated Darwin
`uname`, is not proof of macOS compatibility.

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

`PI_LAYERFS_PLATFORM=linux/amd64` builds the other architecture, and
`--out DIR` keeps candidate assets apart from `release-out/`. The host scripts
use the Bash 3.2 and BSD userland shipped with macOS: hashing uses `sha256sum`
or `shasum -a 256`, and paths are canonicalized with `cd` and `pwd -P`.

## Docker Engine

The installer resolves the host CLI's socket from the active Docker context
(or `DOCKER_HOST` when `DOCKER_CONTEXT` is not set), refuses TCP and remote
contexts, and pins that socket in the private deployment state; every later
Docker call uses it even if the user's context changes. Containers mount the
Engine VM's `/var/run/docker.sock`, not the Mac's proxy socket. Changing Engines
requires a separate installation; existing Store data belongs to its original
Engine. Before installing, the installer checks the image architecture, loads
the native binding with the VM's `/dev/fuse`, and on host networking probes
both container-to-container and macOS-to-container loopback. It changes no
Docker settings.

## Networking

The launcher uses host networking on every platform. The Pi container joins
the VM's network namespace, where each Sandbox daemon publishes its port on
`127.0.0.1`, the same topology as on Linux.

- **OrbStack** forwards host-network loopback listeners to macOS, so the
  `/layerfs ui` URL opens directly in a Mac browser.
- **Docker Desktop** forwards them only when *Settings → Resources → Network →
  Enable host networking* is on (Docker Desktop 4.34+).
- **Colima** needs host networking and localhost port forwarding; it is
  otherwise unqualified.

`PI_LAYERFS_NETWORK=bridge` (set for both `install.sh` and the launcher) is an
opt-in alternative for Engines without host networking. The daemons are then
dialed through `host.docker.internal`, and the dashboard listens on the
container interface; Docker publishes it on the Mac's `127.0.0.1` and the plugin
reads back the assigned port, so the reported URL works from both the Mac and
the container. Avoid bridge mode on OrbStack: it sets up those forwarded ports
asynchronously, and a fresh Sandbox's daemon can be refused at `Connect`.

Model endpoints on the Mac (for example a local model server on `localhost`)
are reached as `host.docker.internal` from the container.

## Source directories

The project directory is bind-mounted read-only at its macOS path; a source
that is not shared with the VM fails to mount rather than appearing empty, and
paths containing commas are refused. OrbStack shares every path. Docker Desktop
shares `/Users`, `/Volumes`, `/private`, `/tmp` and `/var/folders` by default;
add other locations under *Settings → Resources → File sharing*. On OrbStack, a
host file rewritten in place can show its previous size to path-based `stat`
inside containers for a while; let editors and builds finish writing before you
import a directory. Development runs through `scripts/client.sh`, which keeps
its own Linux `node_modules` in a volume, can hit the same effect when tsx loads
a just-edited source file ("Unexpected end of file"); rerun after a short pause.

## Real-host acceptance

On the Mac, verify the archive checksum, extract it under a shared directory,
then run the bundled harness with a fresh evidence directory:

```bash
bash /path/to/extracted-bundle/host-smoke.sh /path/to/extracted-bundle \
  "$HOME/.cache/pi-layerfs-host-check"
```

It installs into an isolated prefix containing spaces with `--skip-register`,
so it does not replace the normal installation or Pi registration, and records:

1. Host OS/architecture, Docker context and Engine/client versions.
2. Checksum verification, offline installation, native/FUSE and loopback probes.
3. The self-test: four independent Pi worker sessions, concurrent test
   execution, merge/publish and reopen.
4. Two read-only host projects with space-containing paths, actual SDK
   import/exec/commit and reopen in separate launcher invocations.
5. EROFS on host writes, no host `.pi` or generated files, separate Store
   volumes and deterministic bindings after reopen.

Logs, fixtures and owned test volumes are retained for inspection. Model
credentials are unnecessary for this acceptance.
