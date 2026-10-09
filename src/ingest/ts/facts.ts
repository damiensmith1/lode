import type { ChannelEndpoint } from "../../schema/index.js";

// Raw facts emitted by the TypeScript plugin, before normalization.

export interface Location {
  file: string; // relative to the project root
  line: number; // 1-based
}

export interface DeclFact {
  id: string; // stable: "<file>#<Outer.Inner>", or "<file>" for a module
  name: string;
  tsKind: string; // ts.SyntaxKind name, e.g. "FunctionDeclaration"
  containerId: string | null;
  loc: Location;
  // Set on variables/properties whose value is a function literal.
  functionValue?: true;
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

export interface TsFacts {
  decls: DeclFact[];
  calls: CallFact[];
  channels: ChannelEndpoint[];
}
