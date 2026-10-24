#!/usr/bin/env bash
set -euo pipefail
# Trusted generated configuration, never source untrusted env files.
source "${1:?Pass env.sh from prepare.sh}"
shift
project_dir="$PI_LAYERFS_PLUGIN"
extra_mounts=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      project_dir=$(realpath -- "${2:?Pass the project directory}")
      if [[ "$project_dir" != "$PI_LAYERFS_PLUGIN" && "$project_dir" != "$PI_LAYERFS_UPSTREAM" ]]; then
        extra_mounts+=(-v "$project_dir:$project_dir:ro")
      fi
      shift 2 ;;
    --manage-projects)
      # Explicit control-plane access, equivalent to the already exposed Docker socket.
      mountpoint=$(docker volume inspect --format '{{.Mountpoint}}' "$LAYERFS_VOLUME")
      PI_LAYERFS_VOLUME_ROOT=$(dirname -- "$(dirname -- "$mountpoint")")
      export PI_LAYERFS_VOLUME_ROOT
      extra_mounts+=(-v "$PI_LAYERFS_VOLUME_ROOT:$PI_LAYERFS_VOLUME_ROOT")
      shift ;;
    *) break ;;
  esac
done
if [[ $# == 0 ]]; then echo 'Pass a client command, e.g. npm run test:integration' >&2; exit 1; fi
tty_flags=(-i)
if [[ -t 0 && -t 1 ]]; then tty_flags+=(-t); fi
# Same networking choice as bin/pi-layerfs; see its notes on bridge mode.
network=${PI_LAYERFS_NETWORK:-host}
networking=(--network "$network")
if [[ "$network" == bridge ]]; then
  networking+=(-p 127.0.0.1::47681 -e PI_LAYERFS_DASHBOARD_LISTEN=0.0.0.0:47681
    -e "LAYERFS_DAEMON_HOST=${LAYERFS_DAEMON_HOST:-host.docker.internal}")
fi
if [[ $(uname -s) != Linux ]]; then
  # Host node_modules hold macOS binaries (esbuild); the client gets its own
  # Linux dependency tree in a volume layered over the read-only checkout.
  modules="pi-layerfs-$PI_LAYERFS_INSTANCE-node-modules"
  extra_mounts+=(-v "$modules:$PI_LAYERFS_PLUGIN/node_modules")
  docker run --rm -v "$PI_LAYERFS_PLUGIN:$PI_LAYERFS_PLUGIN:ro" -v "$modules:$PI_LAYERFS_PLUGIN/node_modules" \
    -w "$PI_LAYERFS_PLUGIN" --entrypoint bash "$LAYERFS_IMAGE" -c \
    'cmp -s package-lock.json node_modules/.pi-layerfs-lock || { npm ci --no-audit --no-fund --ignore-scripts >&2 && cp package-lock.json node_modules/.pi-layerfs-lock; }'
fi
exec docker run --rm "${tty_flags[@]}" "${networking[@]}" ${extra_mounts[@]+"${extra_mounts[@]}"} \
  --label "pi-layerfs.instance=$PI_LAYERFS_INSTANCE" \
  -v "$PI_LAYERFS_UPSTREAM:$PI_LAYERFS_UPSTREAM:ro" \
  -v "$PI_LAYERFS_PLUGIN:$PI_LAYERFS_PLUGIN:ro" \
  -v "$LAYERFS_VOLUME:/layerfs-store" \
  -v "$LAYERFS_DOCKER:$LAYERFS_DOCKER" \
  -e LAYERFS_HOME -e LAYERFS_DOCKER -e LAYERFS_IMAGE -e LAYERFS_VOLUME \
  -e LAYERFS_DAEMON -e LAYERFS_NATIVE -e LAYERFS_STORE_PATH -e LAYERFS_CONTAINER_PREFIX \
  -e PI_LAYERFS_INSTANCE -e PI_LAYERFS_VOLUME_ROOT -e PI_LAYERFS_UPSTREAM -e PI_LAYERFS_PLUGIN -e PI_OFFLINE=1 -e PI_SKIP_VERSION_CHECK=1 \
  -e "UV_THREADPOOL_SIZE=${UV_THREADPOOL_SIZE:-64}" \
  -e PI_CODING_AGENT_DIR=/layerfs-store/pi-agent -w "$project_dir" --entrypoint /usr/bin/env "$LAYERFS_IMAGE" "$@"
