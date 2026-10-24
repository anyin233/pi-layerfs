#!/usr/bin/env bash
# Host-only helpers. The SDK, Store and FUSE always run in the Linux VM.
# Keep this file compatible with the Bash 3.2 shipped by macOS.
layerfs_host_platform() {
  case "$(uname -s):$(uname -m)" in
    Linux:x86_64) PI_LAYERFS_HOST_PLATFORM=linux-x64 ;;
    Darwin:x86_64|Darwin:arm64) PI_LAYERFS_HOST_PLATFORM=macos ;;
    *) echo 'Requires Linux x86_64 or macOS (Intel/Apple Silicon).' >&2; return 1 ;;
  esac
  export PI_LAYERFS_HOST_PLATFORM
}
layerfs_canonical_dir() { (cd -- "$1" && pwd -P); }
layerfs_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@";
  else shasum -a 256 "$@"; fi
}
layerfs_docker_connect() {
  local endpoint=${PI_LAYERFS_HOST_DOCKER:-}
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
  [[ $(docker info --format '{{.OSType}}') == linux ]] || {
    echo 'Docker must run Linux containers.' >&2; return 1;
  }
  if [[ "$PI_LAYERFS_HOST_PLATFORM" == macos ]]; then
    # This source is the Engine VM's socket, not the Mac's proxy socket.
    PI_LAYERFS_ENGINE_SOCKET=/var/run/docker.sock
  else
    PI_LAYERFS_ENGINE_SOCKET=${endpoint#unix://}
    [[ -c /dev/fuse ]] || { echo '/dev/fuse is unavailable on this Linux host.' >&2; return 1; }
  fi
  export PI_LAYERFS_ENGINE_SOCKET
}
layerfs_runtime_probe() {
  local image=$1
  # --device checks the VM device on macOS; no macFUSE installation is needed.
  docker run --rm --platform linux/amd64 --device /dev/fuse --entrypoint sh "$image" -c 'test -c /dev/fuse && node -e "require(\"/opt/pi-layerfs/vendor/layerfs/sdk/js/native/layerfs.node\")"' || {
    echo 'The Linux runtime needs a VM with /dev/fuse and amd64 image support (emulation on Apple Silicon).' >&2
    return 1
  }
}

layerfs_macos_network_probe() {
  [[ "$PI_LAYERFS_HOST_PLATFORM" == macos ]] || return 0
  local image=$1 probe port result
  # The daemon and dashboard both require the VM's host loopback to be
  # reachable. Test from another client container AND from the Mac itself.
  probe=$(docker run -d --rm --platform linux/amd64 --network host --entrypoint node "$image" -e 'const fs=require("node:fs"); const server=require("node:http").createServer((q,r)=>r.end("pi-layerfs-network-ok")); server.listen(0,"127.0.0.1",()=>fs.writeFileSync("/tmp/probe-port",String(server.address().port)));') || return
  if port=$(docker exec "$probe" node -e 'const fs=require("node:fs"); const wait=()=>{try{console.log(fs.readFileSync("/tmp/probe-port","utf8"));}catch{setTimeout(wait,50);}};setTimeout(()=>process.exit(1),10000).unref();wait();') &&
    docker run --rm --platform linux/amd64 --network host --entrypoint node "$image" -e 'fetch("http://127.0.0.1:"+process.argv[1],{signal:AbortSignal.timeout(5000)}).then(async r=>{if(await r.text()!=="pi-layerfs-network-ok")process.exit(1);}).catch(()=>process.exit(1));' "$port" &&
    result=$(curl --noproxy '*' --fail --silent --show-error --max-time 5 "http://127.0.0.1:$port") &&
    [[ "$result" == pi-layerfs-network-ok ]]; then
    docker rm -f "$probe" >/dev/null
  else
    docker rm -f "$probe" >/dev/null
    echo 'Docker host networking must reach both Linux containers and macOS localhost. On Docker Desktop enable Settings > Resources > Network > Enable host networking. With Colima enable localhost port forwarding.' >&2
    return 1
  fi
}
