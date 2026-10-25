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

## macOS (Apple Silicon, OrbStack)

Same pins, on macOS 27.0.1 (Apple Silicon, `arm64`), OrbStack Docker Engine `29.8.2` (`linux/arm64`, btrfs data root), host Node `26.9.0`, runtime Node `24.21.0`. The `linux/arm64` archive was built from source with `npm run release:build`; each `client.sh` suite ran on its own fresh `prepare.sh` state.

| Command | Observed result |
| --- | --- |
| `npm run typecheck && npm test && npm run lint` | Exit 0; 63 tests pass |
| `npm run release:build -- --out DIR`, `shasum -a 256 -c SHA256SUMS`, then `node scripts/check-package.mjs DIR/pi-layerfs-0.1.0.tgz` | Exit 0; 402 packed files, host Pi loads the package, native ELF |
| `bash BUNDLE/host-smoke.sh BUNDLE EVIDENCE` | `Host acceptance passed`; offline install, four-worker self-test, two space-containing host projects with reopen, read-only host source, separate persistent Store volumes |
| Installed launcher, `pi-layerfs --self-test` 20 times in a row | 20 of 20 pass, 5 to 6 s each |
| `bash scripts/client.sh ENV npm run test:integration`, 6 fresh states | 5 pass; 1 hit layerfs#426's intermittent variant after the timed-out command |
| `bash scripts/client.sh ENV --manage-projects node_modules/.bin/tsx scripts/parity-smoke.ts` | Exit 0, 47 receipt lines; both test projects removed |
| `bash scripts/client.sh ENV npm run test:recovery`, fresh volume | Exit 0; `remainingMounts: []` |

Before mounts waited for the Sandbox to settle, 4 of 11 self-tests failed: the first Workspace on the freshly created Sandbox committed, then its unmount was refused with `Retained(TeardownCustody { stage: Join })` after the daemon's 5-second drain wait ([layerfs#426](https://github.com/Ephemeral-AI-Lab/layerfs/issues/426)).
