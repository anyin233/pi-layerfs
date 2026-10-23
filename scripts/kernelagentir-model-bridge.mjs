import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

// Keeps the user's normal credential resolution in the host process. Only
// model context/events cross loopback; credentials never enter a test image.
const runtime = await ModelRuntime.create({
  refreshOnCreate: false,
  authPath: "/home/yanweiye/.pi/agent/auth.json",
  modelsPath: "/home/yanweiye/.pi/agent/models.json",
});
const model = runtime.getModel("magpie", "auto/deepseek-v4.1-flash");
if (!model) throw Error("Configured acceptance model is unavailable");
const token = randomBytes(32).toString("hex");
let calls = 0;
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(403).end();
    return;
  }
  const chunks = [];
  let bytes = 0;
  for await (const c of req) {
    bytes += c.length;
    if (bytes > 8 * 1024 * 1024) {
      res.writeHead(413).end();
      return;
    }
    chunks.push(c);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls++;
    console.log(
      JSON.stringify({ request: calls, time: new Date().toISOString() }),
    );
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const stream = runtime.streamSimple(model, body.context, {
      reasoning: "off",
      maxTokens: 8192,
      signal: abort.signal,
    });
    for await (const event of stream) res.write(`${JSON.stringify(event)}\n`);
    res.end();
  } catch (error) {
    console.log(
      JSON.stringify({ request: calls, error: String(error).slice(0, 300) }),
    );
    res.end();
  }
});
server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No bridge address");
  await writeFile(
    "/tmp/pi-layerfs-kernelagentir-HSOK3zhe/bridge.json",
    JSON.stringify({ port: address.port, token }),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ ready: true, model: model.id }));
});
setTimeout(() => server.close(), 10 * 60 * 1000).unref();
