import type { BlockLink, NodeRef } from "../src/query/types.js";
import type { LodeStorage } from "./storage.js";

// What a host (an IDE, Clance, the standalone app) provides to lode views.
// Views call these; they never touch the host's UI directly.
export interface LodeHost {
  // Optional: show a source location in the host's editor. Without one
  // (no editor, as in the standalone app), the flow opens the file as a card.
  openSource?(file: string, line?: number): void;
  // Open another lode view, usually as a new tab.
  openView(view: ViewRequest): void;
  // Optional: mark source lines in the host's editor for what the view
  // shows (null clears). The host decides whether to open or scroll.
  highlight?(highlight: SourceHighlight | null): void;
  // Optional: syntax-colour source text, one HTML string per line, with the
  // source escaped. Views that show code use it; without it, code is plain.
  syntax?(text: string, file: string): string[];
  // CSS for the classes `syntax` emits; views put it inside their shadow root.
  syntaxCss?: string;
  // Optional: CSS added last inside every view's shadow root, to restyle
  // anything (themes are better set as --lode-* tokens; see theme.ts).
  css?: string;
  // Optional: which keys do what in a flow (see FlowCommand), or false for
  // none, e.g. when the host routes its own shortcuts to flow.run().
  // Unlisted commands keep their defaults; [] turns one off.
  keys?: false | Partial<Record<FlowCommand, string[]>>;
  // Optional: whether cards' code can be edited (all of them, none, or
  // per card). Default: every card from a project file.
  editable?: boolean | ((card: CardInfo) => boolean);
  // Optional: save a card's edits yourself (e.g. as an editor edit, so the
  // editor's undo and dirty state include it). Default: the service writes
  // the file. Edits are line spans as the card showed them (`expected`)
  // and what they became (`lines`); refuse with ok:false if they don't
  // match the file any more.
  saveEdits?(request: { file: string; edits: LineEdit[] }): Promise<EditResult>;
  // Optional: text an empty canvas shows ("Pick a file to start reading").
  // Default: nothing.
  empty?: string;
  // Optional: extra markup in cards (see CardRender).
  render?: CardRender;
  // Optional: where views keep their state, per view (see ViewRequest's
  // `state`). Defaults to the project's cache, through the connection.
  storage?: LodeStorage;
}

export interface SourceHighlight {
  node: string; // the focused node
  file: string;
  range?: [number, number]; // its first and last line (not for whole files)
  marks: number[]; // lines of its steps (calls, members)
  hover?: number; // the line under the pointer, if in this file
}

// A flow to show (createView), or one the flow asks the host for
// (openView: a new tab the model asked for). `state` names where a flow
// keeps its canvas in the host's storage: give each flow tab its own to
// keep them apart, and the same one again to bring a tab back as it was.
// Defaults to "flow". `ask` builds the flow for a question ("how do we
// create tabs?"). `diff` shows git changes on a flow's cards, against that
// ref ("HEAD": uncommitted changes); `ids` opens several at once; `newTab`
// asks the host for a fresh flow rather than the current one.
export type ViewRequest = { kind: "flow"; id?: string; ids?: string[]; state?: string; diff?: string; newTab?: boolean; ask?: string };

// What a flow can be asked to do, by a key (LodeHost.keys) or by the host
// calling flow.run(command).
export type FlowCommand =
  // cards
  | "close" | "undo" | "fit" | "focus" | "deselect" | "zoomReset" | "clear" | "expand"
  // moving around: a line cursor in the selected card
  | "lineDown" | "lineUp" | "follow" | "back" | "nextChip" | "nextCard" | "prevCard" | "nextChange" | "prevChange"
  // folds, editing, the rest
  | "openFold" | "collapseFold" | "edit" | "search" | "help";

// Keys are "Delete", "Mod+z" (Mod is ⌘ or Ctrl), "Shift+N", "Escape",
// "Space", "?"… Letters match their case through Shift; other single
// characters ("?", "/", "[") match however they're typed.
export const DEFAULT_KEYS: Record<FlowCommand, string[]> = {
  close: ["Delete", "Backspace", "x"],
  undo: ["Mod+z"],
  fit: ["f"],
  focus: ["Space"],
  deselect: [],
  zoomReset: [],
  clear: [],
  expand: ["e"],
  lineDown: ["ArrowDown", "j"],
  lineUp: ["ArrowUp", "k"],
  follow: ["ArrowRight", "l"],
  back: ["ArrowLeft", "h"],
  nextChip: ["Tab"],
  nextCard: ["]"],
  prevCard: ["["],
  nextChange: ["n"],
  prevChange: ["Shift+N"],
  openFold: ["o"],
  collapseFold: ["c"],
  edit: ["Enter"],
  search: ["/"],
  help: ["?"],
};

// What each command does, for a host's help screen (its "?").
export const COMMAND_HELP: Record<FlowCommand, string> = {
  lineDown: "next line",
  lineUp: "previous line",
  follow: "follow the line's chip or fold (open it, or go to it)",
  back: "back along the arrow to where this came from (or its first caller)",
  nextChip: "next chip (or fold) on the line, for →",
  nextCard: "next card, in reading order",
  prevCard: "previous card",
  nextChange: "next change (git), opening folds to reach it",
  prevChange: "previous change",
  expand: "expand the card: all lines, and what it leads to",
  openFold: "open the fold on the line (not its chips)",
  collapseFold: "fold the lines opened around the cursor again",
  edit: "edit the card's code, at the cursor (Esc stops)",
  focus: "bring the card into view",
  fit: "fit the cards (the selection, if several)",
  zoomReset: "zoom to 100%",
  close: "close the selected cards",
  undo: "undo",
  deselect: "deselect",
  clear: "clear the canvas",
  search: "search for a symbol",
  help: "show or hide these keys",
};

// A card as hosts see it, in events, render hooks and flow.cards().
export interface CardInfo {
  key: string; // the card's id on the canvas: a node id, or node@start-end for part of one
  node: NodeRef;
  range: [number, number];
  fragment?: string; // for part of a block: its header line
  x: number;
  y: number;
  selected: boolean;
}

// Hooks that add the host's own markup to cards. Each returns HTML (the
// host escapes what it puts in) or nothing. Elements with
// data-action="host:<name>" are the host's buttons: clicking one fires
// lode-action with that action, the card, and the element's data-* values.
export interface CardRender {
  // After the title and file line in a card's header (badges, buttons).
  header?(card: CardInfo): string | undefined;
  // Below a card's code.
  footer?(card: CardInfo): string | undefined;
  // At the end of a line, before its chips (blame, coverage, a comment dot).
  line?(card: CardInfo, line: number): string | undefined;
  // A chip's label in place of the default ("→ name", "writes x", …).
  chip?(link: BlockLink, card: CardInfo): string | undefined;
}

// Events views dispatch (bubbling, composed, so a host can listen on any
// ancestor). Details in FlowEventMap.
export const ACTION_EVENT = "lode-action"; // about to act on a click or key; cancelable
export const SELECT_EVENT = "lode-select"; // the selection changed
export const OPEN_EVENT = "lode-open"; // a card was opened, or gone to
export const CLOSE_EVENT = "lode-close"; // cards were closed
export const CHANGE_EVENT = "lode-change"; // the canvas changed (cards, arrows, layout, folds, camera)
export const DIRTY_EVENT = "lode-dirty"; // a card got (or lost) unsaved edits
export const SAVE_EVENT = "lode-save"; // a card's edits were saved, or refused
export const CURSOR_EVENT = "lode-cursor"; // the line cursor moved (or left the canvas)
export const ASK_EVENT = "lode-ask"; // the question the flow answers, or how asking it went, changed

// The question a flow answers (flow.ask, or a plan loaded), and how it
// went: still asking, answered (`detail`: "jev · 6 cards · 2.1s"), nothing
// found, or an error (`detail`: why).
export interface AskState {
  question: string;
  status: "asking" | "answered" | "empty" | "error";
  detail?: string;
}

// A change to a file from a card: lines start..end (1-based, inclusive) as
// the card showed them, and what they are now (any number of lines).
export interface LineEdit {
  start: number;
  end: number;
  expected: string[];
  lines: string[];
}

export type EditResult = { ok: true } | { ok: false; reason?: string; message: string };

export interface FlowEventMap {
  // `action` is a card button's or a key's: open, fold, reroot (a caller),
  // close, more, all, less, callers, source, save, discard, a FlowCommand
  // (by key: "search" and "help" are only this, for the host), or
  // host:<name>. preventDefault() stops lode handling it, so
  // a host can take any of them over (e.g. open chips in its editor).
  [ACTION_EVENT]: { action: string; card?: CardInfo; target?: string; line?: number; via: "click" | "key"; data: Record<string, string> };
  [SELECT_EVENT]: { selected: CardInfo | null; cards: CardInfo[] };
  [OPEN_EVENT]: { card: CardInfo; from?: string; line?: number; existing: boolean };
  [CLOSE_EVENT]: { cards: string[] };
  [CHANGE_EVENT]: Record<string, never>;
  [DIRTY_EVENT]: { card: CardInfo; dirty: boolean };
  [SAVE_EVENT]: { card: CardInfo; file: string; ok: boolean; message?: string };
  [CURSOR_EVENT]: { key: string; line: number } | null;
  [ASK_EVENT]: AskState | null;
}
