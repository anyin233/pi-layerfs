# Self-contained release verification

The v0.1.0 Linux x86_64 distribution carries the complete runtime in its archive.
Its external runtime requirements are Linux/FUSE, Docker Engine and a plain
local ext4/xfs/btrfs volume. Model access still requires user credentials.
Host Rust, Node, npm, a LayerFS source checkout and the unpublished
`@layerfs/agent`/`@layerfs/backend` packages are not installation requirements.

The complete archive has been extracted and installed into a fresh prefix with
spaces in its path. Installation and the four-worker self-test passed with a
host PATH containing no Node, npm, Cargo, rustc or Pi. The bundled image archive
was also loaded through `docker load`. Separate project directories imported
into different Stores, reopened their original bindings and stayed read-only;
a corrupted VERSION checksum was refused before installation created a prefix.

The plugin tarball and complete installation archive have different scopes:

| Asset | Contents |
| --- | --- |
| `pi-layerfs-0.1.0.tgz` | Pi extension source and compiled code, vendored `@layerfs/agent` and `@layerfs/backend` JS, Linux native binding, daemon and license notices; Pi peers come from the host |
| `pi-layerfs-0.1.0-linux-x64.tar.gz` | The plugin tarball, complete Docker image including Pi 1.4.0 and production dependencies, installer, provenance manifest and internal checksums |
| `SHA256SUMS` | Checksums of the two release archives |
| `release-manifest.json` | Immutable runtime image identity, source commit, qualified upstream revision and platform requirements |
| `release-verification.json` | Final installed-archive acceptance receipt, attached to the GitHub release |

The builder checks that the package contains the vendored `@layerfs/agent` and
`@layerfs/backend` entries, native ELF binding, executable daemon and dependency
license index; those packages are its only `node_modules`. It extracts the real
tarball to a new temporary directory without the development `node_modules`,
imports both vendored entries and loads its declared package entry through Pi's
public resource loader. A host-only
installation registers no replacement tools until a deployment is supplied.

The runtime image includes the SDK/native/daemon at fixed internal
`/opt/pi-layerfs/vendor/layerfs` paths and Pi under `/opt/pi-runtime`. The
launcher does not mount the development checkout, npm development dependencies
or an upstream checkout. Host project sources are mounted read-only. Each
canonical project directory receives its own labelled Store volume; Pi model
credentials and settings use a separate private control volume.

`pi-layerfs --self-test` creates a dedicated temporary Store and uses real Pi
sessions, the native binding, the daemon, FUSE mounts and Docker commands. Four
workers read a small source module, add tests in isolated branches and execute
them in parallel. The lead merges them, runs the four tests in a retained
Workspace, commits/unmounts, publishes and reopens the saved project. The test
also verifies that branch writes do not appear in the input source or another
worker's branch. It makes no model requests and needs no credentials. A
successful self-test removes only its own sandbox and Store; failure retains
evidence for inspection.

Final acceptance installs from the extracted archive into a fresh prefix and
launcher directory, verifies checksums and the bundled image, then runs the
same self-test through the installed launcher. Installer checksum refusal is
checked before any package replacement. Ordinary project launches are checked
for independent volumes and deterministic reopening without `.pi` writes into
host sources. The complete archive can also register its unpacked plugin in an
existing host Pi installation.

The source checks are `npm run typecheck`, `npm test`, `npm run lint`,
`npm run build`, `npm run test:release`, shell syntax checks and active LSP
probes on changed TypeScript. The GitHub workflow runs source checks on pushes
and PRs; manual workflow dispatch additionally rebuilds the native code and
complete distribution and runs installed-archive acceptance.

License collection covers the locked Cargo dependency set and Rust standard
library notices. Supplemental license files for crates whose source archives
omit their repository-level texts are pinned to public source commits and
recorded in `vendor/layerfs/supplemental-licenses/SOURCES.json`.

No credentials, Docker volumes, private deployment environments, KernelAgentIR
source snapshots or local `node_modules` are shipped. The benchmark documents
are historical evidence; their workstation-specific paths are not deployment
dependencies. LayerFS remains a Disposable Store and this verification does not
claim power-loss durability or isolation from a malicious host process.
