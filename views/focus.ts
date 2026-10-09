import type { FocusResult, Link, NodeRef } from "../src/query/types.js";
import type { LodeClient } from "./client.js";
import { TITLE_EVENT, type LodeHost, type SourceHighlight } from "./host.js";
import { ARROW_DEFS, BASE_CSS, escape, wire } from "./theme.js";

const COLLAPSE_AFTER = 3; // links of one kind shown before "+N more"

const CSS = `
.stage { position: relative; padding: 28px 40px 48px; display: flex; flex-direction: column; align-items: center; gap: 64px; min-width: 620px; }
.band { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 8px; max-width: 980px; }
.band-label { font-size: 11px; color: var(--lode-faint); }
.row { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
.card { display: flex; flex-direction: column; gap: 1px; min-width: 150px; max-width: 230px; padding: 7px 11px; border: 1px dashed var(--lode-outline); border-radius: 8px; background: var(--lode-bg); }
.card:hover { border-style: solid; border-color: var(--lode-fg); }
.card .name { font-family: var(--lode-mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .sub { font-size: 11px; color: var(--lode-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card.more { justify-content: center; color: var(--lode-muted); font-size: 12px; }
.focus { position: relative; z-index: 1; min-width: 340px; max-width: 460px; background: var(--lode-surface); border: 1px solid var(--lode-fg); border-radius: 10px; padding: 14px 64px 14px 16px; box-shadow: 0 1px 2px rgba(23,22,20,.04); }
.focus h2 { margin: 0; font: 600 14px var(--lode-mono); }
.focus .meta { font-size: 11.5px; color: var(--lode-faint); margin-top: 2px; }
.steps { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.step { display: flex; justify-content: space-between; gap: 12px; width: 100%; padding: 5px 10px; background: var(--lode-sunken); border-radius: 5px; font: 12px var(--lode-mono); }
.step:hover { background: var(--lode-border); }
.step.callback { background: none; border: 1px dashed var(--lode-border); }
.step .line { color: var(--lode-faint); font-size: 11px; }
.step .ret { color: var(--lode-local); }
.hidden-note { margin-top: 10px; font-size: 11.5px; color: var(--lode-faint); }
.arcs { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.wire-label { position: absolute; z-index: 1; font: 10.5px var(--lode-mono); color: var(--lode-local); white-space: nowrap; pointer-events: none; }
`;

// <lode-focus node="file#symbol">: one symbol expanded, what feeds it above,
// what it feeds below. Clicking a node refocuses in place (with back).
export class LodeFocus extends HTMLElement {
  static observedAttributes = ["node"];
  client?: LodeClient;
  host?: LodeHost;

  private readonly root = this.attachShadow({ mode: "open" });
  private data: FocusResult | null = null;
  private history: string[] = [];
  private expanded = new Set<string>();
  private unsubscribe?: () => void;
  private resize = new ResizeObserver(() => this.drawWires());

  connectedCallback() {
    this.root.addEventListener("click", (e) => this.onClick(e));
    this.root.addEventListener("mouseover", (e) => this.onHover(e));
    this.root.addEventListener("mouseleave", () => this.highlight());
    this.unsubscribe = this.client?.onChanged(() => this.load());
    this.resize.observe(this);
    void this.load();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    this.resize.disconnect();
  }

  attributeChangedCallback(_name: string, before: string | null, after: string | null) {
    if (before !== null && before !== after) {
      this.expanded.clear();
      void this.load();
    }
  }

  private get nodeId() {
    return this.getAttribute("node") ?? "";
  }

  private go(id: string) {
    if (id === this.nodeId) return;
    this.history.push(this.nodeId);
    this.setAttribute("node", id);
  }

  private async load() {
    if (!this.client || !this.nodeId) return;
    this.data = await this.client.call<FocusResult | null>("focus", { id: this.nodeId });
    this.render();
    this.highlight();
    this.dispatchEvent(new CustomEvent(TITLE_EVENT, { detail: this.data?.node.name ?? this.nodeId, bubbles: true, composed: true }));
  }

  // Tell the host which source lines this view is about.
  private highlight(hover?: number) {
    const d = this.data;
    const file = d?.node.file;
    if (!d || !file || !d.node.line) return void this.host?.highlight?.(null);
    const h: SourceHighlight = {
      node: d.node.id,
      file,
      ...(d.node.id !== file && { range: [d.node.line, d.node.endLine ?? d.node.line] as [number, number] }),
      marks: d.steps.map((s) => s.line).filter((l) => l > 0),
      ...(hover && { hover }),
    };
    this.host?.highlight?.(h);
  }

  // Hovering a step (or a card for something in the same file) points at
  // its line in the source.
  private onHover(event: Event) {
    const el = (event.target as Element).closest<HTMLElement>("[data-step], .card[data-id]");
    if (!el) return this.highlight();
    const d = this.data;
    if (!d) return;
    if (el.dataset.step) return this.highlight(d.steps[Number(el.dataset.step)]?.line);
    const link = [...d.up, ...d.down].find((l) => l.node.id === el.dataset.id);
    this.highlight(link?.node.file === d.node.file ? link?.node.line : undefined);
  }

  private onClick(event: Event) {
    const el = (event.target as Element).closest<HTMLElement>("[data-action]");
    if (!el) return;
    const { action, id, file, line, key, parent } = el.dataset;
    if (action === "go" && id) {
      if ((event as MouseEvent).metaKey || (event as MouseEvent).ctrlKey) this.host?.openView({ kind: "focus", id });
      else this.go(id);
    } else if (action === "back") {
      const previous = this.history.pop();
      if (previous) this.setAttribute("node", previous);
    } else if (action === "source" && file) {
      this.host?.openSource(file, line ? Number(line) : undefined);
    } else if (action === "map") {
      this.host?.openView({ kind: "map", lens: "runtime", ...(parent && { parent }) });
    } else if (action === "expand" && key) {
      this.expanded.add(key);
      this.render();
    }
  }

  private render() {
    const d = this.data;
    if (!d) {
      this.root.innerHTML = `<style>${BASE_CSS}${CSS}</style><div class="empty">No node <span class="mono">${escape(this.nodeId)}</span>. It may have been renamed.</div>`;
      return;
    }
    const n = d.node;
    const crumbs = d.path
      .map((p, i) => {
        const last = i === d.path.length - 1;
        if (last) return `<span class="crumb current mono">${escape(p.name)}</span>`;
        if (p.id.startsWith("runtime:")) return `<button class="crumb" data-action="map" data-parent="${escape(p.id)}">${escape(p.name)}</button>`;
        return `<button class="crumb mono" data-action="source" data-file="${escape(p.file ?? "")}">${escape(p.name)}</button>`;
      })
      .join(`<span class="sep">›</span>`);

    const returns = new Set(d.flows.filter((f) => f.to === "return").map((f) => f.from));
    const steps = d.steps.length
      ? `<ol class="steps">${d.steps
          .map(
            (s, i) => `<li><button class="step${s.callback ? " callback" : ""}" data-step="${i}" data-action="go" data-id="${escape(s.target?.id ?? "")}" title="${escape(s.target?.id ?? "")}">
              <span>${escape(s.label)}${returns.has(i) ? ` <span class="ret" title="returned">↩</span>` : ""}</span><span class="line">:${s.line}</span></button></li>`,
          )
          .join("")}</ol>`
      : `<div class="hidden-note">No calls into project code.</div>`;

    this.root.innerHTML = `<style>${BASE_CSS}${CSS}</style>
      <div class="toolbar">
        <button class="crumb" data-action="back" ${this.history.length ? "" : "disabled"} aria-label="Back">←</button>
        ${crumbs}
        <span class="spacer"></span>
        <button class="crumb" data-action="source" data-file="${escape(n.file ?? "")}" data-line="${n.line ?? ""}">open source ↗</button>
      </div>
      <div class="stage">
        ${this.band("up", "feeds it", d.up)}
        <section class="focus" aria-label="${escape(n.name)}">
          <h2>${escape(n.name)}${n.kind === "callable" ? "()" : ""}</h2>
          <div class="meta">${escape(n.file ?? "")}${n.line ? `:${n.line}` : ""} · ${escape(n.kind)}${n.runtime ? ` · ${escape(n.runtime)}` : ""}</div>
          ${steps}
          ${d.hidden.libraryCalls ? `<div class="hidden-note">+ ${d.hidden.libraryCalls} library call${d.hidden.libraryCalls === 1 ? "" : "s"}</div>` : ""}
          <svg class="arcs" aria-hidden="true"></svg>
        </section>
        ${this.band("down", "it feeds", d.down)}
        <svg class="wires" aria-hidden="true">${ARROW_DEFS}</svg>
      </div>`;
    requestAnimationFrame(() => this.drawWires());
  }

  private band(side: "up" | "down", label: string, links: Link[]): string {
    if (!links.length) return `<div class="band"><div class="band-label">nothing ${side === "up" ? "feeds it" : "downstream"}</div></div>`;
    const byKind = new Map<string, Link[]>();
    for (const l of links) byKind.set(l.kind, [...(byKind.get(l.kind) ?? []), l]);
    const cards: string[] = [];
    for (const [kind, list] of byKind) {
      const key = `${side}:${kind}`;
      const shown = list.length > COLLAPSE_AFTER && !this.expanded.has(key) ? list.slice(0, COLLAPSE_AFTER - 1) : list;
      for (const l of shown) cards.push(card(l, side));
      if (shown.length < list.length) {
        cards.push(`<button class="card more" data-action="expand" data-key="${key}">+ ${list.length - shown.length} more ${kindWord(kind)}</button>`);
      }
    }
    return `<div class="band"><div class="band-label">${label}</div><div class="row">${cards.join("")}</div></div>`;
  }

  // Wires are measured from the laid-out cards, so layout stays plain CSS.
  private drawWires() {
    const stage = this.root.querySelector<HTMLElement>(".stage");
    const focus = this.root.querySelector<HTMLElement>(".focus");
    const svg = this.root.querySelector<SVGSVGElement>(".wires");
    if (!stage || !focus || !svg || !this.data) return;
    this.root.querySelectorAll(".wire-label").forEach((l) => l.remove());
    const origin = stage.getBoundingClientRect();
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { l: r.left - origin.left, r: r.right - origin.left, t: r.top - origin.top, b: r.bottom - origin.top, cx: (r.left + r.right) / 2 - origin.left, cy: (r.top + r.bottom) / 2 - origin.top };
    };
    const f = rect(focus);
    const clampX = (x: number) => Math.max(f.l + 28, Math.min(f.r - 28, x));
    const curve = (x1: number, y1: number, x2: number, y2: number) => `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;

    const paths: string[] = [];
    this.root.querySelectorAll<HTMLElement>(".card[data-side]").forEach((c) => {
      const r = rect(c);
      const kind = c.dataset.kind!;
      const title = c.getAttribute("title") ?? "";
      if (c.dataset.side === "up") paths.push(wire(curve(r.cx, r.b, clampX(r.cx), f.t - 2), kind, title));
      else paths.push(wire(curve(clampX(r.cx), f.b, r.cx, r.t - 2), kind, title));
    });

    // Local flows: arcs on the right of the steps, from producer to consumer,
    // drawn inside the focus box (relative to it) so they sit above its fill.
    const arcs: string[] = [];
    const inFocus = (el: Element) => {
      const r = el.getBoundingClientRect();
      const o = focus.getBoundingClientRect();
      return { r: r.right - o.left, cy: (r.top + r.bottom) / 2 - o.top };
    };
    const steps = [...this.root.querySelectorAll<HTMLElement>(".step")];
    this.data.flows.forEach((flow, k) => {
      if (flow.to === "return") return;
      const a = steps[flow.from];
      const b = steps[flow.to];
      if (!a || !b) return;
      const ra = inFocus(a);
      const rb = inFocus(b);
      const bulge = 22 + 10 * k;
      arcs.push(wire(`M ${ra.r + 2} ${ra.cy} C ${ra.r + bulge} ${ra.cy}, ${rb.r + bulge} ${rb.cy}, ${rb.r + 4} ${rb.cy}`, "local", flow.type ?? ""));
      if (flow.type) {
        const label = document.createElement("div");
        label.className = "wire-label";
        label.textContent = shortType(flow.type);
        label.title = flow.type;
        const s = rect(a);
        label.style.left = `${s.r + bulge * 0.75 + 8}px`;
        label.style.top = `${(rect(a).cy + rect(b).cy) / 2 - 7}px`;
        stage.append(label);
      }
    });
    svg.innerHTML = ARROW_DEFS + paths.join("");
    const arcSvg = this.root.querySelector<SVGSVGElement>(".arcs");
    if (arcSvg) arcSvg.innerHTML = ARROW_DEFS + arcs.join("");
  }
}

function card(l: Link, side: "up" | "down"): string {
  const sub = [l.label, l.detail ?? place(l.node)].filter(Boolean).join(" · ");
  const title = [l.node.id, l.type].filter(Boolean).join("\n");
  return `<button class="card k-${l.kind}" data-side="${side}" data-kind="${l.kind}" data-action="go" data-id="${escape(l.node.id)}" title="${escape(title)}">
    <span class="name">${escape(l.node.name)}${l.count > 1 ? ` <span class="faint">×${l.count}</span>` : ""}</span>
    <span class="sub"><span class="tag k-${l.kind}">${escape(kindWord(l.kind, true))}</span>${sub ? ` · ${escape(sub)}` : ""}</span>
  </button>`;
}

function place(n: NodeRef): string {
  const file = n.file?.split("/").pop() ?? "";
  return n.runtime ? `${n.runtime} · ${file}` : file;
}

function kindWord(kind: string, short = false): string {
  if (kind === "channel") return short ? "ipc" : "channels";
  if (kind === "state") return short ? "state" : "values";
  return short ? "calls" : "calls";
}

// `{ sampleRate: number; … }` is too long for a wire; keep the head of it.
function shortType(type: string): string {
  return type.length > 28 ? `${type.slice(0, 26)}…` : type;
}
