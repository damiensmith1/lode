import type { ChannelEndpoint, Region } from "../../schema/index.js";
import type { ChannelFact } from "./channels.js";

// Raw facts emitted by the TypeScript plugin, before normalization.

export interface Location {
  file: string; // relative to the project root
  line: number; // 1-based
  endLine?: number; // declarations: the last line they span
}

export interface DeclFact {
  id: string; // stable: "<file>#<Outer.Inner>", or "<file>" for a module
  name: string;
  tsKind: string; // ts.SyntaxKind name, e.g. "FunctionDeclaration"
  containerId: string | null;
  loc: Location;
  // Set on variables/properties whose value is a function literal.
  functionValue?: true;
  // Set on CommonJS exports whose value is an object literal (`module.exports = {…}`).
  objectValue?: true;
  // Set when this is a callback handed to a registration (event, IPC, route…).
  registration?: { call: string; key: string | null };
}

export interface CallFact {
  callerId: string; // nearest enclosing declaration, or the module
  calleeId: string | null; // null when the callee isn't a node (see localCallee) or can't be resolved
  localCallee?: true; // callee is a local variable or parameter, e.g. a callback passed in
  calleeText: string; // the callee expression as written
  argTypes: string[];
  // Per argument: set when it's a parameter of the caller (see channels.ts).
  argParams?: ({ wrapperId: string; index: number } | null)[];
  returnType: string;
  loc: Location;
}

// Tier 1: a call's result flowing into another call's argument, or out as
// the return value of the function it's in.
export interface FlowFact {
  from: string; // the callee that produced the value
  to: string; // the callee it's passed to, or the function returning it
  within: string; // where it happens
  type: string;
  loc: Location;
}

// A node using a value (read or write) or a type, other than by calling it.
export interface RefFact {
  from: string;
  to: string;
  access: "read" | "write" | "type";
  type?: string; // value refs: the value's type
  loc: Location;
}

export interface TsFacts {
  decls: DeclFact[];
  calls: CallFact[];
  flows: FlowFact[];
  refs: RefFact[];
  channels: ChannelEndpoint[];
  imports: Record<string, string[]>; // file -> project files it imports
  regions: Region[];
}

// One file's facts, before cross-file resolution (channel wrappers).
export interface FileFacts {
  file: string;
  imports: string[]; // project files this one imports (relative paths)
  decls: DeclFact[];
  calls: CallFact[];
  channelFacts: ChannelFact[];
  flows: FlowFact[];
  refs: RefFact[];
  regions: Region[];
}
