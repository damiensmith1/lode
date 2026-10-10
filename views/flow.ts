import type { BlockLink, BlockRegion, CodeBlock, LinkKind } from "../src/query/types.js";
import type { LodeClient } from "./client.js";
import { TITLE_EVENT, type LodeHost } from "./host.js";
import { ARROW_DEFS, BASE_CSS, escape, wire } from "./theme.js";

const MAX_CALLERS = 4;
const MAX_ROLLED = 3; // chips carried up from inside a fold before "+N inside"
const SMALL = 3; // regions hiding this many lines or fewer never fold
const PAGE = 25; // lines a card shows before "show 25 more"
const GAP = 72; // space between a card and one opened from it
const PAD = 32; // board padding
const UNDO_LIMIT = 100;
const LAYOUT = "flow"; // the name the layout is saved under
const ZOOM = { min: 0.2, max: 2 };

interface Camera {
  x: number; // screen offset of the board's origin
  y: number;
  k: number; // scale
}

// Comments and imports open in place: a card of them is just a detour.
const inPlace = (r: BlockRegion) => r.kind === "comment" || r.kind === "imports";

// A card on the canvas: a node's code, or a range inside one (a fragment),
// shown one level deep (nested regions fold to their header line).
interface Card {
  key: string; // node id, or "<node id>@<start>-<end>" for a fragment
  block: CodeBlock;
  range: [number, number];
  fragment?: string; // the fragment's header text, for its title
  expanded: Set<number>; // comment/import folds opened in place
  limit: number; // lines shown before "show more"
  allCallers?: boolean;
  x: number;
  y: number;
}

// An arrow from a line in one card to another card.
interface Arrow {
  from: string;
  line: number;
  to: string;
  kind: LinkKind;
}

interface Snapshot {
  cards: Card[];
  arrows: Arrow[];
  selected: string | null;
}

// What's saved with the project (blocks are refetched on load).
interface SavedLayout {
  v: 1;
  cards: { key: string; node: string; range: [number, number]; fragment?: string; expanded: number[]; limit: number; allCallers?: boolean; x: number; y: number }[];
  arrows: Arrow[];
  selected: string | null;
  camera?: Camera; // x, y: where the canvas origin (0, 0) sits on screen
}

const CSS = `
:host { display: flex; flex-direction: column; overflow: hidden; }
.canvas { position: relative; flex: 1; min-height: 0; overflow: hidden; cursor: grab; touch-action: none; }
.canvas.panning { cursor: grabbing; }
.canvas.panning, .canvas.moving { user-select: none; -webkit-user-select: none; }
.card header { user-select: none; -webkit-user-select: none; }
.board { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.zoom { min-width: 44px; text-align: center; font-variant-numeric: tabular-nums; }
.card { position: absolute; z-index: 1; width: max-content; min-width: 480px; max-width: 760px; background: var(--lode-surface); border: 1px solid var(--lode-border); border-radius: 10px; box-shadow: 0 1px 2px rgba(23,22,20,.04); }
.card.selected { border-color: var(--lode-local); box-shadow: 0 0 0 1px var(--lode-local), 0 4px 14px rgba(23,22,20,.06); z-index: 3; }
.card.dragging { box-shadow: 0 0 0 1px var(--lode-local), 0 12px 32px rgba(23,22,20,.16); z-index: 4; }
.card header { position: relative; padding: 10px 40px 8px 14px; border-bottom: 1px solid var(--lode-border); display: flex; flex-direction: column; gap: 3px; cursor: grab; }
.card.dragging header { cursor: grabbing; }
.close { position: absolute; top: 6px; right: 8px; width: 24px; height: 24px; border-radius: 5px; color: var(--lode-faint); text-align: center; font-size: 15px; line-height: 24px; }
.close:hover { background: var(--lode-sunken); color: var(--lode-fg); }
.title { font: 600 13px var(--lode-mono); align-self: flex-start; }
.title:hover { text-decoration: underline; }
.title .part { font-weight: 450; color: var(--lode-muted); }
.meta { font-size: 11.5px; color: var(--lode-faint); }
.callers { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 11.5px; color: var(--lode-faint); margin-bottom: 4px; }
.caller { font: 11.5px var(--lode-mono); color: var(--lode-muted); padding: 1px 6px; border: 1px dashed var(--lode-outline); border-radius: 5px; }
.caller:hover { border-style: solid; color: var(--lode-fg); }
.callers.all { max-height: 92px; overflow-y: auto; padding-right: 4px; }
.caller.more { border-style: solid; border-color: var(--lode-border); background: var(--lode-sunken); font-family: var(--lode-font); }
.caller.open { border-style: solid; border-color: var(--lode-local); color: var(--lode-local); }
.code { padding: 6px 0 8px; font: 12px/20px var(--lode-mono); cursor: auto; }
.ln { display: flex; align-items: flex-start; padding-right: 8px; }
.ln .no { flex: none; width: 46px; padding-right: 12px; text-align: right; color: #a3a09a; user-select: none; }
/* Long lines wrap (hanging under their indent) rather than being cut off. */
.ln .src { white-space: pre-wrap; overflow-wrap: anywhere; flex: 1; min-width: 0; }
.ln.linked .no { color: var(--lode-local); }
.ln.active { background: rgba(47, 95, 168, .08); box-shadow: inset 2px 0 0 var(--lode-local); }
.fold { margin-left: 6px; padding: 0 6px; font: 11px/18px var(--lode-mono); color: var(--lode-muted); background: var(--lode-sunken); border: 1px solid transparent; border-radius: 4px; white-space: nowrap; }
.fold:hover { border-color: var(--lode-outline); color: var(--lode-fg); }
.fold.active { border-color: var(--lode-local); color: var(--lode-local); }
.paging { display: flex; gap: 6px; margin: 6px 0 2px 58px; }
.more-lines { padding: 3px 10px; font: 11.5px var(--lode-font); color: var(--lode-muted); background: var(--lode-sunken); border-radius: 5px; }
.more-lines:hover { color: var(--lode-fg); }
.chips { flex: none; max-width: 170px; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding-left: 12px; }
.chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; font: 10.5px/18px var(--lode-mono); padding: 0 6px; border-radius: 4px; border: 1px solid transparent; white-space: nowrap; }
.chip:hover, .chip.active { border-color: currentColor; }
.chip.rolled { opacity: .72; }
.chip.k-calls { color: var(--lode-local); background: rgba(47, 95, 168, .07); }
.chip.k-channel { color: var(--lode-channel-text); background: rgba(226, 99, 47, .09); }
.chip.k-state { color: var(--lode-state); background: rgba(138, 59, 107, .07); }
.arrows { position: absolute; left: 0; top: 0; pointer-events: none; overflow: visible; z-index: 2; }
.hint { padding: 32px; color: var(--lode-muted); }
`;

// <lode-flow node="file#symbol">: code as nodes, on a canvas. Cards of real
// code, each one level deep (nested blocks fold to their first line). A line
// that leads somewhere (a call, IPC, shared state) has a chip; clicking it,
// or a big fold, opens that code as a card beside it with an arrow from the
// exact line. Opening from several places branches; new starting points add
// trees; cards drag anywhere; × closes a card and what only it led to; ←
// undoes. The layout is saved with the project.
export class LodeFlow extends HTMLElement {
  static observedAttributes = ["node"];
  client?: LodeClient;
  host?: LodeHost;

  private readonly root = this.attachShadow({ mode: "open" });
  private cards = new Map<string, Card>();
  private arrows: Arrow[] = [];
  private selected: string | null = null;
  private built = false;
  private undo: Snapshot[] = [];
  private offset = { x: PAD, y: PAD }; // board origin, so negative positions fit
  private camera: Camera = { x: 0, y: 0, k: 1 };
  private ready: Promise<void> = Promise.resolve();
  private saveTimer?: number;
  private unsubscribe?: () => void;

  connectedCallback() {
    document.addEventListener("keydown", this.onKey);
    this.unsubscribe = this.client?.onChanged(() => void this.reload());
    // Hosts move views around (switching tabs reattaches them): build and
    // wire up once, or every reattach adds another set of listeners and a
    // click acts twice.
    if (this.built) {
      // Laid out while detached, everything measured 0: measure again.
      if (this.cards.size) this.position();
      return;
    }
    this.built = true;
    this.root.innerHTML = `<style>${BASE_CSS}${CSS}${this.host?.syntaxCss ?? ""}</style>
      <div class="toolbar">
        <button class="crumb" data-action="undo" aria-label="Undo" title="Undo">←</button>
        <span class="count faint"></span>
        <span class="spacer"></span>
        <span class="faint">scroll or drag to move around · pinch or ⌘-scroll to zoom · drag a card by its header</span>
        <button class="crumb zoom" data-action="zoom-reset" title="Back to 100%">100%</button>
        <button class="crumb" data-action="fit" title="Show every card">fit</button>
        <button class="crumb" data-action="focus" title="Zoom to the selected card">focus</button>
        <button class="crumb" data-action="clear">clear</button>
      </div>
      <div class="canvas"><div class="board"></div></div>`;
    this.root.addEventListener("click", (e) => void this.onClick(e));
    this.setupDrag();
    this.ready = this.restore();
    void this.ready.then(() => {
      const id = this.getAttribute("node");
      // A link to a card that's already on the restored canvas just selects
      // it; the saved view stays where it was.
      if (id && this.cards.has(id)) this.select(id);
      else if (id) void this.show(id);
      else this.render();
    });
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    document.removeEventListener("keydown", this.onKey);
  }

  // Delete/Backspace closes the selected card; ⌘Z / Ctrl+Z undoes. Only while
  // this view is showing, and never while typing somewhere.
  private onKey = (e: KeyboardEvent) => {
    if (!this.isConnected || !this.offsetParent) return;
    const typing = e.composedPath().some((t) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)));
    if (typing) return;
    if ((e.key === "Delete" || e.key === "Backspace") && this.selected && this.cards.has(this.selected)) {
      e.preventDefault();
      this.close(this.selected, true);
    } else if (e.key === "z" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      e.preventDefault();
      this.popUndo();
    }
  };

  attributeChangedCallback(_n: string, before: string | null, after: string | null) {
    if (after && before !== after && this.isConnected) void this.ready.then(() => this.show(after));
  }

  // Show a node: select its card if it's open, else add it as a new tree.
  async show(id: string) {
    await this.ready;
    if (this.cards.has(id)) return this.goTo(id);
    const block = await this.fetch(id);
    if (!block) return;
    this.remember();
    this.cards.set(id, newCard(id, block));
    this.render();
    this.placeRoot(id);
    this.goTo(id);
    this.changed();
  }

  private async fetch(id: string) {
    return (await this.client?.call<CodeBlock | null>("block", { id })) ?? null;
  }

  // --- actions -------------------------------------------------------------

  private async onClick(event: Event) {
    const el = (event.target as Element).closest<HTMLElement>("[data-action]");
    const cardEl = (event.target as Element).closest<HTMLElement>(".card");
    if (!el) {
      if (cardEl && !String(window.getSelection() ?? "")) this.select(cardEl.dataset.key!);
      return;
    }
    const { action, id, line, start, end } = el.dataset;
    const key = cardEl?.dataset.key ?? "";
    const here = this.cards.get(key);

    if (action === "undo") return this.popUndo();
    if (action === "fit") return this.fit();
    if (action === "focus") return this.selected && this.frame(this.selected);
    if (action === "zoom-reset") return this.zoomTo(1, this.viewCentre());
    if (action === "clear") {
      if (!this.cards.size) return;
      this.remember();
      this.cards.clear();
      this.arrows = [];
      this.selected = null;
      this.render();
      return this.changed();
    }
    if (!here) return;
    if (action === "open" && id) return this.openFrom(key, Number(line), id, (el.className.match(/k-(\w+)/)?.[1] ?? "calls") as LinkKind);
    if (action === "fold") return this.fold(here, Number(start), Number(end));
    if (action === "reroot" && id) return this.openCaller(key, id, Number(line), (el.dataset.kind ?? "calls") as LinkKind);
    if (action === "close") return this.close(key);
    if (action === "more" || action === "all" || action === "less") {
      // Paging: 25 more, everything, or back 25 (to the first 25 from
      // everything).
      this.remember();
      const total = Number(el.dataset.total);
      if (action === "more") here.limit += PAGE;
      else if (action === "all") here.limit = total;
      else here.limit = here.limit >= total ? PAGE : Math.max(PAGE, here.limit - PAGE);
      return this.rerender();
    }
    if (action === "callers") {
      here.allCallers = true;
      return this.rerender();
    }
    if (action === "source") {
      const n = here.block.node;
      if (!n.file) return;
      if (this.host?.openSource) return this.host.openSource(n.file, here.range[0]);
      // No editor: the file goes on the canvas, left of the card like a
      // caller, with an arrow from where the card's code starts in it.
      if (n.id !== n.file) return this.openCaller(key, n.file, here.range[0], "local");
    }
  }

  // Open `id` as a card to the right of `from`, with an arrow from `line`.
  // If it's already on the canvas, just add the arrow and go to it.
  private async openFrom(from: string, line: number, id: string, kind: LinkKind, fragment?: { block: CodeBlock; range: [number, number]; header: string }) {
    const key = fragment ? `${id}@${fragment.range[0]}-${fragment.range[1]}` : id;
    const existing = this.cards.has(key);
    const block = fragment ? fragment.block : existing ? null : await this.fetch(id);
    if (!existing && !block) return;
    this.remember();
    if (!existing) {
      const card = newCard(key, block!);
      if (fragment) Object.assign(card, { range: fragment.range, fragment: fragment.header });
      this.cards.set(key, card);
    }
    this.addArrow({ from, line, to: key, kind });
    this.render();
    if (!existing) this.placeBeside(key, from, line);
    this.goTo(key);
    this.changed();
  }

  // A caller goes to the left of the card, with an arrow from its line.
  private async openCaller(cardKey: string, callerId: string, line: number, kind: LinkKind) {
    const existing = this.cards.has(callerId);
    const block = existing ? null : await this.fetch(callerId);
    if (!existing && !block) return;
    this.remember();
    if (!existing) this.cards.set(callerId, newCard(callerId, block!));
    this.addArrow({ from: callerId, line, to: cardKey, kind });
    this.render();
    if (!existing) this.placeLeft(callerId, cardKey, line);
    this.goTo(callerId);
    this.changed();
  }

  private fold(card: Card, start: number, end: number) {
    const region = card.block.regions.find((r) => r.start === start && r.end === end);
    if (!region) return;
    if (inPlace(region)) {
      // Comments and imports: open (or close) in place; the card grows by
      // the lines revealed, so what was showing stays showing.
      this.remember();
      const lines = region.end - region.start;
      if (card.expanded.has(start)) {
        card.expanded.delete(start);
        card.limit = Math.max(PAGE, card.limit - lines);
      } else {
        card.expanded.add(start);
        card.limit += lines;
      }
      return this.rerender();
    }
    if (region.node) return this.openFrom(card.key, start, region.node.id, "calls");
    const header = card.block.lines.find((l) => l.n === start)?.text.trim() ?? "";
    return this.openFrom(card.key, start, card.block.node.id, "calls", { block: card.block, range: [region.start, region.end], header });
  }

  // Close a card, and every card that was only reachable through it.
  // × closes a card and every card only reachable through it; the Delete
  // key (`alone`) closes just the card, leaving what it opened in place.
  private close(key: string, alone = false) {
    this.remember();
    const gone = new Set([key]);
    for (let grew = !alone; grew; ) {
      grew = false;
      for (const k of this.cards.keys()) {
        if (gone.has(k)) continue;
        const incoming = this.arrows.filter((a) => a.to === k);
        if (incoming.length && incoming.every((a) => gone.has(a.from))) (gone.add(k), (grew = true));
      }
    }
    for (const k of gone) this.cards.delete(k);
    this.arrows = this.arrows.filter((a) => !gone.has(a.from) && !gone.has(a.to));
    if (this.selected && gone.has(this.selected)) this.selected = null;
    this.render();
    this.changed();
  }

  private addArrow(a: Arrow) {
    if (a.from === a.to) return;
    if (!this.arrows.some((b) => b.from === a.from && b.line === a.line && b.to === a.to)) this.arrows.push(a);
  }

  // --- undo ----------------------------------------------------------------

  private remember() {
    this.undo.push(this.snapshot());
    if (this.undo.length > UNDO_LIMIT) this.undo.shift();
  }

  private snapshot(): Snapshot {
    return {
      cards: [...this.cards.values()].map((c) => ({ ...c, expanded: new Set(c.expanded) })),
      arrows: this.arrows.map((a) => ({ ...a })),
      selected: this.selected,
    };
  }

  private popUndo() {
    const s = this.undo.pop();
    if (!s) return;
    this.cards = new Map(s.cards.map((c) => [c.key, c]));
    this.arrows = s.arrows;
    this.selected = s.selected;
    this.render();
    if (this.selected) this.select(this.selected);
    this.changed();
  }

  // --- selection -------------------------------------------------------------

  private select(key: string) {
    this.selected = key;
    this.root.querySelector<HTMLButtonElement>('[data-action="fit"]')!.disabled = !this.cards.size;
    this.root.querySelector<HTMLButtonElement>('[data-action="focus"]')!.disabled = false;
    this.root.querySelectorAll<HTMLElement>(".card").forEach((c) => c.classList.toggle("selected", c.dataset.key === key));
    const c = this.cards.get(key);
    const n = c?.block.node;
    if (!c || !n?.file) return void this.host?.highlight?.(null);
    this.host?.highlight?.({ node: n.id, file: n.file, range: c.range, marks: [...new Set(c.block.links.map((l) => l.line))] });
  }

  private goTo(key: string) {
    this.select(key);
    this.reveal(key);
  }

  // --- camera ------------------------------------------------------------------

  private canvas() {
    return this.root.querySelector<HTMLElement>(".canvas")!;
  }

  private applyCamera() {
    const { x, y, k } = this.camera;
    this.board().style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    const label = this.root.querySelector(".zoom");
    if (label) label.textContent = `${Math.round(k * 100)}%`;
  }

  private viewCentre() {
    const r = this.canvas().getBoundingClientRect();
    return { x: r.width / 2, y: r.height / 2 };
  }

  // Zoom to `k`, keeping the screen point `at` (relative to the canvas) still.
  private zoomTo(k: number, at: { x: number; y: number }) {
    const next = Math.min(ZOOM.max, Math.max(ZOOM.min, k));
    const c = this.camera;
    this.camera = { k: next, x: at.x - ((at.x - c.x) * next) / c.k, y: at.y - ((at.y - c.y) * next) / c.k };
    this.applyCamera();
    this.changed();
  }

  // Pan so a card is on screen (only if it isn't already).
  private reveal(key: string) {
    const el = this.cardEl(key);
    if (!el) return;
    const view = this.canvas().getBoundingClientRect();
    const { x, y, k } = this.camera;
    const left = x + el.offsetLeft * k;
    const top = y + el.offsetTop * k;
    const width = Math.min(el.offsetWidth * k, view.width - 80);
    const height = Math.min(el.offsetHeight * k, view.height - 80);
    let dx = 0;
    let dy = 0;
    if (left < 24) dx = 24 - left;
    else if (left + width > view.width - 24) dx = view.width - 24 - (left + width);
    if (top < 24) dy = 24 - top;
    else if (top + height > view.height - 24) dy = view.height - 24 - (top + height);
    if (!dx && !dy) return;
    this.camera = { ...this.camera, x: x + dx, y: y + dy };
    this.applyCamera();
    this.changed();
  }

  // Bring a card to the left of the view at a readable zoom: no closer than
  // 100%, further out only if it wouldn't fit otherwise. Vertically centred
  // when it fits, else from its top.
  // Zoom and pan so every card is in view (at most 100%).
  private fit() {
    const els = [...this.root.querySelectorAll<HTMLElement>(".card")];
    if (!els.length) return;
    const minX = Math.min(...els.map((e) => e.offsetLeft));
    const minY = Math.min(...els.map((e) => e.offsetTop));
    const maxX = Math.max(...els.map((e) => e.offsetLeft + e.offsetWidth));
    const maxY = Math.max(...els.map((e) => e.offsetTop + e.offsetHeight));
    const view = this.canvas().getBoundingClientRect();
    const k = Math.max(ZOOM.min, Math.min(1, (view.width - 48) / (maxX - minX), (view.height - 48) / (maxY - minY)));
    this.camera = { k, x: (view.width - (maxX - minX) * k) / 2 - minX * k, y: (view.height - (maxY - minY) * k) / 2 - minY * k };
    this.applyCamera();
    this.changed();
  }

  private frame(key: string) {
    const el = this.cardEl(key);
    if (!el) return;
    const view = this.canvas().getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const k = Math.max(ZOOM.min, Math.min(1, (view.width - 96) / w, (view.height - 48) / h));
    const y = h * k < view.height - 48 ? (view.height - h * k) / 2 : 24;
    this.camera = { k, x: 48 - el.offsetLeft * k, y: y - el.offsetTop * k };
    this.applyCamera();
    this.changed();
  }


  // --- saving ----------------------------------------------------------------

  private changed() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), 400);
  }

  private async save() {
    const data: SavedLayout = {
      v: 1,
      cards: [...this.cards.values()].map((c) => ({
        key: c.key,
        node: c.block.node.id,
        range: c.range,
        ...(c.fragment && { fragment: c.fragment }),
        expanded: [...c.expanded],
        limit: c.limit,
        ...(c.allCallers && { allCallers: true }),
        x: Math.round(c.x),
        y: Math.round(c.y),
      })),
      arrows: this.arrows,
      selected: this.selected,
      // Saved in canvas coordinates, independent of the board's padding origin.
      camera: {
        x: Math.round(this.camera.x + this.offset.x * this.camera.k),
        y: Math.round(this.camera.y + this.offset.y * this.camera.k),
        k: Math.round(this.camera.k * 1000) / 1000,
      },
    };
    await this.client?.call("saveLayout", { name: LAYOUT, data }).catch(() => {});
  }

  private async restore() {
    const saved = await this.client?.call<SavedLayout | null>("loadLayout", { name: LAYOUT }).catch(() => null);
    if (!saved || saved.v !== 1) return;
    const ids = [...new Set(saved.cards.map((c) => c.node))];
    const blocks = new Map((await Promise.all(ids.map(async (id) => [id, await this.fetch(id)] as const))).filter(([, b]) => b));
    for (const c of saved.cards) {
      const block = blocks.get(c.node);
      if (!block) continue; // gone since: renamed or deleted
      this.cards.set(c.key, {
        key: c.key,
        block,
        range: c.fragment ? c.range : fullRange(block),
        ...(c.fragment && { fragment: c.fragment }),
        expanded: new Set(c.expanded),
        limit: c.limit,
        ...(c.allCallers && { allCallers: true }),
        x: c.x,
        y: c.y,
      });
    }
    this.arrows = saved.arrows.filter((a) => this.cards.has(a.from) && this.cards.has(a.to));
    this.selected = saved.selected && this.cards.has(saved.selected) ? saved.selected : null;
    this.render();
    if (saved.camera) {
      const { x, y, k } = saved.camera;
      this.camera = { k, x: x - this.offset.x * k, y: y - this.offset.y * k };
      this.applyCamera();
    }
    if (this.selected) this.select(this.selected);
  }

  // After re-indexing, refetch every card (lines may have moved).
  private async reload() {
    const ids = [...new Set([...this.cards.values()].map((c) => c.block.node.id))];
    const blocks = new Map(await Promise.all(ids.map(async (id) => [id, await this.fetch(id)] as const)));
    for (const [key, c] of this.cards) {
      const block = blocks.get(c.block.node.id);
      if (!block) this.cards.delete(key);
      else Object.assign(c, { block, ...(c.fragment ? {} : { range: fullRange(block) }) });
    }
    this.arrows = this.arrows.filter((a) => this.cards.has(a.from) && this.cards.has(a.to));
    this.render();
  }

  // --- layout ----------------------------------------------------------------

  private board() {
    return this.root.querySelector<HTMLElement>(".board")!;
  }

  private cardEl(key: string) {
    return [...this.root.querySelectorAll<HTMLElement>(".card")].find((c) => c.dataset.key === key) ?? null;
  }

  // The visible row for a line: the line itself, or the fold or cap hiding it.
  private rowFor(cardEl: HTMLElement, line: number): HTMLElement | null {
    let best: HTMLElement | null = null;
    for (const row of cardEl.querySelectorAll<HTMLElement>(".ln")) if (Number(row.dataset.n) <= line) best = row;
    return best;
  }

  // New card to the right of `from`, level with the line that opened it.
  private placeBeside(key: string, from: string, line: number) {
    const a = this.cards.get(from)!;
    const aEl = this.cardEl(from)!;
    const row = this.rowFor(aEl, line);
    const header = this.cardEl(key)!.querySelector("header")!.offsetHeight;
    this.settle(key, a.x + aEl.offsetWidth + GAP, a.y + (row?.offsetTop ?? 0) - header / 2);
  }

  // A caller to the left of `to`, its calling line level with `to`'s top.
  private placeLeft(key: string, to: string, line: number) {
    const t = this.cards.get(to)!;
    const el = this.cardEl(key)!;
    const row = this.rowFor(el, line);
    this.settle(key, t.x - el.offsetWidth - GAP, t.y - (row?.offsetTop ?? 0) + 24);
  }

  // A new tree: below everything already open.
  private placeRoot(key: string) {
    const others = [...this.cards.values()].filter((c) => c.key !== key);
    if (!others.length) return this.settle(key, 0, 0);
    const bottom = Math.max(...others.map((c) => c.y + (this.cardEl(c.key)?.offsetHeight ?? 0)));
    this.settle(key, Math.min(...others.map((c) => c.x)), bottom + 56);
  }

  // Put a card at (x, y), moving it down until it overlaps nothing.
  private settle(key: string, x: number, y: number) {
    const card = this.cards.get(key)!;
    const el = this.cardEl(key)!;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    for (let i = 0; i < 200; i++) {
      const hit = [...this.cards.values()].find((o) => {
        if (o.key === key) return false;
        const oe = this.cardEl(o.key);
        if (!oe) return false;
        return x < o.x + oe.offsetWidth + 24 && x + w + 24 > o.x && y < o.y + oe.offsetHeight + 24 && y + h + 24 > o.y;
      });
      if (!hit) break;
      y = hit.y + (this.cardEl(hit.key)?.offsetHeight ?? 0) + 24;
    }
    card.x = x;
    card.y = y;
    this.position();
  }

  // Lay cards out at their positions, size the board to fit, draw arrows.
  private position() {
    const els = [...this.root.querySelectorAll<HTMLElement>(".card")];
    if (!els.length) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of els) {
      const c = this.cards.get(el.dataset.key!)!;
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + el.offsetWidth);
      maxY = Math.max(maxY, c.y + el.offsetHeight);
    }
    // When the board's origin shifts (a card went further left or up), move
    // the camera the other way so nothing jumps on screen.
    const next = { x: PAD - minX, y: PAD - minY };
    this.camera.x -= (next.x - this.offset.x) * this.camera.k;
    this.camera.y -= (next.y - this.offset.y) * this.camera.k;
    this.offset = next;
    this.applyCamera();
    for (const el of els) {
      const c = this.cards.get(el.dataset.key!)!;
      el.style.left = `${c.x + this.offset.x}px`;
      el.style.top = `${c.y + this.offset.y}px`;
    }
    const board = this.board();
    board.style.width = `${maxX - minX + PAD * 2 + 200}px`;
    board.style.height = `${maxY - minY + PAD * 2 + 200}px`;
    this.drawArrows();
  }

  private drawArrows() {
    const svg = this.root.querySelector<SVGSVGElement>(".arrows");
    if (!svg) return;
    const board = this.board();
    svg.setAttribute("width", String(board.offsetWidth));
    svg.setAttribute("height", String(board.offsetHeight));
    const paths: string[] = [];
    for (const a of this.arrows) {
      const fromEl = this.cardEl(a.from);
      const toEl = this.cardEl(a.to);
      if (!fromEl || !toEl) continue;
      const row = this.rowFor(fromEl, a.line);
      const y0 = fromEl.offsetTop + (row ? row.offsetTop + row.offsetHeight / 2 : 20);
      const header = toEl.querySelector("header")!.offsetHeight;
      const y1 = toEl.offsetTop + header / 2;
      // Leave from the side facing the target.
      const rightward = toEl.offsetLeft + toEl.offsetWidth / 2 >= fromEl.offsetLeft + fromEl.offsetWidth / 2;
      const x0 = rightward ? fromEl.offsetLeft + fromEl.offsetWidth : fromEl.offsetLeft;
      const x1 = rightward ? toEl.offsetLeft - 3 : toEl.offsetLeft + toEl.offsetWidth + 3;
      const bend = Math.max(40, Math.abs(x1 - x0) / 2) * (rightward ? 1 : -1);
      paths.push(wire(`M ${x0} ${y0} C ${x0 + bend} ${y0}, ${x1 - bend} ${y1}, ${x1} ${y1}`, a.kind));
    }
    svg.innerHTML = ARROW_DEFS + paths.join("");
  }

  // Drag a card by its header; arrows follow. A move can be undone.
  private setupDrag() {
    let drag: { key: string; el: HTMLElement; x: number; y: number; cx: number; cy: number; before: Snapshot; moved: boolean } | null = null;
    let pan: { x: number; y: number; cam: Camera } | null = null;
    const canvas = this.canvas();
    this.root.addEventListener("pointerdown", (event) => {
      const e = event as PointerEvent;
      const target = e.target as Element;
      // Empty canvas: drag to move around.
      if (!target.closest(".card") && target.closest(".canvas")) {
        e.preventDefault(); // no text selection while panning
        window.getSelection()?.removeAllRanges();
        pan = { x: e.clientX, y: e.clientY, cam: { ...this.camera } };
        canvas.setPointerCapture(e.pointerId);
        canvas.classList.add("panning");
        return;
      }
      const header = target.closest("header");
      if (!header || target.closest("button")) return;
      e.preventDefault(); // no text selection while moving a card
      const el = header.closest<HTMLElement>(".card")!;
      const c = this.cards.get(el.dataset.key!)!;
      canvas.classList.add("moving");
      drag = { key: c.key, el, x: e.clientX, y: e.clientY, cx: c.x, cy: c.y, before: this.snapshot(), moved: false };
      el.setPointerCapture(e.pointerId);
    });
    this.root.addEventListener("pointermove", (event) => {
      const e = event as PointerEvent;
      if (pan) {
        this.camera = { ...pan.cam, x: pan.cam.x + e.clientX - pan.x, y: pan.cam.y + e.clientY - pan.y };
        return this.applyCamera();
      }
      if (!drag) return;
      // Screen pixels to board pixels.
      const dx = (e.clientX - drag.x) / this.camera.k;
      const dy = (e.clientY - drag.y) / this.camera.k;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      drag.el.classList.add("dragging");
      const c = this.cards.get(drag.key)!;
      c.x = drag.cx + dx;
      c.y = drag.cy + dy;
      drag.el.style.left = `${c.x + this.offset.x}px`;
      drag.el.style.top = `${c.y + this.offset.y}px`;
      this.drawArrows();
    });
    const end = () => {
      if (pan) {
        pan = null;
        canvas.classList.remove("panning");
        this.changed();
      }
      if (!drag) return;
      canvas.classList.remove("moving");
      drag.el.classList.remove("dragging");
      if (drag.moved) {
        this.undo.push(drag.before);
        this.position();
        this.changed();
      } else this.select(drag.key);
      drag = null;
    };
    this.root.addEventListener("pointerup", end);
    this.root.addEventListener("pointercancel", end);
    // Scroll to move around; pinch (which arrives as ctrl + wheel) or
    // ⌘-scroll to zoom around the pointer.
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          const r = canvas.getBoundingClientRect();
          const step = e.ctrlKey ? 0.01 : 0.0015; // pinches report small deltas
          return this.zoomTo(this.camera.k * Math.exp(-e.deltaY * step), { x: e.clientX - r.left, y: e.clientY - r.top });
        }
        const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
        // Shift turns a plain mouse wheel sideways.
        const [dx, dy] = e.shiftKey && !e.deltaX ? [e.deltaY, 0] : [e.deltaX, e.deltaY];
        this.camera = { ...this.camera, x: this.camera.x - dx * unit, y: this.camera.y - dy * unit };
        this.applyCamera();
        this.changed();
      },
      { passive: false },
    );
  }

  // --- rendering -------------------------------------------------------------

  private render() {
    const board = this.board();
    this.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.disabled = !this.undo.length;
    this.root.querySelector<HTMLButtonElement>('[data-action="focus"]')!.disabled = !this.selected || !this.cards.has(this.selected);
    this.root.querySelector(".count")!.textContent = this.cards.size ? `${this.cards.size} card${this.cards.size === 1 ? "" : "s"}` : "";
    if (!this.cards.size) {
      board.innerHTML = `<div class="hint">Pick an entry point, a file or a symbol to start reading from it.</div>`;
      board.style.width = board.style.height = "";
      board.style.transform = "";
      this.dispatchEvent(new CustomEvent(TITLE_EVENT, { detail: "flow", bubbles: true, composed: true }));
      return;
    }
    board.innerHTML = [...this.cards.values()].map((c) => this.cardHtml(c)).join("") + `<svg class="arrows" aria-hidden="true">${ARROW_DEFS}</svg>`;
    this.position();
    const first = this.cards.values().next().value!;
    this.dispatchEvent(new CustomEvent(TITLE_EVENT, { detail: `flow · ${first.block.node.name}`, bubbles: true, composed: true }));
  }

  private rerender() {
    this.render();
    if (this.selected) this.select(this.selected);
    this.changed();
  }

  private cardHtml(c: Card): string {
    const b = c.block;
    const n = b.node;
    const out = this.arrows.filter((a) => a.from === c.key);
    const isActive = (line: number, to: string) => out.some((a) => a.line === line && a.to === to);

    const header = c.fragment ? `<div class="callers">in <span class="mono">${escape(blockName(b))}</span></div>` : this.callersHtml(c);

    // Folds: the outermost regions inside this card, one level deep.
    const folds = topFolds(c);
    const hidden = new Set<number>();
    for (const f of folds) for (let k = f.start + 1; k <= f.end; k++) hidden.add(k);
    const foldAt = new Map(folds.map((f) => [f.start, f]));
    // Folds opened in place keep a button on their header line to close them.
    const openedAt = new Map(b.regions.filter((r) => c.expanded.has(r.start) && inPlace(r) && r.start >= c.range[0] && r.end <= c.range[1]).map((r) => [r.start, r]));

    const linksByLine = new Map<number, BlockLink[]>();
    for (const l of b.links) linksByLine.set(l.line, [...(linksByLine.get(l.line) ?? []), l]);
    const first = b.lines[0]?.n ?? 1;
    const html = this.host?.syntax?.(b.lines.map((l) => l.text).join("\n"), n.file ?? "") ?? b.lines.map((l) => escape(l.text));

    const chip = (link: BlockLink, line: number, rolled: boolean) =>
      `<button class="chip k-${link.kind}${rolled ? " rolled" : ""}${isActive(line, link.target.id) ? " active" : ""}" data-action="open" data-id="${escape(link.target.id)}" data-line="${line}" title="${escape(link.target.id)}${rolled ? " (inside the fold)" : ""}">${escape(chipText(link))}</button>`;

    const rows: string[] = [];
    let shownLines = 0;
    let remaining = 0;
    // Show up to the limit, and always down to lines that arrows leave from.
    const mustReach = Math.max(0, ...out.map((a) => a.line));
    for (let line = c.range[0]; line <= c.range[1]; line++) {
      if (hidden.has(line)) continue;
      if (shownLines >= c.limit && line > mustReach) {
        remaining++;
        continue;
      }
      shownLines++;
      const own = linksByLine.get(line) ?? [];
      const fold = foldAt.get(line);
      let foldHtml = "";
      const opened = openedAt.get(line);
      if (opened && !fold) {
        foldHtml = `<button class="fold" data-action="fold" data-start="${opened.start}" data-end="${opened.end}" title="Fold these lines again">⌃ collapse ${opened.end - opened.start} lines</button>`;
      }
      const rolled: BlockLink[] = [];
      if (fold) {
        const count = fold.end - fold.start;
        const small = inPlace(fold); // opens in place rather than as a card
        const foldKey = fold.node ? fold.node.id : `${n.id}@${fold.start}-${fold.end}`;
        const active = !small && isActive(line, foldKey);
        foldHtml = `<button class="fold${active ? " active" : ""}" data-action="fold" data-start="${fold.start}" data-end="${fold.end}" title="${small ? "Show these lines here" : "Open as a card"}">⋯ ${count} lines${small ? "" : " →"}</button>`;
        // An anonymous fold carries the chips from inside it; a named one
        // doesn't (its own card shows them).
        if (!fold.node) {
          const seen = new Set(own.map((l) => l.target.id));
          for (let k = fold.start + 1; k <= fold.end; k++) for (const l of linksByLine.get(k) ?? []) if (!seen.has(l.target.id)) (seen.add(l.target.id), rolled.push(l));
        }
      }
      const more =
        rolled.length > MAX_ROLLED && fold
          ? `<button class="chip rolled" data-action="fold" data-start="${fold.start}" data-end="${fold.end}" title="Open the fold to see them">+${rolled.length - MAX_ROLLED} inside</button>`
          : "";
      const chips = [...own.map((l) => chip(l, line, false)), ...rolled.slice(0, MAX_ROLLED).map((l) => chip(l, line, true)), more].join("");
      const classes = ["ln", own.length || rolled.length ? "linked" : "", out.some((a) => a.line === line) ? "active" : ""].filter(Boolean).join(" ");
      rows.push(`<div class="${classes}" data-n="${line}"><span class="no">${line}</span><span class="src">${html[line - first] || " "}${foldHtml}</span>${chips ? `<span class="chips">${chips}</span>` : ""}</div>`);
    }
    const total = shownLines + remaining;
    const paging = [
      remaining ? `<button class="more-lines" data-action="more">show ${Math.min(PAGE, remaining)} more</button>` : "",
      remaining > PAGE ? `<button class="more-lines" data-action="all" data-total="${total}">show all ${remaining}</button>` : "",
      c.limit > PAGE && shownLines > PAGE ? `<button class="more-lines" data-action="less" data-total="${total}">⌃ collapse</button>` : "",
    ].join("");
    if (paging) rows.push(`<div class="paging">${paging}</div>`);

    const span = c.range[1] - c.range[0] + 1;
    return `<section class="card${c.key === this.selected ? " selected" : ""}" data-key="${escape(c.key)}" aria-label="${escape(cardName(c))}">
      <header>
        <button class="close" data-action="close" aria-label="Close this card" title="Close (and what only it opened)">×</button>
        ${header}
        <button class="title" data-action="source" title="Open the source">${titleHtml(c)}</button>
        <span class="meta">${escape(n.file ?? "")}:${c.range[0]}${n.runtime ? ` · ${escape(n.runtime)}` : ""} · ${span} line${span === 1 ? "" : "s"}</span>
      </header>
      <div class="code">${rows.join("")}</div>
    </section>`;
  }

  // What leads to a card: callers, IPC senders, writers, users. Ones already
  // on the canvas with an arrow here are marked.
  private callersHtml(c: Card): string {
    const b = c.block;
    if (!b.callers.length) {
      if (b.outline) return "";
      return `<div class="callers">${b.trigger ? `runs on <span class="mono">${escape(b.trigger)}</span>` : "nothing in the project calls this"}</div>`;
    }
    const shown = c.allCallers ? b.callers : b.callers.slice(0, MAX_CALLERS);
    const allCalls = b.callers.every((cl) => cl.kind === "calls" && !cl.label);
    // Same name from different places (two preloads exposing one API): add the file.
    const nameCount = new Map<string, number>();
    for (const cl of b.callers) nameCount.set(cl.node.name, (nameCount.get(cl.node.name) ?? 0) + 1);
    const nameOf = (cl: CodeBlock["callers"][number]) => (nameCount.get(cl.node.name)! > 1 ? `${cl.node.name} (${cl.node.file?.split("/").pop()})` : cl.node.name);
    const open = (id: string) => this.arrows.some((a) => a.from === id && a.to === c.key);
    return `<div class="callers${c.allCallers ? " all" : ""}">${allCalls ? "called by" : "used by"} ${shown
      .map(
        (cl) =>
          `<button class="caller${open(cl.node.id) ? " open" : ""}" data-action="reroot" data-kind="${cl.kind}" data-id="${escape(cl.node.id)}" data-line="${cl.line}" title="${escape(cl.node.id)}">${escape(nameOf(cl))}${
            cl.kind === "channel" ? ` ⇢ ${escape(cl.label ?? "")}` : cl.label ? ` · ${escape(cl.label)}` : ""
          }</button>`,
      )
      .join("")}${b.callers.length > shown.length ? `<button class="caller more" data-action="callers">+${b.callers.length - shown.length} more</button>` : ""}</div>`;
  }
}

function newCard(key: string, block: CodeBlock): Card {
  return { key, block, range: fullRange(block), expanded: new Set(), limit: PAGE, x: 0, y: 0 };
}

function fullRange(b: CodeBlock): [number, number] {
  return [b.lines[0]?.n ?? 1, b.lines.at(-1)?.n ?? 1];
}

// The regions that fold in a card: inside its range, not its own root (the
// region spanning the whole card), outermost first. Small regions never fold,
// and nor do comment/import folds the reader opened; regions inside those
// get their turn instead.
function topFolds(c: Card): BlockRegion[] {
  const [from, to] = c.range;
  const folds: BlockRegion[] = [];
  for (const r of c.block.regions) {
    if (r.start < from || r.end > to) continue;
    if (r.start <= from && r.end >= to) continue; // the card itself
    if (folds.some((f) => r.start >= f.start && r.end <= f.end)) continue; // inside a fold
    if (r.end - r.start <= SMALL) continue;
    if (c.expanded.has(r.start) && inPlace(r)) continue;
    folds.push(r);
  }
  return folds;
}

function chipText(l: BlockLink): string {
  if (l.kind === "channel") return `ipc ⇢ ${l.target.name}`;
  if (l.kind === "state") return `${l.label === "read by" ? "read by" : "writes"} ${l.target.name}`;
  if (l.label === "passes") return `passes ${l.target.name}`;
  return `→ ${l.target.name}`;
}

function blockName(b: CodeBlock): string {
  return b.node.kind === "callable" ? `${b.node.name}()` : b.node.name;
}

function shorten(text: string, max = 36): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cardName(c: Card): string {
  return c.fragment ? `${blockName(c.block)} › ${shorten(c.fragment, 24)}` : blockName(c.block);
}

function titleHtml(c: Card): string {
  if (!c.fragment) return escape(blockName(c.block));
  return `${escape(blockName(c.block))} <span class="part">› ${escape(shorten(c.fragment))}</span>`;
}
