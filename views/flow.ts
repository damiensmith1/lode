import type { BlockLink, BlockRegion, ChangesResult, CodeBlock, DiffHunk, FlowPlan, LinkKind } from "../src/query/types.js";
import type { LodeConnection } from "./connection.js";
import type { LodeStorage } from "./storage.js";
import { ACTION_EVENT, ASK_EVENT, CHANGE_EVENT, CLOSE_EVENT, CURSOR_EVENT, DEFAULT_KEYS, DIRTY_EVENT, OPEN_EVENT, SAVE_EVENT, SELECT_EVENT, type AskState, type CardInfo, type EditResult, type FlowCommand, type FlowEventMap, type LodeHost } from "./host.js";
import { ARROW_DEFS, escape, viewCss, wire } from "./theme.js";
import { Editing } from "./editing.js";
import type { ContextResult } from "../src/context/index.js";
import type { CanvasAction } from "../src/explain/index.js";

const MAX_CALLERS = 4;
const MAX_ROLLED = 3; // chips carried up from inside a fold before "+N inside"
const SMALL = 3; // regions hiding this many lines or fewer never fold
const PAGE = 25; // lines a card shows before "show 25 more"
const GAP = 72; // space between a card and one opened from it
const PAD = 32; // board padding
const UNDO_LIMIT = 100;
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
  note?: string; // why it's here (a flow built for a question)
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
  cards: { key: string; node: string; range: [number, number]; fragment?: string; expanded: number[]; limit: number; allCallers?: boolean; note?: string; x: number; y: number }[];
  ask?: AskState; // the question this flow answers, and how it went
  banner?: string; // (older saves) the same, as one line: "/ question · how"
  arrows: Arrow[];
  selected: string | null;
  camera?: Camera; // x, y: where the canvas origin (0, 0) sits on screen
  diff?: string | null; // showing git changes against this ref
}

const CSS = `
:host { display: flex; flex-direction: column; overflow: hidden; }
.stage { flex: 1; min-height: 0; display: flex; }
.canvas { position: relative; flex: 1; min-width: 0; min-height: 0; overflow: hidden; cursor: grab; touch-action: none; }
.card.hl { box-shadow: 0 0 0 3px color-mix(in srgb, var(--lode-local) 45%, transparent), 0 4px 14px color-mix(in srgb, var(--lode-shadow) 8%, transparent); }
.card.fresh { animation: fresh 2.4s ease-out; }
@keyframes fresh { 0% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--lode-added) 55%, transparent); } 100% { box-shadow: 0 0 0 0 transparent; } }
.canvas.panning { cursor: grabbing; }
.canvas.panning, .canvas.moving { user-select: none; -webkit-user-select: none; }
.card header { user-select: none; -webkit-user-select: none; }
.board { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.card { position: absolute; z-index: 1; width: max-content; min-width: 480px; max-width: 760px; background: var(--lode-surface); border: 1px solid var(--lode-border); border-radius: 10px; box-shadow: 0 1px 2px color-mix(in srgb, var(--lode-shadow) 4%, transparent); }
.card.selected { border-color: var(--lode-local); box-shadow: 0 0 0 1px var(--lode-local), 0 4px 14px color-mix(in srgb, var(--lode-shadow) 6%, transparent); z-index: 3; }
.card.dragging { box-shadow: 0 0 0 1px var(--lode-local), 0 12px 32px color-mix(in srgb, var(--lode-shadow) 16%, transparent); z-index: 4; }
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
.ln .no { flex: none; width: 46px; padding-right: 12px; text-align: right; color: var(--lode-line-number); user-select: none; }
/* Long lines wrap (hanging under their indent) rather than being cut off. */
.ln .src { white-space: pre-wrap; overflow-wrap: anywhere; flex: 1; min-width: 0; }
.code[contenteditable="true"] { outline: none; caret-color: var(--lode-fg); }
.ln.added .no { color: var(--lode-channel); }
.ln.diff-added { background: color-mix(in srgb, var(--lode-added) 9%, transparent); box-shadow: inset 3px 0 0 var(--lode-added); }
.ln-removed { display: flex; padding-right: 8px; background: color-mix(in srgb, var(--lode-removed) 8%, transparent); box-shadow: inset 3px 0 0 var(--lode-removed); color: var(--lode-muted); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--lode-removed) 45%, transparent); user-select: none; }
.ln-removed .no { flex: none; width: 46px; padding-right: 12px; text-align: right; color: var(--lode-removed); }
.ln-removed .src { white-space: pre-wrap; overflow-wrap: anywhere; flex: 1; min-width: 0; opacity: .8; }
.fold.changed, .more-lines.changed { box-shadow: inset 0 0 0 1px var(--lode-added); }
.fold.changed::after, .more-lines.changed::after { content: " ●"; color: var(--lode-added); }
.card.editing { box-shadow: 0 0 0 2px color-mix(in srgb, var(--lode-local) 45%, transparent), 0 4px 14px color-mix(in srgb, var(--lode-shadow) 6%, transparent); }
.card.editing .code { cursor: text; }
.card.editing header .meta::after { content: " · editing (Esc to stop)"; color: var(--lode-local); }
.ln.cursor { outline: 1.5px solid color-mix(in srgb, var(--lode-local) 70%, transparent); outline-offset: -1.5px; border-radius: 3px; }
.chip.kbd, .fold.kbd { outline: 2px solid var(--lode-local); outline-offset: 1px; }
.note { align-self: flex-start; margin-top: 2px; padding: 2px 8px; border-radius: 4px; font-size: 11.5px; color: var(--lode-local); background: color-mix(in srgb, var(--lode-local) 8%, transparent); }
.card-actions { display: flex; gap: 6px; align-self: flex-start; }
.card-actions:empty { display: none; }
.expand { margin-left: 0; padding: 0 7px; border-radius: 4px; font-size: 11px; color: var(--lode-muted); box-shadow: inset 0 0 0 1px var(--lode-border); }
.expand:hover { color: var(--lode-fg); background: var(--lode-sunken); }
.open-changes { margin-left: 0; padding: 0 7px; border-radius: 4px; font-size: 11px; color: var(--lode-added); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--lode-added) 55%, transparent); }
.open-changes:hover { background: color-mix(in srgb, var(--lode-added) 12%, transparent); }
.chip.to-changed::before, .caller.to-changed::before { content: "● "; color: var(--lode-added); }
.chip.to-changed { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--lode-added) 55%, transparent); }
.chips, .paging, .ln .no { user-select: none; }
.unsaved { display: none; align-items: center; gap: 8px; margin-top: 6px; font-size: 11.5px; color: var(--lode-channel-text); }
.unsaved .dot { color: var(--lode-channel); }
.unsaved button { padding: 1px 8px; border-radius: 4px; background: var(--lode-sunken); color: var(--lode-fg); }
.unsaved button:hover { background: color-mix(in srgb, var(--lode-channel) 14%, transparent); }
.unsaved .edit-note { color: var(--lode-muted); }
.card.dirty { border-color: var(--lode-channel); }
.card.dirty .unsaved { display: flex; }
.ln.linked .no { color: var(--lode-local); }
.ln.active { background: color-mix(in srgb, var(--lode-local) 8%, transparent); box-shadow: inset 2px 0 0 var(--lode-local); }
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
.chip.k-calls { color: var(--lode-local); background: color-mix(in srgb, var(--lode-local) 7%, transparent); }
.chip.k-channel { color: var(--lode-channel-text); background: color-mix(in srgb, var(--lode-channel) 9%, transparent); }
.chip.k-state { color: var(--lode-state); background: color-mix(in srgb, var(--lode-state) 7%, transparent); }
.chip.k-imports { color: var(--lode-muted); background: var(--lode-sunken); }
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
  client?: LodeConnection;
  // Where this flow's canvas is kept in the host's storage (attribute
  // "state"); flows with different keys are independent.
  stateKey = "flow";
  // Nodes to open once connected (ViewRequest.ids).
  pendingIds: string[] = [];
  host?: LodeHost;

  private readonly root = this.attachShadow({ mode: "open" });
  private cardMap = new Map<string, Card>();
  private arrows: Arrow[] = [];
  private selected: string | null = null; // the primary card (highlighted in the host)
  private group = new Set<string>(); // every selected card, ⌘-click adds
  private dragged = false; // the click ending a drag isn't a click
  // Editing: cards with unsaved edits, and what each card showed (to save
  // against and to tell edited from not).
  private editing?: Editing;
  private dirty = new Set<string>();
  // Git changes shown on cards (null: not shown), by file.
  private diffBase: string | null = null;
  private hunks = new Map<string, DiffHunk[]>();
  private changedIds = new Set<string>(); // symbols with changes: chips to them are marked
  private held = new Set<string>(); // just saved, caret still in: shown as edited, not redrawn
  private editingKey: string | null = null; // the card in editing (Enter), if any
  private bases = new Map<string, { file: string; runs: { start: number; end: number }[]; original: Map<number, string> }>();
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
    // (And what changed in git may have moved on while hidden.)
      if (this.cardMap.size) this.position();
      return;
    }
    this.built = true;
    this.root.innerHTML = `<style>${viewCss(CSS, this.host)}</style>
      <div class="stage">
        <div class="canvas" part="canvas"><div class="board" part="board"></div></div>
      </div>`;
    this.root.addEventListener("click", (e) => void this.onClick(e));
    // A just-saved card refreshes once the caret leaves its code.
    this.root.addEventListener("focusout", (e) => {
      const code = (e.target as Element).closest?.<HTMLElement>(".code");
      const key = code?.closest<HTMLElement>(".card")?.dataset.key;
      if (key && !code!.contains((e as FocusEvent).relatedTarget as Node | null))
        setTimeout(() => {
          this.stopEditing(key);
          this.release(key);
        }, 0);
    });
    this.editing = new Editing({
      root: this.root,
      file: (key) => this.cardMap.get(key)?.block.node.file,
      highlight: (text, file) => this.host?.syntax?.(text, file)[0] ?? escape(text),
      edited: (key) => this.edited(key),
      save: (key) => void this.saveEdits(key, "key"),
      restored: (key) => this.renumber(key),
      // Esc out of code: navigate from the line the caret was on.
      left: (key, line) => {
        if (line) this.cursor = { key, line, chip: 0 };
        this.paintCursor();
      },
    });
    this.setupDrag();
    this.stateKey = this.getAttribute("state") ?? this.stateKey;
    this.ready = this.restore();
    void this.ready.then(() => {
      const id = this.getAttribute("node");
      // A link to a card that's already on the restored canvas just selects
      // it; the saved view stays where it was.
      if (id && this.cardMap.has(id)) this.select(id);
      else if (id) void this.show(id);
      else this.render();
      if (this.pendingIds.length) void this.showAll(this.pendingIds.splice(0));
      if (this.pendingAsk) void this.ask(this.pendingAsk.trim()).then(() => (this.pendingAsk = ""));
    });
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    document.removeEventListener("keydown", this.onKey);
  }

  // Delete/Backspace closes the selected cards; ⌘Z / Ctrl+Z undoes. Only while
  // this view is showing, and never while typing somewhere.
  private onKey = (e: KeyboardEvent) => {
    if (!this.isConnected || !this.offsetParent || this.host?.keys === false) return;
    const typing = e.composedPath().some((t) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)));
    if (typing) return;
    const keys = { ...DEFAULT_KEYS, ...(this.host?.keys || {}) };
    const command = (Object.keys(keys) as FlowCommand[]).find((c) => keys[c]?.some((k) => keyMatches(k, e)));
    if (!command || !this.canRun(command)) return;
    e.preventDefault();
    if (this.emit(ACTION_EVENT, { action: command, via: "key", data: {} }, true)) this.run(command);
  };

  // --- for hosts ---------------------------------------------------------------

  // Do what a key or toolbar button would. Returns whether there was
  // anything to do.
  run(command: FlowCommand): boolean {
    if (!this.canRun(command)) return false;
    if (command === "close") this.close([...this.group]);
    else if (command === "undo") this.popUndo();
    else if (command === "fit") this.fit(this.group.size > 1 ? [...this.group] : [...this.cardMap.keys()]);
    else if (command === "focus") this.frame([...this.group]);
    else if (command === "zoomReset") this.zoomTo(1, this.viewCentre());
    else if (command === "deselect") this.setSelection([]);
    else if (command === "clear") this.clearAll();
    else if (command === "expand") void this.expand(this.cardMap.get(this.selected!)!);
    else if (command === "lineDown") this.moveLine(1);
    else if (command === "lineUp") this.moveLine(-1);
    else if (command === "follow") void this.follow();
    else if (command === "back") void this.back();
    else if (command === "nextChip") this.nextChip();
    else if (command === "nextCard") this.stepCard(1);
    else if (command === "prevCard") this.stepCard(-1);
    else if (command === "nextChange") void this.stepChange(1);
    else if (command === "prevChange") void this.stepChange(-1);
    else if (command === "openFold") this.foldAtCursor(true);
    else if (command === "collapseFold") this.foldAtCursor(false);
    else if (command === "edit") this.editAtCursor();
    // "search" and "help" are the host's (its search box, its key list):
    // lode-action tells it.
    return true;
  }

  // Whether a command has anything to do now (a host greys its buttons by it).
  canRun(command: FlowCommand): boolean {
    if (command === "zoomReset") return this.camera.k !== 1;
    if (command === "close" || command === "focus" || command === "deselect") return this.group.size > 0;
    if (command === "undo") return this.undo.length > 0;
    if (command === "fit" || command === "clear") return this.cardMap.size > 0;
    if (command === "expand" || command === "edit" || command === "openFold" || command === "collapseFold" || command === "nextChip") return !!this.selected && this.cardMap.has(this.selected);
    if (["lineDown", "lineUp", "follow", "back", "nextCard", "prevCard"].includes(command)) return this.cardMap.size > 0;
    if (command === "nextChange" || command === "prevChange") return this.diffBase !== null && this.cardMap.size > 0;
    return true;
  }

  // --- navigating, for hosts ------------------------------------------------------
  //
  // Everything keys and the mouse do, a host can do: run(command) for the
  // commands (undo, fit, follow, nextChange…), apply(CanvasAction) to open,
  // expand, fold, close, select or frame cards, and these for the rest.
  // lode-change (cards, layout, camera), lode-select and lode-cursor say
  // when to read them again; a host draws its own toolbar from them.

  // The zoom (1 is 100%), and setting it (about the view's centre).
  get zoom(): number {
    return this.camera.k;
  }

  setZoom(k: number) {
    this.zoomTo(k, this.viewCentre());
  }

  // The line cursor (keyboard navigation), and putting it on a card's line
  // (default: its first). Selects the card and keeps the line in view.
  get cursorAt(): { key: string; line: number } | null {
    return this.cursor && this.cardMap.has(this.cursor.key) ? { key: this.cursor.key, line: this.cursor.line } : null;
  }

  moveCursor(key: string, line?: number) {
    if (this.cardMap.has(key)) this.setCursor(key, line);
  }

  // Select a card and pan to it if it's off screen.
  goTo(key: string) {
    if (!this.cardMap.has(key)) return;
    this.select(key);
    this.reveal(key);
  }

  // The git ref changes are shown against (null: not shown); setDiff sets it.
  get diff(): string | null {
    return this.diffBase;
  }

  // Cards with unsaved edits (lode-dirty says when this changes).
  unsaved(): string[] {
    return [...this.dirty];
  }

  // --- moving around with keys ----------------------------------------------------
  //
  // The selected card has a line cursor (a visible line of it). Keys move
  // it, follow what's on its line, go back along arrows, step through cards
  // in reading order and through git changes. Esc in code comes back to it;
  // Enter edits there.

  private cursor: { key: string; line: number; chip: number } | null = null;

  // The card's visible lines, as rows (lines added while editing aside).
  private rowsOf(key: string): HTMLElement[] {
    return [...(this.cardEl(key)?.querySelectorAll<HTMLElement>(".code > .ln[data-n]") ?? [])];
  }

  private cursorRow(): HTMLElement | null {
    if (!this.cursor) return null;
    const el = this.cardEl(this.cursor.key);
    return el ? this.rowFor(el, this.cursor.line) : null;
  }

  // Put the cursor on a card's line (default: its first), select the card,
  // and keep it in view.
  private setCursor(key: string, line?: number, chip = 0) {
    const rows = this.rowsOf(key);
    if (!rows.length) return;
    const n = line ?? Number(rows[0].dataset.n);
    this.cursor = { key, line: n, chip };
    if (this.selected !== key || this.group.size !== 1) this.select(key);
    this.paintCursor();
    const row = this.cursorRow();
    if (row) this.keepInView(row);
  }

  // What → can follow on a row: its chips, then its fold. Tab picks.
  private targetsOf(row: HTMLElement | null): HTMLElement[] {
    if (!row) return [];
    const fold = row.querySelector<HTMLElement>(".src > .fold");
    return [...row.querySelectorAll<HTMLElement>(".chips .chip"), ...(fold && fold.title !== "Fold these lines again" ? [fold] : [])];
  }

  private lastCursor = "null";

  private paintCursor() {
    const at = JSON.stringify(this.cursorAt);
    if (at !== this.lastCursor) {
      this.lastCursor = at;
      this.emit(CURSOR_EVENT, this.cursorAt);
    }
    this.root.querySelectorAll(".ln.cursor").forEach((r) => r.classList.remove("cursor"));
    this.root.querySelectorAll(".kbd").forEach((c) => c.classList.remove("kbd"));
    if (this.cursor && !this.cardMap.has(this.cursor.key)) this.cursor = null;
    const row = this.cursorRow();
    if (!row || this.cursor!.key === this.editingKey) return;
    row.classList.add("cursor");
    const targets = this.targetsOf(row);
    if (targets.length) targets[this.cursor!.chip % targets.length].classList.add("kbd");
  }

  // Pan just enough to show an element (with a margin).
  private keepInView(el: HTMLElement) {
    const view = this.canvas().getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const margin = 48;
    let dx = 0;
    let dy = 0;
    if (r.top < view.top + margin) dy = view.top + margin - r.top;
    else if (r.bottom > view.bottom - margin) dy = view.bottom - margin - r.bottom;
    if (r.left < view.left + margin) dx = view.left + margin - r.left;
    else if (r.right > view.right - margin && r.width < view.width - 2 * margin) dx = view.right - margin - r.right;
    if (!dx && !dy) return;
    this.camera = { ...this.camera, x: this.camera.x + dx, y: this.camera.y + dy };
    this.applyCamera();
    this.changed();
  }

  // The card to start from: the cursor's, the selected one, or the first.
  private here(): string | null {
    if (this.cursor && this.cardMap.has(this.cursor.key)) return this.cursor.key;
    if (this.selected && this.cardMap.has(this.selected)) return this.selected;
    return this.readingOrder()[0] ?? null;
  }

  private moveLine(step: 1 | -1) {
    const key = this.here();
    if (!key) return;
    if (!this.cursor || this.cursor.key !== key) return this.setCursor(key);
    const rows = this.rowsOf(key);
    const at = rows.indexOf(this.cursorRow()!);
    const next = rows[at + step];
    if (next) return this.setCursor(key, Number(next.dataset.n));
    // Past the last line: show 25 more, if there are.
    const c = this.cardMap.get(key)!;
    if (step > 0 && this.cardEl(key)?.querySelector('[data-action="more"]') && !this.dirty.has(key)) {
      this.remember();
      c.limit += PAGE;
      this.rerender();
      const more = this.rowsOf(key);
      const after = more[more.findIndex((r) => Number(r.dataset.n) === this.cursor!.line) + 1];
      if (after) this.setCursor(key, Number(after.dataset.n));
    }
  }

  private nextChip() {
    const row = this.cursorRow();
    if (!row || !this.cursor) return;
    const targets = this.targetsOf(row).length;
    if (targets) this.cursor.chip = (this.cursor.chip + 1) % targets;
    this.paintCursor();
  }

  // Follow the line: its chosen chip, else its fold (as clicking them).
  private async follow() {
    const key = this.here();
    if (!key) return;
    if (!this.cursor || this.cursor.key !== key) return this.setCursor(key);
    const targets = this.targetsOf(this.cursorRow());
    const target = targets[this.cursor.chip % Math.max(1, targets.length)];
    if (!target) return;
    await this.activate(key, target);
  }

  // Click a chip or fold for the keyboard, then put the cursor in the card
  // it opened or went to (an in-place fold keeps it where it is).
  private async activate(key: string, target: HTMLElement) {
    const before = new Set(this.cardMap.keys());
    target.click();
    // Wait for the card it opens (or goes to), then put the cursor there.
    for (let i = 0; i < 40 && this.selected === key; i++) await new Promise((r) => setTimeout(r, 25));
    const to = this.selected;
    if (to && to !== key) this.setCursor(to);
    else if (to && [...this.cardMap.keys()].some((k) => !before.has(k))) this.setCursor(to, this.cursor?.line);
  }

  // Back along the arrow into this card, to the line it left from; a card
  // nothing on the canvas points to opens its first caller.
  private async back() {
    const key = this.here();
    if (!key) return;
    if (!this.cursor || this.cursor.key !== key) return this.setCursor(key);
    const arrow = this.arrows.find((a) => a.to === key);
    if (arrow) return this.setCursor(arrow.from, arrow.line);
    const caller = this.cardMap.get(key)!.block.callers[0];
    if (!caller) return;
    await this.openCaller(key, caller.node.id, caller.line, caller.kind);
    this.setCursor(caller.node.id, caller.line);
  }

  // Cards in reading order: each tree (top to bottom), depth first along
  // its arrows in line order.
  readingOrder(): string[] {
    const incoming = new Set(this.arrows.map((a) => a.to));
    const byPlace = [...this.cardMap.values()].sort((a, b) => a.y - b.y || a.x - b.x).map((c) => c.key);
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (k: string) => {
      if (seen.has(k) || !this.cardMap.has(k)) return;
      seen.add(k);
      order.push(k);
      for (const a of this.arrows.filter((x) => x.from === k).sort((x, y) => x.line - y.line)) visit(a.to);
    };
    for (const k of byPlace) if (!incoming.has(k)) visit(k);
    for (const k of byPlace) visit(k); // cycles with no way in
    return order;
  }

  private stepCard(step: 1 | -1) {
    const order = this.readingOrder();
    const key = this.here();
    if (!key) return;
    const at = order.indexOf(key);
    const next = this.cursor ? order[at + step] : key;
    if (next) this.setCursor(next);
  }

  // A row is a change if it's added, follows removed lines, or folds
  // (or pages) changes away.
  private isChange(row: HTMLElement): boolean {
    const prev = row.previousElementSibling;
    return row.classList.contains("diff-added") || !!prev?.classList.contains("ln-removed") || !!row.querySelector(".fold.changed");
  }

  // Next (or previous) change, in reading order. Going forward, a change
  // folded away is opened (in place, or as a card) and the cursor goes in.
  private async stepChange(step: 1 | -1): Promise<void> {
    const order = this.readingOrder();
    const start = this.here();
    if (!start) return;
    const from = order.indexOf(start);
    const cards = step > 0 ? [...order.slice(from), ...order.slice(0, from)] : [...order.slice(0, from + 1).reverse(), ...order.slice(from + 1).reverse()];
    for (const [i, key] of cards.entries()) {
      // Where each change starts: a changed line whose line above isn't one
      // (or with removed lines just above it, or a fold hiding changes).
      const all = this.rowsOf(key);
      let starts = all.filter((r, k) => this.isChange(r) && (k === 0 || !this.isChange(all[k - 1]) || !!r.previousElementSibling?.classList.contains("ln-removed") || !!r.querySelector(".fold.changed")));
      if (step < 0) starts = starts.reverse();
      const after = (r: HTMLElement) => i > 0 || !this.cursor || this.cursor.key !== key || (step > 0 ? Number(r.dataset.n) > this.cursor.line : Number(r.dataset.n) < this.cursor.line);
      const row = starts.find(after);
      if (row) {
        this.setCursor(key, Number(row.dataset.n));
        if (step > 0 && row.querySelector(".fold.changed")) {
          await this.follow();
          // Into the card it opened: its first change.
          const opened = this.cursor?.key;
          const first = opened && opened !== key ? this.rowsOf(opened).find((r) => this.isChange(r)) : undefined;
          if (first) this.setCursor(opened!, Number(first.dataset.n));
        }
        return;
      }
      // Changes past the paging cut: show more and look again.
      if (step > 0 && this.cardEl(key)?.querySelector(".more-lines.changed") && !this.dirty.has(key)) {
        this.remember();
        this.cardMap.get(key)!.limit += PAGE;
        this.rerender();
        return this.stepChange(step);
      }
    }
  }

  // Open (or close again) the fold at the cursor: one on its line, or the
  // in-place one it's inside.
  private foldAtCursor(open: boolean) {
    const key = this.here();
    if (!key) return;
    if (!this.cursor || this.cursor.key !== key) return this.setCursor(key);
    const card = this.cardMap.get(key)!;
    const line = this.cursor.line;
    if (open) {
      // The fold itself, never a chip on the line.
      const fold = this.cursorRow()?.querySelector<HTMLElement>(".src > .fold");
      if (fold && fold.title !== "Fold these lines again") void this.activate(key, fold);
      return;
    }
    const region = card.block.regions.find((r) => inPlace(r) && card.expanded.has(r.start) && r.start <= line && line <= r.end);
    if (region) {
      void this.fold(card, region.start, region.end);
      this.cursor.line = region.start;
      this.paintCursor();
    }
  }

  // Enter: the card's code becomes editable, with the caret at the cursor
  // (the end of its line). Until then clicks and keys only read.
  private editAtCursor() {
    const key = this.here();
    const card = key ? this.cardMap.get(key) : undefined;
    if (!key || !card || !this.isEditable(card) || !this.editing) return;
    if (this.editingKey && this.editingKey !== key) this.stopEditing(this.editingKey, true);
    this.editingKey = key;
    const el = this.cardEl(key)!;
    const code = el.querySelector<HTMLElement>(".code")!;
    code.setAttribute("contenteditable", "true");
    code.setAttribute("spellcheck", "false");
    el.classList.add("editing");
    const row = this.cursorRow() ?? this.rowsOf(key)[0];
    code.focus({ preventScroll: true });
    if (row) this.editing.caret({ row, offset: row.querySelector(".text")?.textContent?.length ?? 0 });
    this.paintCursor();
  }

  // Out of editing (Esc, or the caret left): the code reads only again.
  // Unsaved edits stay; Enter carries on with them.
  private stopEditing(key: string, force = false) {
    if (this.editingKey !== key) return;
    // Focus "left" only because a redraw moved the card (it's put back).
    if (!force && this.cardEl(key)?.contains(this.root.activeElement)) return;
    this.editingKey = null;
    const el = this.cardEl(key);
    el?.querySelector(".code")?.removeAttribute("contenteditable");
    el?.classList.remove("editing");
    this.paintCursor();
  }

  // Every card on the canvas.
  cards(): CardInfo[] {
    return [...this.cardMap.keys()].map((k) => this.info(k)!);
  }

  // The selected cards, the primary one first.
  selection(): CardInfo[] {
    const keys = [...this.group];
    if (this.selected) keys.sort((a, b) => Number(b === this.selected) - Number(a === this.selected));
    return keys.flatMap((k) => this.info(k) ?? []);
  }

  // Select these cards (the first is the primary); [] clears.
  setSelection(keys: string[]) {
    const known = keys.filter((k) => this.cardMap.has(k));
    this.group = new Set(known);
    this.selected = known[0] ?? null;
    this.showSelection();
  }

  private info(key: string): CardInfo | undefined {
    const c = this.cardMap.get(key);
    if (!c) return undefined;
    const n = c.block.node;
    return {
      key,
      node: { id: n.id, name: n.name, kind: n.kind, file: n.file, line: n.line, ...(n.runtime && { runtime: n.runtime }) } as CardInfo["node"],
      range: c.range,
      ...(c.fragment && { fragment: c.fragment }),
      x: Math.round(c.x),
      y: Math.round(c.y),
      selected: this.group.has(key),
    };
  }

  private emit<K extends keyof FlowEventMap>(name: K, detail: FlowEventMap[K], cancelable = false): boolean {
    return this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true, cancelable }));
  }



  attributeChangedCallback(_n: string, before: string | null, after: string | null) {
    if (after && before !== after && this.isConnected) void this.ready.then(() => this.show(after));
  }

  // Show a node: select its card if it's open, else add it as a new tree.
  // --- context for LLMs -------------------------------------------------------------

  // These cards (the selection, if two or more are selected) as context for
  // a language model: their code, how they connect, their notes and any
  // changes, sized to `budget` tokens (see src/context).
  async context(budget = 12_000): Promise<ContextResult | null> {
    if (!this.client || !this.cardMap.size) return null;
    const keys = this.group.size > 1 ? [...this.group] : this.readingOrder();
    const chosen = new Set(keys);
    return this.client.call<ContextResult>("context", {
      canvas: {
        cards: keys.map((k) => {
          const c = this.cardMap.get(k)!;
          return { id: k, ...(c.note && { note: c.note }), ...(c.fragment && { range: c.range }) };
        }),
        arrows: this.arrows.filter((a) => chosen.has(a.from) && chosen.has(a.to)),
      },
      ...(this.diffBase !== null && { changes: this.diffBase }),
      budget,
    });
  }

  // --- building on the canvas ------------------------------------------------------
  //
  // Explaining is the service's (src/explain: an answer, and CanvasActions
  // for the canvas); how it's shown is the host's: a side panel, an overlay,
  // notes in cards. These are the pieces a host builds that from: what a
  // question is about (scope), doing what the model asked (apply), and
  // pointing at a card (highlight).

  private freshCards = new Map<string, number>(); // added by apply(): when (they glow briefly)
  private undoGroup: string | null = null; // apply()'s last undo group
  private applying: Promise<void> = Promise.resolve();

  // What a question about the canvas is about: the selection (two or more
  // cards, or with `selection` even one), else every card, in reading
  // order. `request` is the explain service's request without `messages`
  // (and `model`): the cards and arrows to explain, the cards it may act
  // on, the git changes shown, the question the flow was built for.
  scope(selection = false): { label: string; focus: string[]; request: { canvas: { cards: { id: string; note?: string; range?: [number, number] }[]; arrows: { from: string; line: number; to: string; kind: LinkKind }[] }; cards: string[]; changes?: string; focus?: string[]; question?: string } } {
    const all = this.readingOrder();
    const picked = this.group.size > 1 || (selection && this.group.size) ? [...this.group] : [];
    const keys = picked.length ? picked : all;
    const n = keys.length;
    const inScope = new Set(keys);
    const card = (k: string) => {
      const c = this.cardMap.get(k)!;
      return { id: k, ...(c.note && { note: c.note }), ...(c.fragment && { range: c.range }) };
    };
    return {
      label: picked.length ? `${n} selected card${n === 1 ? "" : "s"}` : `all ${n} card${n === 1 ? "" : "s"}`,
      focus: picked,
      request: {
        canvas: { cards: keys.map(card), arrows: this.arrows.filter((a) => inScope.has(a.from) && inScope.has(a.to)) },
        cards: [...this.cardMap.keys()],
        ...(this.diffBase !== null && { changes: this.diffBase }),
        ...(picked.length && { focus: picked }),
        ...(this.asked && { question: this.asked.question }),
      },
    };
  }

  // Do what a model asked to the canvas (explain's `action` events, or its
  // result's `actions`), in order, each after the last. The server checked
  // them against the cards it was sent; the canvas may have changed since,
  // so what's gone is skipped. Actions sharing an `undoGroup` (one answer's,
  // say) undo as one step; moving the view and showing changes aren't
  // undone. Cards they add glow for a moment.
  apply(actions: CanvasAction | CanvasAction[], options: { undoGroup?: string } = {}): Promise<void> {
    for (const a of Array.isArray(actions) ? actions : [actions]) this.applying = this.applying.then(() => this.act(a, options.undoGroup ?? null)).catch(() => {});
    return this.applying;
  }

  // Light up a card (a name hovered in an answer, say); null clears it.
  highlight(id: string | null) {
    this.root.querySelectorAll(".card.hl").forEach((c) => c.classList.remove("hl"));
    if (id) this.cardEl(id)?.classList.add("hl");
  }

  private async act(a: CanvasAction, group: string | null) {
    const has = (keys: string[]) => keys.filter((k) => this.cardMap.has(k));
    if (a.kind === "tab") return void this.host?.openView({ kind: "flow", newTab: true, ...(a.question && { ask: a.question }) });
    if (a.kind !== "focus" && a.kind !== "fit" && a.kind !== "changes" && (group === null || group !== this.undoGroup)) {
      this.remember();
      this.undoGroup = group;
    }
    this.holdUndo = true;
    try {
      switch (a.kind) {
        case "add":
        case "plan": {
          const ids = a.kind === "add" ? a.ids : a.plan.cards.map((c) => c.id);
          for (const id of ids) this.freshCards.set(id, Date.now());
          return void (await (a.kind === "add" ? this.showAll(ids) : this.loadPlan(a.plan)));
        }
        case "expand": {
          const card = this.cardMap.get(a.card);
          return void (card && (await this.expand(card)));
        }
        case "fold": {
          const card = this.cardMap.get(a.card);
          const region = card?.block.regions.find((r) => r.start === a.start && r.end === a.end);
          if (!card || !region) return;
          // In place: open or close it. Otherwise opening opens its card,
          // and closing closes the card it opened.
          if (inPlace(region)) return void (card.expanded.has(a.start) !== a.open && (await this.fold(card, a.start, a.end)));
          if (a.open) return void (await this.fold(card, a.start, a.end));
          const opened = this.arrows.find((r) => r.from === card.key && r.line === a.start)?.to;
          return void (opened && this.close([opened]));
        }
        case "close":
          return this.close(has(a.cards));
        case "select":
          return this.setSelection(has(a.cards));
        case "focus":
          return this.fit(has(a.cards));
        case "fit":
          return this.fit([...this.cardMap.keys()]);
        case "changes":
          return void (await this.setDiff(a.base));
      }
    } finally {
      this.holdUndo = false;
    }
  }

  // --- asking ------------------------------------------------------------------

  private askState: AskState | null = null;
  // A question to ask once connected (ViewRequest.ask).
  pendingAsk = "";

  // The question this flow answers, and how that went (null: none). A host
  // shows it as it likes; lode-ask says when it changes.
  get asked(): AskState | null {
    return this.askState;
  }

  private setAsked(state: AskState | null) {
    this.askState = state;
    this.emit(ASK_EVENT, state);
  }

  // Ask a question and lay out the flow that answers it here (the server
  // builds it: see src/ask). Its cards come with a note on why each is in.
  async ask(question: string) {
    await this.ready;
    if (!this.client) return;
    this.setAsked({ question, status: "asking" });
    let plan: FlowPlan;
    try {
      plan = await this.client.call<FlowPlan>("ask", { question });
    } catch (error) {
      this.setAsked({ question, status: "error", detail: error instanceof Error ? error.message : String(error) });
      return this.changed();
    }
    this.loadPlan(plan);
  }

  // Lay out a flow plan (from ask(), or a host's own): its cards, linked
  // where they call each other, each with its note.
  async loadPlan(plan: FlowPlan) {
    const ids = plan.cards.map((c) => c.id);
    const how = `${plan.route} · ${plan.cards.length} card${plan.cards.length === 1 ? "" : "s"} · ${(plan.ms / 1000).toFixed(1)}s`;
    this.setAsked(plan.answered ? { question: plan.question, status: "answered", detail: how } : { question: plan.question, status: "empty", detail: plan.message ?? "nothing found" });
    if (!ids.length) return this.changed();
    await this.showAll(ids);
    for (const c of plan.cards) {
      const card = this.cardMap.get(c.id);
      if (card) card.note = c.note;
    }
    this.render();
    // Laid out by the plan's steps: where to start in the first column,
    // each hop one further right, in the plan's order down each column.
    if (plan.cards.some((c) => c.step)) {
      const columns: string[][] = [];
      for (const c of plan.cards) if (this.cardMap.has(c.id)) (columns[c.step ?? 0] ??= []).push(c.id);
      const others = [...this.cardMap.values()].filter((c) => !ids.includes(c.key));
      const left = others.length ? Math.min(...others.map((c) => c.x)) : 0;
      const top0 = others.length ? Math.max(...others.map((c) => c.y + (this.cardEl(c.key)?.offsetHeight ?? 0))) + 120 : 0;
      let x = left;
      for (const col of columns.filter(Boolean)) {
        let y = top0;
        for (const id of col) {
          Object.assign(this.cardMap.get(id)!, { x, y });
          y += (this.cardEl(id)?.offsetHeight ?? 200) + 32;
        }
        x += Math.max(...col.map((id) => this.cardEl(id)?.offsetWidth ?? 480)) + GAP + 24;
      }
      this.position();
    }
    this.fit(ids.filter((id) => this.cardMap.has(id)));
    this.changed();
  }

  // Open several nodes at once (one is just show()). They link up with
  // arrows where they call each other, and are laid out as a flow: callers
  // left of what they call, a column per step, unconnected groups below
  // one another, below what's already on the canvas.
  async showAll(ids: string[]) {
    await this.ready;
    const wanted = [...new Set(ids)];
    if (wanted.length <= 1) return wanted[0] ? this.show(wanted[0]) : undefined;
    const fresh = wanted.filter((id) => !this.cardMap.has(id));
    const blocks = await Promise.all(fresh.map(async (id) => [id, await this.fetch(id)] as const));
    this.remember();
    const added: string[] = [];
    for (const [id, block] of blocks) {
      if (!block) continue;
      const card = newCard(id, block);
      this.revealChanges(card);
      this.cardMap.set(id, card);
      added.push(id);
    }
    for (const id of added) this.connect(id);
    this.render();
    const keys = wanted.filter((id) => this.cardMap.has(id));
    this.arrange(keys, added);
    for (const id of added) this.emit(OPEN_EVENT, { card: this.info(id)!, existing: false });
    this.setSelection([]);
    this.fit(keys);
    this.changed();
  }

  // Lay `keys` out as a flow (see showAll). Only `movable` cards move;
  // cards already on the canvas keep their place.
  private arrange(keys: string[], movable: string[]) {
    const inSet = new Set(keys);
    const move = new Set(movable);
    const edges = this.arrows.filter((a) => inSet.has(a.from) && inSet.has(a.to) && a.from !== a.to);
    const out = new Map(keys.map((k) => [k, [] as string[]]));
    const into = new Map(keys.map((k) => [k, [] as string[]]));
    for (const e of edges) if (!out.get(e.from)!.includes(e.to)) (out.get(e.from)!.push(e.to), into.get(e.to)!.push(e.from));
    // Groups: cards connected either way.
    const group = new Map<string, number>();
    const groups: string[][] = [];
    for (const k of keys) {
      if (group.has(k)) continue;
      const members: string[] = [];
      const queue = [k];
      group.set(k, groups.length);
      while (queue.length) {
        const v = queue.shift()!;
        members.push(v);
        for (const w of [...out.get(v)!, ...into.get(v)!]) if (!group.has(w)) (group.set(w, groups.length), queue.push(w));
      }
      groups.push(members);
    }
    // Columns: the longest call path from a group's starts (cycles cut).
    const column = new Map<string, number>();
    const visiting = new Set<string>();
    const depth = (v: string): number => {
      if (column.has(v)) return column.get(v)!;
      if (visiting.has(v)) return 0;
      visiting.add(v);
      const d = Math.max(0, ...into.get(v)!.map((u) => (visiting.has(u) ? 0 : depth(u) + 1)));
      visiting.delete(v);
      column.set(v, d);
      return d;
    };
    for (const k of keys) depth(k);
    const size = (k: string) => ({ w: this.cardEl(k)?.offsetWidth ?? 480, h: this.cardEl(k)?.offsetHeight ?? 200 });
    const order = (k: string) => {
      const n = this.cardMap.get(k)!.block.node;
      return `${n.file ?? ""}:${String(n.line ?? 0).padStart(6, "0")}`;
    };
    // Each group laid out on its own (columns of call steps), then the
    // groups packed in rows, biggest first, wrapping to about the view's
    // shape; all below what's already on the canvas.
    const ROW = 32;
    const laid = groups.map((members) => {
      const columns: string[][] = [];
      for (const k of members) (columns[column.get(k)!] ??= []).push(k);
      const y = new Map<string, number>();
      const at = new Map<string, { x: number; y: number }>();
      let x = 0;
      let height = 0;
      columns.forEach((col, i) => {
        // First column in file order; later ones next to what calls them.
        const by = (k: string) => {
          const ys = into.get(k)!.filter((u) => y.has(u)).map((u) => y.get(u)!);
          return ys.length ? Math.min(...ys) : Infinity;
        };
        col.sort((a, b) => (i ? by(a) - by(b) : 0) || order(a).localeCompare(order(b)));
        let cy = 0;
        for (const k of col) {
          const want = i ? by(k) : cy;
          const top = Math.max(cy, Number.isFinite(want) ? want : cy);
          y.set(k, top);
          at.set(k, { x, y: top });
          cy = top + size(k).h + ROW;
        }
        height = Math.max(height, cy - ROW);
        x += Math.max(...col.map((k) => size(k).w)) + GAP + 24;
      });
      return { members, at, width: x - GAP - 24, height, first: order([...members].sort((a, b) => order(a).localeCompare(order(b)))[0]) };
    });
    laid.sort((a, b) => b.members.length - a.members.length || a.first.localeCompare(b.first));
    const view = this.canvas().getBoundingClientRect();
    const area = laid.reduce((n, g) => n + (g.width + 88) * (g.height + 88), 0);
    const rowWidth = Math.max(...laid.map((g) => g.width), Math.sqrt(area * Math.max(1, view.width / Math.max(1, view.height))));
    const others = [...this.cardMap.values()].filter((c) => !inSet.has(c.key));
    const left = others.length ? Math.min(...others.map((c) => c.x)) : 0;
    let top = others.length ? Math.max(...others.map((c) => c.y + size(c.key).h)) + 120 : 0;
    let x = left;
    let rowHeight = 0;
    for (const g of laid) {
      if (x > left && x - left + g.width > rowWidth) {
        top += rowHeight + 88;
        x = left;
        rowHeight = 0;
      }
      for (const [k, p] of g.at) if (move.has(k)) Object.assign(this.cardMap.get(k)!, { x: x + p.x, y: top + p.y });
      x += g.width + 88;
      rowHeight = Math.max(rowHeight, g.height);
    }
    this.position();
  }

  async show(id: string) {
    await this.ready;
    if (this.cardMap.has(id)) {
      this.goTo(id);
      return void this.emit(OPEN_EVENT, { card: this.info(id)!, existing: true });
    }
    const block = await this.fetch(id);
    if (!block) return;
    this.remember();
    const card = newCard(id, block);
    this.revealChanges(card);
    this.cardMap.set(id, card);
    this.connect(id);
    this.render();
    this.placeRoot(id);
    this.goTo(id);
    this.emit(OPEN_EVENT, { card: this.info(id)!, existing: false });
    this.changed();
  }

  private async fetch(id: string) {
    return (await this.client?.call<CodeBlock | null>("block", { id })) ?? null;
  }

  // --- actions -------------------------------------------------------------

  private async onClick(event: Event) {
    const el = (event.target as Element).closest<HTMLElement>("[data-action]");
    const cardEl = (event.target as Element).closest<HTMLElement>(".card");
    if (this.dragged) {
      this.dragged = false;
      if (!el) return;
    }
    if (!el) {
      const e = event as MouseEvent;
      if (e.metaKey) this.leaveCode(); // ⌘-click selects cards; it doesn't edit
      if (cardEl && (e.metaKey || !String(window.getSelection() ?? ""))) this.select(cardEl.dataset.key!, e.metaKey);
      // The line cursor follows clicks: the clicked line, or the card's first.
      if (cardEl && !e.metaKey) {
        const row = (event.target as Element).closest<HTMLElement>(".ln[data-n]");
        const key = cardEl.dataset.key!;
        if (row) this.cursor = { key, line: Number(row.dataset.n), chip: 0 };
        else if (this.cursor?.key !== key) this.cursor = { key, line: Number(this.rowsOf(key)[0]?.dataset.n ?? 0), chip: 0 };
        this.paintCursor();
      }
      return;
    }
    const { action = "", id, line, start, end } = el.dataset;
    const key = cardEl?.dataset.key ?? "";
    const here = this.cardMap.get(key);
    // Tell the host first; it can take any action over (or handle its own,
    // host:<name>, from markup it added).
    const data = { ...el.dataset } as Record<string, string>;
    const detail = { action, via: "click" as const, data, ...(here && { card: this.info(key) }), ...(id && { target: id }), ...(line && { line: Number(line) }) };
    if (!this.emit(ACTION_EVENT, detail, true) || action.startsWith("host:")) return;

    if (!here) return;
    if (action === "open" && id) return this.openFrom(key, Number(line), id, (el.className.match(/k-(\w+)/)?.[1] ?? "calls") as LinkKind);
    if (action === "fold") return this.fold(here, Number(start), Number(end));
    if (action === "reroot" && id) return this.openCaller(key, id, Number(line), (el.dataset.kind ?? "calls") as LinkKind);
    if (action === "close") return this.close([key]);
    if (action === "open-changes") return void this.openChanges(here);
    if (action === "expand") return void this.expand(here);
    if (action === "save") return void this.saveEdits(key, "click");
    if (action === "discard") return void this.discardEdits(key);
    if (action === "more" || action === "all" || action === "less") {
      if (this.blockedByEdits([key])) return;
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

  // --- editing -----------------------------------------------------------------

  // Take the caret out of a card's code, so keys act on cards again.
  private leaveCode() {
    const active = this.root.activeElement as HTMLElement | null;
    if (active?.isContentEditable) active.blur();
  }

  private isEditable(c: Card): boolean {
    const e = this.host?.editable;
    if (e === false || !c.block.node.file) return false;
    return typeof e === "function" ? e(this.info(c.key)!) : true;
  }

  // The edits a card's rows make to its file, against what it showed: one
  // per run whose lines differ.
  private editsOf(key: string) {
    const base = this.bases.get(key);
    const code = this.cardEl(key)?.querySelector<HTMLElement>(".code");
    if (!base || !code || !this.editing) return [];
    const now = this.editing.runs(code);
    return base.runs.flatMap((r, i) => {
      const expected = Array.from({ length: r.end - r.start + 1 }, (_, k) => base.original.get(r.start + k) ?? "");
      const lines = now.get(i) ?? expected;
      return lines.length === expected.length && lines.every((l, k) => l === expected[k]) ? [] : [{ start: r.start, end: r.end, expected, lines }];
    });
  }

  // After any edit: is the card different from what it showed?
  private edited(key: string) {
    const was = this.dirty.has(key);
    const now = this.editsOf(key).length > 0;
    if (now) this.dirty.add(key);
    else this.dirty.delete(key);
    const el = this.cardEl(key);
    el?.classList.toggle("dirty", now);
    if (el) el.querySelector(".edit-note")!.textContent = "";
    if (was !== now) {
      this.emit(DIRTY_EVENT, { card: this.info(key)!, dirty: now });
    }
  }

  // Write a card's edits (through the host if it saves, else the service).
  // Refused, with a note on the card, if the file changed underneath.
  private async saveEdits(key: string, via: "click" | "key"): Promise<boolean> {
    const base = this.bases.get(key);
    const edits = this.editsOf(key);
    if (!base || !edits.length) return true;
    if (!this.emit(ACTION_EVENT, { action: "save", card: this.info(key), via, data: {} }, true)) return false;
    const request = { file: base.file, edits };
    let result: EditResult;
    try {
      result = this.host?.saveEdits ? await this.host.saveEdits(request) : await this.client!.call<EditResult>("editFile", request);
    } catch (error) {
      result = { ok: false, reason: "conflict", message: error instanceof Error ? error.message : String(error) };
    }
    this.emit(SAVE_EVENT, { card: this.info(key)!, file: base.file, ok: result.ok, ...(!result.ok && { message: result.message }) });
    if (!result.ok) {
      const note = this.cardEl(key)?.querySelector(".edit-note");
      if (note) note.textContent = ` · ${result.message}`;
      return false;
    }
    this.rebase(key);
    void this.fetch(this.cardMap.get(key)!.block.node.id).then((block) => block && Object.assign(this.cardMap.get(key) ?? {}, { block }));
    return true;
  }

  // Just saved: the card keeps what it shows (so undo can go back past the
  // save), renumbered to the file as it now is, and that becomes what it's
  // compared against. It's held like this, not redrawn from the file, while
  // the caret is in its code; leaving lets it refresh (see release()).
  private rebase(key: string) {
    const base = this.bases.get(key);
    const code = this.cardEl(key)?.querySelector<HTMLElement>(".code");
    if (!base || !code || !this.editing) return;
    const written = this.editing.runs(code);
    let shift = 0;
    const runs = base.runs.map((r, i) => {
      const lines = written.get(i) ?? [];
      const start = r.start + shift;
      shift += lines.length - (r.end - r.start + 1);
      return { start, end: start + lines.length - 1 };
    });
    const original = new Map<number, string>();
    runs.forEach((r, i) => (written.get(i) ?? []).forEach((l, k) => original.set(r.start + k, l)));
    this.bases.set(key, { file: base.file, runs, original });
    const c = this.cardMap.get(key);
    if (c?.fragment) c.range = [c.range[0], c.range[1] + shift];
    for (const row of code.querySelectorAll<HTMLElement>(":scope > .ln[data-new]")) {
      delete row.dataset.new;
      row.classList.remove("added");
      row.setAttribute("part", "line");
    }
    this.renumber(key);
    this.dirty.delete(key);
    this.held.add(key);
    this.editing.saved(key);
    const el = this.cardEl(key)!;
    el.classList.remove("dirty");
    el.querySelector(".edit-note")!.textContent = "";
    this.emit(DIRTY_EVENT, { card: this.info(key)!, dirty: false });
    this.drawArrows();
  }

  // The caret left a held card: show it fresh from the file. Its undo
  // history stays if the fresh card shows the same lines in the same runs.
  private release(key: string) {
    if (!this.held.has(key) || this.dirty.has(key)) return;
    // Focus "left" only because a redraw moved the card (it's put back).
    if (this.cardEl(key)?.contains(this.root.activeElement)) return;
    const code = this.cardEl(key)?.querySelector<HTMLElement>(".code");
    const shown = code && this.editing ? this.editing.runs(code) : null;
    this.held.delete(key);
    const c = this.cardMap.get(key);
    if (c && !c.fragment) c.range = fullRange(c.block);
    this.rerender();
    const base = this.bases.get(key);
    const linesUp =
      !!shown &&
      !!base &&
      base.runs.length === shown.size &&
      base.runs.every((r, i) => {
        const lines = shown.get(i) ?? [];
        return lines.length === r.end - r.start + 1 && lines.every((l, k) => l === base.original.get(r.start + k));
      });
    if (!linesUp) this.editing?.forget(key);
  }

  private async discardEdits(key: string) {
    if (!this.dirty.has(key)) return;
    await this.refreshCard(key);
  }

  // Forget a card's edits and show it fresh from the file.
  private async refreshCard(key: string) {
    this.stopEditing(key, true); // drawn fresh, not kept as it was
    this.dirty.delete(key);
    this.held.delete(key);
    this.editing?.forget(key);
    const c = this.cardMap.get(key);
    const block = c && (await this.fetch(c.block.node.id));
    if (c && block) Object.assign(c, { block, ...(c.fragment ? {} : { range: fullRange(block) }) });
    this.emit(DIRTY_EVENT, { card: this.info(key)!, dirty: false });
    this.rerender();
  }

  // Number a card's rows from the lines it shows: rows that were lines get
  // their run's numbers in order, added rows "+".
  private renumber(key: string) {
    const base = this.bases.get(key);
    const code = this.cardEl(key)?.querySelector<HTMLElement>(".code");
    if (!base || !code) return;
    const next = base.runs.map((r) => r.start);
    for (const row of code.querySelectorAll<HTMLElement>(":scope > .ln")) {
      if (row.dataset.new !== undefined) continue;
      const run = Number(row.dataset.run);
      const n = next[run]++;
      row.dataset.n = String(n);
      row.querySelector(".no")!.textContent = String(n);
    }
  }

  // Unsaved cards can't be closed, folded or paged (that would lose or
  // misplace edits): say so on the card instead.
  private blockedByEdits(keys: string[]): boolean {
    const blocked = keys.filter((k) => this.dirty.has(k));
    for (const k of blocked) {
      const note = this.cardEl(k)?.querySelector(".edit-note");
      if (note) note.textContent = " · save or discard first";
    }
    return blocked.length > 0;
  }

  private clearAll() {
    if (this.blockedByEdits([...this.cardMap.keys()])) return;
    this.remember();
    const gone = [...this.cardMap.keys()];
    this.cardMap.clear();
    this.arrows = [];
    this.selected = null;
    this.group.clear();
    this.render();
    this.emit(CLOSE_EVENT, { cards: gone });
    this.changed();
  }

  // Open `id` as a card to the right of `from`, with an arrow from `line`.
  // If it's already on the canvas, just add the arrow and go to it.
  private async openFrom(from: string, line: number, id: string, kind: LinkKind, fragment?: { block: CodeBlock; range: [number, number]; header: string }) {
    const key = fragment ? `${id}@${fragment.range[0]}-${fragment.range[1]}` : id;
    const existing = this.cardMap.has(key);
    const block = fragment ? fragment.block : existing ? null : await this.fetch(id);
    if (!existing && !block) return;
    this.remember();
    if (!existing) {
      const card = newCard(key, block!);
      if (fragment) Object.assign(card, { range: fragment.range, fragment: fragment.header });
      this.revealChanges(card);
      this.cardMap.set(key, card);
    }
    this.addArrow({ from, line, to: key, kind });
    if (!existing) this.connect(key);
    this.render();
    if (!existing) this.placeBeside(key, from, line);
    this.goTo(key);
    this.emit(OPEN_EVENT, { card: this.info(key)!, from, line, existing });
    this.changed();
  }

  // A caller goes to the left of the card, with an arrow from its line.
  private async openCaller(cardKey: string, callerId: string, line: number, kind: LinkKind) {
    const existing = this.cardMap.has(callerId);
    const block = existing ? null : await this.fetch(callerId);
    if (!existing && !block) return;
    this.remember();
    if (!existing) {
      const card = newCard(callerId, block!);
      this.revealChanges(card);
      this.cardMap.set(callerId, card);
    }
    this.addArrow({ from: callerId, line, to: cardKey, kind });
    if (!existing) this.connect(callerId);
    this.render();
    if (!existing) this.placeLeft(callerId, cardKey, line);
    this.goTo(callerId);
    this.emit(OPEN_EVENT, { card: this.info(callerId)!, from: cardKey, line, existing });
    this.changed();
  }

  private fold(card: Card, start: number, end: number) {
    const region = card.block.regions.find((r) => r.start === start && r.end === end);
    if (!region) return;
    if (inPlace(region)) {
      // Comments and imports: open (or close) in place; the card grows by
      // the lines revealed, so what was showing stays showing.
      if (this.blockedByEdits([card.key])) return;
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
  // Close just these cards (× or Delete); what they opened stays. To close
  // a branch, ⌘-click its cards and press Delete.
  private close(keys: string[]) {
    if (this.blockedByEdits(keys)) keys = keys.filter((k) => !this.dirty.has(k));
    if (!keys.length) return;
    this.remember();
    const gone = new Set(keys);
    for (const k of gone) this.cardMap.delete(k);
    this.arrows = this.arrows.filter((a) => !gone.has(a.from) && !gone.has(a.to));
    if (this.selected && gone.has(this.selected)) this.selected = null;
    for (const k of gone) (this.group.delete(k), this.bases.delete(k), this.held.delete(k), this.editing?.forget(k));
    this.render();
    this.emit(CLOSE_EVENT, { cards: [...gone] });
    this.changed();
  }

  // A card that arrives (again) links up with what's already on the canvas:
  // an arrow to each card it calls and from each card that calls it, from
  // the first line that does (its own line, not one inside a nested
  // declaration's body), unless there's an arrow between them already or
  // one card is inside the other.
  // Whole files don't, or one would point at everything it contains.
  private connect(key: string) {
    const card = this.cardMap.get(key);
    if (!card) return;
    const isFile = (c: Card) => c.block.node.id === c.block.node.file;
    if (isFile(card)) return;
    // One card inside the other (a method in its class): not a link.
    const within = (inner: Card, outer: Card) =>
      inner.block.node.file === outer.block.node.file && inner.range[0] >= outer.range[0] && inner.range[1] <= outer.range[1];
    // A line inside a declaration nested in the card (a method's body, in a
    // class card): the call is that declaration's, not the card's.
    const nested = (c: Card, line: number) => c.block.regions.some((r) => r.node && r.start < line && line <= r.end && !(r.start <= c.range[0] && r.end >= c.range[1]));
    const link = (from: Card, to: string) => {
      if (isFile(from) || this.arrows.some((a) => a.from === from.key && a.to === to)) return;
      const target = this.cardMap.get(to);
      if (target && (within(target, from) || within(from, target))) return;
      const l = from.block.links.find((l) => l.target.id === to && l.line >= from.range[0] && l.line <= from.range[1] && !nested(from, l.line));
      if (l) this.addArrow({ from: from.key, line: l.line, to, kind: l.kind });
    };
    for (const other of this.cardMap.values()) {
      if (other === card) continue;
      if (this.cardMap.has(other.block.node.id) && other.key === other.block.node.id) link(card, other.key);
      if (key === card.block.node.id) link(other, key);
    }
  }

  private addArrow(a: Arrow) {
    if (a.from === a.to) return;
    if (!this.arrows.some((b) => b.from === a.from && b.line === a.line && b.to === a.to)) this.arrows.push(a);
  }

  // --- undo ----------------------------------------------------------------

  private holdUndo = false; // while the model acts: one undo step a message

  private remember() {
    if (this.holdUndo) return;
    this.undo.push(this.snapshot());
    if (this.undo.length > UNDO_LIMIT) this.undo.shift();
  }

  private snapshot(): Snapshot {
    return {
      cards: [...this.cardMap.values()].map((c) => ({ ...c, expanded: new Set(c.expanded) })),
      arrows: this.arrows.map((a) => ({ ...a })),
      selected: this.selected,
    };
  }

  private popUndo() {
    const s = this.undo.pop();
    if (!s) return;
    this.cardMap = new Map(s.cards.map((c) => [c.key, c]));
    this.arrows = s.arrows;
    this.selected = s.selected && this.cardMap.has(s.selected) ? s.selected : null;
    this.group = new Set(this.selected ? [this.selected] : []);
    this.render();
    if (this.selected) this.select(this.selected);
    this.changed();
  }

  // --- selection -------------------------------------------------------------

  // Select one card (the group becomes just it), or with `add` (⌘-click)
  // add it to the group, or take it out if it's already in.
  private select(key: string, add = false) {
    if (!add) this.group = new Set([key]);
    else if (this.group.has(key)) {
      this.group.delete(key);
      if (this.selected === key) this.selected = [...this.group].pop() ?? null;
      return this.showSelection();
    } else this.group.add(key);
    this.selected = key;
    this.showSelection();
  }

  private lastSelection = JSON.stringify([null, []]); // nothing selected

  // Tell the host when the selection is different from last time.
  private announceSelection() {
    const signature = JSON.stringify([this.selected, [...this.group].sort()]);
    if (signature === this.lastSelection) return;
    this.lastSelection = signature;
    const cards = this.selection();
    this.emit(SELECT_EVENT, { selected: (this.selected && this.info(this.selected)) || null, cards });
  }

  private showSelection() {
    this.announceSelection();
    this.root.querySelectorAll<HTMLElement>(".card").forEach((c) => c.classList.toggle("selected", this.group.has(c.dataset.key!)));
    const c = this.selected ? this.cardMap.get(this.selected) : undefined;
    const n = c?.block.node;
    if (!c || !n?.file) return void this.host?.highlight?.(null);
    this.host?.highlight?.({ node: n.id, file: n.file, range: c.range, marks: [...new Set(c.block.links.map((l) => l.line))] });
  }

  // --- camera ------------------------------------------------------------------

  private canvas() {
    return this.root.querySelector<HTMLElement>(".canvas")!;
  }

  private applyCamera() {
    const { x, y, k } = this.camera;
    this.board().style.transform = `translate(${x}px, ${y}px) scale(${k})`;
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
  // The board rectangle around some cards.
  private bounds(keys: string[]) {
    const els = keys.map((k) => this.cardEl(k)).filter((e): e is HTMLElement => !!e);
    if (!els.length) return null;
    return {
      minX: Math.min(...els.map((e) => e.offsetLeft)),
      minY: Math.min(...els.map((e) => e.offsetTop)),
      maxX: Math.max(...els.map((e) => e.offsetLeft + e.offsetWidth)),
      maxY: Math.max(...els.map((e) => e.offsetTop + e.offsetHeight)),
    };
  }

  // Zoom and pan so the cards are in view, centred (at most 100%).
  private fit(keys: string[]) {
    const b = this.bounds(keys);
    if (!b) return;
    const { minX, minY, maxX, maxY } = b;
    const view = this.canvas().getBoundingClientRect();
    const k = Math.max(ZOOM.min, Math.min(1, (view.width - 48) / (maxX - minX), (view.height - 48) / (maxY - minY)));
    this.camera = { k, x: (view.width - (maxX - minX) * k) / 2 - minX * k, y: (view.height - (maxY - minY) * k) / 2 - minY * k };
    this.applyCamera();
    this.changed();
  }

  private frame(keys: string[]) {
    const b = this.bounds(keys);
    if (!b) return;
    const view = this.canvas().getBoundingClientRect();
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    const k = Math.max(ZOOM.min, Math.min(1, (view.width - 96) / w, (view.height - 48) / h));
    const y = h * k < view.height - 48 ? (view.height - h * k) / 2 : 24;
    this.camera = { k, x: 48 - b.minX * k, y: y - b.minY * k };
    this.applyCamera();
    this.changed();
  }


  // --- saving ----------------------------------------------------------------

  private changed() {
    this.emit(CHANGE_EVENT, {});
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), 400);
  }

  // Only where the host says: without host.storage, nothing is saved.
  private storage(): LodeStorage | undefined {
    return this.host?.storage;
  }

  private async save() {
    const data: SavedLayout = {
      v: 1,
      cards: [...this.cardMap.values()].map((c) => ({
        key: c.key,
        node: c.block.node.id,
        range: c.range,
        ...(c.fragment && { fragment: c.fragment }),
        expanded: [...c.expanded],
        limit: c.limit,
        ...(c.allCallers && { allCallers: true }),
        ...(c.note && { note: c.note }),
        x: Math.round(c.x),
        y: Math.round(c.y),
      })),
      arrows: this.arrows,
      selected: this.selected,
      diff: this.diffBase,
      ...(this.askState && { ask: this.askState }),
      // Saved in canvas coordinates, independent of the board's padding origin.
      camera: {
        x: Math.round(this.camera.x + this.offset.x * this.camera.k),
        y: Math.round(this.camera.y + this.offset.y * this.camera.k),
        k: Math.round(this.camera.k * 1000) / 1000,
      },
    };
    try {
      await this.storage()?.save(this.stateKey, data);
    } catch {
      // Not kept this time; the next change tries again.
    }
  }

  private async restore() {
    let saved: SavedLayout | null = null;
    try {
      saved = ((await this.storage()?.load(this.stateKey)) ?? null) as SavedLayout | null;
    } catch {
      // Unreadable: start empty.
    }
    if (saved?.diff !== undefined && this.diffBase === null) this.diffBase = saved.diff;
    await this.loadDiff();
    if (!saved || saved.v !== 1) return;
    const ids = [...new Set(saved.cards.map((c) => c.node))];
    const blocks = new Map((await Promise.all(ids.map(async (id) => [id, await this.fetch(id)] as const))).filter(([, b]) => b));
    for (const c of saved.cards) {
      const block = blocks.get(c.node);
      if (!block) continue; // gone since: renamed or deleted
      this.cardMap.set(c.key, {
        key: c.key,
        block,
        range: c.fragment ? c.range : fullRange(block),
        ...(c.fragment && { fragment: c.fragment }),
        expanded: new Set(c.expanded),
        limit: c.limit,
        ...(c.allCallers && { allCallers: true }),
        ...(c.note && { note: c.note }),
        x: c.x,
        y: c.y,
      });
    }
    this.arrows = saved.arrows.filter((a) => this.cardMap.has(a.from) && this.cardMap.has(a.to));
    this.selected = saved.selected && this.cardMap.has(saved.selected) ? saved.selected : null;
    this.group = new Set(this.selected ? [this.selected] : []);
    this.render();
    if (!this.askState) {
      const [question, detail] = saved.banner?.replace(/^\/ /, "").split(" · ") ?? [];
      const ask = saved.ask ?? (question ? { question, status: "answered" as const, ...(detail && { detail }) } : null);
      if (ask) this.setAsked(ask);
    }
    if (saved.camera) {
      const { x, y, k } = saved.camera;
      this.camera = { k, x: x - this.offset.x * k, y: y - this.offset.y * k };
      this.applyCamera();
    }
    if (this.selected) this.select(this.selected);
  }

  // After re-indexing, refetch every card (lines may have moved).
  private async reload() {
    const ids = [...new Set([...this.cardMap.values()].map((c) => c.block.node.id))];
    const blocks = new Map(await Promise.all(ids.map(async (id) => [id, await this.fetch(id)] as const)));
    for (const [key, c] of this.cardMap) {
      const block = blocks.get(c.block.node.id);
      if (!block) this.cardMap.delete(key);
      else Object.assign(c, { block, ...(c.fragment ? {} : { range: fullRange(block) }) });
    }
    this.arrows = this.arrows.filter((a) => this.cardMap.has(a.from) && this.cardMap.has(a.to));
    await this.loadDiff();
    this.render();
  }

  // --- git changes --------------------------------------------------------------

  // Before it's on the page: start with git changes shown against `base`.
  setDiffOnConnect(base: string) {
    this.diffBase = base;
  }

  // Show (or stop showing) git changes on the cards, against `base`.
  async setDiff(base: string | null) {
    this.diffBase = base;
    await this.loadDiff();
    if (base !== null) for (const c of this.cardMap.values()) if (!this.dirty.has(c.key)) this.revealChanges(c);
    this.render();
    this.changed();
  }

  private async loadDiff() {
    this.hunks = new Map();
    this.changedIds = new Set();
    if (this.diffBase === null || !this.client) return;
    const result = await this.client.call<ChangesResult>("changes", { base: this.diffBase }).catch(() => null);
    for (const f of result?.files ?? []) {
      this.hunks.set(f.file, f.hunks);
      for (const sym of f.symbols) this.changedIds.add(sym.node.id);
    }
  }

  // What a card leads to, one level: its chips (calls, IPC, state) on its
  // own lines (not ones inside a nested declaration: those are that
  // declaration's), and its nested declarations (a file's functions, a
  // class's methods), each once, in line order.
  private leadsTo(c: Card): { id: string; line: number; kind: LinkKind }[] {
    const own = (r: BlockRegion) => r.start <= c.range[0] && r.end >= c.range[1];
    const nested = c.block.regions.filter((r) => r.node && !own(r) && r.start >= c.range[0] && r.end <= c.range[1]);
    const inNested = (line: number) => nested.some((r) => r.start < line && line <= r.end);
    // Only the outermost nested declarations: a class's methods come with it.
    const outer = nested.filter((r) => !nested.some((o) => o !== r && o.start <= r.start && o.end >= r.end));
    const found = new Map<string, { id: string; line: number; kind: LinkKind }>();
    for (const r of outer) found.set(r.node!.id, { id: r.node!.id, line: r.start, kind: "calls" });
    for (const l of c.block.links) {
      // What a file imports is a chip to follow, not part of expanding it.
      if (l.kind === "imports") continue;
      if (l.line < c.range[0] || l.line > c.range[1] || inNested(l.line) || found.has(l.target.id) || l.target.id === c.block.node.id) continue;
      found.set(l.target.id, { id: l.target.id, line: l.line, kind: l.kind });
    }
    return [...found.values()].sort((a, b) => a.line - b.line);
  }

  // Expand a card: all its lines shown, and everything it leads to (see
  // leadsTo) opened as cards beside it, in one go. One level: the new
  // cards aren't expanded.
  private async expand(card: Card) {
    const key = card.key;
    const targets = this.leadsTo(card);
    const fresh = targets.filter((t) => !this.cardMap.has(t.id));
    const blocks = new Map(await Promise.all(fresh.map(async (t) => [t.id, await this.fetch(t.id)] as const)));
    this.remember();
    if (!this.dirty.has(key)) {
      // The whole length: every line, comment and import folds opened in place.
      for (const r of card.block.regions) if (inPlace(r) && r.start >= card.range[0] && r.end <= card.range[1]) card.expanded.add(r.start);
      card.limit = card.range[1] - card.range[0] + 1;
    }
    const added: string[] = [];
    for (const t of targets) {
      const block = blocks.get(t.id);
      if (block && !this.cardMap.has(t.id)) {
        const fresh = newCard(t.id, block);
        this.revealChanges(fresh);
        this.cardMap.set(t.id, fresh);
        added.push(t.id);
      }
      if (this.cardMap.has(t.id)) this.addArrow({ from: key, line: t.line, to: t.id, kind: t.kind });
    }
    for (const id of added) this.connect(id);
    this.render();
    for (const t of targets) if (added.includes(t.id)) this.placeBeside(t.id, key, t.line);
    this.select(key);
    for (const id of added) this.emit(OPEN_EVENT, { card: this.info(id)!, from: key, line: targets.find((t) => t.id === id)!.line, existing: false });
    this.changed();
  }

  // Is there anything left for expand to do?
  private canExpand(c: Card, shownAll: boolean): number {
    if (topFolds(c).some(inPlace)) shownAll = false; // folded comments/imports to open
    const missing = this.leadsTo(c).filter((t) => !this.cardMap.has(t.id) || !this.arrows.some((a) => a.from === c.key && a.to === t.id)).length;
    return missing || (shownAll ? 0 : -1); // -1: only lines to show
  }

  // A card that arrives while changes are shown opens far enough to show
  // them: comment/import folds holding changes open in place, and it shows
  // down to its last changed line (folds that open as cards stay folded,
  // marked; "open N changes" opens those).
  private revealChanges(c: Card) {
    const diff = this.diffFor(c);
    if (!diff.any) return;
    const lines = [...diff.added, ...diff.removed.keys()].filter((l) => l >= c.range[0] && l <= c.range[1] + 1);
    if (!lines.length) return;
    for (const r of c.block.regions) if (inPlace(r) && r.start >= c.range[0] && r.end <= c.range[1] && lines.some((l) => l > r.start && l <= r.end)) c.expanded.add(r.start);
    c.limit = Math.max(c.limit, Math.min(c.range[1] + 1, Math.max(...lines) + 3) - c.range[0]);
  }

  // The folds in a card that hide changes and open as cards (not the
  // comments and imports that open in place).
  private changedFolds(c: Card): BlockRegion[] {
    const diff = this.diffFor(c);
    if (!diff.any) return [];
    const changed = (from: number, to: number) => {
      for (let l = from; l <= to; l++) if (diff.added.has(l) || diff.removed.has(l)) return true;
      return false;
    };
    return topFolds(c).filter((f) => !inPlace(f) && changed(f.start + 1, f.end));
  }

  // Open every fold in a card that hides changes, each as a card beside it
  // (as clicking each would).
  private async openChanges(card: Card) {
    for (const f of this.changedFolds(card)) await this.fold(card, f.start, f.end);
  }

  // A card's changes by line: lines added or changed, and removed lines by
  // the line they were before (a removal at the very end: last line + 1).
  private diffFor(c: Card) {
    const hunks = this.diffBase === null ? undefined : this.hunks.get(c.block.node.file ?? "");
    const added = new Set<number>();
    const removed = new Map<number, string[]>();
    for (const h of hunks ?? []) {
      for (let l = h.start; l < h.start + h.added; l++) added.add(l);
      if (h.removed.length) {
        const at = h.added ? h.start : h.start + 1;
        removed.set(at, [...(removed.get(at) ?? []), ...h.removed]);
      }
    }
    return { added, removed, any: !!hunks?.length };
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
    const a = this.cardMap.get(from)!;
    const aEl = this.cardEl(from)!;
    const row = this.rowFor(aEl, line);
    const header = this.cardEl(key)!.querySelector("header")!.offsetHeight;
    this.settle(key, a.x + aEl.offsetWidth + GAP, a.y + (row?.offsetTop ?? 0) - header / 2);
  }

  // A caller to the left of `to`, its calling line level with `to`'s top.
  private placeLeft(key: string, to: string, line: number) {
    const t = this.cardMap.get(to)!;
    const el = this.cardEl(key)!;
    const row = this.rowFor(el, line);
    this.settle(key, t.x - el.offsetWidth - GAP, t.y - (row?.offsetTop ?? 0) + 24);
  }

  // A new tree: below everything already open.
  private placeRoot(key: string) {
    const others = [...this.cardMap.values()].filter((c) => c.key !== key);
    if (!others.length) return this.settle(key, 0, 0);
    const bottom = Math.max(...others.map((c) => c.y + (this.cardEl(c.key)?.offsetHeight ?? 0)));
    this.settle(key, Math.min(...others.map((c) => c.x)), bottom + 56);
  }

  // Put a card at (x, y), moving it down until it overlaps nothing.
  private settle(key: string, x: number, y: number) {
    const card = this.cardMap.get(key)!;
    const el = this.cardEl(key)!;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    for (let i = 0; i < 200; i++) {
      const hit = [...this.cardMap.values()].find((o) => {
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
      const c = this.cardMap.get(el.dataset.key!)!;
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
      const c = this.cardMap.get(el.dataset.key!)!;
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
    // A drag moves the card, or the whole selection when the card is in it.
    let drag: { key: string; x: number; y: number; starts: { c: Card; el: HTMLElement; x: number; y: number }[]; before: Snapshot; moved: boolean } | null = null;
    let pan: { x: number; y: number; cam: Camera } | null = null;
    const canvas = this.canvas();
    this.root.addEventListener("pointerdown", (event) => {
      const e = event as PointerEvent;
      const target = e.target as Element;
      this.dragged = false;
      // Empty canvas: drag to move around.
      if (!target.closest(".card") && target.closest(".canvas")) {
        e.preventDefault(); // no text selection while panning
        this.leaveCode(); // a click on the canvas leaves the code too
        window.getSelection()?.removeAllRanges();
        pan = { x: e.clientX, y: e.clientY, cam: { ...this.camera } };
        canvas.setPointerCapture(e.pointerId);
        canvas.classList.add("panning");
        return;
      }
      const header = target.closest("header");
      if (!header || target.closest("button, a, input, [data-action]")) return; // controls, not a drag handle
      e.preventDefault(); // no text selection while moving a card
      this.leaveCode(); // and keys go to the canvas, not the code last typed in
      const el = header.closest<HTMLElement>(".card")!;
      const key = el.dataset.key!;
      const keys = this.group.has(key) ? [...this.group] : [key];
      const starts = keys.flatMap((k) => {
        const c = this.cardMap.get(k);
        const cel = this.cardEl(k);
        return c && cel ? [{ c, el: cel, x: c.x, y: c.y }] : [];
      });
      canvas.classList.add("moving");
      drag = { key, x: e.clientX, y: e.clientY, starts, before: this.snapshot(), moved: false };
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
      for (const s of drag.starts) {
        s.el.classList.add("dragging");
        s.c.x = s.x + dx;
        s.c.y = s.y + dy;
        s.el.style.left = `${s.c.x + this.offset.x}px`;
        s.el.style.top = `${s.c.y + this.offset.y}px`;
      }
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
      for (const s of drag.starts) s.el.classList.remove("dragging");
      if (drag.moved) {
        this.dragged = true;
        this.undo.push(drag.before);
        this.position();
        this.changed();
      }
      // Without a move, the click that follows selects the card.
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
    this.announceSelection();
    const board = this.board();
    if (!this.cardMap.size) {
      // An empty canvas says what the host wants it to (host.empty).
      board.innerHTML = this.host?.empty ? `<div class="hint" part="empty">${escape(this.host.empty)}</div>` : "";
      board.style.width = board.style.height = "";
      board.style.transform = "";
      return;
    }
    // Cards with unsaved edits keep their own rows (and the caret, if it's
    // in one): rendering them from the block would lose the edits.
    const kept = new Map([...this.dirty, ...this.held, ...(this.editingKey ? [this.editingKey] : [])].flatMap((k) => (this.cardEl(k) ? [[k, this.cardEl(k)!] as const] : [])));
    const focused = [...kept].find(([, el]) => el.contains(this.root.activeElement));
    const caret = focused && this.editing?.selection(focused[1].querySelector<HTMLElement>(".code")!);
    board.innerHTML = [...this.cardMap.values()].map((c) => this.cardHtml(c)).join("") + `<svg class="arrows" part="arrows" aria-hidden="true">${ARROW_DEFS}</svg>`;
    for (const [k, el] of kept) {
      const fresh = this.cardEl(k);
      if (!fresh) continue;
      el.className = fresh.className + (this.dirty.has(k) ? " dirty" : "") + (k === this.editingKey ? " editing" : "");
      fresh.replaceWith(el);
    }
    if (focused && caret) {
      focused[1].querySelector<HTMLElement>(".code")!.focus({ preventScroll: true });
      if (caret.start.row.isConnected) this.editing?.caret(caret.start);
    }
    this.position();
    this.paintCursor();
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
    // The host's own markup (LodeHost.render), given the card as it sees it.
    const render = this.host?.render;
    const info = render ? this.info(c.key)! : undefined;

    const header = c.fragment ? `<div class="callers" part="callers">in <span class="mono">${escape(blockName(b))}</span></div>` : this.callersHtml(c);

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
      `<button part="chip chip-${link.kind}" class="chip k-${link.kind}${this.changedIds.has(link.target.id) ? " to-changed" : ""}${rolled ? " rolled" : ""}${isActive(line, link.target.id) ? " active" : ""}" data-action="open" data-id="${escape(link.target.id)}" data-line="${line}" title="${escape(link.target.id)}${rolled ? " (inside the fold)" : ""}">${(info && render?.chip?.(link, info)) ?? escape(chipText(link))}</button>`;

    const rows: string[] = [];
    let shownLines = 0;
    let remaining = 0;
    // Git changes: added lines marked, removed ones shown where they were
    // (read-only), folds and the paging cut marked when they hide some.
    const diff = this.diffFor(c);
    let lastShown = 0;
    const ghost = (lines: string[]) =>
      lines
        .map((t) => `<div class="ln-removed" part="line-removed" contenteditable="false"><span class="no">−</span><span class="src">${t ? (this.host?.syntax?.(t, n.file ?? "")[0] ?? escape(t)) : " "}</span></div>`)
        .join("");
    const changedWithin = (from: number, to: number) => {
      for (let l = from; l <= to; l++) if (diff.added.has(l) || diff.removed.has(l)) return true;
      return false;
    };
    // Runs of visible lines that are contiguous in the file: what can be
    // edited as one (see editing.ts). Kept as what the card showed, to save
    // against.
    const runs: { start: number; end: number }[] = [];
    const original = new Map<number, string>();
    // Show up to the limit, and always down to lines that arrows leave from.
    const mustReach = Math.max(0, ...out.map((a) => a.line));
    for (let line = c.range[0]; line <= c.range[1]; line++) {
      if (hidden.has(line)) continue;
      if (shownLines >= c.limit && line > mustReach) {
        remaining++;
        continue;
      }
      shownLines++;
      lastShown = line;
      if (diff.removed.has(line)) rows.push(ghost(diff.removed.get(line)!));
      const own = linksByLine.get(line) ?? [];
      const fold = foldAt.get(line);
      let foldHtml = "";
      const opened = openedAt.get(line);
      if (opened && !fold) {
        foldHtml = `<button part="fold" class="fold" data-action="fold" data-start="${opened.start}" data-end="${opened.end}" title="Fold these lines again">⌃ collapse ${opened.end - opened.start} lines</button>`;
      }
      const rolled: BlockLink[] = [];
      if (fold) {
        const count = fold.end - fold.start;
        const small = inPlace(fold); // opens in place rather than as a card
        const foldKey = fold.node ? fold.node.id : `${n.id}@${fold.start}-${fold.end}`;
        const active = !small && isActive(line, foldKey);
        const hidesChanges = diff.any && changedWithin(fold.start + 1, fold.end);
        foldHtml = `<button part="fold" class="fold${active ? " active" : ""}${hidesChanges ? " changed" : ""}" data-action="fold" data-start="${fold.start}" data-end="${fold.end}" title="${small ? "Show these lines here" : "Open as a card"}">⋯ ${count} lines${small ? "" : " →"}</button>`;
        // An anonymous fold carries the chips from inside it; a named one
        // doesn't (its own card shows them).
        if (!fold.node) {
          const seen = new Set(own.map((l) => l.target.id));
          for (let k = fold.start + 1; k <= fold.end; k++) for (const l of linksByLine.get(k) ?? []) if (!seen.has(l.target.id)) (seen.add(l.target.id), rolled.push(l));
        }
      }
      const more =
        rolled.length > MAX_ROLLED && fold
          ? `<button part="chip" class="chip rolled" data-action="fold" data-start="${fold.start}" data-end="${fold.end}" title="Open the fold to see them">+${rolled.length - MAX_ROLLED} inside</button>`
          : "";
      const hostLine = info && render?.line?.(info, line);
      const chips = [hostLine ? `<span class="host-line" part="host-line">${hostLine}</span>` : "", ...own.map((l) => chip(l, line, false)), ...rolled.slice(0, MAX_ROLLED).map((l) => chip(l, line, true)), more].join("");
      const classes = ["ln", own.length || rolled.length ? "linked" : "", out.some((a) => a.line === line) ? "active" : "", diff.added.has(line) ? "diff-added" : ""].filter(Boolean).join(" ");
      const run = runs.length && runs[runs.length - 1].end === line - 1 && !foldAt.has(runs[runs.length - 1].end) ? runs[runs.length - 1] : (runs.push({ start: line, end: line }), runs[runs.length - 1]);
      run.end = line;
      original.set(line, b.lines[line - first]?.text ?? "");
      const lockedHtml = foldHtml && foldHtml.replace("<button ", '<button contenteditable="false" ');
      rows.push(
        `<div part="line" class="${classes}" data-n="${line}" data-run="${runs.length - 1}"><span class="no" part="line-number" contenteditable="false">${line}</span><span class="src" part="source"><span class="text">${b.lines[line - first]?.text ? html[line - first] : "<br>"}</span>${lockedHtml}</span>${chips ? `<span class="chips" part="chips" contenteditable="false">${chips}</span>` : ""}</div>`,
      );
    }
    // Removed at the very end of what the card shows.
    if (!remaining && diff.removed.has(lastShown + 1) && lastShown === c.range[1]) rows.push(ghost(diff.removed.get(lastShown + 1)!));
    const pagedChanges = remaining > 0 && diff.any && changedWithin(lastShown + 1, c.range[1]);
    const total = shownLines + remaining;
    const paging = [
      remaining ? `<button part="paging-button" class="more-lines${pagedChanges ? " changed" : ""}" data-action="more">show ${Math.min(PAGE, remaining)} more</button>` : "",
      remaining > PAGE ? `<button part="paging-button" class="more-lines" data-action="all" data-total="${total}">show all ${remaining}</button>` : "",
      c.limit > PAGE && shownLines > PAGE ? `<button part="paging-button" class="more-lines" data-action="less" data-total="${total}">⌃ collapse</button>` : "",
    ].join("");
    if (paging) rows.push(`<div class="paging" part="paging" contenteditable="false">${paging}</div>`);
    if (!this.dirty.has(c.key) && !this.held.has(c.key)) this.bases.set(c.key, { file: n.file ?? "", runs, original });
    const editable = this.isEditable(c);

    const span = c.range[1] - c.range[0] + 1;
    // Changed folds not opened yet (the button goes once they all are).
    const expandable = this.canExpand(c, remaining === 0);
    const changedFolds = this.changedFolds(c).filter((f) => !this.cardMap.has(f.node ? f.node.id : `${n.id}@${f.start}-${f.end}`));
    const hostHeader = info && render?.header?.(info);
    const hostFooter = info && render?.footer?.(info);
    const fresh = Date.now() - (this.freshCards.get(c.key) ?? 0) < 2500;
    return `<section part="card${this.group.has(c.key) ? " card-selected" : ""}" class="card${this.group.has(c.key) ? " selected" : ""}${fresh ? " fresh" : ""}" data-key="${escape(c.key)}" aria-label="${escape(cardName(c))}">
      <header part="card-header">
        <button class="close" part="card-close" data-action="close" aria-label="Close this card" title="Close this card">×</button>
        ${header}
        <button class="title" part="card-title" data-action="source" title="Open the source">${titleHtml(c)}</button>
        <span class="meta" part="card-meta">${escape(n.file ?? "")}:${c.range[0]}${n.runtime ? ` · ${escape(n.runtime)}` : ""} · ${span} line${span === 1 ? "" : "s"}</span>
        ${c.note ? `<div class="note" part="note">${escape(c.note)}</div>` : ""}
        <div class="card-actions">${expandable ? `<button class="expand" part="expand" data-action="expand" title="Show all its lines and open everything it leads to (one level)">${expandable > 0 ? `expand · ${expandable} →` : "expand"}</button>` : ""}
        ${changedFolds.length ? `<button class="open-changes" part="open-changes" data-action="open-changes" title="Open every folded part with changes as a card">open ${changedFolds.length} change${changedFolds.length === 1 ? "" : "s"} →</button>` : ""}</div>
        ${hostHeader ? `<div class="host-header" part="host-header">${hostHeader}</div>` : ""}
        <div class="unsaved" part="unsaved"><span class="dot">●</span> unsaved <button data-action="save" title="Save (⌘S)">save</button><button data-action="discard" title="Throw these edits away">discard</button><span class="edit-note"></span></div>
      </header>
      <div class="code" part="code"${editable && this.editingKey === c.key ? ' contenteditable="true" spellcheck="false" autocapitalize="off" autocorrect="off"' : ""}>${rows.join("")}</div>
      ${hostFooter ? `<div class="host-footer" part="host-footer">${hostFooter}</div>` : ""}
    </section>`;
  }

  // What leads to a card: callers, IPC senders, writers, users. Ones already
  // on the canvas with an arrow here are marked.
  private callersHtml(c: Card): string {
    const b = c.block;
    if (!b.callers.length) {
      if (b.outline) return "";
      return `<div class="callers" part="callers">${b.trigger ? `runs on <span class="mono">${escape(b.trigger)}</span>` : "nothing in the project calls this"}</div>`;
    }
    const shown = c.allCallers ? b.callers : b.callers.slice(0, MAX_CALLERS);
    const allCalls = b.callers.every((cl) => cl.kind === "calls" && !cl.label);
    const allImports = b.callers.every((cl) => cl.kind === "imports");
    // Same name from different places (two preloads exposing one API): add the file.
    const nameCount = new Map<string, number>();
    for (const cl of b.callers) nameCount.set(cl.node.name, (nameCount.get(cl.node.name) ?? 0) + 1);
    // Files with one name (two index.ts): their folder tells them apart.
    const nameOf = (cl: CodeBlock["callers"][number]) =>
      nameCount.get(cl.node.name)! <= 1 ? cl.node.name : cl.node.id === cl.node.file ? (cl.node.file ?? "").split("/").slice(-2).join("/") : `${cl.node.name} (${cl.node.file?.split("/").pop()})`;
    const open = (id: string) => this.arrows.some((a) => a.from === id && a.to === c.key);
    return `<div class="callers${c.allCallers ? " all" : ""}" part="callers">${allImports ? "imported by" : allCalls ? "called by" : "used by"} ${shown
      .map(
        (cl) =>
          `<button part="caller" class="caller${this.changedIds.has(cl.node.id) ? " to-changed" : ""}${open(cl.node.id) ? " open" : ""}" data-action="reroot" data-kind="${cl.kind}" data-id="${escape(cl.node.id)}" data-line="${cl.line}" title="${escape(cl.node.id)}">${escape(nameOf(cl))}${
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

// Does a key name ("Delete", "Mod+z", "Shift+F", "Alt+ArrowLeft") match the
// event? Mod is ⌘ or Ctrl. Letters ignore case; modifiers must match.
function keyMatches(spec: string, e: KeyboardEvent): boolean {
  const parts = spec.split("+");
  const key = parts.pop()!;
  const want = new Set(parts.map((p) => p.toLowerCase()));
  const mod = want.has("mod");
  if (mod ? !(e.metaKey || e.ctrlKey) : e.metaKey !== want.has("meta") || e.ctrlKey !== want.has("ctrl")) return false;
  // Punctuation ("?", "[") is typed with or without Shift depending on the
  // layout: only letters and named keys check it.
  const punctuation = key.length === 1 && !/[a-z0-9]/i.test(key);
  if ((!punctuation && e.shiftKey !== want.has("shift")) || e.altKey !== want.has("alt")) return false;
  return key === "Space" ? e.key === " " : e.key.toLowerCase() === key.toLowerCase();
}


