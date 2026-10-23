import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { quote, type SDK, type Value, type Workspace } from "./runtime.js";

class Output extends Writable {
  bytes = 0;
  tail = Buffer.alloc(0);
  chunks: Buffer[] = [];
  kept = 0;
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ) {
    this.bytes += chunk.length;
    this.tail = Buffer.from(Buffer.concat([this.tail, chunk]).subarray(-256));
    const part = Buffer.from(
      chunk.subarray(0, Math.max(0, 24 * 1024 - this.kept)),
    );
    if (part.length) this.chunks.push(part);
    this.kept += part.length;
    done();
  }
  text(size = this.kept) {
    return Buffer.concat(this.chunks).subarray(0, size).toString("utf8");
  }
}
// A retained Workspace deliberately leaves commit/discard to the caller.
export async function runWorkspace(
  sdk: SDK,
  ws: Workspace,
  command: string,
  seconds: number,
  signal?: AbortSignal,
): Promise<Value> {
  if (signal?.aborted) throw new Error("Cancelled before execution");
  const stdout = new Output(),
    stderr = new Output();
  const marker = `__PI_LAYERFS_EXIT_${randomUUID()}__`;
  const inner = `bash -c ${quote(command)}; _pi_exit=$?; printf '\\n${marker}:%s\\n' "$_pi_exit" >&2; exit 0`;
  const value = await sdk.workspace.exec(
    ws,
    `timeout --signal=TERM --kill-after=2s ${seconds}s bash -c ${quote(inner)}`,
    "Pi retained Workspace command",
    { stdout, stderr },
  );
  const timedOut = [124, 137].includes(Number(value.exitCode));
  let exitCode = Number(value.exitCode);
  const inlineErr = typeof value.stderr === "string" ? value.stderr : undefined;
  let stderrBytes = Number(
    value.stderrBytes ??
      (inlineErr === undefined ? stderr.bytes : Buffer.byteLength(inlineErr)),
  );
  if (!timedOut) {
    const match = (inlineErr ?? stderr.tail.toString("utf8")).match(
      new RegExp(`\\n${marker}:(\\d{1,3})\\n$`),
    );
    if (exitCode !== 0 || !match || Number(match[1]) > 255)
      throw new Error(
        "Command completion unknown; Workspace retained, do not commit until inspected",
      );
    exitCode = Number(match[1]);
    stderrBytes -= Buffer.byteLength(match[0]);
    if (stderrBytes < 0) throw new Error("Invalid command completion frame");
  }
  return {
    ...value,
    exitCode,
    timedOut,
    cancelled: signal?.aborted ?? false,
    stdout:
      typeof value.stdout === "string"
        ? Buffer.from(value.stdout).subarray(0, 24576).toString("utf8")
        : stdout.text(),
    stderr:
      inlineErr === undefined
        ? stderr.text(stderrBytes)
        : Buffer.from(inlineErr)
            .subarray(0, Math.min(stderrBytes, 24576))
            .toString("utf8"),
    stdoutBytes:
      value.stdoutBytes ??
      (typeof value.stdout === "string"
        ? Buffer.byteLength(value.stdout)
        : stdout.bytes),
    stderrBytes,
    stdoutTruncated: stdout.bytes > 24576,
    stderrTruncated: stderrBytes > 24576,
  };
}
