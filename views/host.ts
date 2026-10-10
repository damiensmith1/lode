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
}

export interface SourceHighlight {
  node: string; // the focused node
  file: string;
  range?: [number, number]; // its first and last line (not for whole files)
  marks: number[]; // lines of its steps (calls, members)
  hover?: number; // the line under the pointer, if in this file
}

export type ViewRequest =
  | { kind: "entries" }
  | { kind: "flow"; id?: string };

// Views dispatch this (bubbling, composed) when their title changes, so the
// host can label the tab.
export const TITLE_EVENT = "lode-title";
