import type { GraphDump, GraphNode, LinkKind } from "../src/query/types.js";
import type { LodeClient } from "./client.js";
import { TITLE_EVENT, type LodeHost } from "./host.js";
import { ARROW_DEFS, BASE_CSS, escape, wire } from "./theme.js";

// Layout: one column per tree level, left (highest) to right (lowest).
const COL = 250;
const NODE_W = 200;
const NODE_H = 26;
const ROW = 32;
const GROUP_GAP = 0.5; // extra rows after a group of siblings
const ZOOM = { min: 0.12, max: 1.6 };
const READABLE = 0.62; // the camera never zooms out past this on its own

interface Camera {
  x: number;
  y: number;
  k: number;
}
interface Pos {
  x: number;
  y: number;
}
interface Snapshot {
  selected: string | null;
  camera: Camera;
}

const CSS = `
:host { overflow: hidden; display: flex; flex-direction: column; }
.surface { position: relative; flex: 1; min-height: 0; cursor: grab; touch-action: none; }
.surface.dragging { cursor: grabbing; }
svg.canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.node rect { fill: var(--lode-surface); stroke: var(--lode-border); stroke-width: 1; }
.node text { font: 12px var(--lode-font); fill: var(--lode-fg); pointer-events: none; }
.node .badge { fill: var(--lode-faint); font: 11px var(--lode-mono); }
.node { cursor: pointer; }
.node:hover rect { stroke: var(--lode-fg); }
.node.d0 rect { fill: var(--lode-fg); stroke: var(--lode-fg); }
.node.d0 text { fill: var(--lode-bg); font-weight: 600; font-size: 13px; }
.node.d0 .badge { fill: var(--lode-outline); }
.node.file rect { fill: var(--lode-sunken); }
.node.callable text.label { font-family: var(--lode-mono); }
.node.value text.label, .node.type text.label { fill: var(--lode-muted); font-family: var(--lode-mono); }
.node.selected rect { stroke: var(--lode-local); stroke-width: 2; }
.node.linked rect { stroke: var(--k); stroke-width: 1.5; }
.dim .node:not(.selected):not(.linked):not(.path):not(.child) { opacity: 0.38; }
.tree { fill: none; stroke: var(--lode-border); stroke-width: 1.2; }
.edge-count { font: 10.5px var(--lode-mono); }
.edge-count.k-channel { fill: var(--lode-channel-text); }
.edge-count.k-state { fill: var(--lode-state); }
.edge-count.k-calls { fill: var(--lode-faint); }
.hint { position: absolute; left: 16px; bottom: 12px; font-size: 12px; color: var(--lode-faint); pointer-events: none; }
`;

// <lode-graph lens="runtime">: the whole project as one horizontal tree you
// zoom around. Click a node to select it, open its children to the right and
// fly the camera to it; its connections are drawn to whatever is visible,
// rolled up to the nearest visible parent. ← → step through what you've seen.
export class LodeGraph extends HTMLElement {
  static observedAttributes = ["lens"];
  client?: LodeClient;
  host?: LodeHost;

  private readonly root = this.attachShadow({ mode: "open" });
  private data: GraphDump | null = null;
  private byId = new Map<string, GraphNode>();
  private kids = new Map<string, string[]>();
  private expanded = new Set<string>();
  private selected: string | null = null;
  private positions = new Map<string, Pos>();
  private camera: Camera = { x: 40, y: 40, k: 1 };
  private history: Snapshot[] = [];
  private cursor = -1;
  private animation = 0;
  private unsubscribe?: () => void;

  connectedCallback() {
    this.root.innerHTML = `<style>${BASE_CSS}${CSS}</style>
      <div class="toolbar">
        <button class="crumb" data-action="prev" aria-label="Previous">←</button>
        <button class="crumb" data-action="next" aria-label="Next">→</button>
        <span class="sep">·</span>
        <span class="path"></span>
        <span class="spacer"></span>
        <button class="crumb" data-action="connections" title="Open the parents of everything the selection connects to">reveal connections</button>
        <button class="crumb" data-action="collapse">collapse</button>
        <button class="crumb" data-action="fit">fit</button>
        <span class="faint stats"></span>
      </div>
      <div class="surface"><svg class="canvas" aria-label="Project graph">${ARROW_DEFS}<g class="cam"></g></svg><div class="hint">click a node to open it · scroll to zoom · drag to pan</div></div>`;
    this.root.addEventListener("click", (e) => this.onClick(e));
    this.setupPanZoom();
    this.unsubscribe = this.client?.onChanged(() => this.load());
    void this.load();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
  }

  attributeChangedCallback(_n: string, before: string | null, after: string | null) {
    if (before !== null && before !== after) void this.load();
  }

  // Open the path to a node, select it and fly there (used by hosts when
  // the user clicks in their code).
  reveal(id: string) {
    if (!this.byId.has(id)) return;
    for (let p = this.byId.get(id)!.parent; p; p = this.byId.get(p)?.parent ?? null) this.expanded.add(p);
    this.select(id, { expand: false });
  }

  private async load() {
    if (!this.client) return;
    const lens = this.getAttribute("lens") ?? "runtime";
    this.data = await this.client.call<GraphDump>("graph", { lens });
    this.byId = new Map(this.data.nodes.map((n) => [n.id, n]));
    this.kids = new Map();
    for (const n of this.data.nodes) if (n.parent) this.kids.set(n.parent, [...(this.kids.get(n.parent) ?? []), n.id]);
    for (const id of [...this.expanded]) if (!this.byId.has(id)) this.expanded.delete(id);
    if (this.selected && !this.byId.has(this.selected)) this.selected = null;
    this.dispatchEvent(new CustomEvent(TITLE_EVENT, { detail: `graph · ${lens}`, bubbles: true, composed: true }));
    this.render();
    const initial = this.getAttribute("select");
    if (initial && this.byId.has(initial) && !this.selected) this.reveal(initial);
    else if (this.cursor < 0) this.fit(this.bounds([...this.positions.keys()]), false);
  }

  // --- interaction ---------------------------------------------------------

  private onClick(event: Event) {
    const target = event.target as Element;
    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (action === "prev") return this.step(-1);
    if (action === "next") return this.step(1);
    if (action === "fit") return this.fit(this.bounds([...this.positions.keys()]));
    if (action === "collapse") {
      this.expanded = new Set(this.data?.nodes.filter((n) => n.depth === 0).map((n) => n.id));
      this.selected = null;
      this.render();
      return this.fit(this.bounds([...this.positions.keys()]));
    }
    if (action === "connections") return this.revealConnections();
    if (action === "crumb") {
      const id = target.closest<HTMLElement>("[data-id]")?.dataset.id;
      if (id) this.select(id, { expand: false });
      return;
    }
    const node = target.closest<SVGGElement>(".node");
    if (node?.dataset.id) {
      const id = node.dataset.id;
      // Clicking the selected, open node closes it; anything else selects.
      if (id === this.selected && this.expanded.has(id)) {
        this.expanded.delete(id);
        this.render();
        this.focusCamera(id);
      } else this.select(id, { expand: true });
    }
  }

  // Selecting keeps only the path to the node open (an accordion), so each
  // column stays short; "reveal connections" opens more on purpose.
  private select(id: string, { expand }: { expand: boolean }) {
    this.selected = id;
    this.expanded = new Set(this.ancestors(id));
    if (expand && this.kids.has(id)) this.expanded.add(id);
    this.render();
    this.focusCamera(id);
    this.history.splice(this.cursor + 1);
    this.history.push({ selected: id, camera: { ...this.target } });
    this.cursor = this.history.length - 1;
    this.tellHost();
  }

  private step(delta: number) {
    const snapshot = this.history[this.cursor + delta];
    if (!snapshot) return;
    this.cursor += delta;
    this.selected = snapshot.selected;
    if (this.selected) this.expanded = new Set([...this.ancestors(this.selected), ...(this.kids.has(this.selected) ? [this.selected] : [])]);
    this.render();
    if (this.selected) this.focusCamera(this.selected);
    else this.animateTo(snapshot.camera);
    this.tellHost();
  }

  // Open the parents of every real endpoint the selection connects to, so
  // edges point at the actual nodes instead of rolled-up ancestors.
  private revealConnections() {
    if (!this.selected || !this.data) return;
    const inside = this.subtree(this.selected);
    let opened = 0;
    for (const e of this.data.edges) {
      const other = inside.has(e.from) && !inside.has(e.to) ? e.to : inside.has(e.to) && !inside.has(e.from) ? e.from : null;
      if (!other || opened > 80) continue;
      for (let p = this.byId.get(other)?.parent; p; p = this.byId.get(p)?.parent ?? null) this.expanded.add(p);
      opened++;
    }
    this.render();
    this.fit(this.bounds(this.focusSet(this.selected)), true, 0.3);
  }

  private tellHost() {
    const n = this.selected ? this.byId.get(this.selected) : null;
    if (!n?.file || !n.line || n.depth < 2) return void this.host?.highlight?.(null);
    this.host?.highlight?.({ node: n.id, file: n.file, range: [n.line, n.endLine ?? n.line], marks: [] });
  }

  // --- pan and zoom ----------------------------------------------------------

  private target: Camera = { ...this.camera };

  private setupPanZoom() {
    const surface = this.root.querySelector<HTMLElement>(".surface")!;
    let drag: { x: number; y: number; cam: Camera; moved: boolean } | null = null;
    surface.addEventListener("pointerdown", (e) => {
      if ((e.target as Element).closest(".node")) return;
      drag = { x: e.clientX, y: e.clientY, cam: { ...this.camera }, moved: false };
      surface.setPointerCapture(e.pointerId);
      surface.classList.add("dragging");
    });
    surface.addEventListener("pointermove", (e) => {
      if (!drag) return;
      drag.moved = true;
      this.setCamera({ ...drag.cam, x: drag.cam.x + e.clientX - drag.x, y: drag.cam.y + e.clientY - drag.y });
    });
    const end = () => {
      drag = null;
      surface.classList.remove("dragging");
      this.target = { ...this.camera };
    };
    surface.addEventListener("pointerup", end);
    surface.addEventListener("pointercancel", end);
    surface.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = surface.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const k = clamp(this.camera.k * Math.exp(-e.deltaY * 0.0015), ZOOM.min, ZOOM.max);
        // Keep the point under the pointer where it is.
        const x = px - ((px - this.camera.x) * k) / this.camera.k;
        const y = py - ((py - this.camera.y) * k) / this.camera.k;
        this.setCamera({ x, y, k });
        this.target = { ...this.camera };
      },
      { passive: false },
    );
  }

  private setCamera(c: Camera) {
    cancelAnimationFrame(this.animation);
    this.camera = c;
    this.root.querySelector(".cam")?.setAttribute("transform", `translate(${c.x} ${c.y}) scale(${c.k})`);
  }

  private animateTo(to: Camera, animate = true) {
    this.target = to;
    if (!animate) return this.setCamera(to);
    const from = { ...this.camera };
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 320);
      const ease = 1 - (1 - t) ** 3;
      this.camera = { x: from.x + (to.x - from.x) * ease, y: from.y + (to.y - from.y) * ease, k: from.k + (to.k - from.k) * ease };
      this.root.querySelector(".cam")?.setAttribute("transform", `translate(${this.camera.x} ${this.camera.y}) scale(${this.camera.k})`);
      if (t < 1) this.animation = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.animation);
    this.animation = requestAnimationFrame(tick);
  }

  private fit(b: { x0: number; y0: number; x1: number; y1: number } | null, animate = true, minZoom = ZOOM.min, centre?: Pos) {
    const surface = this.root.querySelector<HTMLElement>(".surface");
    if (!b || !surface) return;
    const w = surface.clientWidth || 800;
    const h = surface.clientHeight || 600;
    const pad = 40;
    const fitK = Math.min((w - pad * 2) / (b.x1 - b.x0 || 1), (h - pad * 2) / (b.y1 - b.y0 || 1));
    const k = clamp(fitK, minZoom, 1.15);
    // Too big to fit readably: centre on the given point instead.
    const cx = fitK < minZoom && centre ? centre.x : (b.x0 + b.x1) / 2;
    const cy = fitK < minZoom && centre ? centre.y : (b.y0 + b.y1) / 2;
    this.animateTo({ k, x: w / 2 - k * cx, y: h / 2 - k * cy }, animate);
  }

  // Frame a node with its parent and its open children, at a readable zoom.
  private focusCamera(id: string) {
    const n = this.byId.get(id);
    const p = this.positions.get(id);
    if (!n || !p) return;
    const ids = [id, ...(n.parent ? [n.parent] : []), ...(this.expanded.has(id) ? this.kids.get(id) ?? [] : [])];
    this.fit(this.bounds(ids), true, READABLE, { x: p.x + NODE_W, y: p.y });
  }

  private ancestors(id: string): string[] {
    const out: string[] = [];
    for (let p = this.byId.get(id)?.parent ?? null; p; p = this.byId.get(p)?.parent ?? null) out.push(p);
    return out;
  }

  // The selection, its visible children and what it connects to.
  private focusSet(id: string): string[] {
    const ids = [id, ...(this.expanded.has(id) ? this.kids.get(id) ?? [] : [])];
    for (const other of this.connections().keys()) ids.push(other.split("|")[0]);
    return ids;
  }

  private bounds(ids: string[]) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const id of ids) {
      const p = this.positions.get(id);
      if (!p) continue;
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x + NODE_W);
      y0 = Math.min(y0, p.y - NODE_H / 2);
      y1 = Math.max(y1, p.y + NODE_H / 2);
    }
    return x0 === Infinity ? null : { x0, y0, x1, y1 };
  }

  // --- layout and drawing ----------------------------------------------------

  private layout() {
    this.positions = new Map();
    let row = 0;
    const place = (id: string): number => {
      const n = this.byId.get(id)!;
      const kids = this.expanded.has(id) ? this.kids.get(id) ?? [] : [];
      let y: number;
      if (kids.length) {
        const ys = kids.map(place);
        y = (ys[0] + ys[ys.length - 1]) / 2;
        row += GROUP_GAP;
      } else {
        y = row * ROW;
        row++;
      }
      this.positions.set(id, { x: n.depth * COL, y });
      return y;
    };
    for (const n of this.data?.nodes ?? []) {
      if (n.depth === 0) {
        place(n.id);
        row += 1;
      }
    }
  }

  private subtree(id: string): Set<string> {
    const out = new Set<string>();
    const walk = (i: string) => {
      out.add(i);
      for (const c of this.kids.get(i) ?? []) walk(c);
    };
    walk(id);
    return out;
  }

  // The nearest visible node at or above `id`.
  private visible(id: string): string | null {
    for (let i: string | null = id; i; i = this.byId.get(i)?.parent ?? null) if (this.positions.has(i)) return i;
    return null;
  }

  // The selection's edges, rolled up to visible nodes: "other|in|kind" → count.
  private connections(): Map<string, number> {
    const out = new Map<string, number>();
    if (!this.selected || !this.data) return out;
    const inside = this.subtree(this.selected);
    for (const e of this.data.edges) {
      const fromIn = inside.has(e.from);
      const toIn = inside.has(e.to);
      if (fromIn === toIn) continue;
      const other = this.visible(fromIn ? e.to : e.from);
      if (!other || inside.has(other)) continue;
      const key = `${other}|${fromIn ? "out" : "in"}|${e.kind}`;
      out.set(key, (out.get(key) ?? 0) + e.count);
    }
    return out;
  }

  private render() {
    if (!this.data) return;
    this.layout();
    const parts: string[] = [];

    // Tree lines first (under everything).
    for (const [id, p] of this.positions) {
      const parent = this.byId.get(id)?.parent;
      const pp = parent ? this.positions.get(parent) : undefined;
      if (!pp) continue;
      const x0 = pp.x + NODE_W;
      const mid = (x0 + p.x) / 2;
      parts.push(`<path class="tree" d="M ${x0} ${pp.y} C ${mid} ${pp.y}, ${mid} ${p.y}, ${p.x} ${p.y}"/>`);
    }

    // The selection's connections.
    const linked = new Map<string, LinkKind>();
    const sel = this.selected ? this.positions.get(this.selected) : undefined;
    if (sel && this.selected) {
      for (const [key, count] of this.connections()) {
        const [other, dir, kind] = key.split("|") as [string, "in" | "out", LinkKind];
        const op = this.positions.get(other)!;
        linked.set(other, kind);
        const [a, b] = dir === "out" ? [sel, op] : [op, sel];
        parts.push(wire(connector(a, b), kind, `${count} ${kind}`).replace('stroke-width="1.5"', `stroke-width="${(1.2 + Math.min(3, Math.log2(count + 1))).toFixed(1)}"`));
        if (count > 1) parts.push(`<text class="edge-count k-${kind}" x="${op.x + NODE_W + 6}" y="${op.y + 4}">×${count}</text>`);
      }
    }

    // Nodes.
    const path = new Set<string>();
    for (let p = this.selected; p; p = this.byId.get(p)?.parent ?? null) path.add(p);
    const childOfSelected = new Set(this.selected && this.expanded.has(this.selected) ? this.kids.get(this.selected) : []);
    for (const [id, p] of this.positions) {
      const n = this.byId.get(id)!;
      const kids = this.kids.get(id)?.length ?? 0;
      const classes = ["node", n.kind, `d${n.depth}`, n.depth === 1 ? "file" : "", id === this.selected ? "selected" : "", linked.has(id) ? `linked k-${linked.get(id)}` : "", path.has(id) ? "path" : "", childOfSelected.has(id) ? "child" : ""].filter(Boolean).join(" ");
      const badge = kids ? `${this.expanded.has(id) ? "▾" : "▸"} ${kids}` : "";
      parts.push(`<g class="${classes}" data-id="${escape(id)}" transform="translate(${p.x} ${p.y - NODE_H / 2})"><title>${escape(id)}</title>
        <rect width="${NODE_W}" height="${NODE_H}" rx="6"/>
        <text class="label" x="10" y="17">${escape(label(n))}</text>
        ${badge ? `<text class="badge" x="${NODE_W - 8}" y="17" text-anchor="end">${badge}</text>` : ""}</g>`);
    }

    const cam = this.root.querySelector(".cam")!;
    cam.innerHTML = parts.join("");
    cam.setAttribute("transform", `translate(${this.camera.x} ${this.camera.y}) scale(${this.camera.k})`);
    this.root.querySelector(".surface")?.classList.toggle("dim", !!this.selected);
    cam.parentElement?.classList.toggle("dim", !!this.selected);

    // Toolbar: where the selection sits, and history buttons.
    const crumbs = [...path].reverse().map((id, i, all) => {
      const n = this.byId.get(id)!;
      return i === all.length - 1
        ? `<span class="crumb current mono">${escape(label(n))}</span>`
        : `<button class="crumb" data-action="crumb" data-id="${escape(id)}">${escape(label(n))}</button>`;
    });
    this.root.querySelector(".path")!.innerHTML = crumbs.join(`<span class="sep">›</span>`) || `<span class="faint">${escape(this.data.lens)}</span>`;
    this.root.querySelector(".stats")!.textContent = `${this.positions.size} shown of ${this.data.nodes.length}`;
    this.root.querySelector<HTMLButtonElement>('[data-action="prev"]')!.disabled = this.cursor <= 0;
    this.root.querySelector<HTMLButtonElement>('[data-action="next"]')!.disabled = this.cursor >= this.history.length - 1;
    this.root.querySelector<HTMLElement>(".hint")!.hidden = !!this.selected;
  }
}

// A curve from a to b that never cuts back across a column: rightwards
// left-to-right, leftwards right-to-left, and a bracket on the left (the
// quieter side; children open to the right) between nodes in one column.
function connector(a: Pos, b: Pos): string {
  if (b.x > a.x + 1) {
    const x0 = a.x + NODE_W;
    const x1 = b.x - 4;
    const bend = Math.max(60, (x1 - x0) / 2);
    return `M ${x0} ${a.y} C ${x0 + bend} ${a.y}, ${x1 - bend} ${b.y}, ${x1} ${b.y}`;
  }
  if (b.x < a.x - 1) {
    const x0 = a.x;
    const x1 = b.x + NODE_W + 4;
    const bend = Math.max(60, (x0 - x1) / 2);
    return `M ${x0} ${a.y} C ${x0 - bend} ${a.y}, ${x1 + bend} ${b.y}, ${x1} ${b.y}`;
  }
  const x = a.x;
  const bulge = Math.min(120, 30 + Math.abs(b.y - a.y) * 0.12);
  return `M ${x} ${a.y} C ${x - bulge} ${a.y}, ${x - bulge} ${b.y}, ${x - 4} ${b.y}`;
}

function label(n: GraphNode): string {
  const name = n.depth === 1 ? n.name : n.kind === "callable" ? `${n.name}()` : n.name;
  return name.length > 30 ? `${name.slice(0, 29)}…` : name;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
