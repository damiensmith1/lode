// Results of the deterministic queries, as sent to views. Plain JSON, no
// graph types, so views (in a browser) depend only on this file.

export type NodeKind = "container" | "callable" | "type" | "value" | "block";

export interface NodeRef {
  id: string;
  name: string;
  kind: NodeKind;
  file?: string;
  line?: number;
  endLine?: number;
  external: boolean;
  runtime?: string; // e.g. "main", from the runtime lens
}

// How two nodes are connected, as views draw it.
export type LinkKind = "calls" | "channel" | "state" | "local";

// One call the focus makes, in source order. Library calls are left out
// (counted in `hidden`); registered callbacks inside it are steps too.
export interface Step {
  label: string;
  target: NodeRef | null;
  line: number;
  callback?: boolean; // a callback defined here (`setTimeout(() => …)`)
  member?: boolean; // for a file or class: something declared in it
}

// A value produced by one step and consumed by another, or returned.
export interface LocalFlow {
  from: number; // step index
  to: number | "return";
  type?: string;
}

export interface Link {
  node: NodeRef;
  kind: LinkKind;
  label?: string; // channel key, "writes", "reads"
  type?: string; // the data carried
  count: number; // edges merged into this link
  detail?: string; // e.g. "9 readers"
}

export interface FocusResult {
  node: NodeRef;
  path: NodeRef[]; // where it sits, runtime first
  steps: Step[];
  flows: LocalFlow[];
  up: Link[]; // what feeds it
  down: Link[]; // what it feeds
  hidden: { libraryCalls: number };
}

export interface MapGroup {
  node: NodeRef;
  children: number;
}

export interface MapEdge {
  from: string;
  to: string;
  kind: LinkKind;
  count: number;
}

export interface MapResult {
  lens: string;
  parent: NodeRef | null;
  path: NodeRef[];
  groups: MapGroup[];
  edges: MapEdge[];
}

export interface Annotation {
  line: number;
  kind: LinkKind;
  text: string;
  target: string; // node id to open
}

export interface FileView {
  file: string;
  text: string;
  annotations: Annotation[];
  symbols: NodeRef[]; // nodes declared in this file
}

export interface FileEntry {
  file: string;
  runtime?: string;
}

export interface ProjectInfo {
  root: string;
  nodes: number;
  edges: number;
  files: number;
  lenses: string[];
}
