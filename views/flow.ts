import type { BlockLink, BlockRegion, CodeBlock, LinkKind } from "../src/query/types.js";
import type { LodeClient } from "./client.js";
import { TITLE_EVENT, type LodeHost } from "./host.js";
import { ARROW_DEFS, BASE_CSS, escape, wire } from "./theme.js";

const MAX_CALLERS = 4;
const MAX_ROLLED = 3; // chips carried up from inside a fold before "+N inside"
const SMALL = 3; // regions hiding this many lines or fewer never fold
const PAGE = 25; // lines a card shows before "show 25 more"

// Comments and imports open in place: a card of them is just a detour.
const inPlace = (r: BlockRegion) => r.kind === "comment" || r.kind === "imports";

// A card: a node's code, or a range inside it (a fragment), shown one level
// deep: nested regions fold to their header line.
interface Column {
  block: CodeBlock;
  range: [number, number];
  fragment?: string; // the fragment's header text, for its title
  fromLine?: number; // the line in the previous card that opened it
  expanded: Set<number>; // comment/import folds opened in place (by header line)
  limit: number; // lines shown before "show more"
  allCallers?: boolean;
}

const CSS = `
:host { display: flex; flex-direction: column; overflow: hidden; }
.canvas { position: relative; flex: 1; min-height: 0; overflow: auto; }
.row { position: relative; display: flex; align-items: flex-start; gap: 72px; padding: 24px 32px 120px; width: max-content; }
.block { position: relative; z-index: 1; width: max-content; min-width: 480px; max-width: 760px; background: var(--lode-surface); border: 1px solid var(--lode-border); border-radius: 10px; box-shadow: 0 1px 2px rgba(23,22,20,.04); }
.block.root { border-color: var(--lode-fg); }
.block.selected { border-color: var(--lode-local); box-shadow: 0 0 0 1px var(--lode-local), 0 1px 2px rgba(23,22,20,.04); }
.block header { padding: 10px 14px 8px; border-bottom: 1px solid var(--lode-border); display: flex; flex-direction: column; gap: 3px; }
.title { font: 600 13px var(--lode-mono); }
.title:hover { text-decoration: underline; }
.title .part { font-weight: 450; color: var(--lode-muted); }
.meta { font-size: 11.5px; color: var(--lode-faint); }
.callers { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 11.5px; color: var(--lode-faint); margin-bottom: 4px; }
.caller { font: 11.5px var(--lode-mono); color: var(--lode-muted); padding: 1px 6px; border: 1px dashed var(--lode-outline); border-radius: 5px; }
.caller:hover { border-style: solid; color: var(--lode-fg); }
.callers.all { max-height: 92px; overflow-y: auto; padding-right: 4px; }
.caller.more { border-style: solid; border-color: var(--lode-border); background: var(--lode-sunken); font-family: var(--lode-font); }
.caller.open { border-style: solid; border-color: var(--lode-local); color: var(--lode-local); }
.code { padding: 6px 0 8px; font: 12px/20px var(--lode-mono); }
.ln { display: flex; align-items: flex-start; padding-right: 8px; }
.ln .no { flex: none; width: 46px; padding-right: 12px; text-align: right; color: #a3a09a; user-select: none; }
/* Long lines wrap (hanging under their indent) rather than being cut off. */
.ln .src { white-space: pre-wrap; overflow-wrap: anywhere; flex: 1; min-width: 0; }
.ln.linked .no { color: var(--lode-local); }
.ln.active { background: rgba(47, 95, 168, .08); box-shadow: inset 2px 0 0 var(--lode-local); }
.fold { margin-left: 6px; padding: 0 6px; font: 11px/18px var(--lode-mono); color: var(--lode-muted); background: var(--lode-sunken); border: 1px solid transparent; border-radius: 4px; white-space: nowrap; }
.fold:hover, .fold.active { border-color: var(--lode-outline); color: var(--lode-fg); }
.fold.active { border-color: var(--lode-local); color: var(--lode-local); }
.more-lines { display: block; margin: 6px 0 2px 58px; padding: 3px 10px; font: 11.5px var(--lode-font); color: var(--lode-muted); background: var(--lode-sunken); border-radius: 5px; }
.more-lines:hover { color: var(--lode-fg); }
.chips { flex: none; max-width: 170px; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding-left: 12px; }
.chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; font: 10.5px/18px var(--lode-mono); padding: 0 6px; border-radius: 4px; border: 1px solid transparent; white-space: nowrap; }
.chip:hover, .chip.active { border-color: currentColor; }
.chip.rolled { opacity: .72; }
.chip.k-calls { color: var(--lode-local); background: rgba(47, 95, 168, .07); }
.chip.k-channel { color: var(--lode-channel-text); background: rgba(226, 99, 47, .09); }
.chip.k-state { color: var(--lode-state); background: rgba(138, 59, 107, .07); }
.arrows { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 2; }
.hint { padding: 32px; color: var(--lode-muted); }
`;

// <lode-flow node="file#symbol">: code as nodes. Cards of real code in
// columns, left to right, each shown one level deep: nested blocks fold to
// their first line. A line that leads somewhere (a call, IPC, shared state)
// has a chip; clicking it, or a big fold, opens that code in the next card
// with an arrow from the exact line. Small folds expand in place.
export class LodeFlow extends HTMLElement {
  static observedAttributes = ["node"];
  client?: LodeClient;
  host?: LodeHost;

  private readonly root = this.attachShadow({ mode: "open" });
  private columns: Column[] = [];
  private selected = 0; // the card reported to the host (highlight)
  // Every move (open, caller, crumb, new start) can be undone with ←.
  private history: { columns: Column[]; selected: number }[] = [];
  private unsubscribe?: () => void;
  private resize = new ResizeObserver(() => this.layout());

  connectedCallback() {
    this.root.innerHTML = `<style>${BASE_CSS}${CSS}${this.host?.syntaxCss ?? ""}</style>
      <div class="toolbar">
        <button class="crumb" data-action="back" aria-label="Back">←</button>
        <span class="path"></span>
        <span class="spacer"></span>
        <span class="faint">click a chip or a fold to follow it →</span>
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
    if (!block) return this.render();
    const fresh = [card(block)];
    if (this.columns.length) this.go(fresh, 0);
    else {
      this.columns = fresh;
      this.render();
      this.select(0);
    }
  }

  // Move to a new set of cards, remembering where we were.
  private go(columns: Column[], select: number) {
    this.history.push({ columns: this.columns, selected: this.selected });
    this.columns = columns;
    this.render();
    this.select(select);
    this.scrollToColumn(select);
  }

  // Select a card, and tell the host which code it is.
  private select(i: number) {
    this.selected = Math.max(0, Math.min(i, this.columns.length - 1));
    this.root.querySelectorAll(".block").forEach((b) => b.classList.toggle("selected", Number((b as HTMLElement).dataset.col) === this.selected));
    const c = this.columns[this.selected];
    const n = c?.block.node;
    if (!n?.file) return void this.host?.highlight?.(null);
    this.host?.highlight?.({ node: n.id, file: n.file, range: c.range, marks: [...new Set(c.block.links.map((l) => l.line))] });
  }

  // After re-indexing, refetch every open card (lines may have moved).
  private async reload() {
    const blocks = await Promise.all(this.columns.map((c) => this.fetch(c.block.node.id)));
    this.columns = this.columns.flatMap((c, i) => (blocks[i] ? [{ ...c, block: blocks[i]!, ...(c.fragment ? {} : { range: fullRange(blocks[i]!) }) }] : []));
    this.render();
  }

  private async onClick(event: Event) {
    const el = (event.target as Element).closest<HTMLElement>("[data-action]");
    if (!el) {
      // A click anywhere else in a card selects it.
      const block = (event.target as Element).closest<HTMLElement>(".block");
      if (block && !String(window.getSelection() ?? "")) this.select(Number(block.dataset.col));
      return;
    }
    const { action, col, id, line, start, end } = el.dataset;
    const c = Number(col);
    const here = this.columns[c];
    if (action === "open" && id) {
      const block = await this.fetch(id);
      if (block) this.go([...this.columns.slice(0, c + 1), { ...card(block), fromLine: Number(line) }], c + 1);
    } else if (action === "fold") {
      const s = Number(start);
      const region = here.block.regions.find((r) => r.start === s && r.end === Number(end));
      if (!region) return;
      if (inPlace(region)) {
        // Comments and imports: open (or close) in place. The card grows by
        // the lines revealed, so what was showing stays showing.
        const lines = region.end - region.start;
        if (here.expanded.has(s)) {
          here.expanded.delete(s);
          here.limit = Math.max(PAGE, here.limit - lines);
        } else {
          here.expanded.add(s);
          here.limit += lines;
        }
        return this.render();
      }
      if (region.node) {
        // The body of a nested declaration: open that declaration's own card.
        const block = await this.fetch(region.node.id);
        if (block) this.go([...this.columns.slice(0, c + 1), { ...card(block), fromLine: s }], c + 1);
      } else {
        // An anonymous block: open that part of this card as a fragment.
        const header = here.block.lines.find((l) => l.n === s)?.text.trim() ?? "";
        this.go([...this.columns.slice(0, c + 1), { block: here.block, range: [region.start, region.end], fragment: header, fromLine: s, expanded: new Set(), limit: PAGE }], c + 1);
      }
    } else if (action === "reroot" && id) {
      // The caller goes to the left of this card, with an arrow from its line
      // (← brings back what was there before).
      const block = await this.fetch(id);
      if (block) this.go([card(block), { ...here, fromLine: Number(line) }, ...this.columns.slice(c + 1)], 0);
    } else if (action === "more") {
      here.limit += PAGE;
      this.render();
    } else if (action === "callers") {
      here.allCallers = true;
      this.render();
    } else if (action === "back") {
      const previous = this.history.pop();
      if (!previous) return;
      this.columns = previous.columns;
      this.render();
      this.select(previous.selected);
      this.scrollToColumn(previous.selected);
    } else if (action === "source") {
      const n = here?.block.node;
      if (n?.file) this.host?.openSource(n.file, here.range[0]);
    } else if (action === "crumb") {
      this.go(this.columns.slice(0, c + 1), c);
    }
  }

  private render() {
    const row = this.root.querySelector(".row")!;
    if (!this.columns.length) {
      row.innerHTML = `<div class="hint">Pick a file or search for a symbol to start reading from it.</div>`;
      this.root.querySelector(".path")!.innerHTML = "";
      return;
    }
    row.innerHTML = this.columns.map((c, i) => this.cardHtml(c, i)).join("") + `<svg class="arrows" aria-hidden="true">${ARROW_DEFS}</svg>`;
    this.root.querySelector(".path")!.innerHTML = this.columns
      .map((c, i) => {
        const name = escape(cardName(c));
        return i === this.columns.length - 1 ? `<span class="crumb current mono">${name}</span>` : `<button class="crumb mono" data-action="crumb" data-col="${i}">${name}</button>`;
      })
      .join(`<span class="sep">→</span>`);
    this.root.querySelector<HTMLButtonElement>('[data-action="back"]')!.disabled = !this.history.length;
    this.dispatchEvent(new CustomEvent(TITLE_EVENT, { detail: `flow · ${this.columns[0].block.node.name}`, bubbles: true, composed: true }));
    requestAnimationFrame(() => this.layout());
  }

  private cardHtml(c: Column, i: number): string {
    const b = c.block;
    const n = b.node;
    const next = this.columns[i + 1];
    const isActive = (line: number, targetId: string) => next?.fromLine === line && !next.fragment && next.block.node.id === targetId;

    const header = c.fragment
      ? `<div class="callers">in <span class="mono">${escape(blockName(b))}</span></div>`
      : this.callersHtml(c, i);

    // Folds: the outermost regions inside this card, one level deep.
    const folds = topFolds(c);
    const hidden = new Set<number>();
    for (const f of folds) for (let k = f.start + 1; k <= f.end; k++) hidden.add(k);
    const foldAt = new Map(folds.map((f) => [f.start, f]));
    // Folds opened in place keep a button on their header line to close them.
    const openedAt = new Map(
      b.regions.filter((r) => c.expanded.has(r.start) && inPlace(r) && r.start >= c.range[0] && r.end <= c.range[1]).map((r) => [r.start, r]),
    );

    const linksByLine = new Map<number, BlockLink[]>();
    for (const l of b.links) linksByLine.set(l.line, [...(linksByLine.get(l.line) ?? []), l]);
    const first = b.lines[0]?.n ?? 1;
    const html = this.host?.syntax?.(b.lines.map((l) => l.text).join("\n"), n.file ?? "") ?? b.lines.map((l) => escape(l.text));

    const chip = (link: BlockLink, line: number, rolled: boolean) =>
      `<button class="chip k-${link.kind}${rolled ? " rolled" : ""}${isActive(line, link.target.id) ? " active" : ""}" data-action="open" data-col="${i}" data-id="${escape(link.target.id)}" data-line="${line}" title="${escape(link.target.id)}${rolled ? " (inside the fold)" : ""}">${escape(chipText(link))}</button>`;

    const rows: string[] = [];
    let shownLines = 0;
    let remaining = 0;
    // Show up to the limit, and always as far as the line the next card came from.
    const mustReach = next?.fromLine ?? 0;
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
        foldHtml = `<button class="fold" data-action="fold" data-col="${i}" data-start="${opened.start}" data-end="${opened.end}" title="Fold these lines again">⌃ collapse ${opened.end - opened.start} lines</button>`;
      }
      let rolled: BlockLink[] = [];
      if (fold) {
        const count = fold.end - fold.start;
        const small = inPlace(fold); // opens in place rather than as a card
        const active = !small && next?.fromLine === line && (fold.node ? next.block.node.id === fold.node.id : !!next.fragment && next.range[0] === fold.start);
        foldHtml = `<button class="fold${active ? " active" : ""}" data-action="fold" data-col="${i}" data-start="${fold.start}" data-end="${fold.end}" title="${small ? "Show these lines here" : "Open in the next card"}">⋯ ${count} lines${small ? "" : " →"}</button>`;
        // An anonymous fold carries the chips from inside it; a named one
        // doesn't (its own card shows them).
        if (!fold.node) {
          const seen = new Set(own.map((l) => l.target.id));
          for (let k = fold.start + 1; k <= fold.end; k++) for (const l of linksByLine.get(k) ?? []) if (!seen.has(l.target.id)) (seen.add(l.target.id), rolled.push(l));
        }
      }
      const more = rolled.length > MAX_ROLLED && fold
        ? `<button class="chip rolled" data-action="fold" data-col="${i}" data-start="${fold.start}" data-end="${fold.end}" title="Open the fold to see them">+${rolled.length - MAX_ROLLED} inside</button>`
        : "";
      const chips = [...own.map((l) => chip(l, line, false)), ...rolled.slice(0, MAX_ROLLED).map((l) => chip(l, line, true)), more].join("");
      const classes = ["ln", own.length || rolled.length ? "linked" : "", next?.fromLine === line ? "active" : ""].filter(Boolean).join(" ");
      rows.push(`<div class="${classes}" data-n="${line}"><span class="no">${line}</span><span class="src">${html[line - first] || " "}${foldHtml}</span>${chips ? `<span class="chips">${chips}</span>` : ""}</div>`);
    }
    if (remaining) {
      rows.push(`<button class="more-lines" data-action="more" data-col="${i}">show ${Math.min(PAGE, remaining)} more · ${remaining} left</button>`);
    }

    const span = c.range[1] - c.range[0] + 1;
    return `<section class="block${i === 0 ? " root" : ""}${i === this.selected ? " selected" : ""}" data-col="${i}" aria-label="${escape(cardName(c))}">
      <header>
        ${header}
        <button class="title" data-action="source" data-col="${i}" title="Open the source">${titleHtml(c)}</button>
        <span class="meta">${escape(n.file ?? "")}:${c.range[0]}${n.runtime ? ` · ${escape(n.runtime)}` : ""} · ${span} line${span === 1 ? "" : "s"}</span>
      </header>
      <div class="code">${rows.join("")}</div>
    </section>`;
  }

  // What leads to a card: callers, IPC senders, writers, users. The one open
  // to its left is marked.
  private callersHtml(c: Column, i: number): string {
    const b = c.block;
    if (!b.callers.length) {
      if (b.outline) return "";
      return `<div class="callers">${b.trigger ? `runs on <span class="mono">${escape(b.trigger)}</span>` : "nothing in the project calls this"}</div>`;
    }
    const left = this.columns[i - 1]?.block.node.id;
    const shown = c.allCallers ? b.callers : b.callers.slice(0, MAX_CALLERS);
    const allCalls = b.callers.every((cl) => cl.kind === "calls" && !cl.label);
    // Same name from different places (two preloads exposing one API): add the file.
    const nameCount = new Map<string, number>();
    for (const cl of b.callers) nameCount.set(cl.node.name, (nameCount.get(cl.node.name) ?? 0) + 1);
    const nameOf = (cl: CodeBlock["callers"][number]) => (nameCount.get(cl.node.name)! > 1 ? `${cl.node.name} (${cl.node.file?.split("/").pop()})` : cl.node.name);
    return `<div class="callers${c.allCallers ? " all" : ""}">${allCalls ? "called by" : "used by"} ${shown
      .map(
        (cl) =>
          `<button class="caller${cl.node.id === left ? " open" : ""}" data-action="reroot" data-col="${i}" data-id="${escape(cl.node.id)}" data-line="${cl.line}" title="${escape(cl.node.id)}">${escape(nameOf(cl))}${
            cl.kind === "channel" ? ` ⇢ ${escape(cl.label ?? "")}` : cl.label ? ` · ${escape(cl.label)}` : ""
          }</button>`,
      )
      .join("")}${b.callers.length > shown.length ? `<button class="caller more" data-action="callers" data-col="${i}">+${b.callers.length - shown.length} more</button>` : ""}</div>`;
  }

  // Line each card up with the line that opened it, then draw the arrows.
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
      // Put the new card's title level with the source line.
      blocks[i].style.marginTop = `${Math.max(0, s.top - origin.top - 24 - header / 2)}px`;
      const t = blocks[i].getBoundingClientRect();
      const anchor = source.querySelector<HTMLElement>(".chip.active, .fold.active") ?? source;
      const a = anchor.getBoundingClientRect();
      const x0 = blocks[i - 1].getBoundingClientRect().right - origin.left;
      const y0 = a.top + a.height / 2 - origin.top;
      const x1 = t.left - origin.left - 3;
      const y1 = t.top + header / 2 - origin.top;
      const kind = (anchor.className.match(/k-(\w+)/)?.[1] ?? "calls") as LinkKind;
      paths.push(wire(`M ${x0} ${y0} C ${x0 + 48} ${y0}, ${x1 - 48} ${y1}, ${x1} ${y1}`, kind));
    }
    svg.innerHTML = ARROW_DEFS + paths.join("");
  }

  private scrollToColumn(i: number) {
    requestAnimationFrame(() => this.root.querySelector(`.block[data-col="${i}"]`)?.scrollIntoView({ inline: "nearest", block: "nearest" }));
  }
}

function card(block: CodeBlock): Column {
  return { block, range: fullRange(block), expanded: new Set(), limit: PAGE };
}

function fullRange(b: CodeBlock): [number, number] {
  return [b.lines[0]?.n ?? 1, b.lines.at(-1)?.n ?? 1];
}

// The regions that fold in a card: inside its range, not its own root (the
// region spanning the whole card), outermost first. Small regions never fold,
// and nor do comment/import folds the reader opened; regions inside those
// get their turn instead.
function topFolds(c: Column): BlockRegion[] {
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

function cardName(c: Column): string {
  return c.fragment ? `${blockName(c.block)} › ${shorten(c.fragment, 24)}` : blockName(c.block);
}

function titleHtml(c: Column): string {
  if (!c.fragment) return escape(blockName(c.block));
  return `${escape(blockName(c.block))} <span class="part">› ${escape(shorten(c.fragment))}</span>`;
}
