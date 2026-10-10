import type { MapResult } from "../src/query/types.js";
import type { LodeClient } from "./client.js";
import { TITLE_EVENT, type LodeHost } from "./host.js";
import { ARROW_DEFS, BASE_CSS, escape, wire } from "./theme.js";

const LABELLED_EDGES = 12; // only the heaviest edges get a count label

const CSS = `
.stage { position: relative; padding: 40px 24px; min-width: 560px; }
.grid { position: relative; z-index: 1; display: flex; flex-wrap: wrap; justify-content: center; gap: 88px 80px; }
.grid.few { flex-wrap: nowrap; width: max-content; margin: 0 auto; }
.group { display: flex; flex-direction: column; gap: 4px; width: 168px; min-height: 120px; padding: 16px; background: var(--lode-surface); border: 1px solid var(--lode-border); border-radius: 10px; }
.group:hover { border-color: var(--lode-fg); }
.group .name { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group .name.mono { font-size: 13px; }
.group .sub { font-size: 12px; color: var(--lode-faint); }
.group .open { margin-top: auto; font-size: 12px; color: var(--lode-muted); }
.count { position: absolute; z-index: 2; font: 11px var(--lode-mono); padding: 0 4px; background: var(--lode-bg); border-radius: 4px; pointer-events: none; white-space: nowrap; }
.count.k-channel { color: var(--lode-channel-text); }
.count.k-state { color: var(--lode-state); }
.count.k-calls { color: var(--lode-faint); }
`;

// <lode-map lens="runtime" parent="runtime:main">: the groups at one level
// of a lens, with every edge between them merged and counted. Click a group
// to go a level deeper; a symbol opens in the flow.
export class LodeMap extends HTMLElement {
  static observedAttributes = ["lens", "parent"];
  client?: LodeClient;
  host?: LodeHost;

  private readonly root = this.attachShadow({ mode: "open" });
  private data: MapResult | null = null;
  private unsubscribe?: () => void;
  private resize = new ResizeObserver(() => this.drawEdges());

  connectedCallback() {
    this.root.addEventListener("click", (e) => this.onClick(e));
    this.root.addEventListener("change", (e) => {
      const select = e.target as HTMLSelectElement;
      if (select.name === "lens") {
        this.removeAttribute("parent");
        this.setAttribute("lens", select.value);
      }
    });
    this.unsubscribe = this.client?.onChanged(() => this.load());
    this.resize.observe(this);
    void this.load();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    this.resize.disconnect();
  }

  attributeChangedCallback(_name: string, before: string | null, after: string | null) {
    if (before !== after && this.isConnected) void this.load();
  }

  private async load() {
    if (!this.client) return;
    const lens = this.getAttribute("lens") ?? "runtime";
    const parent = this.getAttribute("parent");
    this.data = await this.client.call<MapResult>("map", { lens, ...(parent && { parent }) });
    this.render();
    const title = this.data.parent ? `map · ${this.data.parent.name}` : `map · ${lens}`;
    this.dispatchEvent(new CustomEvent(TITLE_EVENT, { detail: title, bubbles: true, composed: true }));
  }

  private onClick(event: Event) {
    const el = (event.target as Element).closest<HTMLElement>("[data-action]");
    if (!el) return;
    const { action, id } = el.dataset;
    if (action === "into" && id) this.setAttribute("parent", id);
    else if (action === "top") this.removeAttribute("parent");
    else if (action === "read" && id) this.host?.openView({ kind: "flow", id });
  }

  private render() {
    const d = this.data!;
    const lenses = ["runtime", "folder", "containment"];
    const crumbs = [
      `<button class="crumb${d.path.length ? "" : " current"}" data-action="top">${escape(d.lens)}</button>`,
      ...d.path.map((p, i) =>
        i === d.path.length - 1
          ? `<span class="crumb current">${escape(p.name)}</span>`
          : `<button class="crumb" data-action="into" data-id="${escape(p.id)}">${escape(p.name)}</button>`,
      ),
    ].join(`<span class="sep">›</span>`);

    const groups = arrange(d)
      .map((g) => {
        const n = g.node;
        const leaf = g.children === 0 || n.kind === "callable";
        const action = leaf ? "read" : "into";
        const isGroup = n.id.startsWith(`${d.lens}:`) || n.id.startsWith("dir:");
        const sub = isGroup ? `${g.children} inside` : `${n.kind}${n.line ? ` · line ${n.line}` : ""}`;
        return `<button class="group" data-action="${action}" data-id="${escape(n.id)}" title="${escape(n.id)}">
          <span class="name${isGroup ? "" : " mono"}">${escape(n.name)}</span>
          <span class="sub">${escape(sub)}</span>
          <span class="open">${leaf ? "read ↗" : "▸ open"}</span>
        </button>`;
      })
      .join("");

    this.root.innerHTML = `<style>${BASE_CSS}${CSS}</style>
      <div class="toolbar">
        ${crumbs}
        <span class="spacer"></span>
        <label class="faint" for="lens">lens</label>
        <select name="lens" id="lens">${lenses.map((l) => `<option${l === d.lens ? " selected" : ""}>${l}</option>`).join("")}</select>
        <span class="faint">${d.groups.length} groups · ${d.edges.reduce((s, e) => s + e.count, 0)} edges between them</span>
      </div>
      <div class="stage">
        <div class="grid${d.groups.length <= 4 ? " few" : ""}">${groups || `<div class="empty">Nothing at this level.</div>`}</div>
        <svg class="wires" aria-hidden="true">${ARROW_DEFS}</svg>
      </div>`;
    requestAnimationFrame(() => this.drawEdges());
  }

  // Merged edges as curves between group centres; a→b and b→a bow apart.
  private drawEdges() {
    const stage = this.root.querySelector<HTMLElement>(".stage");
    const svg = this.root.querySelector<SVGSVGElement>(".wires");
    if (!stage || !svg || !this.data) return;
    this.root.querySelectorAll(".count").forEach((c) => c.remove());
    const origin = stage.getBoundingClientRect();
    const boxes = new Map<string, DOMRect>();
    this.root.querySelectorAll<HTMLElement>(".group").forEach((g) => boxes.set(g.dataset.id!, g.getBoundingClientRect()));
    const max = Math.max(1, ...this.data.edges.map((e) => e.count));

    const paths: string[] = [];
    this.data.edges.forEach((e, i) => {
      const a = boxes.get(e.from);
      const b = boxes.get(e.to);
      if (!a || !b) return;
      const [x1, y1] = edgePoint(a, b, origin);
      const [x2, y2] = edgePoint(b, a, origin);
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const bow = 28; // to the left of travel, so opposite directions separate
      const mx = (x1 + x2) / 2 + (-dy / len) * bow;
      const my = (y1 + y2) / 2 + (dx / len) * bow;
      const width = 1.2 + 2.3 * Math.sqrt(e.count / max);
      paths.push(wire(`M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`, e.kind, `${e.count} ${e.kind}`).replace('stroke-width="1.5"', `stroke-width="${width.toFixed(1)}"`));
      if (i < LABELLED_EDGES) {
        const label = document.createElement("div");
        label.className = `count k-${e.kind}`;
        label.textContent = `${e.count} ${e.kind === "channel" ? "ipc" : e.kind}`;
        label.style.left = `${(x1 + x2) / 4 + mx / 2 - 18}px`;
        label.style.top = `${(y1 + y2) / 4 + my / 2 - 8}px`;
        stage.append(label);
      }
    });
    svg.innerHTML = ARROW_DEFS + paths.join("");
  }
}

// Busiest groups in the middle, so their edges stay short.
function arrange(d: MapResult): MapResult["groups"] {
  const degree = new Map<string, number>();
  for (const e of d.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + e.count);
    degree.set(e.to, (degree.get(e.to) ?? 0) + e.count);
  }
  if (d.groups.length > 5) return d.groups;
  const sorted = [...d.groups].sort((a, b) => (degree.get(b.node.id) ?? 0) - (degree.get(a.node.id) ?? 0));
  const out: MapResult["groups"] = [];
  sorted.forEach((g, i) => (i % 2 ? out.unshift(g) : out.push(g)));
  return out;
}

// Where the line from box a's centre towards box b's centre leaves box a.
function edgePoint(a: DOMRect, b: DOMRect, origin: DOMRect): [number, number] {
  const ax = (a.left + a.right) / 2;
  const ay = (a.top + a.bottom) / 2;
  const dx = (b.left + b.right) / 2 - ax;
  const dy = (b.top + b.bottom) / 2 - ay;
  const scale = 1 / Math.max(Math.abs(dx) / (a.width / 2 + 6), Math.abs(dy) / (a.height / 2 + 6), 1e-6);
  return [ax + dx * scale - origin.left, ay + dy * scale - origin.top];
}
