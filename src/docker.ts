import { request } from "node:http";
import { environment, required } from "./config.js";
import type { Value } from "./runtime.js";

export function docker(
  path: string,
  method = "GET",
  data?: Value,
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const body = data === undefined ? undefined : JSON.stringify(data);
    const req = request(
      {
        socketPath: required(environment().DOCKER),
        path,
        method,
        timeout: 15000,
        headers: body
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024)
            req.destroy(new Error("Docker response exceeds 4 MiB"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!res.statusCode || res.statusCode >= 300)
            return reject(
              new Error(`Docker ${method} ${path}: ${res.statusCode} ${text}`),
            );
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () =>
      req.destroy(
        new Error("Docker request timed out; inspect outcome before retry"),
      ),
    );
    req.end(body);
  });
}
