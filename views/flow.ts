import type { BlockLink, CodeBlock, LinkKind } from "../src/query/types.js";
import type { LodeClient } from "./client.js";
import { TITLE_EVENT, type LodeHost } from "./host.js";
import { ARROW_DEFS, BASE_CSS, escape, wire } from "./theme.js";

const SHORT_BODY = 26; // bodies up to this many lines show in full
const MAX_CALLERS = 4;

interface Column {
  block: CodeBlock;
  fromLine?: number; // the line in the previous column that opened it
  unfolded: Set<number>; // folds the reader opened (by first hidden line)
  showAll: boolean;
}

const CSS = `
:host { display: flex; flex-direction: column; overflow: hidden; }
.canvas { position: relative; flex: 1; min-height: 0; overflow: auto; }
.row { position: relative; display: flex; align-items: flex-start; gap: 72px; padding: 24px 32px 120px; width: max-content; }
.block { position: relative; z-index: 1; width: 600px; background: var(--lode-surface); border: 1px solid var(--lode-border); border-radius: 10px; box-shadow: 0 1px 2px rgba(23,22,20,.04); }
.block.root { border-color: var(--lode-fg); }
.block.selected { border-color: var(--lode-local); box-shadow: 0 0 0 1px var(--lode-local), 0 1px 2px rgba(23,22,20,.04); }
.ln.hovered { background: rgba(226, 99, 47, .16); box-shadow: inset 2px 0 0 var(--lode-channel); }
.block header { padding: 10px 14px 8px; border-bottom: 1px solid var(--lode-border); display: flex; flex-direction: column; gap: 3px; }
.title { font: 600 13px var(--lode-mono); }
.title:hover { text-decoration: underline; }
.meta { font-size: 11.5px; color: var(--lode-faint); }
.callers { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 11.5px; color: var(--lode-faint); margin-bottom: 4px; }
.caller { font: 11.5px var(--lode-mono); color: var(--lode-muted); padding: 1px 6px; border: 1px dashed var(--lode-outline); border-radius: 5px; }
.caller:hover { border-style: solid; color: var(--lode-fg); }
.code { padding: 6px 0 8px; font: 12px/20px var(--lode-mono); overflow-x: auto; }
.ln { display: flex; align-items: flex-start; padding-right: 8px; }
.ln .no { flex: none; width: 46px; padding-right: 12px; text-align: right; color: #a3a09a; user-select: none; }
.ln .src { white-space: pre; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ln.linked .no { color: var(--lode-local); }
.ln.active { background: rgba(47, 95, 168, .08); box-shadow: inset 2px 0 0 var(--lode-local); }
.chips { flex: none; width: 150px; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding-left: 12px; }
.chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.chip { font: 10.5px/18px var(--lode-mono); padding: 0 6px; border-radius: 4px; border: 1px solid transparent; white-space: nowrap; }
.chip:hover, .chip.active { border-color: currentColor; }
.chip.k-calls { color: var(--lode-local); background: rgba(47, 95, 168, .07); }
.chip.k-channel { color: var(--lode-channel-text); background: rgba(226, 99, 47, .09); }
.chip.k-state { color: var(--lode-state); background: rgba(138, 59, 107, .07); }
.fold { display: block; width: 100%; padding: 1px 0 1px 58px; font: 11px/18px var(--lode-mono); color: var(--lode-faint); text-align: left; }
.fold:hover { background: var(--lode-sunken); color: var(--lode-fg); }
.arrows { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 2; }
.hint { padding: 32px; color: var(--lode-muted); }
`;

// <lode-flow node="file#symbol">: code as nodes. Blocks of real code in
// columns, left to right; a line that leads somewhere (a call, IPC, shared
// state) has a chip, and clicking it opens that code in the next column with
// an arrow from the exact line. The first block's callers re-root it upstream.
export class LodeFlow extends HTMLElement {
  static observedAttributes = ["node"];
  client?: LodeClient;
  host?: LodeHost;

  private readonly root = this.attachShadow({ mode: "open" });
  private columns: Column[] = [];
  private selected = 0; // the block the host's summary (focus) follows
  private rootHistory: Column[][] = [];
  private unsubscribe?: () => void;
  private resize = new ResizeObserver(() => this.layout());

  connectedCallback() {
    this.root.innerHTML = `<style>${BASE_CSS}${CSS}${this.host?.syntaxCss ?? ""}</style>
      <div class="toolbar">
        <button class="crumb" data-action="back" aria-label="Back">←</button>
        <span class="path"></span>
        <span class="spacer"></span>
        <span class="faint">click a chip to follow it →</span>
      </div>
      <div class="canvas"><div class="row"></div></div>`;
    this.root.addEventListener("click", (e) => this.onClick(e));
    this.unsubscribe = this.client?.onChanged(() => this.reload());
    this.resize.observe(this);
    void this.start();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    this.resize.disconnect();
  }

  attributeChangedCallback(_n: string, before: string | null, after: string | null) {
    if (before !== after && this.isConnected) void this.start();
  }

  private async fetch(id: string) {
    return (await this.client?.call<CodeBlock | null>("block", { id })) ?? null;
  }

  private async start() {
    const id = this.getAttribute("node");
    if (!id) return this.render();
    const block = await this.fetch(id);
    if (block) {
      if (this.columns.length) this.rootHistory.push(this.columns);
      this.columns = [{ block, unfolded: new Set(), showAll: false }];
    }
    this.render();
    this.select(0);
  }

  // Select a block: the host's summary view follows it.
  private select(i: number) {
    this.selected = Math.max(0, Math.min(i, this.columns.length - 1));
    this.root.querySelectorAll(".block").forEach((b) => b.classList.toggle("selected", Number((b as HTMLElement).dataset.col) === this.selected));
    const b = this.columns[this.selected]?.block;
    const n = b?.node;
    if (!n?.file || !n.line) return void this.host?.highlight?.(null);
    this.host?.highlight?.({ node: n.id, file: n.file, range: [n.line, n.endLine ?? n.line], marks: [...new Set(b.links.map((l) => l.line))] });
  }

  // Show `id`, reached from the open block `from`: as the next column from
  // the line that leads to it, as a new root when it calls the first block,
  // by going back to it if it's already open, or else as a fresh root.
  async reveal(id: string, from: string) {
    const existing = this.columns.findIndex((c) => c.block.node.id === id);
    if (existing >= 0) {
      this.columns = this.columns.slice(0, Math.max(existing + 1, this.columns.findIndex((c) => c.block.node.id === from) + 1));
      this.render();
      this.select(existing);
      return this.scrollToColumn(existing);
    }
    const block = await this.fetch(id);
    if (!block) return;
    const col = this.columns.findIndex((c) => c.block.node.id === from);
    const link = col >= 0 ? this.columns[col].block.links.find((l) => l.target.id === id) : undefined;
    const caller = col === 0 ? this.columns[0].block.callers.find((c) => c.node.id === id) : undefined;
    if (link) {
      this.columns = [...this.columns.slice(0, col + 1), { block, fromLine: link.line, unfolded: new Set(), showAll: false }];
      this.render();
      this.select(this.columns.length - 1);
    } else if (caller) {
      this.rootHistory.push(this.columns);
      this.columns = [{ block, unfolded: new Set(), showAll: false }, { ...this.columns[0], fromLine: caller.line }, ...this.columns.slice(1)];
      this.render();
      this.select(0);
    } else {
      if (this.columns.length) this.rootHistory.push(this.columns);
      this.columns = [{ block, unfolded: new Set(), showAll: false }];
      this.render();
      this.select(0);
    }
    this.scrollToColumn(this.selected);
  }

  // Point at a line in an open block (e.g. while the summary is hovered).
  // Marked only; nothing scrolls.
  mark(id: string, line?: number) {
    this.root.querySelectorAll(".ln.hovered").forEach((r) => r.classList.remove("hovered"));
    if (!line) return;
    const col = this.columns.findIndex((c) => c.block.node.id === id);
    this.root.querySelector(`.block[data-col="${col}"] .ln[data-n="${line}"]`)?.classList.add("hovered");
  }

  // After re-indexing, refetch every open block (lines may have moved).
  private async reload() {
    const blocks = await Promise.all(this.columns.map((c) => this.fetch(c.block.node.id)));
    this.columns = this.columns.flatMap((c, i) => (blocks[i] ? [{ ...c, block: blocks[i]! }] : []));
    this.render();
  }

  private async onClick(event: Event) {
    const el = (event.target as Element).closest<HTMLElement>("[data-action]");
    if (!el) {
      // A click anywhere else in a block selects it.
      const block = (event.target as Element).closest<HTMLElement>(".block");
      if (block && !String(window.getSelection() ?? "")) this.select(Number(block.dataset.col));
      return;
    }
    const { action, col, id, line, gap } = el.dataset;
    const c = Number(col);
    if (action === "open" && id) {
      const block = await this.fetch(id);
      if (!block) return;
      this.columns = [...this.columns.slice(0, c + 1), { block, fromLine: Number(line), unfolded: new Set(), showAll: false }];
      this.render();
      this.select(this.columns.length - 1);
      this.scrollToColumn(this.columns.length - 1);
    } else if (action === "reroot" && id) {
      const block = await this.fetch(id);
      if (!block) return;
      this.rootHistory.push(this.columns);
      const [first, ...rest] = this.columns;
      this.columns = [{ block, unfolded: new Set(), showAll: false }, { ...first, fromLine: Number(line) }, ...rest];
      this.render();
      this.select(0);
      this.scrollToColumn(0);
    } else if (action === "unfold") {
      this.columns[c].unfolded.add(Number(gap));
      this.render();
    } else if (action === "all") {
      this.columns[c].showAll = !this.columns[c].showAll;
      this.render();
    } else if (action === "back") {
      if (this.columns.length > 1) this.columns = this.columns.slice(0, -1);
      else if (this.rootHistory.length) this.columns = this.rootHistory.pop()!;
      this.render();
      this.select(this.columns.length - 1);
    } else if (action === "source") {
      const b = this.columns[c]?.block.node;
      if (b?.file) this.host?.openSource(b.file, b.line);
    } else if (action === "crumb") {
      this.columns = this.columns.slice(0, c + 1);
      this.render();
      this.select(c);
      this.scrollToColumn(c);
    }
  }

  private render() {
    const row = this.root.querySelector(".row")!;
    if (!this.columns.length) {
      row.innerHTML = `<div class="hint">Pick a file or search for a symbol to start reading from it.</div>`;
      this.root.querySelector(".path")!.innerHTML = "";
      return;
    }
    row.innerHTML = this.columns.map((c, i) => this.blockHtml(c, i)).join("") + `<svg class="arrows" aria-hidden="true">${ARROW_DEFS}</svg>`;
    this.root.querySelector(".path")!.innerHTML = this.columns
      .map((c, i) => {
        const name = escape(blockName(c.block));
        return i === this.columns.length - 1 ? `<span class="crumb current mono">${name}</span>` : `<button class="crumb mono" data-action="crumb" data-col="${i}">${name}</button>`;
      })
      .join(`<span class="sep">→</span>`);
    this.root.querySelector<HTMLButtonElement>('[data-action="back"]')!.disabled = this.columns.length < 2 && !this.rootHistory.length;
    this.dispatchEvent(new CustomEvent(TITLE_EVENT, { detail: `flow · ${this.columns[0].block.node.name}`, bubbles: true, composed: true }));
    requestAnimationFrame(() => this.layout());
  }

  private blockHtml(c: Column, i: number): string {
    const b = c.block;
    const n = b.node;
    const next = this.columns[i + 1];
    const activeLine = next?.fromLine;
    const activeTarget = next?.block.node.id;

    const callers =
      i === 0 && b.callers.length
        ? `<div class="callers">called by ${b.callers
            .slice(0, MAX_CALLERS)
            .map((cl) => `<button class="caller" data-action="reroot" data-id="${escape(cl.node.id)}" data-line="${cl.line}" title="${escape(cl.node.id)}">${escape(cl.node.name)}${cl.label ? ` ⇢ ${escape(cl.label)}` : ""}</button>`)
            .join("")}${b.callers.length > MAX_CALLERS ? ` +${b.callers.length - MAX_CALLERS}` : ""}</div>`
        : "";

    const linksByLine = new Map<number, BlockLink[]>();
    for (const l of b.links) linksByLine.set(l.line, [...(linksByLine.get(l.line) ?? []), l]);
    const html = this.host?.syntax?.(b.lines.map((l) => l.text).join("\n"), n.file ?? "") ?? b.lines.map((l) => escape(l.text));

    const rows: string[] = [];
    const shown = visibleLines(c, linksByLine);
    let hiddenFrom: number | null = null;
    const flushFold = (upTo: number) => {
      if (hiddenFrom === null) return;
      const count = upTo - hiddenFrom;
      rows.push(`<button class="fold" data-action="unfold" data-col="${i}" data-gap="${hiddenFrom}">⋯ ${count} line${count === 1 ? "" : "s"}</button>`);
      hiddenFrom = null;
    };
    b.lines.forEach((l, k) => {
      if (!shown.has(l.n)) {
        hiddenFrom ??= l.n;
        return;
      }
      flushFold(l.n);
      const links = linksByLine.get(l.n) ?? [];
      const chips = links
        .map((link) => `<button class="chip k-${link.kind}${l.n === activeLine && link.target.id === activeTarget ? " active" : ""}" data-action="open" data-col="${i}" data-id="${escape(link.target.id)}" data-line="${l.n}" title="${escape(link.target.id)}">${escape(chipText(link))}</button>`)
        .join("");
      const classes = ["ln", links.length ? "linked" : "", l.n === activeLine ? "active" : ""].filter(Boolean).join(" ");
      rows.push(`<div class="${classes}" data-n="${l.n}"><span class="no">${l.n}</span><span class="src" title="${escape(l.text.trim())}">${html[k] || " "}</span><span class="chips">${chips}</span></div>`);
    });
    flushFold((b.lines.at(-1)?.n ?? 0) + 1);

    const long = b.lines.length > SHORT_BODY && !b.outline;
    return `<section class="block${i === 0 ? " root" : ""}${i === this.selected ? " selected" : ""}" data-col="${i}" aria-label="${escape(n.name)}">
      <header>
        ${callers}
        <button class="title" data-action="source" data-col="${i}" title="Open in the editor">${escape(blockName(b))}</button>
        <span class="meta">${escape(n.file ?? "")}:${n.line ?? ""}${n.runtime ? ` · ${escape(n.runtime)}` : ""}${b.outline ? ` · ${b.lines.length} members` : ` · ${b.lines.length} lines`}${
          long ? ` · <button class="crumb" data-action="all" data-col="${i}">${c.showAll ? "fold" : "show all"}</button>` : ""
        }</span>
      </header>
      <div class="code">${rows.join("")}</div>
    </section>`;
  }

  // Line each block up with the line that opened it, then draw the arrows.
  private layout() {
    const row = this.root.querySelector<HTMLElement>(".row");
    const svg = this.root.querySelector<SVGSVGElement>(".arrows");
    if (!row || !svg) return;
    const blocks = [...row.querySelectorAll<HTMLElement>(".block")];
    blocks.forEach((b) => (b.style.marginTop = "0px"));
    const origin = row.getBoundingClientRect();
    const paths: string[] = [];
    for (let i = 1; i < blocks.length; i++) {
      const from = this.columns[i].fromLine;
      const source = blocks[i - 1].querySelector<HTMLElement>(`.ln[data-n="${from}"]`);
      if (!source) continue;
      const s = source.getBoundingClientRect();
      const header = blocks[i].querySelector("header")!.getBoundingClientRect().height;
      // Put the new block's title level with the source line.
      blocks[i].style.marginTop = `${Math.max(0, s.top - origin.top - 24 - header / 2)}px`;
      const t = blocks[i].getBoundingClientRect();
      const chip = source.querySelector<HTMLElement>(".chip.active") ?? source;
      const c = chip.getBoundingClientRect();
      const x0 = blocks[i - 1].getBoundingClientRect().right - origin.left;
      const y0 = c.top + c.height / 2 - origin.top;
      const x1 = t.left - origin.left - 3;
      const y1 = t.top + header / 2 - origin.top;
      const kind = (chip.className.match(/k-(\w+)/)?.[1] ?? "calls") as LinkKind;
      paths.push(wire(`M ${x0} ${y0} C ${x0 + 48} ${y0}, ${x1 - 48} ${y1}, ${x1} ${y1}`, kind));
    }
    svg.innerHTML = ARROW_DEFS + paths.join("");
  }

  private scrollToColumn(i: number) {
    requestAnimationFrame(() => this.root.querySelector(`.block[data-col="${i}"]`)?.scrollIntoView({ inline: "nearest", block: "nearest" }));
  }
}

// Which lines a block shows: short bodies in full (minus long comment runs),
// long ones folded down to the lines that lead somewhere, with context.
function visibleLines(c: Column, linksByLine: Map<number, BlockLink[]>): Set<number> {
  const lines = c.block.lines;
  const shown = new Set<number>();
  if (c.block.outline || c.showAll) {
    for (const l of lines) shown.add(l.n);
    return shown;
  }
  const first = lines[0]?.n ?? 0;
  const last = lines.at(-1)?.n ?? 0;
  if (lines.length <= SHORT_BODY) {
    for (const l of lines) if (!isComment(l.text)) shown.add(l.n);
    // Fold only runs of 3+ comment lines; keep short ones.
    let run: number[] = [];
    const flush = () => (run.length < 3 && run.forEach((n) => shown.add(n)), (run = []));
    for (const l of lines) isComment(l.text) ? run.push(l.n) : flush();
    flush();
  } else {
    shown.add(first);
    shown.add(last);
    for (const n of linksByLine.keys()) for (const k of [n - 1, n, n + 1]) if (k >= first && k <= last) shown.add(k);
  }
  // Folds the reader opened.
  for (const start of c.unfolded) {
    for (let n = start; n <= last && !shown.has(n); n++) shown.add(n);
  }
  return shown;
}

function isComment(text: string): boolean {
  const t = text.trim();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
}

function chipText(l: BlockLink): string {
  if (l.kind === "channel") return `ipc ⇢ ${l.target.name}`;
  if (l.kind === "state") return `${l.label === "read by" ? "read by" : "writes"} ${l.target.name}`;
  return l.label === "open" ? l.target.name : `→ ${l.target.name}`;
}

function blockName(b: CodeBlock): string {
  return b.node.kind === "callable" ? `${b.node.name}()` : b.node.name;
}
