// What a host (an IDE, Clance, the standalone app) provides to lode views.
// Views call these; they never touch the host's UI directly.
export interface LodeHost {
  // Show a source location in the host's editor.
  openSource(file: string, line?: number): void;
  // Open another lode view, usually as a new tab.
  openView(view: ViewRequest): void;
}

export type ViewRequest =
  | { kind: "focus"; id: string }
  | { kind: "map"; lens?: string; parent?: string };

// Views dispatch this (bubbling, composed) when their title changes, so the
// host can label the tab.
export const TITLE_EVENT = "lode-title";
