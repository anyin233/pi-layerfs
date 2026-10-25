# Third-party notices

pi-layerfs is distributed under the MIT license in [LICENSE](LICENSE).

## LayerFS

The bundled JavaScript packages, native Node binding and daemon come from
[Ephemeral-AI-Lab/layerfs](https://github.com/Ephemeral-AI-Lab/layerfs), revision
`ad78914e36b258b360daf13aec164b5655814689` (LayerFS 1.1.0).
Copyright (c) 2026 Ephemeral-AI. The complete MIT license is preserved at
`vendor/layerfs/LICENSE`. The `package.json` and `src/` of `@layerfs/agent`
and `@layerfs/backend` under `vendor/layerfs/node_modules/@layerfs/` are
unmodified.

Release packages contain `vendor/layerfs/ARTIFACTS.json` with binary SHA-256
values and `vendor/layerfs/licenses/INDEX.json` with locked Rust dependency
versions, license identifiers and corresponding license-file paths. License,
COPYING, NOTICE and copyright files found in those dependencies are preserved
under that directory, together with Rust 1.85.1's MIT/Apache licenses and
copyright notices. Some workspace crates use the repository-level MIT license.

Native source and dependency resolution are reproducible from the revision
above and its `core/Cargo.lock`; `scripts/build-native.sh` documents the build.
The binaries target Linux x86_64 and Debian Bookworm's glibc 2.36.

## Container runtime

The complete release includes a Docker image based on the pinned official
`node:24.21.0-bookworm` image
`sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0`.
Node.js and its third-party license information are included by that image;
Debian package copyrights and licensing materials reside in `/usr/share/doc`.
Node's source is available at https://github.com/nodejs/node/tree/v24.21.0 and
Debian sources are available from https://sources.debian.org/.

Pi `@earendil-works/pi-coding-agent` 1.4.0 (MIT) and its production dependency
tree are installed without pruning their package license files under
`/opt/pi-runtime/node_modules`. Exact dependency versions and integrity values
are recorded in `container/package-lock.json`. Pi source is available at
https://github.com/earendil-works/pi. Corepack, pnpm and Yarn are included by the
qualified runtime setup; their notices remain with their distributions.

These components retain their respective licenses. The standalone Pi plugin
package declares Pi and typebox as host-supplied peer dependencies; it does not
embed a second Pi runtime in the host extension process.
