// project.init: one positional SDK operation.
import { invokeClient } from "../client.js";
export function init(client, sourcePath) {
  const policy = client.options.storePolicy;
  return invokeClient(client, "project.init", { path: sourcePath, name: client.projectName, ...(policy ? { policy } : {}) });
}
