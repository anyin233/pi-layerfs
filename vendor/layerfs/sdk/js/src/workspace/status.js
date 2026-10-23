// workspace.status: the Workspace's state; the Branch head is read in this
// process's Store.
import { invokeClient, workspaceArgs } from "../client.js";
export async function status(client, ws) {
  await client.store();
  return invokeClient(client, "workspace.status", workspaceArgs(ws));
}
