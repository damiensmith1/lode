// lode's core, for a host running Node (an editor extension, an Electron
// main process, a CLI): read a folder into a graph, query it, and answer
// views. The views live in "lode/views"; the WebSocket server in
// "lode/server".
//
//   import { GraphStore, tsPlugin, createService, serveMessages } from "lode";
//   const store = GraphStore.open(tsPlugin, folder);   // any folder
//   const service = createService(store);
//   serveMessages(service, { send, listen });           // e.g. a webview
export { GraphStore, type StoreOptions } from "./graph/store.js";
export { Graph, type Direction } from "./graph/graph.js";
export { tsPlugin } from "./ingest/ts/index.js";
export { Queries } from "./query/index.js";
export { createService, serveMessages, type LodeService, type ServiceOptions } from "./service/index.js";
export type * from "./schema/index.js";
export type * from "./query/types.js";
export type { NodeKind } from "./schema/index.js"; // the same in both
