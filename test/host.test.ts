import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const helper = resolve("scripts/host-platform.sh");
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const mac = "uname() { echo Darwin; }; layerfs_host_platform;";
function shell(script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    "/bin/bash",
    ["-euc", `source ${quote(helper)}; ${script}`],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PI_LAYERFS_HOST_DOCKER: "",
        DOCKER_HOST: "",
        DOCKER_CONTEXT: "",
        ...env,
      },
    },
  );
}

test("macOS host routing uses the VM socket and pins the selected local Engine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-layerfs-host-unit-"));
  try {
    const docker = join(dir, "docker");
    await writeFile(
      docker,
      '#!/bin/sh\ncase "$*" in\n  "context inspect --format {{.Endpoints.docker.Host}}") echo "unix:///Users/test/.colima/default/docker.sock" ;;\n  "--host unix:///Users/test/.colima/default/docker.sock version --format {{.Server.Os}}/{{.Server.Arch}}") echo linux/arm64 ;;\n  *) printf "%s\\n" "$*" ;;\nesac\n',
    );
    await chmod(docker, 0o755);
    const r = shell(
      `${mac} layerfs_docker_connect; printf '%s\\n' "$PI_LAYERFS_HOST_PLATFORM" "$PI_LAYERFS_ENGINE_ARCH" "$PI_LAYERFS_ENGINE_SOCKET"; docker version`,
      {
        PATH: `${dir}:${process.env.PATH}`,
        DOCKER_CONTEXT: "colima",
        DOCKER_HOST: "tcp://must-not-be-used:2375",
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      "macos\narm64\n/var/run/docker.sock\n--host unix:///Users/test/.colima/default/docker.sock version\n",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("host routing refuses a remote Docker endpoint before using its Engine", () => {
  const r = shell(`${mac} layerfs_docker_connect`, {
    PI_LAYERFS_HOST_DOCKER: "tcp://remote:2375",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /local Docker Engine Unix socket/);
});

test("portable host hashing and canonical paths do not require GNU sha256sum or realpath", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-layerfs-portable-unit-"));
  try {
    const bin = join(dir, "bin");
    const target = join(dir, "real directory");
    await mkdir(bin);
    await mkdir(target);
    await symlink(target, join(dir, "alias"));
    const shasum = spawnSync("/bin/sh", ["-c", "command -v shasum"], {
      encoding: "utf8",
    }).stdout.trim();
    assert.ok(shasum, "shasum is needed for the portable hash regression");
    await symlink(shasum, join(bin, "shasum"));
    const r = shell(
      `printf abc | layerfs_sha256; layerfs_canonical_dir ${quote(join(dir, "alias"))}`,
      { PATH: bin },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -\n${target}\n`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a runtime image of another architecture than the Engine's is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-layerfs-arch-unit-"));
  try {
    const docker = join(dir, "docker");
    await writeFile(
      docker,
      '#!/bin/sh\ncase "$*" in\n  *"version --format"*) echo linux/arm64 ;;\n  *"image inspect --format {{.Architecture}} amd64-image") echo amd64 ;;\n  *"image inspect --format {{.Architecture}} arm64-image") echo arm64 ;;\n  *) exit 1 ;;\nesac\n',
    );
    await chmod(docker, 0o755);
    const check = (image: string) =>
      shell(`${mac} layerfs_docker_connect; layerfs_image_check ${image}`, {
        PATH: `${dir}:${process.env.PATH}`,
        PI_LAYERFS_HOST_DOCKER: "unix:///var/run/docker.sock",
      });
    assert.equal(check("arm64-image").status, 0);
    const refused = check("amd64-image");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /amd64 but the Docker Engine runs arm64/);
    assert.match(check("missing-image").stderr, /missing from this Engine/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
