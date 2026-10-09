import path from "node:path";
import ts from "typescript";
import type { CallFact, DeclFact, Location, TsFacts } from "./facts.js";
import { type Registration, registrationOf } from "./registrations.js";

// Declarations that become nodes. Anything else nested inside them is
// attributed to the nearest one of these.
const DECL_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.VariableDeclaration,
]);

export function ingestTsProject(tsconfigPath: string): TsFacts {
  const root = path.dirname(path.resolve(tsconfigPath));
  const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const projectFiles = new Set(parsed.fileNames.map((f) => path.resolve(f)));

  const rel = (fileName: string) => path.relative(root, fileName).split(path.sep).join("/");
  const isProjectFile = (sf: ts.SourceFile) => projectFiles.has(path.resolve(sf.fileName));

  const locOf = (node: ts.Node): Location => {
    const sf = node.getSourceFile();
    return { file: rel(sf.fileName), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 };
  };

  const registrations = new Map<ts.Node, Registration | null>();
  const registration = (node: ts.Node) => {
    if (!registrations.has(node)) registrations.set(node, registrationOf(node, checker));
    return registrations.get(node)!;
  };

  // Callbacks handed to registrations are named after what they handle:
  // "on:popup:hide", or "setTimeout@L42" when there's no literal key.
  const nameOf = (node: ts.Node): string | null => {
    const reg = registration(node);
    if (reg) return reg.key ? `${reg.call}:${reg.key}` : `${reg.call}@L${locOf(node).line}`;
    if (!DECL_KINDS.has(node.kind) || isLocalVariable(node)) return null;
    return declName(node as ts.NamedDeclaration);
  };

  const isDecl = (node: ts.Node) => nameOf(node) !== null;

  // "<file>#<Outer.Inner>" for project code; "ext:<package>#<name>" otherwise.
  const declId = (decl: ts.Node): string => {
    const sf = decl.getSourceFile();
    const names: string[] = [];
    for (let n: ts.Node | undefined = decl; n && n !== sf; n = n.parent) {
      if (isDecl(n)) names.unshift(nameOf(n)!);
    }
    if (!isProjectFile(sf)) {
      const pkg = program.isSourceFileDefaultLibrary(sf) ? "lib" : packageOf(sf.fileName);
      return `ext:${pkg}#${names.join(".")}`;
    }
    return names.length ? `${rel(sf.fileName)}#${names.join(".")}` : rel(sf.fileName);
  };

  const enclosingId = (node: ts.Node): string => {
    for (let n = node.parent; n; n = n.parent) {
      if (ts.isSourceFile(n)) return rel(n.fileName);
      if (isDecl(n)) return declId(n);
    }
    throw new Error("node outside a source file");
  };

  // "local" when the callee is a local variable or parameter inside a
  // function (a helper, a callback passed in): real, but not a node.
  const resolveCallee = (call: ts.CallExpression | ts.NewExpression): string | "local" | null => {
    const target = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
    let symbol = checker.getSymbolAtLocation(target);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!decl) return null;
    if (isProjectFile(decl.getSourceFile()) && !isDecl(decl)) return "local";
    return declId(decl);
  };

  const decls: DeclFact[] = [];
  const calls: CallFact[] = [];

  for (const sf of program.getSourceFiles()) {
    if (!isProjectFile(sf)) continue;
    decls.push({ id: rel(sf.fileName), name: path.basename(sf.fileName), tsKind: "SourceFile", containerId: null, loc: { file: rel(sf.fileName), line: 1 } });

    const visit = (node: ts.Node) => {
      if (isDecl(node)) {
        const reg = registration(node);
        decls.push({
          id: declId(node),
          name: nameOf(node)!,
          tsKind: ts.SyntaxKind[node.kind],
          containerId: enclosingId(node),
          loc: locOf(node),
          ...(reg && { registration: reg }),
          ...(isFunctionValue(node) && { functionValue: true as const }),
        });
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        const callee = resolveCallee(node);
        calls.push({
          callerId: enclosingId(node),
          calleeId: callee === "local" ? null : callee,
          ...(callee === "local" && { localCallee: true as const }),
          calleeText: calleeText(node.expression),
          argTypes: (node.arguments ?? []).map((a) => checker.typeToString(checker.getTypeAtLocation(a))),
          returnType: signature ? checker.typeToString(checker.getReturnTypeOfSignature(signature)) : "unknown",
          loc: locOf(node),
        });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  return { decls, calls };
}

function isFunctionValue(node: ts.Node): boolean {
  if (!ts.isVariableDeclaration(node) && !ts.isPropertyDeclaration(node)) return false;
  const init = node.initializer;
  return !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
}

// One line, so inline callees (IIFEs, callbacks) stay readable.
function calleeText(expr: ts.Expression): string {
  const text = expr.getText().split("\n")[0];
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

// Only module-level variables are structural; locals belong to their function.
function isLocalVariable(node: ts.Node): boolean {
  if (!ts.isVariableDeclaration(node)) return false;
  const statement = node.parent?.parent; // VariableDeclarationList -> VariableStatement
  return !(statement && ts.isVariableStatement(statement) && (ts.isSourceFile(statement.parent) || ts.isModuleBlock(statement.parent)));
}

function declName(node: ts.NamedDeclaration): string | null {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const name = node.name;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null; // destructuring patterns, computed names
}

function packageOf(fileName: string): string {
  const parts = fileName.split(/[\\/]/);
  const i = parts.lastIndexOf("node_modules");
  if (i === -1) return "lib";
  return parts[i + 1].startsWith("@") ? `${parts[i + 1]}/${parts[i + 2]}` : parts[i + 1];
}
