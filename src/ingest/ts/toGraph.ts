import type { Edge, GraphData, Node, NodeKind } from "../../schema/index.js";
import type { DeclFact, TsFacts } from "./facts.js";

const KIND_BY_TS: Record<string, NodeKind> = {
  SourceFile: "container",
  ClassDeclaration: "container",
  ObjectLiteralExpression: "container",
  PropertyAssignment: "callable",
  FunctionDeclaration: "callable",
  MethodDeclaration: "callable",
  MethodSignature: "callable",
  Constructor: "callable",
  GetAccessor: "callable",
  SetAccessor: "callable",
  ArrowFunction: "callable",
  FunctionExpression: "callable",
  InterfaceDeclaration: "type",
  TypeAliasDeclaration: "type",
  EnumDeclaration: "type",
  VariableDeclaration: "value",
  PropertyDeclaration: "value",
  PropertySignature: "value",
};

// Maps TS facts into the lode schema. Library code the project calls into
// becomes external nodes, grouped under one container per package.
export function toGraph(facts: TsFacts): GraphData {
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];

  for (const decl of facts.decls) nodes.set(decl.id, declNode(decl));

  const external = (id: string) => {
    if (nodes.has(id)) return;
    const [pkgId, name] = splitExternal(id);
    if (!nodes.has(pkgId)) {
      nodes.set(pkgId, { id: pkgId, kind: "container", name: pkgId.slice("ext:".length), parent: null, loc: null, external: true });
    }
    nodes.set(id, { id, kind: "callable", name, parent: pkgId, loc: null, external: true });
  };

  for (const call of facts.calls) {
    if (!call.calleeId) continue; // unresolved: kept in the facts, not the graph
    if (call.calleeId.startsWith("ext:")) {
      if (!splitExternal(call.calleeId)[1]) continue; // anonymous library code
      external(call.calleeId);
    } else if (!nodes.has(call.calleeId)) {
      continue; // resolved to something that isn't a node, e.g. a local function
    }
    edges.push({
      kind: "calls",
      from: call.callerId,
      to: call.calleeId,
      confidence: "exact",
      loc: call.loc,
      args: call.argTypes,
      returns: call.returnType,
    });
  }

  return { nodes: [...nodes.values()], edges, channels: facts.channels };
}

function declNode(decl: DeclFact): Node {
  const kind = decl.functionValue ? "callable" : KIND_BY_TS[decl.tsKind];
  if (!kind) throw new Error(`no node kind for TS kind ${decl.tsKind} (${decl.id})`);
  return {
    id: decl.id,
    kind,
    name: decl.name,
    parent: decl.containerId,
    loc: decl.loc,
    external: false,
    detail: { tsKind: decl.tsKind, ...(decl.registration && { registration: decl.registration }) },
  };
}

function splitExternal(id: string): [string, string] {
  const hash = id.indexOf("#");
  return [id.slice(0, hash), id.slice(hash + 1)];
}
