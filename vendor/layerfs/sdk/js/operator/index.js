// Internal operator surface; public dispatch cannot admit these names.
import { snapshot } from "./inspect/snapshot.js";
import { invokeOperator, page, projectArgs, workspaceArgs } from "../src/client.js";
export class LayerFSOperator {
  constructor(client) {
    // Store calls run in this process against the client's Store; the others
    // go to the project's Sandboxes (a Workspace's own, or every one).
    const store = async (method, args = {}) => (await client.store(), invokeOperator(`operator.${method}`, { ...args, project: client.projectName, home: client.options.home, storePath: client.options.storePath }, client.options));
    const sandboxes = (method, args = {}) => invokeOperator(`operator.${method}`, { ...args, ...projectArgs(client) }, client.options);
    this.store = {
      stats: async () => { const v = await store("store.stats"); return { ...v, dedupe: v.dedupe === null ? null : Number(v.dedupe), compression: v.compression === null ? null : Number(v.compression) }; },
      commits: (branch, pageSize, pagePos) => store("store.commits", { branch, ...page(pageSize,pagePos) }),
      // every Layer one publication overwrote, newest first, one page
      overwritten: (layer, pageSize, pagePos) => store("store.overwritten", { layer, ...page(pageSize,pagePos) }),
    };
    this.files = {
      stats: (ref,path) => store("files.stats", { branch: ref,path }),
      history: (ref,path,pageSize,pagePos) => store("files.history", { branch:ref,path,...page(pageSize,pagePos) }),
    };
    this.workspace = {
      overlay: (ws) => sandboxes("workspace.overlay", workspaceArgs(ws)),
      changes: (ws,pageSize,pagePos) => sandboxes("workspace.changes", { ...workspaceArgs(ws),...page(pageSize,pagePos) }),
    };
    this.inspect = { snapshot: (since) => snapshot(client,since) };
    // the project's Sandboxes from their records, [{ id, name }]; it starts none
    this.sandbox = { list: async () => (await sandboxes("sandbox.list")).items };
    // the running Init of this project, read while project.init runs (no Sandbox): { step, entries, files, bytes } or null
    this.project = { progress: () => invokeOperator("operator.project.progress", { project: client.projectName }, client.options) };
    this.process = {
      start: (ws,command) => sandboxes("process.start", { ...workspaceArgs(ws),command,background:true }),
      // every background process of the project, each with its `sandbox`
      list: () => sandboxes("process.list"),
      // a process id names its Sandbox
      cancel: (process) => sandboxes("process.cancel", { process }),
    };
  }
}
