#!/usr/bin/env bash
set -euo pipefail
bundle=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
prefix=${PI_LAYERFS_PREFIX:-"$HOME/.local/share/pi-layerfs"}
bin_dir=${PI_LAYERFS_BIN_DIR:-"$HOME/.local/bin"}
register=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) prefix=${2:?Pass an installation directory}; shift 2 ;;
    --bin-dir) bin_dir=${2:?Pass a launcher directory}; shift 2 ;;
    --skip-register) register=false; shift ;;
    --help)
      echo 'Usage: bash install.sh [--prefix DIR] [--bin-dir DIR] [--skip-register]'
      echo 'Loads the bundled image and installs without network downloads or Rust/Node on the host.'
      exit 0 ;;
    *) echo "Unknown installer option: $1" >&2; exit 1 ;;
  esac
done
host_os=$(uname -s)
[[ "$host_os" == Linux || "$host_os" == Darwin ]] || { echo 'Requires Linux, or macOS with OrbStack or Docker Desktop.' >&2; exit 1; }
# On macOS the Engine's Linux VM supplies FUSE; it is checked in Docker below.
if [[ "$host_os" == Linux ]]; then
  [[ -c /dev/fuse ]] || { echo '/dev/fuse is unavailable; enable FUSE on this Linux host.' >&2; exit 1; }
fi
command -v docker >/dev/null
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -- "$1"; else shasum -a 256 -- "$1"; fi | cut -d' ' -f1
}
engine_arch=$(docker version --format '{{.Server.Arch}}' 2>/dev/null) || {
  echo 'The Docker Engine is not reachable. Start Docker (on macOS, OrbStack or Docker Desktop) and retry.' >&2; exit 1; }
while read -r sum name; do
  [[ "$sum" =~ ^[a-f0-9]{64}$ && "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { echo 'Malformed SHA256SUMS.' >&2; exit 1; }
  [[ $(sha256 "$bundle/$name") == "$sum" ]] || { echo "Checksum mismatch: $name" >&2; exit 1; }
  echo "$name: OK"
done < "$bundle/SHA256SUMS"
image=$(<"$bundle/IMAGE_ID")
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid bundled image identity.' >&2; exit 1; }
if ! docker image inspect "$image" >/dev/null 2>&1; then
  gzip -dc -- "$bundle/runtime-image.tar.gz" | docker load
fi
image_arch=$(docker image inspect --format '{{.Architecture}}' "$image")
[[ "$image_arch" == "$engine_arch" ]] || { echo "This bundle is for $image_arch, but the Docker Engine runs $engine_arch; use the matching release archive." >&2; exit 1; }
docker run --rm --device /dev/fuse --entrypoint test "$image" -c /dev/fuse \
  || { echo 'The Docker Engine provides no usable /dev/fuse; LayerFS needs FUSE in its Linux kernel.' >&2; exit 1; }
mkdir -p -- "$prefix" "$bin_dir"
prefix=$(realpath -- "$prefix")
bin_dir=$(realpath -- "$bin_dir")
chmod 700 "$prefix"
if [[ -e "$prefix/package" && ! -f "$prefix/.pi-layerfs-installation" ]]; then
  echo "Refusing to replace an unrecognized $prefix/package" >&2; exit 1
fi
stage=$(mktemp -d "$prefix/.install-XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
tar -xzf "$bundle/plugin.tgz" -C "$stage"
[[ -f "$stage/package/dist/extension.js" && -f "$stage/package/vendor/layerfs/sdk/js/native/layerfs.node" ]] || { echo 'Incomplete plugin artifact.' >&2; exit 1; }
[[ -x "$stage/package/vendor/layerfs/bin/layerfs-daemon" ]] || { echo 'Missing executable daemon.' >&2; exit 1; }
if [[ -e "$prefix/package" ]]; then
  backup="$prefix/package.previous.$(date +%s).$$"
  mv -- "$prefix/package" "$backup"
  echo "Previous package retained at $backup"
fi
mv -- "$stage/package" "$prefix/package"
mkdir -p -- "$prefix/state"
chmod 700 "$prefix/state"
instance=$(printf '%s' "$prefix" | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } | cut -c1-12)
volume="pi-layerfs-$instance-store"
if docker volume inspect "$volume" >/dev/null 2>&1; then
  owner=$(docker volume inspect --format '{{index .Labels "pi-layerfs.instance"}}' "$volume")
  [[ "$owner" == "$instance" ]] || { echo 'Existing volume belongs to another deployment.' >&2; exit 1; }
else
  docker volume create --label "pi-layerfs.instance=$instance" "$volume" >/dev/null
fi
docker run --rm -v "$volume:/layerfs-store" --entrypoint bash "$image" -c 'mkdir -p /layerfs-store/home /layerfs-store/pi-agent; chmod 700 /layerfs-store/home /layerfs-store/pi-agent'
{
  printf 'export LAYERFS_HOME=%q\n' /layerfs-store/home
  printf 'export LAYERFS_IMAGE=%q\n' "$image"
  printf 'export LAYERFS_VOLUME=%q\n' "$volume"
  printf 'export PI_LAYERFS_CONTROL_VOLUME=%q\n' "$volume"
  printf 'export LAYERFS_DOCKER=%q\n' /var/run/docker.sock
  printf 'export LAYERFS_DAEMON=%q\n' /opt/pi-layerfs/vendor/layerfs/bin/layerfs-daemon
  printf 'export LAYERFS_NATIVE=%q\n' /opt/pi-layerfs/vendor/layerfs/sdk/js/native/layerfs.node
  printf 'export LAYERFS_STORE_PATH=%q\n' /layerfs-store/global/store.sqlite
  printf 'export LAYERFS_CONTAINER_PREFIX=%q\n' "pi-lfs-$instance-"
  printf 'export PI_LAYERFS_INSTANCE=%q\n' "$instance"
} > "$prefix/state/deployment.env"
chmod 600 "$prefix/state/deployment.env"
printf '%s\n' pi-layerfs > "$prefix/.pi-layerfs-installation"
chmod +x "$prefix/package/bin/pi-layerfs"
{
  printf '#!/usr/bin/env bash\n'
  printf 'exec %q "$@"\n' "$prefix/package/bin/pi-layerfs"
} > "$bin_dir/pi-layerfs"
chmod +x "$bin_dir/pi-layerfs"
if $register && command -v pi >/dev/null 2>&1; then
  PI_OFFLINE=1 pi install "$prefix/package"
fi
printf 'Installed pi-layerfs %s\nLauncher: %s/pi-layerfs\nVerify: %s/pi-layerfs --self-test\n' "$(<"$bundle/VERSION")" "$bin_dir" "$bin_dir"
