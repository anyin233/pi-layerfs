#!/usr/bin/env bash
set -euo pipefail
# Usage: bash scripts/prepare.sh /absolute/layerfs [private-state-directory]
# Works on Linux and on macOS with OrbStack or Docker Desktop: native artifacts
# are built for the Engine's architecture inside the pinned Bookworm builder.
plugin_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
upstream=$(realpath -- "${1:?Pass an existing LayerFS checkout}")
state_dir=${2:-"$plugin_root/.layerfs-local"}
mkdir -p -- "$state_dir"
state_dir=$(realpath -- "$state_dir")
chmod 700 "$state_dir"
host_os=$(uname -s)
[[ "$host_os" == Linux || "$host_os" == Darwin ]]
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
docker version
if [[ "$host_os" == Linux ]]; then [[ -c /dev/fuse ]]; fi
[[ $(git -C "$upstream" rev-parse HEAD) == 1aa56ece78e2ecd71b46cf07076100345df47239 ]] || { echo 'LayerFS revision differs from qualified revision; review compatibility first' >&2; exit 1; }
# The daemon must target the runtime's glibc, not the development host's.
bash "$plugin_root/scripts/build-native.sh" "$upstream"
arch=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).platform.slice(6)' "$plugin_root/vendor/layerfs/ARTIFACTS.json")
target="$upstream/core/target/pi-bookworm-$arch"
# Official runtime build; the actual immutable ID, never the tag, is given to SDK.
docker build -t pi-layerfs-runtime:local "$upstream/dsh/tools/history/runtime"
image_id=$(docker image inspect --format '{{.Id}}' pi-layerfs-runtime:local)
docker run --rm --device /dev/fuse --entrypoint test "$image_id" -c /dev/fuse \
  || { echo 'The Docker Engine provides no /dev/fuse.' >&2; exit 1; }
# State-directory identity makes resources specific to this installation.
instance=$(printf '%s' "$state_dir" | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } | cut -c1-12)
volume="pi-layerfs-$instance-store"
docker volume inspect "$volume" >/dev/null 2>&1 || docker volume create --label pi-layerfs.instance="$instance" "$volume"
# Private SDK discovery and Pi control plane live outside any imported tree.
docker run --rm -v "$volume:/layerfs-store" --entrypoint bash "$image_id" -c 'mkdir -p /layerfs-store/home; chmod 700 /layerfs-store/home; stat -f -c %T /layerfs-store'
{
  printf 'export PI_LAYERFS_UPSTREAM=%q\n' "$upstream"
  printf 'export PI_LAYERFS_PLUGIN=%q\n' "$plugin_root"
  printf 'export LAYERFS_IMAGE=%q\n' "$image_id"
  printf 'export LAYERFS_VOLUME=%q\n' "$volume"
  printf 'export LAYERFS_HOME=%q\n' /layerfs-store/home
  printf 'export LAYERFS_DOCKER=%q\n' /var/run/docker.sock
  printf 'export LAYERFS_DAEMON=%q\n' "$target/release/layerfs-daemon"
  printf 'export LAYERFS_NATIVE=%q\n' "$target/layerfs.node"
  printf 'export LAYERFS_STORE_PATH=%q\n' /layerfs-store/global/store.sqlite
  printf 'export LAYERFS_CONTAINER_PREFIX=%q\n' "pi-lfs-$instance-"
  printf 'export PI_LAYERFS_INSTANCE=%q\n' "$instance"
} > "$state_dir/env.sh"
chmod 600 "$state_dir/env.sh"
printf 'Prepared %s\nNext: bash scripts/client.sh %q npm run test:integration\n' "$state_dir/env.sh" "$state_dir/env.sh"
