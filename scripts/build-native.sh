#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source_dir=${1:-"$root/.build/layerfs"}
revision=ad78914e36b258b360daf13aec164b5655814689
if [[ ! -d "$source_dir/.git" ]]; then
  [[ ! -e "$source_dir" ]] || { echo 'Upstream directory exists without Git metadata.' >&2; exit 1; }
  mkdir -p -- "$source_dir"
  git -C "$source_dir" init --quiet
  git -C "$source_dir" fetch --depth=1 https://github.com/Ephemeral-AI-Lab/layerfs.git "$revision"
  git -C "$source_dir" checkout --detach FETCH_HEAD
fi
source_dir=$(realpath -- "$source_dir")
[[ $(git -C "$source_dir" rev-parse HEAD) == "$revision" ]] || { echo 'Upstream revision differs from the qualified pin.' >&2; exit 1; }
[[ -z $(git -C "$source_dir" status --porcelain --untracked-files=no) ]] || { echo 'Upstream has tracked modifications.' >&2; exit 1; }
cargo +1.85.1 fetch --manifest-path "$source_dir/core/Cargo.toml" --locked
mkdir -p -- "$source_dir/core/target/pi-bookworm"
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$source_dir:/work" \
  -v "${CARGO_HOME:-$HOME/.cargo}/registry:/usr/local/cargo/registry:ro" \
  -e CARGO_TARGET_DIR=/work/core/target/pi-bookworm -w /work \
  rust:1.85.1-bookworm cargo build --manifest-path core/Cargo.toml --offline --locked --release \
  -p layerfs-node --lib -p layerfs-daemon --bins
cp "$source_dir/core/target/pi-bookworm/release/liblayerfs_node.so" "$source_dir/core/target/pi-bookworm/layerfs.node"
node "$root/scripts/vendor-runtime.mjs" "$source_dir"
