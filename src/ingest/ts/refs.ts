import ts from "typescript";
import type { Location, RefFact } from "./facts.js";

// Methods that change what their receiver holds: `cache.set(k, v)` writes `cache`.
const MUTATORS = new Set([
  "set", "add", "delete", "clear", "push", "pop", "shift", "unshift", "splice",
  "sort", "reverse", "fill", "copyWithin",
]);

// Declarations an identifier can reference as a value: module-level state,
// class fields, and functions passed around without being called.
const VALUE_TARGETS = new Set([
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

const TYPE_TARGETS = new Set([
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ClassDeclaration,
]);

interface Context {
  checker: ts.TypeChecker;
  nodeIdOf: (node: ts.Node) => string | null;
  enclosingId: (node: ts.Node) => string;
  locOf: (node: ts.Node) => Location;
}

// What `id` refers to, if it's a reference worth an edge. Calls are skipped
// (they're call edges), as are declaration names, imports and exports.
export function referenceOf(id: ts.Identifier, ctx: Context): RefFact | null {
  if (isNotAReference(id)) return null;

  // `{ count }` refers to the variable `count`, not the new property.
  let symbol = ts.isShorthandPropertyAssignment(id.parent)
    ? ctx.checker.getShorthandAssignmentValueSymbol(id.parent)
    : ctx.checker.getSymbolAtLocation(id);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = ctx.checker.getAliasedSymbol(symbol);
  const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!decl) return null;
  const to = ctx.nodeIdOf(decl);
  if (!to || to.startsWith("ext:")) return null; // project code only; library use shows up as calls
  const from = ctx.enclosingId(id);
  if (from === to) return null;

  if (inTypePosition(id)) {
    return TYPE_TARGETS.has(decl.kind) ? { from, to, access: "type", loc: ctx.locOf(id) } : null;
  }
  if (!VALUE_TARGETS.has(decl.kind)) return null;

  // `x.prop` is about `prop` when `id` is the name; about `x` otherwise.
  const expr = ts.isPropertyAccessExpression(id.parent) && id.parent.name === id ? id.parent : id;
  if (isCallee(expr)) return null;
  const type = ctx.checker.typeToString(ctx.checker.getTypeAtLocation(id));
  return { from, to, access: isWrite(expr) ? "write" : "read", type, loc: ctx.locOf(id) };
}

function isNotAReference(id: ts.Identifier): boolean {
  const p = id.parent;
  const isName = (p as ts.NamedDeclaration).name === id;
  if (isName && !ts.isPropertyAccessExpression(p) && !ts.isShorthandPropertyAssignment(p)) return true; // the declaration itself
  return (
    ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) ||
    ts.isExportSpecifier(p) || ts.isExportAssignment(p) || ts.isQualifiedName(p) && p.right !== id
  );
}

function inTypePosition(id: ts.Identifier): boolean {
  for (let n: ts.Node = id; n.parent; n = n.parent) {
    if (ts.isTypeNode(n.parent) || ts.isHeritageClause(n.parent) || ts.isExpressionWithTypeArguments(n.parent)) return true;
    if (!ts.isQualifiedName(n.parent) && !ts.isIdentifier(n.parent)) return false;
  }
  return false;
}

function isCallee(expr: ts.Expression): boolean {
  const p = expr.parent;
  return (ts.isCallExpression(p) || ts.isNewExpression(p) || ts.isDecorator(p)) && p.expression === expr;
}

function isWrite(expr: ts.Expression): boolean {
  if (assigns(expr)) return true;
  // Changing what it holds: `x.a = 1`, `x[k] = 1`, `x.a++`, `x.set(k, v)`.
  const p = expr.parent;
  if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === expr) {
    if (assigns(p)) return true;
    if (ts.isPropertyAccessExpression(p) && ts.isCallExpression(p.parent) && p.parent.expression === p) {
      return MUTATORS.has(p.name.text);
    }
  }
  return false;
}

function assigns(expr: ts.Expression): boolean {
  const p = expr.parent;
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind;
    return p.left === expr && op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment;
  }
  if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) {
    return p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken;
  }
  return ts.isDeleteExpression(p);
}
