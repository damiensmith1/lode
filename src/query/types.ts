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

// The whole project as one tree (a lens) plus every edge between its nodes,
// merged per pair. Views roll edges up to whatever is visible themselves.
export interface GraphNode {
  id: string;
  name: string;
  kind: NodeKind;
  parent: string | null;
  depth: number; // 0 = lens group (e.g. a runtime)
  file?: string;
  line?: number;
  endLine?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: LinkKind;
  count: number;
}

export interface GraphDump {
  lens: string;
  nodes: GraphNode[]; // parents before children, children in source order
  edges: GraphEdge[];
}

// A node's own code, as a block for code-as-nodes views: its lines, the lines
// that lead somewhere (and where), and who leads to it.
export interface BlockLink {
  line: number; // the line in this block it leaves from
  kind: LinkKind;
  target: NodeRef;
  label?: string; // channel key, "writes", "read by"
}

// A foldable span inside a block. When it's exactly a nested declaration's
// body, `node` is that declaration (open it as its own card).
export interface BlockRegion {
  start: number; // the header line, kept visible
  end: number;
  kind: "block" | "literal" | "args" | "comment" | "imports";
  node?: NodeRef;
}

export interface CodeBlock {
  node: NodeRef;
  outline: boolean; // a whole file
  lines: { n: number; text: string }[];
  links: BlockLink[];
  callers: { node: NodeRef; line: number; kind: LinkKind; label?: string }[]; // line is in the caller
  trigger?: string; // a registered callback: what runs it ("addEventListener drop")
  regions: BlockRegion[]; // foldable spans inside it, outermost first
}

// Where to start reading: entry points by runtime and kind, plus a one-line
// summary of how the runtimes talk.
export interface EntryPoint {
  node: NodeRef;
  label: string; // what it answers to: a channel, an event, a file
  detail: string; // where it is, or how much it does
}

export interface EntryCategory {
  name: string; // "on load", "ipc handlers", …
  collapsed: boolean; // long tails start folded
  entries: EntryPoint[];
}

export interface EntryGroup {
  runtime: string | null;
  categories: EntryCategory[];
}

export interface EntriesResult {
  summary: { from: string; to: string; kind: LinkKind; count: number }[];
  groups: EntryGroup[];
}
