// lode views: framework-free web components any host can mount.
//
//   defineLodeElements();
//   const view = createView({ kind: "flow", id: "src/main.ts#run" }, client, host);
//   container.append(view);
export { LodeClient } from "./client.js";
export { TITLE_EVENT, type LodeHost, type SourceHighlight, type ViewRequest } from "./host.js";
export { LodeEntries } from "./entries.js";
export { LodeFlow } from "./flow.js";
export type * from "../src/query/types.js";

import type { LodeClient } from "./client.js";
import { LodeEntries } from "./entries.js";
import { LodeFlow } from "./flow.js";
import type { LodeHost, ViewRequest } from "./host.js";

export function defineLodeElements() {
  if (!customElements.get("lode-entries")) customElements.define("lode-entries", LodeEntries);
  if (!customElements.get("lode-flow")) customElements.define("lode-flow", LodeFlow);
}

// The element for a view request, wired to a client and host, ready to mount.
export function createView(view: ViewRequest, client: LodeClient, host: LodeHost): HTMLElement {
  defineLodeElements();
  const el = document.createElement(`lode-${view.kind}`) as LodeEntries | LodeFlow;
  el.client = client;
  el.host = host;
  if (view.kind === "flow" && view.id) el.setAttribute("node", view.id);
  return el;
}
