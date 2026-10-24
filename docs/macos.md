# macOS container deployment (development)

Status: the host installer and launcher have a macOS path. Real macOS qualification is pending; do not treat the existing public v0.1.0 Linux release as a tested macOS release. Linux regression and the gallus receipt must be recorded before promoting this work.

## Architecture and requirements

Pi, the SDK/native binding, daemon, Store and FUSE run inside Linux containers in Docker's VM. The Mac only runs the Bash launcher and Docker CLI. Project folders on APFS are shared read-only into the client container; Stores remain in plain local ext4/xfs/btrfs Docker volumes. No macFUSE, host Node/npm/Rust or separate upstream checkout is required at installation.

The current payload is **linux/amd64**. Intel Macs run that architecture; Apple Silicon requires Docker's amd64 emulation. This is not a native arm64 kernel/runtime build and may be slower. The image is explicitly selected with `--platform linux/amd64`.

Use a local Unix-socket Docker context with Linux containers, a VM `/dev/fuse`, and host networking:

- Docker Desktop: enable **Settings → Resources → Network → Enable host networking**. Enable amd64 emulation on Apple Silicon as appropriate for that installation.
- Colima: the Linux VM must support amd64 execution, host networking, and forwarding VM localhost ports to macOS. Keep test sources and evidence under the shared home directory.
- Other VM backends are unqualified. The installer probes native loading/FUSE, container-to-container loopback and macOS-to-container loopback before changing the installation.

The host CLI socket is resolved from the active Docker context (or DOCKER_HOST when DOCKER_CONTEXT is not set) and pinned in private deployment state. On macOS, containers mount `/var/run/docker.sock` from the Engine VM, not the Mac's Docker proxy socket. Changing engines requires a separate installation or explicit deployment reconciliation; existing Store data belongs to its original engine.

The launcher keeps `--network host` so daemon RPC and the existing loopback-only dashboard retain the Linux behavior. Network access does not require weakening dashboard authentication or binding it to all interfaces. The network probe makes no Docker Desktop setting changes.

Bash 3.2 syntax is used for host scripts. Hashing uses `sha256sum` or macOS `shasum -a 256`; path canonicalization uses `cd` and `pwd -P`. Docker bind mounts fail when the source is not shared; they do not create an empty replacement directory. Source paths containing commas are currently refused.

## Build and verify

Build the candidate on the qualified Linux build host:

```bash
node scripts/build-release.mjs --upstream /path/to/pinned/layerfs \
  --target macos --out /tmp/pi-layerfs-macos-build
```

This produces an offline `pi-layerfs-VERSION-macos.tar.gz`, plugin tgz, checksums and manifest. `--out` keeps candidate assets separate from the published release output. `runtimePlatform` and `appleSiliconEmulation` are recorded in the manifest.

On the Mac, verify the external archive checksum, extract it under the shared home directory, then run:

```bash
bash /path/to/extracted-bundle/host-smoke.sh /path/to/extracted-bundle \
  "$HOME/.cache/pi-layerfs-gallus-check"
```

Use a fresh evidence directory. This installs into an isolated prefix containing spaces with `--skip-register`, so it does not replace the normal installation or Pi registration. The harness records:

1. Host OS/architecture, Docker context and Engine/client versions.
2. Checksum verification, offline installation, native/FUSE and localhost connectivity probes.
3. Four independent Pi worker sessions, concurrent test execution, merge/publish and reopen.
4. Two read-only host projects with space-containing paths, actual SDK import/exec/commit and reopen in separate launcher invocations.
5. EROFS on host writes, no host `.pi` or generated test files, separate Store volumes and deterministic bindings after reopen.

Logs, fixtures and owned test volumes are retained for inspection. A passing Linux run, or a simulated Darwin `uname`, is not proof of macOS compatibility. Model credentials are unnecessary for this acceptance; real model execution is a separate optional validation.

## gallus handoff

The candidate build host is `jazz1`, checkout `/home/yanweiye/.t3/projects/pi-layerfs`. The current candidate output is `/tmp/pi-layerfs-macos-build-v3`; this is an uncommitted development candidate, not the published v0.1.0 asset.

A T3 session on GALLUS can use its existing SSH access to retrieve `pi-layerfs-0.1.0-macos.tar.gz` and `SHA256SUMS` from `yanweiye@jazz1:/tmp/pi-layerfs-macos-build-v3/`, verify the macOS archive with `shasum -a 256`, extract under its home, then run the bundled harness. Do not copy credentials or private deployment state. Report failures with logs rather than changing Docker/account security preferences silently. Return receipts to a new evidence directory on jazz1 and include any necessary patches separately; do not overwrite the shared checkout from GALLUS.

The current session discovered the GALLUS environment through T3 Connect but its cross-environment token exchange returned HTTP 401 `invalid_bearer`. The available MCP thread tools are scoped to jazz1, and the SSH alias `gallus` does not resolve from jazz1. A usable T3 session on GALLUS or its reachable SSH address is still needed for real qualification.
