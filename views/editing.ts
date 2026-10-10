// Editing code in place, in a card's own rows. A card's code is always
// editable; what you can edit is what you can see. Visible lines come in
// runs (lines that are contiguous in the file); folds and the paging cut
// end a run, and no edit crosses from one run to another, so hidden lines
// are never touched. Typing within a line is the browser's own editing;
// anything that adds, joins or removes lines (Enter, Backspace at a line's
// start, pasting, deleting a selection over several lines) goes through
// replace(), which rebuilds the rows of one run.
//
// Rows are `.ln` elements with `data-run` (which run) and either `data-n`
// (the file line it was) or `data-new` (added here). The editable text of
// a row is its `.text`; line numbers, fold buttons and chips are
// contenteditable=false.

export interface EditingHost {
  root: ShadowRoot;
  // The file a card's code is from (where its highlight comes from).
  file(cardKey: string): string | undefined;
  // One line's HTML (escaped, maybe coloured).
  highlight(text: string, file: string): string;
  // A card's rows changed (dirty or not, from comparing with what it showed).
  edited(cardKey: string): void;
  save(cardKey: string): void;
}

interface Point {
  row: HTMLElement;
  offset: number;
}

interface Snapshot {
  html: string;
  caret: { row: number; offset: number } | null;
}

const TYPING_PAUSE = 800; // ms: typing after a pause starts a new undo step

export class Editing {
  private history = new Map<string, { undo: Snapshot[]; redo: Snapshot[]; typedAt: number }>();
  private composing = false;

  constructor(private readonly host: EditingHost) {
    const root = host.root;
    root.addEventListener("beforeinput", (e) => this.onBeforeInput(e as InputEvent));
    root.addEventListener("input", (e) => this.onInput(e as InputEvent));
    root.addEventListener("keydown", (e) => this.onKeyDown(e as KeyboardEvent));
    root.addEventListener("copy", (e) => this.onCopy(e as ClipboardEvent, false));
    root.addEventListener("cut", (e) => this.onCopy(e as ClipboardEvent, true));
    // Keep the caret in a line's text: End, clicks past a line's end and
    // arrow keys can leave it beside a fold button, where typing does nothing.
    document.addEventListener("selectionchange", () => this.keepCaretInText());
    root.addEventListener("compositionstart", () => (this.composing = true));
    root.addEventListener("compositionend", (e) => {
      this.composing = false;
      const row = (e.target as Element).closest?.<HTMLElement>(".ln");
      if (row) this.rehighlight(row);
    });
  }

  // The current lines of each run of a card's code, by run index.
  runs(code: HTMLElement): Map<number, string[]> {
    const runs = new Map<number, string[]>();
    for (const row of rows(code)) {
      const run = Number(row.dataset.run);
      runs.set(run, [...(runs.get(run) ?? []), textOf(row)]);
    }
    return runs;
  }

  // Drop a card's undo history (saved, discarded or closed).
  forget(cardKey: string) {
    this.history.delete(cardKey);
  }

  private keepCaretInText() {
    const s = this.domSelection();
    if (!s || !s.rangeCount || !s.isCollapsed || this.composing) return;
    const node = s.anchorNode;
    const el = node && (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement);
    const code = el?.closest<HTMLElement>('.code[contenteditable="true"]');
    if (!code || !this.host.root.contains(code) || el!.closest(".text")) return;
    const point = pointIn(code, node!, s.anchorOffset);
    if (point) this.caret(point);
  }

  private domSelection(): Selection | null {
    return (this.host.root as ShadowRoot & { getSelection?(): Selection | null }).getSelection?.() ?? document.getSelection();
  }

  // --- events --------------------------------------------------------------

  private onBeforeInput(e: InputEvent) {
    const code = codeOf(e.target);
    if (!code) return;
    const sel = this.selection(code);
    const type = e.inputType;
    if (type.startsWith("format")) return e.preventDefault();
    if (type === "historyUndo" || type === "historyRedo") {
      e.preventDefault();
      return this.undoRedo(code, type === "historyUndo");
    }
    if (!sel) return e.preventDefault();
    const sameRow = sel.start.row === sel.end.row;
    const collapsed = sameRow && sel.start.offset === sel.end.offset;

    if (type === "insertParagraph" || type === "insertLineBreak") {
      e.preventDefault();
      const indent = /^\s*/.exec(textOf(sel.start.row).slice(0, sel.start.offset))![0];
      return this.replace(code, sel.start, sel.end, "\n" + indent);
    }
    if (type === "insertFromPaste" || type === "insertFromDrop" || type === "insertFromYank" || type === "insertReplacementText") {
      e.preventDefault();
      const text = e.dataTransfer?.getData("text/plain") ?? e.data ?? "";
      return this.replace(code, sel.start, sel.end, text);
    }
    if (type.startsWith("insert")) {
      // Typing: the browser's own editing within a line; ours over several.
      if (sameRow) return this.typing(code);
      e.preventDefault();
      return this.replace(code, sel.start, sel.end, e.data ?? "");
    }
    if (type.startsWith("delete")) {
      if (!collapsed) {
        if (sameRow && type !== "deleteByCut") return this.typing(code);
        e.preventDefault();
        return this.replace(code, sel.start, sel.end, "");
      }
      // At a line's edge, Backspace/Delete join it with its neighbour (in
      // the same run only: across a fold there are hidden lines between).
      const backward = type.includes("Backward");
      const { row, offset } = sel.start;
      if (backward && offset === 0) {
        e.preventDefault();
        const prev = neighbour(row, -1);
        if (prev) this.replace(code, { row: prev, offset: textOf(prev).length }, sel.start, "");
        return;
      }
      if (!backward && offset === textOf(row).length) {
        e.preventDefault();
        const next = neighbour(row, 1);
        if (next) this.replace(code, sel.start, { row: next, offset: 0 }, "");
        return;
      }
      return this.typing(code);
    }
    e.preventDefault(); // anything else (e.g. inserting HTML) isn't for code
  }

  // After the browser's own edit within a row: tidy, colour, mark edited.
  private onInput(e: InputEvent) {
    const code = codeOf(e.target);
    if (!code || this.composing) return;
    const sel = this.selection(code);
    const row = sel?.start.row ?? (e.target as Element).closest?.<HTMLElement>(".ln");
    if (row) this.rehighlight(row);
    this.host.edited(cardKeyOf(code));
  }

  private onKeyDown(e: KeyboardEvent) {
    const code = codeOf(e.target);
    if (!code) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      return this.host.save(cardKeyOf(code));
    }
    if (mod && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
      e.preventDefault();
      return this.undoRedo(code, e.key.toLowerCase() === "z" && !e.shiftKey);
    }
    if (e.key === "Tab" && !mod && !e.altKey) {
      e.preventDefault();
      const sel = this.selection(code);
      if (sel) this.replace(code, sel.start, sel.end, "  ");
      return;
    }
    if (e.key === "Escape") (e.target as HTMLElement).blur?.();
  }

  // Copy (and cut) the code itself: lines joined with newlines, without
  // line numbers, chips or fold buttons.
  private onCopy(e: ClipboardEvent, cut: boolean) {
    const code = codeOf(e.target);
    if (!code) return;
    const sel = this.selection(code);
    if (!sel || (sel.start.row === sel.end.row && sel.start.offset === sel.end.offset)) return;
    const all = rows(code);
    const from = all.indexOf(sel.start.row);
    const to = all.indexOf(sel.end.row);
    const text =
      from === to
        ? textOf(sel.start.row).slice(sel.start.offset, sel.end.offset)
        : [textOf(sel.start.row).slice(sel.start.offset), ...all.slice(from + 1, to).map(textOf), textOf(sel.end.row).slice(0, sel.end.offset)].join("\n");
    e.clipboardData?.setData("text/plain", text);
    e.preventDefault();
    if (cut) this.replace(code, sel.start, sel.end, "");
  }

  // --- changes ---------------------------------------------------------------

  // Replace from `a` to `b` (rows of one run) with `text`, which may hold
  // newlines: the rows between are rebuilt. Refused across runs.
  replace(code: HTMLElement, a: Point, b: Point, text: string) {
    const all = rows(code);
    const from = all.indexOf(a.row);
    const to = all.indexOf(b.row);
    if (from < 0 || to < from) return;
    const span = all.slice(from, to + 1);
    if (span.some((r) => r.dataset.run !== a.row.dataset.run)) return; // crosses hidden lines
    this.remember(code, true);
    const file = this.host.file(cardKeyOf(code)) ?? "";
    const before = textOf(a.row).slice(0, a.offset);
    const after = textOf(b.row).slice(b.offset);
    const lines = (before + text + after).split(/\r?\n/);
    // The first row stays (with its number and chips); rows in between go;
    // new lines get new rows. Fold buttons stay on the run's last row.
    const last = span[span.length - 1];
    const folds = [...last.querySelectorAll<HTMLElement>(".src > .fold")];
    for (const r of span.slice(1)) r.remove();
    this.setText(a.row, lines[0], file);
    let prev = a.row;
    for (const line of lines.slice(1)) {
      const row = newRow(a.row.dataset.run!);
      prev.after(row);
      this.setText(row, line, file);
      prev = row;
    }
    for (const f of folds) prev.querySelector(".src")!.append(f);
    this.caret({ row: prev, offset: lines[lines.length - 1].length - after.length });
    this.host.edited(cardKeyOf(code));
  }

  private typing(code: HTMLElement) {
    this.remember(code, false);
  }

  private rehighlight(row: HTMLElement) {
    const code = row.closest<HTMLElement>(".code");
    if (!code) return;
    // Text typed next to the fold button (outside .text) belongs in it.
    const src = row.querySelector(".src")!;
    const text = row.querySelector<HTMLElement>(".text")!;
    let stray = "";
    for (const node of [...src.childNodes]) if (node !== text && node.nodeType === Node.TEXT_NODE) (stray += node.textContent), node.remove();
    const sel = this.selection(code);
    const offset = sel && sel.start.row === row ? sel.start.offset : null;
    this.setText(row, textOf(row) + stray, this.host.file(cardKeyOf(code)) ?? "");
    if (offset !== null || stray) this.caret({ row, offset: offset ?? textOf(row).length });
  }

  private setText(row: HTMLElement, text: string, file: string) {
    row.querySelector<HTMLElement>(".text")!.innerHTML = text ? this.host.highlight(text, file) : "";
  }

  // --- undo ------------------------------------------------------------------

  // Before a change: a structural change is always its own step; typing
  // joins the step before unless there was a pause.
  private remember(code: HTMLElement, structural: boolean) {
    const key = cardKeyOf(code);
    const h = this.history.get(key) ?? { undo: [], redo: [], typedAt: 0 };
    this.history.set(key, h);
    const now = Date.now();
    if (structural || now - h.typedAt > TYPING_PAUSE) h.undo.push(this.snapshot(code));
    h.typedAt = structural ? 0 : now;
    h.redo = [];
    if (h.undo.length > 200) h.undo.shift();
  }

  private undoRedo(code: HTMLElement, undo: boolean) {
    const h = this.history.get(cardKeyOf(code));
    const from = undo ? h?.undo : h?.redo;
    const to = undo ? h?.redo : h?.undo;
    const snap = from?.pop();
    if (!h || !snap) return;
    to!.push(this.snapshot(code));
    h.typedAt = 0;
    code.innerHTML = snap.html;
    const all = rows(code);
    if (snap.caret && all[snap.caret.row]) this.caret({ row: all[snap.caret.row], offset: snap.caret.offset });
    this.host.edited(cardKeyOf(code));
  }

  private snapshot(code: HTMLElement): Snapshot {
    const sel = this.selection(code);
    return { html: code.innerHTML, caret: sel ? { row: rows(code).indexOf(sel.start.row), offset: sel.start.offset } : null };
  }

  // --- selection ---------------------------------------------------------------

  // The selection as row + offset into the row's text, start first.
  selection(code: HTMLElement): { start: Point; end: Point } | null {
    const s = this.domSelection();
    if (!s || !s.rangeCount) return null;
    const range = s.getRangeAt(0);
    const start = pointIn(code, range.startContainer, range.startOffset);
    const end = pointIn(code, range.endContainer, range.endOffset);
    return start && end ? { start, end } : null;
  }

  caret(p: Point) {
    const text = p.row.querySelector<HTMLElement>(".text")!;
    const s = this.domSelection();
    if (!s) return;
    let left = p.offset;
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const n = node.textContent!.length;
      if (left <= n) return void s.setBaseAndExtent(node, left, node, left);
      left -= n;
    }
    s.setBaseAndExtent(text, text.childNodes.length, text, text.childNodes.length);
  }
}

function codeOf(target: EventTarget | null): HTMLElement | null {
  return (target as Element | null)?.closest?.<HTMLElement>('.code[contenteditable="true"]') ?? null;
}

function cardKeyOf(code: HTMLElement): string {
  return code.closest<HTMLElement>(".card")!.dataset.key!;
}

function rows(code: HTMLElement): HTMLElement[] {
  return [...code.querySelectorAll<HTMLElement>(":scope > .ln")];
}

function textOf(row: HTMLElement): string {
  return row.querySelector(".text")?.textContent ?? "";
}

// The row next to this one, if it's in the same run.
function neighbour(row: HTMLElement, step: -1 | 1): HTMLElement | null {
  const next = (step < 0 ? row.previousElementSibling : row.nextElementSibling) as HTMLElement | null;
  return next?.classList.contains("ln") && next.dataset.run === row.dataset.run ? next : null;
}

function newRow(run: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "ln added";
  row.setAttribute("part", "line line-added");
  row.dataset.run = run;
  row.dataset.new = "";
  row.innerHTML = `<span class="no" part="line-number" contenteditable="false">+</span><span class="src" part="source"><span class="text"></span></span>`;
  return row;
}

// A DOM position as row + offset into the row's text. Positions outside a
// row's text (its number, chips) clamp to the text's start or end.
function pointIn(code: HTMLElement, node: Node, offset: number): Point | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const row = el?.closest<HTMLElement>(".ln");
  if (!row || row.parentElement !== code) {
    // Between rows (on the code element itself): the nearest row's edge.
    if (node !== code) return null;
    const all = rows(code);
    const at = all[Math.min(offset, all.length - 1)];
    return at ? { row: at, offset: offset >= all.length ? textOf(at).length : 0 } : null;
  }
  const text = row.querySelector(".text")!;
  if (!text.contains(node) && node !== text) {
    // Outside the text: before it (the line number) is its start, after it
    // (fold button, chips) its end. A container holding the text decides
    // by which side of it the offset falls.
    let before: boolean;
    if (node.contains(text)) {
      const child = [...node.childNodes].findIndex((c) => c === text || c.contains(text));
      before = offset <= child;
    } else before = !!(text.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING);
    return { row, offset: before ? 0 : textOf(row).length };
  }
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(node, offset);
  return { row, offset: range.toString().length };
}
