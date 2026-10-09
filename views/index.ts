// lode views: framework-free web components any host can mount.
//
//   defineLodeElements();
//   const view = document.createElement("lode-focus");
//   Object.assign(view, { client, host });
//   view.setAttribute("node", "src/main.ts#run");
export { LodeClient } from "./client.js";
export { TITLE_EVENT, type LodeHost, type ViewRequest } from "./host.js";
export { LodeFocus } from "./focus.js";
export { LodeMap } from "./map.js";
export type * from "../src/query/types.js";

import type { LodeClient } from "./client.js";
import { LodeFocus } from "./focus.js";
import type { LodeHost, ViewRequest } from "./host.js";
import { LodeMap } from "./map.js";

export function defineLodeElements() {
  if (!customElements.get("lode-focus")) customElements.define("lode-focus", LodeFocus);
  if (!customElements.get("lode-map")) customElements.define("lode-map", LodeMap);
}

// The element for a view request, wired to a client and host, ready to mount.
export function createView(view: ViewRequest, client: LodeClient, host: LodeHost): HTMLElement {
  defineLodeElements();
  const el = document.createElement(view.kind === "focus" ? "lode-focus" : "lode-map") as LodeFocus | LodeMap;
  el.client = client;
  el.host = host;
  if (view.kind === "focus") el.setAttribute("node", view.id);
  else {
    el.setAttribute("lens", view.lens ?? "runtime");
    if (view.parent) el.setAttribute("parent", view.parent);
  }
  return el;
}
