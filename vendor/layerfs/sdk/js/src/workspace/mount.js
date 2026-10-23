// workspace.mount: a new Workspace of a Branch, placed by LayerFS in one of
// the project's Sandboxes of its image (the lowest-numbered running one with
// a free slot, else a new one, started with the client's deployment). The
// image is `options.image`, else the deployment's; one project's Sandboxes
// may run different images. The Branch is found by name in this process's
// Store; the daemon binds its id. Returns the Workspace, `{ sandbox, path }`,
// and its Sandbox's `image`.
import { deployment, invokeClient } from "../client.js";
export async function mount(client, branch, options = {}) {
  await client.store();
  const deploy = deployment({ ...client.options.deploy, ...(options.image ? { image: options.image } : {}) });
  const value = await invokeClient(client, "workspace.mount", { branch, deploy });
  return { sandbox: value.sandbox, path: value.path, image: value.image };
}
