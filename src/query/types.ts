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
export type LinkKind = "calls" | "channel" | "state" | "local" | "imports";

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
  indexed?: boolean; // in the code graph (TS/JS); other files are read as text
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

// Git changes (see src/query/git.ts). Line numbers are the current file's.
export interface DiffHunk {
  start: number; // first added/changed line (new file); for a pure removal, the line it follows (0: the top)
  added: number; // lines added or changed from start
  removed: string[]; // the old lines this hunk replaced or removed, shown before `start` (after it when added is 0)
}

export interface ChangedSymbol {
  node: NodeRef; // the declaration changed lines are in, or the file for top-level code
  parent?: string; // the enclosing changed-list symbol (a method's class), for a hierarchy
  added: number; // its own lines (not its children's)
  removed: number;
}

export interface FileChange {
  file: string; // relative to the project root
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  from?: string; // renamed from
  indexed: boolean; // part of the graph (can be opened as cards)
  added: number;
  removed: number;
  hunks: DiffHunk[];
  symbols: ChangedSymbol[];
}

export interface ChangesResult {
  base: string; // what the working tree is compared with
  error?: string; // not a git repository, unknown base, …
  files: FileChange[];
}

// A flow built for a question (see src/ask): cards to open, each with why
// it's there, in reading order.
export type FlowRoute = "how" | "breakage" | "changes" | "callers" | "where" | "other";

export interface FlowPlan {
  question: string;
  route: FlowRoute;
  answered: boolean; // false: nothing in the code seems to answer it (see message)
  message?: string;
  cards: { id: string; note: string; score?: number; step?: number }[]; // in reading order; step: 0 for where to start, then each hop
  requests: number; // model calls it took
  ms: number;
}
