// What a host (an IDE, Clance, the standalone app) provides to lode views.
// Views call these; they never touch the host's UI directly.
export interface LodeHost {
  // Show a source location in the host's editor.
  openSource(file: string, line?: number): void;
  // Open another lode view, usually as a new tab.
  openView(view: ViewRequest): void;
  // Optional: mark source lines in the host's editor for what the view
  // shows (null clears). The host decides whether to open or scroll.
  highlight?(highlight: SourceHighlight | null): void;
}

export interface SourceHighlight {
  node: string; // the focused node
  file: string;
  range?: [number, number]; // its first and last line (not for whole files)
  marks: number[]; // lines of its steps (calls, members)
  hover?: number; // the line under the pointer, if in this file
}

export type ViewRequest =
  | { kind: "focus"; id: string }
  | { kind: "map"; lens?: string; parent?: string }
  | { kind: "graph"; lens?: string; select?: string };

// Views dispatch this (bubbling, composed) when their title changes, so the
// host can label the tab.
export const TITLE_EVENT = "lode-title";
