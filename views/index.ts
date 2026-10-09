// lode views: framework-free web components any host can mount.
//
//   defineLodeElements();
//   const view = document.createElement("lode-focus");
//   Object.assign(view, { client, host });
//   view.setAttribute("node", "src/main.ts#run");
export { LodeClient } from "./client.js";
export { TITLE_EVENT, type LodeHost, type SourceHighlight, type ViewRequest } from "./host.js";
export { LodeFocus } from "./focus.js";
export { LodeMap } from "./map.js";
export { LodeGraph } from "./graph.js";
export { LodeFlow } from "./flow.js";
export type * from "../src/query/types.js";

import type { LodeClient } from "./client.js";
import { LodeFocus } from "./focus.js";
import { LodeFlow } from "./flow.js";
import { LodeGraph } from "./graph.js";
import type { LodeHost, ViewRequest } from "./host.js";
import { LodeMap } from "./map.js";

export function defineLodeElements() {
  if (!customElements.get("lode-focus")) customElements.define("lode-focus", LodeFocus);
  if (!customElements.get("lode-map")) customElements.define("lode-map", LodeMap);
  if (!customElements.get("lode-graph")) customElements.define("lode-graph", LodeGraph);
  if (!customElements.get("lode-flow")) customElements.define("lode-flow", LodeFlow);
}

// The element for a view request, wired to a client and host, ready to mount.
export function createView(view: ViewRequest, client: LodeClient, host: LodeHost): HTMLElement {
  defineLodeElements();
  const el = document.createElement(`lode-${view.kind}`) as LodeFocus | LodeMap | LodeGraph | LodeFlow;
  el.client = client;
  el.host = host;
  if (view.kind === "focus") el.setAttribute("node", view.id);
  else if (view.kind === "flow") view.id && el.setAttribute("node", view.id);
  else el.setAttribute("lens", view.lens ?? "runtime");
  if (view.kind === "map" && view.parent) el.setAttribute("parent", view.parent);
  if (view.kind === "graph" && view.select) el.setAttribute("select", view.select);
  return el;
}
