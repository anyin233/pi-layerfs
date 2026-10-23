#!/usr/bin/env bash
set -euo pipefail
# Usage: bash scripts/prepare.sh /absolute/layerfs [private-state-directory]
plugin_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
upstream=$(realpath -- "${1:?Pass an existing LayerFS checkout}")
state_dir=${2:-"$plugin_root/.layerfs-local"}
mkdir -p -- "$state_dir"
state_dir=$(realpath -- "$state_dir")
chmod 700 -- "$state_dir"
[[ $(uname -s) == Linux ]]
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
docker version
[[ -c /dev/fuse ]]
[[ $(git -C "$upstream" rev-parse HEAD) == 1aa56ece78e2ecd71b46cf07076100345df47239 ]] || { echo 'LayerFS revision differs from qualified revision; review compatibility first' >&2; exit 1; }
(
  cd -- "$upstream"
  cargo +1.85.1 fetch --manifest-path core/Cargo.toml --locked
  npm --prefix sdk/js run build:native
  cargo +1.85.1 build --manifest-path core/Cargo.toml --offline --locked --release -p layerfs-daemon --bins
)
# The daemon must target the runtime's glibc, not the development host's.
# Follow upstream's bookworm build recipe with its own target directory.
docker pull rust:1.85.1-bookworm
mkdir -p "$upstream/core/target/pi-bookworm"
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$upstream:/work" -v "${CARGO_HOME:-$HOME/.cargo}/registry:/usr/local/cargo/registry:ro" \
  -e CARGO_TARGET_DIR=/work/core/target/pi-bookworm -w /work \
  rust:1.85.1-bookworm cargo build --manifest-path core/Cargo.toml --offline --locked --release -p layerfs-node --lib -p layerfs-daemon --bins
cp "$upstream/core/target/pi-bookworm/release/liblayerfs_node.so" "$upstream/core/target/pi-bookworm/layerfs.node"
# Official runtime build; the actual immutable ID, never the tag, is given to SDK.
docker build -t pi-layerfs-runtime:local "$upstream/dsh/tools/history/runtime"
image_id=$(docker image inspect --format '{{.Id}}' pi-layerfs-runtime:local)
# State-directory identity makes resources specific to this installation.
instance=$(printf '%s' "$state_dir" | sha256sum | cut -c1-12)
volume="pi-layerfs-$instance-store"
docker volume create --label pi-layerfs.instance="$instance" "$volume"
# Private SDK discovery and Pi control plane live outside any imported tree.
docker run --rm -v "$volume:/layerfs-store" --entrypoint bash "$image_id" -c 'mkdir -p /layerfs-store/home; chmod 700 /layerfs-store/home; stat -f -c %T /layerfs-store'
{
  printf 'export PI_LAYERFS_UPSTREAM=%q\n' "$upstream"
  printf 'export PI_LAYERFS_PLUGIN=%q\n' "$plugin_root"
  printf 'export LAYERFS_IMAGE=%q\n' "$image_id"
  printf 'export LAYERFS_VOLUME=%q\n' "$volume"
  printf 'export LAYERFS_HOME=%q\n' /layerfs-store/home
  printf 'export LAYERFS_DOCKER=%q\n' /var/run/docker.sock
  printf 'export LAYERFS_DAEMON=%q\n' "$upstream/core/target/pi-bookworm/release/layerfs-daemon"
  printf 'export LAYERFS_NATIVE=%q\n' "$upstream/core/target/pi-bookworm/layerfs.node"
  printf 'export LAYERFS_STORE_PATH=%q\n' /layerfs-store/global/store.sqlite
  printf 'export LAYERFS_CONTAINER_PREFIX=%q\n' "pi-lfs-$instance-"
  printf 'export PI_LAYERFS_INSTANCE=%q\n' "$instance"
} > "$state_dir/env.sh"
chmod 600 "$state_dir/env.sh"
printf 'Prepared %s\nNext: bash scripts/client.sh %q npm run test:integration\n' "$state_dir/env.sh" "$state_dir/env.sh"
