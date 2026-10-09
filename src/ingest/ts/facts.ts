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
  // Set when this is a callback handed to a registration (event, IPC, route…).
  registration?: { call: string; key: string | null };
}

export interface CallFact {
  callerId: string; // nearest enclosing declaration, or the module
  calleeId: string | null; // null when the callee can't be resolved
  calleeText: string; // the callee expression as written
  argTypes: string[];
  returnType: string;
  loc: Location;
}

export interface TsFacts {
  decls: DeclFact[];
  calls: CallFact[];
}
