#!/usr/bin/env bash
# Host-only helpers. Pi, the SDK, Store and FUSE always run in Linux containers
# on the Docker Engine; on macOS that is the OrbStack or Docker Desktop VM.
# Keep this file compatible with the Bash 3.2 shipped by macOS.
layerfs_host_platform() {
  case "$(uname -s)" in
    Linux) PI_LAYERFS_HOST_PLATFORM=linux ;;
    Darwin) PI_LAYERFS_HOST_PLATFORM=macos ;;
    *) echo 'Requires Linux, or macOS with OrbStack or Docker Desktop.' >&2; return 1 ;;
  esac
  export PI_LAYERFS_HOST_PLATFORM
}
layerfs_canonical_dir() { (cd -- "$1" && pwd -P); }
layerfs_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@";
  else shasum -a 256 "$@"; fi
}
layerfs_docker_connect() {
  local endpoint=${PI_LAYERFS_HOST_DOCKER:-} engine
  if [[ -z "$endpoint" ]]; then
    if [[ -n "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]]; then
      endpoint=$DOCKER_HOST
    else
      endpoint=$(command docker context inspect --format '{{.Endpoints.docker.Host}}') || return
    fi
  fi
  case "$endpoint" in
    unix:///*) ;;
    *) echo 'A local Docker Engine Unix socket is required; TCP/remote contexts are unsupported.' >&2; return 1 ;;
  esac
  PI_LAYERFS_HOST_DOCKER=$endpoint
  export PI_LAYERFS_HOST_DOCKER
  # Pin all CLI calls to the same Engine even if the user's context changes.
  docker() { command env -u DOCKER_CONTEXT -u DOCKER_HOST docker --host "$PI_LAYERFS_HOST_DOCKER" "$@"; }
  engine=$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}' 2>/dev/null) || {
    echo 'The Docker Engine is not reachable. Start Docker (on macOS, OrbStack or Docker Desktop) and retry.' >&2; return 1; }
  [[ "$engine" == linux/* ]] || { echo 'Docker must run Linux containers.' >&2; return 1; }
  # Bundles are built per Engine architecture; none runs under emulation.
  PI_LAYERFS_ENGINE_ARCH=${engine#linux/}
  if [[ "$PI_LAYERFS_HOST_PLATFORM" == macos ]]; then
    # This source is the Engine VM's socket, not the Mac's proxy socket.
    PI_LAYERFS_ENGINE_SOCKET=/var/run/docker.sock
  else
    PI_LAYERFS_ENGINE_SOCKET=${endpoint#unix://}
  fi
  export PI_LAYERFS_ENGINE_ARCH PI_LAYERFS_ENGINE_SOCKET
}
layerfs_image_check() {
  local image=$1 arch
  arch=$(docker image inspect --format '{{.Architecture}}' "$image" 2>/dev/null) || {
    echo "Runtime image $image is missing from this Engine; rerun the release bundle's install.sh." >&2; return 1; }
  [[ "$arch" == "$PI_LAYERFS_ENGINE_ARCH" ]] || {
    echo "Runtime image is $arch but the Docker Engine runs $PI_LAYERFS_ENGINE_ARCH; use the matching release archive." >&2; return 1; }
}
layerfs_runtime_probe() {
  local image=$1
  # --device checks the Engine kernel's device; macOS needs no macFUSE.
  docker run --rm --device /dev/fuse --entrypoint sh "$image" -c 'test -c /dev/fuse && node -e "require(\"/opt/pi-layerfs/vendor/layerfs/node_modules/binding/layerfs.node\")"' || {
    echo 'The Docker Engine provides no usable /dev/fuse or cannot load the native binding; LayerFS needs FUSE in its Linux kernel.' >&2
    return 1
  }
}

layerfs_macos_network_probe() {
  [[ "$PI_LAYERFS_HOST_PLATFORM" == macos && "${PI_LAYERFS_NETWORK:-host}" == host ]] || return 0
  local image=$1 probe port result
  # Host networking must reach the VM's loopback, where daemons and the
  # dashboard listen. Test from another client container AND from the Mac itself.
  probe=$(docker run -d --rm --network host --entrypoint node "$image" -e 'const fs=require("node:fs"); const server=require("node:http").createServer((q,r)=>r.end("pi-layerfs-network-ok")); server.listen(0,"127.0.0.1",()=>fs.writeFileSync("/tmp/probe-port",String(server.address().port)));') || return
  if port=$(docker exec "$probe" node -e 'const fs=require("node:fs"); const wait=()=>{try{console.log(fs.readFileSync("/tmp/probe-port","utf8"));}catch{setTimeout(wait,50);}};setTimeout(()=>process.exit(1),10000).unref();wait();') &&
    docker run --rm --network host --entrypoint node "$image" -e 'fetch("http://127.0.0.1:"+process.argv[1],{signal:AbortSignal.timeout(5000)}).then(async r=>{if(await r.text()!=="pi-layerfs-network-ok")process.exit(1);}).catch(()=>process.exit(1));' "$port" &&
    result=$(curl --noproxy '*' --fail --silent --show-error --max-time 5 "http://127.0.0.1:$port") &&
    [[ "$result" == pi-layerfs-network-ok ]]; then
    docker rm -f "$probe" >/dev/null
  else
    docker rm -f "$probe" >/dev/null
    echo 'Docker host networking must reach both Linux containers and macOS localhost. OrbStack does; on Docker Desktop enable Settings > Resources > Network > Enable host networking; with Colima enable localhost port forwarding. Engines without host networking can use PI_LAYERFS_NETWORK=bridge.' >&2
    return 1
  fi
}
