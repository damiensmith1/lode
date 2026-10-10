// lode views: framework-free web components any host can mount.
//
//   const connection = new LodeClient(rpcUrl);   // or a MessageConnection
//   const view = createView({ kind: "flow", id: "src/main.ts#run", state: "tab-1" }, connection, host);
//   container.append(view);
//
// A host supplies the connection (how to reach lode), and in LodeHost what
// to do with sources, syntax colours and where to keep each view's state.
export { LodeClient } from "./client.js";
export { MessageConnection, type LodeConnection, type LodeMessagePort } from "./connection.js";
export { localStorageStorage, memoryStorage, serviceStorage, type LodeStorage } from "./storage.js";
export { DARK_THEME, LIGHT_THEME, themeCss, type LodeTheme } from "./theme.js";
export {
  ACTION_EVENT,
  CHANGE_EVENT,
  CLOSE_EVENT,
  DEFAULT_KEYS,
  OPEN_EVENT,
  SELECT_EVENT,
  TITLE_EVENT,
  type CardInfo,
  type CardRender,
  type FlowCommand,
  type FlowEventMap,
  type LodeHost,
  type SourceHighlight,
  type ViewRequest,
} from "./host.js";
export { buildFileTree, lodeApi, type FileTreeNode, type LodeApi } from "./api.js";
export { LodeEntries } from "./entries.js";
export { LodeFlow } from "./flow.js";
export type * from "../src/query/types.js";

import type { LodeConnection } from "./connection.js";
import { LodeEntries } from "./entries.js";
import { LodeFlow } from "./flow.js";
import type { LodeHost, ViewRequest } from "./host.js";

export function defineLodeElements() {
  if (!customElements.get("lode-entries")) customElements.define("lode-entries", LodeEntries);
  if (!customElements.get("lode-flow")) customElements.define("lode-flow", LodeFlow);
}

// The element for a view request, wired to a client and host, ready to mount.
export function createView(view: ViewRequest, client: LodeConnection, host: LodeHost): HTMLElement {
  defineLodeElements();
  const el = document.createElement(`lode-${view.kind}`) as LodeEntries | LodeFlow;
  el.client = client;
  el.host = host;
  if (view.kind === "flow") {
    if (view.id) el.setAttribute("node", view.id);
    if (view.state) (el as LodeFlow).stateKey = view.state;
  }
  return el;
}
