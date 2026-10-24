import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import type { Control } from "./control.js";
import { dashboardPage } from "./dashboard-page.js";
import { docker } from "./docker.js";
import { errorData, type Value } from "./runtime.js";

export class Dashboard {
  private servers: Server[] = [];
  private token = randomBytes(32).toString("hex");
  private port = 0;
  private requests = new Set<Promise<void>>();
  private stopped = false;
  onSession?: (project: string) => Promise<void>;
  onSelect?: (project: string) => Promise<unknown>;
  constructor(readonly control: Control) {}
  get url() {
    return `http://127.0.0.1:${this.port}/#${this.token}`;
  }
  async start(port = 0) {
    if (this.servers.length) return this.url;
    if (this.stopped) throw new Error("Dashboard has closed");
    const handler: RequestListener = (req, res) => {
      const operation = (async () => {
        const json = (status: number, value: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(value));
        };
        try {
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Referrer-Policy", "no-referrer");
          res.setHeader("X-Content-Type-Options", "nosniff");
          const host = req.headers.host;
          if (
            host !== `127.0.0.1:${this.port}` &&
            host !== `localhost:${this.port}`
          )
            return json(403, { error: { message: "Invalid Host" } });
          if (req.headers.origin && req.headers.origin !== `http://${host}`)
            return json(403, {
              error: { message: "Cross-origin requests refused" },
            });
          const url = new URL(req.url ?? "/", `http://${host}`);
          if (req.method === "GET" && url.pathname === "/") {
            const nonce = randomBytes(24).toString("base64");
            res.setHeader(
              "Content-Security-Policy",
              `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
            );
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(dashboardPage.replace("__NONCE__", nonce));
            return;
          }
          const auth = Buffer.from(req.headers.authorization ?? ""),
            expected = Buffer.from(`Bearer ${this.token}`);
          if (
            auth.length !== expected.length ||
            !timingSafeEqual(auth, expected)
          )
            return json(401, { error: { message: "Authentication required" } });
          if (url.pathname !== "/api")
            return json(404, { error: { message: "Unknown route" } });
          if (req.method !== "GET" && req.method !== "POST")
            return json(405, { error: { message: "GET or POST required" } });
          const method = url.searchParams.get("method") ?? "status";
          let args: Value = Object.fromEntries(url.searchParams);
          for (const key of ["limit", "page", "line", "offset"]) {
            if (args[key] === undefined) continue;
            const value = Number(args[key]);
            if (
              !Number.isSafeInteger(value) ||
              value < (key === "page" || key === "offset" ? 0 : 1) ||
              (key === "limit" && value > 1000)
            )
              throw new Error(`Invalid ${key}`);
            args[key] = value;
          }
          if (req.method === "POST") {
            if (
              req.headers["content-type"]?.split(";")[0] !== "application/json"
            )
              return json(415, { error: { message: "JSON required" } });
            const chunks: Buffer[] = [];
            let bytes = 0;
            for await (const chunk of req) {
              bytes += chunk.length;
              if (bytes > 65536)
                return json(413, { error: { message: "Request too large" } });
              chunks.push(chunk);
            }
            const parsed: unknown = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            );
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
              throw new Error("Body must be an object");
            args = parsed as Value;
            if (method === "init")
              return json(
                202,
                await this.control.init(
                  String(args.name),
                  args.source ? String(args.source) : undefined,
                ),
              );
            if (method === "select")
              return json(
                200,
                await (this.onSelect
                  ? this.onSelect(String(args.name))
                  : this.control.select(String(args.name))),
              );
            if (method === "remove")
              return json(
                200,
                await this.control.remove(
                  String(args.name),
                  String(args.confirmation),
                  args.stopSandboxes === true,
                ),
              );
            if (method === "session") {
              const project = String(args.name);
              await this.control.project(project);
              if (!this.onSession)
                return json(200, {
                  command: `/layerfs session ${project}`,
                  message: "Run this command in Pi to create the session",
                });
              res.once("finish", () => {
                void this.onSession?.(project).catch((error) =>
                  this.control.operations.record({
                    method: "session.error",
                    error: errorData(error),
                  }),
                );
              });
              return json(202, {
                accepted: true,
                message:
                  "Creating a new Pi session; this dashboard closes with its originating session",
              });
            }
            return json(405, { error: { message: "Mutation not supported" } });
          }
          if (method === "projects")
            return json(200, await this.control.projects());
          if (method === "job")
            return json(200, await this.control.job(String(args.id)));
          if (method === "status")
            return json(200, {
              project: this.control.runtime.config.project,
              locked: this.control.locked,
              selected: !this.control.unbound,
              jobs: [...this.control.jobs.values()],
            });
          if (
            ![
              "state",
              "work",
              "storage",
              "progress",
              "sandboxes",
              "file_stats",
              "file_history",
              "overwritten",
              "changes",
              "trace_files",
              "trace_read",
              "branches",
              "commits",
              "diff_commits",
              "diff_branches",
              "list",
              "read",
              "stat",
              "blame",
              "diff_files",
            ].includes(method)
          )
            return json(404, { error: { message: "Unknown method" } });
          const ops = await this.control.reader(
            url.searchParams.get("project") ||
              this.control.runtime.config.project,
          );
          if (method === "state")
            return json(200, await ops.inspect("snapshot"));
          if (method === "work") return json(200, await ops.work());
          if (
            [
              "storage",
              "progress",
              "sandboxes",
              "file_stats",
              "file_history",
              "overwritten",
              "changes",
              "trace_files",
              "trace_read",
            ].includes(method)
          )
            return json(200, await ops.inspect(method, args));
          if (
            ["branches", "commits", "diff_commits", "diff_branches"].includes(
              method,
            )
          )
            return json(
              200,
              await ops.branch(method === "branches" ? "list" : method, args),
            );
          if (
            ["list", "read", "stat", "blame", "diff_files"].includes(method)
          ) {
            try {
              return json(200, await ops.filesystem(method, args));
            } catch (e) {
              if (
                (e as { code?: string }).code === "Binary" &&
                method === "read"
              )
                return json(200, {
                  binary: true,
                  ...(await ops.filesystem("stat", args)),
                });
              throw e;
            }
          }
          return json(404, { error: { message: "Unknown method" } });
        } catch (e) {
          if (!res.headersSent) json(400, { error: errorData(e) });
          else res.destroy();
        }
      })().finally(() => this.requests.delete(operation));
      this.requests.add(operation);
    };
    const listen = async (port: number, address: string) => {
      const server = createServer(handler);
      server.requestTimeout = 15000;
      server.headersTimeout = 10000;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, address, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      server.unref();
      this.servers.push(server);
      return (server.address() as AddressInfo).port;
    };
    // Bridge-networked launches (PI_LAYERFS_NETWORK=bridge) set PI_LAYERFS_DASHBOARD_LISTEN
    // to the container port that Docker publishes on the host's 127.0.0.1.
    // The URL names the host port; it is also served on the container's own
    // loopback so the same URL works from inside the container.
    const configured = process.env.PI_LAYERFS_DASHBOARD_LISTEN;
    const published = configured?.match(/^([0-9.]+):([0-9]{1,5})$/);
    if (configured && !published)
      throw new Error("PI_LAYERFS_DASHBOARD_LISTEN must be ADDRESS:PORT");
    try {
      if (published) {
        await listen(Number(published[2]), published[1]);
        this.port = await publishedPort(Number(published[2]));
        if (this.port !== Number(published[2]))
          await listen(this.port, "127.0.0.1");
      } else this.port = await listen(port, "127.0.0.1");
    } catch (error) {
      await this.closeServers();
      throw error;
    }
    return this.url;
  }
  private async closeServers() {
    const servers = this.servers;
    this.servers = [];
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((e) => (e ? reject(e) : resolve()));
            server.closeIdleConnections();
          }),
      ),
    );
  }
  async close() {
    this.stopped = true;
    await this.closeServers();
    await Promise.allSettled([...this.requests]);
  }
}

// The host side of a published port, read from this container's own record.
async function publishedPort(containerPort: number) {
  const container = await docker(
    `/containers/${encodeURIComponent(hostname())}/json`,
  );
  const ports = (container.NetworkSettings as { Ports?: Value } | undefined)
    ?.Ports?.[`${containerPort}/tcp`] as
    | { HostIp?: string; HostPort?: string }[]
    | null
    | undefined;
  const binding = ports?.find((p) => p.HostIp === "127.0.0.1");
  const port = Number(binding?.HostPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error(
      `Dashboard port ${containerPort} is not published on host 127.0.0.1`,
    );
  return port;
}
