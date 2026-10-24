#!/usr/bin/env bash
set -euo pipefail
# Usage: bash scripts/build-native.sh [upstream-dir]
# Builds the native binding and daemon for the Docker Engine's Linux
# architecture (PI_LAYERFS_PLATFORM=linux/amd64|linux/arm64 overrides it).
# Everything Rust-related runs in the pinned builder image, so macOS hosts need
# only Docker (OrbStack or Docker Desktop) and Node.
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source_dir=${1:-"$root/.build/layerfs"}
revision=1aa56ece78e2ecd71b46cf07076100345df47239
if [[ ! -d "$source_dir/.git" ]]; then
  [[ ! -e "$source_dir" ]] || { echo 'Upstream directory exists without Git metadata.' >&2; exit 1; }
  mkdir -p -- "$source_dir"
  git -C "$source_dir" init --quiet
  git -C "$source_dir" fetch --depth=1 https://github.com/Ephemeral-AI-Lab/layerfs.git "$revision"
  git -C "$source_dir" checkout --detach FETCH_HEAD
fi
source_dir=$(cd -- "$source_dir" && pwd -P)
[[ $(git -C "$source_dir" rev-parse HEAD) == "$revision" ]] || { echo 'Upstream revision differs from the qualified pin.' >&2; exit 1; }
[[ -z $(git -C "$source_dir" status --porcelain --untracked-files=no) ]] || { echo 'Upstream has tracked modifications.' >&2; exit 1; }
platform=${PI_LAYERFS_PLATFORM:-linux/$(docker version --format '{{.Server.Arch}}')}
case "$platform" in
  linux/amd64) arch=x64 ;;
  linux/arm64) arch=arm64 ;;
  *) echo "Unsupported Docker platform $platform; use linux/amd64 or linux/arm64." >&2; exit 1 ;;
esac
target="core/target/pi-bookworm-$arch"
# Registry sources are kept beside the checkout so license texts named by
# Cargo metadata stay readable from the host after the container exits.
cargo_home="$(dirname -- "$source_dir")/cargo-home"
mkdir -p -- "$source_dir/$target" "$cargo_home"
docker run --rm --platform "$platform" --user "$(id -u):$(id -g)" \
  -v "$source_dir:/work" -v "$cargo_home:/cargo" \
  -e CARGO_HOME=/cargo -e CARGO_TARGET_DIR="/work/$target" -w /work \
  rust:1.85.1-bookworm bash -euo pipefail -c '
    cargo=/usr/local/cargo/bin/cargo
    $cargo fetch --manifest-path core/Cargo.toml --locked
    $cargo build --manifest-path core/Cargo.toml --offline --locked --release \
      -p layerfs-node --lib -p layerfs-daemon --bins
    $cargo metadata --manifest-path core/Cargo.toml --format-version 1 --locked --offline \
      > "$CARGO_TARGET_DIR/cargo-metadata.json"
    mkdir -p "$CARGO_TARGET_DIR/rust-licenses"
    cp "$(rustc --print sysroot)"/share/doc/rust/{COPYRIGHT,LICENSE-APACHE,LICENSE-MIT} "$CARGO_TARGET_DIR/rust-licenses/"'
cp "$source_dir/$target/release/liblayerfs_node.so" "$source_dir/$target/layerfs.node"
node "$root/scripts/vendor-runtime.mjs" "$source_dir" "$arch"
