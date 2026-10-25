#!/usr/bin/env bash
set -euo pipefail
# Supply an extracted candidate bundle. No host Node/npm/Rust/Pi is needed.
bundle=${1:?Usage: bash scripts/host-smoke.sh EXTRACTED_BUNDLE [EVIDENCE_DIR]}
evidence=${2:-"$HOME/.cache/pi-layerfs-host-check-$(date +%s)-$$"}
mkdir -p "$evidence"
evidence=$(cd "$evidence" && pwd -P)
[[ ! -e "$evidence/installation" ]] || { echo 'Use a fresh evidence directory.' >&2; exit 1; }
{
  uname -a
  if command -v sw_vers >/dev/null 2>&1; then sw_vers; fi
  docker context show
  docker version --format '{{json .}}'
} > "$evidence/machine.log"
bash "$bundle/install.sh" --prefix "$evidence/installation" --bin-dir "$evidence/installed commands" --skip-register > "$evidence/install.log" 2>&1
launcher="$evidence/installed commands/pi-layerfs"
"$launcher" --self-test > "$evidence/four-workers.json" 2>&1
for name in a b; do
  project="$evidence/project $name"
  mkdir "$project"
  printf 'pi-layerfs host fixture %s\n' "$name" > "$project/README.md"
  "$launcher" --project "$project" --exec node /opt/pi-layerfs/scripts/project-smoke.mjs > "$evidence/project-$name.json" 2>&1
  "$launcher" --project "$project" --exec node /opt/pi-layerfs/scripts/project-smoke.mjs > "$evidence/project-$name-reopened.json" 2>&1
  [[ $(<"$project/README.md") == "pi-layerfs host fixture $name" ]]
  [[ ! -e "$project/generated.txt" && ! -e "$project/must-not-exist.txt" && ! -e "$project/.pi" ]]
done
source "$evidence/installation/package/scripts/host-platform.sh"
layerfs_host_platform
source "$evidence/installation/state/deployment.env"
layerfs_docker_connect
docker run --rm --mount "type=bind,source=$evidence,target=/evidence,readonly" --entrypoint node "$LAYERFS_IMAGE" -e '
const fs=require("node:fs"), assert=require("node:assert/strict");
const get=name=>JSON.parse(fs.readFileSync("/evidence/"+name+".json","utf8"));
const a=get("project-a"), b=get("project-b");
assert.notEqual(a.volume,b.volume);
assert.equal(a.volume,get("project-a-reopened").volume);
assert.equal(b.volume,get("project-b-reopened").volume);
console.log(JSON.stringify({ok:true,separateStores:true,persistentBindings:true}));
' > "$evidence/store-isolation.json"
# The two receipts name different Store volumes, and reopening keeps each one.
# Keep all fixtures, owned test volumes and logs for inspection.
printf 'Host acceptance passed. Evidence: %s\n' "$evidence"
