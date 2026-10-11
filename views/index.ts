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
  CONTEXT_EVENT,
  COMMAND_HELP,
  DEFAULT_KEYS,
  DIRTY_EVENT,
  SAVE_EVENT,
  OPEN_EVENT,
  SELECT_EVENT,
  TITLE_EVENT,
  type CardInfo,
  type CardRender,
  type EditResult,
  type LineEdit,
  type FlowCommand,
  type FlowEventMap,
  type LodeHost,
  type SourceHighlight,
  type ViewRequest,
} from "./host.js";
export { buildFileTree, lodeApi, type FileTreeNode, type LodeApi } from "./api.js";
export { codeNames, renderMarkdown } from "./markdown.js";
export { LodeEntries } from "./entries.js";
export { LodeChanges } from "./changes.js";
export { LodeFlow } from "./flow.js";
export type { CanvasAction, ExplainEvent } from "../src/explain/index.js";
export type * from "../src/query/types.js";

import type { LodeConnection } from "./connection.js";
import { LodeEntries } from "./entries.js";
import { LodeChanges } from "./changes.js";
import { LodeFlow } from "./flow.js";
import type { LodeHost, ViewRequest } from "./host.js";

export function defineLodeElements() {
  if (!customElements.get("lode-entries")) customElements.define("lode-entries", LodeEntries);
  if (!customElements.get("lode-flow")) customElements.define("lode-flow", LodeFlow);
  if (!customElements.get("lode-changes")) customElements.define("lode-changes", LodeChanges);
}

// The element for a view request, wired to a client and host, ready to mount.
export function createView(view: ViewRequest, client: LodeConnection, host: LodeHost): HTMLElement {
  defineLodeElements();
  const el = document.createElement(`lode-${view.kind}`) as LodeEntries | LodeFlow | LodeChanges;
  el.client = client;
  el.host = host;
  if (view.kind === "flow") {
    const flow = el as LodeFlow;
    if (view.id) flow.setAttribute("node", view.id);
    if (view.state) flow.stateKey = view.state;
    if (view.diff) flow.setDiffOnConnect(view.diff);
    if (view.ids?.length) flow.pendingIds = [...view.ids];
    if (view.ask) flow.pendingAsk = view.ask;
  }
  if (view.kind === "changes" && view.base) (el as LodeChanges).base = view.base;
  return el;
}
