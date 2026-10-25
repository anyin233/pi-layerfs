# Verification record

## LayerFS 1.1.0 upgrade

Re-verified against Pi `1.4.0`, LayerFS `ad78914e36b258b360daf13aec164b5655814689` (1.1.0 plus the #436 binding fix), Linux x86_64, Docker Engine `29.5.3`, host Node `24.13.1`, runtime Node `24.21.0` and Rust `1.85.1` (upstream `rust-version` is still 1.85). Each environment was a fresh `scripts/prepare.sh` state directory with its own volume.

| Command | Observed result |
| --- | --- |
| `bash scripts/build-native.sh <checkout at ad78914e>` | Exit 0; Bookworm addon and daemon, 142 licensed Rust packages, none without license files |
| `npm run typecheck && npm test && npm run lint` | Exit 0; 59 tests pass |
| `bash scripts/client.sh ENV npm run test:integration` | Exit 0; SDK preflight, Pi tools, reopen |
| `bash scripts/client.sh ENV --manage-projects node_modules/.bin/tsx scripts/parity-smoke.ts` | Exit 0, 47 receipt lines; both test projects removed |
| `bash scripts/client.sh ENV npm run test:recovery`, fresh volume | Exit 0; `remainingMounts: []` |
| `node scripts/build-release.mjs --upstream <checkout>`, then `npm run test:release` | Exit 0; 402 packed files, host Pi loads the package |
| Installed the built archive into a fresh prefix, `pi-layerfs --self-test` | Exit 0; bundled `@layerfs/agent` path |
