// lode views: the flow, a framework-free web component any host can mount.
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
  CURSOR_EVENT,
  ASK_EVENT,
  COMMAND_HELP,
  DEFAULT_KEYS,
  DIRTY_EVENT,
  SAVE_EVENT,
  OPEN_EVENT,
  SELECT_EVENT,
  type AskState,
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
export { LodeFlow } from "./flow.js";
export type { CanvasAction, ExplainEvent } from "../src/explain/index.js";
export type * from "../src/query/types.js";

import type { LodeConnection } from "./connection.js";
import { LodeFlow } from "./flow.js";
import type { LodeHost, ViewRequest } from "./host.js";

export function defineLodeElements() {
  if (!customElements.get("lode-flow")) customElements.define("lode-flow", LodeFlow);
}

// A flow, wired to a client and host, ready to mount. Everything else a
// host shows (tabs, a file tree, entry points, a changes list, toolbars,
// an explain UI) it builds itself, from lodeApi and the flow's methods and
// events.
export function createView(view: ViewRequest, client: LodeConnection, host: LodeHost): LodeFlow {
  defineLodeElements();
  const flow = document.createElement("lode-flow") as LodeFlow;
  flow.client = client;
  flow.host = host;
  if (view.id) flow.setAttribute("node", view.id);
  if (view.state) flow.stateKey = view.state;
  if (view.diff) flow.setDiffOnConnect(view.diff);
  if (view.ids?.length) flow.pendingIds = [...view.ids];
  if (view.ask) flow.pendingAsk = view.ask;
  return flow;
}
