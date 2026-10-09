// The lode schema: the contract between language plugins and the core.
// Nothing here knows about any particular language.

export type NodeId = string;

export type NodeKind =
  | "container" // files, classes, namespaces, packages
  | "callable" // functions, methods, registered callbacks
  | "type" // interfaces, type aliases, enums
  | "value" // module-level variables, properties
  | "block"; // steps inside a callable (not produced yet)

export type EdgeKind = "calls" | "references" | "flows";

// How an edge was established. Compiler facts are exact; derived matches
// may be patterns; model guesses (later) are inferred.
export type Confidence = "exact" | "pattern" | "inferred";

export interface Location {
  file: string; // relative to the project root
  line: number; // 1-based
}

export interface Node {
  id: NodeId;
  kind: NodeKind;
  name: string;
  // Containment is a tree, so it lives on the node rather than as edges.
  parent: NodeId | null;
  loc: Location | null; // null for external (library) nodes
  external: boolean;
  // Language-specific detail, opaque to the core.
  detail?: Record<string, unknown>;
}

export interface Edge {
  kind: EdgeKind;
  from: NodeId;
  to: NodeId;
  confidence: Confidence;
  loc: Location | null;
  args?: string[]; // calls: types passed in
  returns?: string; // calls: type passed back
  type?: string; // flows/references: the type carried
  via?: { family: string; key: string }; // flows: the channel it crossed
}

// One side of a string-keyed channel (IPC, events, queues). Plugins say
// which calls send and receive; derive matches them into flow edges.
export interface ChannelEndpoint {
  node: NodeId;
  role: "send" | "receive";
  family: string; // only endpoints of the same family can match
  key: string; // the channel name; "*" is a wildcard when pattern is true
  pattern: boolean;
  payload?: string; // send: the types passed
  awaitsReply?: boolean; // send: the receiver's return value comes back
  returns?: string; // receive: what the handler returns
  loc: Location;
}

export interface GraphData {
  nodes: Node[];
  edges: Edge[];
  channels?: ChannelEndpoint[];
}

export interface LanguagePlugin {
  name: string;
  // Index a project and return it in lode's schema.
  index(projectPath: string): GraphData;
}
