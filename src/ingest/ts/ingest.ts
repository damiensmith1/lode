import path from "node:path";
import ts from "typescript";
import type { CallFact, DeclFact, FileFacts, FlowFact, Location, RefFact, TsFacts } from "./facts.js";
import { returningFunction, sourceCalls } from "./flows.js";
import { loadProject, type Project } from "./project.js";
import { referenceOf } from "./refs.js";
import { regionsOf } from "./regions.js";
import { bridgeReceiveOf, bridgeSendOf, channelFactOf, type ChannelFact, keyParamOf, resolveEndpoints } from "./channels.js";
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

// Whole project in one pass. Sessions (session.ts) use the pieces below to
// re-extract only what changed.
export function ingestTsProject(projectPath: string): TsFacts {
  const project = loadProject(projectPath);
  const program = ts.createProgram(project.files, project.options);
  const extract = createExtractor(program, project);
  return mergeFacts(project.files.map((f) => extract(program.getSourceFile(f)!)));
}

export function mergeFacts(files: FileFacts[]): TsFacts {
  const calls = files.flatMap((f) => f.calls);
  return {
    decls: files.flatMap((f) => f.decls),
    calls,
    flows: files.flatMap((f) => f.flows),
    refs: files.flatMap((f) => f.refs),
    regions: files.flatMap((f) => f.regions),
    imports: Object.fromEntries(files.map((f) => [f.file, f.imports])),
    channels: resolveEndpoints(files.flatMap((f) => f.channelFacts), calls),
  };
}

// Facts for one file. Needs the whole program, since resolving names and
// types reaches into other files.
export function createExtractor(program: ts.Program, project: Project): (sf: ts.SourceFile) => FileFacts {
  const { root } = project;
  const checker = program.getTypeChecker();
  const projectFiles = new Set(project.files);

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
    if (ts.isPropertyAssignment(node)) return isObjectMember(node) ? declName(node) : null;
    if (ts.isBinaryExpression(node)) return commonJsExportName(node);
    if (isJsDocTypedef(node)) return node.name && ts.isIdentifier(node.name) ? node.name.text : null;
    if (!DECL_KINDS.has(node.kind) || isLocalVariable(node)) return null;
    return declName(node as ts.NamedDeclaration);
  };

  const isDecl = (node: ts.Node) => nameOf(node) !== null;

  // `{ hide: () => … }` members are nodes when their object is one: a
  // module-level variable, or an object handed to a registration
  // (contextBridge.exposeInMainWorld). Elsewhere they stay inside their parent.
  const isObjectMember = (node: ts.PropertyAssignment): boolean => {
    const init = node.initializer;
    if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) return false;
    const object = node.parent;
    if (registration(object)) return true;
    const holder = object.parent; // `const api = {…}` or `module.exports = {…}`
    if (ts.isVariableDeclaration(holder)) return holder.initializer === object && isDecl(holder);
    return ts.isBinaryExpression(holder) && holder.right === object && isDecl(holder);
  };

  // "<file>#<Outer.Inner>" for project code; "ext:<package>#<name>" otherwise.
  const declId = (decl: ts.Node): string => {
    const sf = decl.getSourceFile();
    const names: string[] = [];
    for (let n: ts.Node | undefined = decl; n && n !== sf; n = n.parent) {
      if (isDecl(n)) names.unshift(nameOf(n)!);
      if (isJsDocTypedef(n)) break; // module-scoped wherever the comment sits
    }
    if (!isProjectFile(sf)) {
      const pkg = program.isSourceFileDefaultLibrary(sf) ? "lib" : (packageOf(sf.fileName) ?? rel(sf.fileName));
      return `ext:${pkg}#${names.join(".")}`;
    }
    return names.length ? `${rel(sf.fileName)}#${names.join(".")}` : rel(sf.fileName);
  };

  const enclosingId = (node: ts.Node): string => {
    if (isJsDocTypedef(node)) return rel(node.getSourceFile().fileName);
    for (let n = node.parent; n; n = n.parent) {
      if (ts.isSourceFile(n)) return rel(n.fileName);
      if (isDecl(n)) return declId(n);
    }
    throw new Error("node outside a source file");
  };

  // "local" when the callee is a local variable or parameter inside a
  // function (a helper, a callback passed in): real, but not a node.
  const callees = new Map<ts.Node, string | "local" | null>();
  const resolveCallee = (call: ts.CallLikeExpression): string | "local" | null => {
    if (!callees.has(call)) callees.set(call, resolveCalleeUncached(call));
    return callees.get(call)!;
  };
  const resolveCalleeUncached = (call: ts.CallLikeExpression): string | "local" | null => {
    if (!ts.isCallExpression(call) && !ts.isNewExpression(call)) return null;
    const target = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
    let symbol = checker.getSymbolAtLocation(target);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const found = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!found) return null;
    const decl = canonicalDecl(found);
    if (isProjectFile(decl.getSourceFile()) && !isDecl(decl)) return "local";
    return declId(decl);
  };

  // The declaration that's actually a node, from what the checker hands back:
  // - `exports.f = …` declares `f` at the left-hand side; the node is the assignment.
  // - `const { f } = require("./m")` (or any destructuring) binds a local;
  //   the node is the property it was taken from.
  const canonicalDecl = (decl: ts.Node, depth = 0): ts.Node => {
    if (ts.isPropertyAccessExpression(decl) && ts.isBinaryExpression(decl.parent) && decl.parent.left === decl) return decl.parent;
    if (ts.isBindingElement(decl) && depth < 3) {
      let holder: ts.Node = decl.parent;
      while (!ts.isVariableDeclaration(holder) && holder.parent) holder = holder.parent;
      const key = decl.propertyName ?? decl.name;
      if (ts.isVariableDeclaration(holder) && holder.initializer && ts.isIdentifier(key)) {
        const prop = checker.getTypeAtLocation(holder.initializer).getProperty(key.text);
        const target = prop?.valueDeclaration ?? prop?.declarations?.[0];
        if (target) return canonicalDecl(target, depth + 1);
      }
    }
    return decl;
  };

  const nodeIdOf = (node: ts.Node) => {
    const decl = canonicalDecl(node);
    return isDecl(decl) ? declId(decl) : null;
  };

  // The node a function's return value belongs to: the function itself, or
  // the variable/property it's assigned to. Null for anonymous inner functions.
  const ownerOf = (fn: ts.Node | undefined): string | null => {
    if (!fn) return null;
    if (isDecl(fn)) return declId(fn);
    const parent = fn.parent;
    const holdsFn = (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) && parent.initializer === fn;
    return holdsFn && isDecl(parent) ? declId(parent) : null;
  };

  // Calls whose results make up `expr`, as resolved node ids (each once).
  const producers = (expr: ts.Expression): string[] => [
    ...new Set(
      sourceCalls(expr, checker)
        .map(resolveCallee)
        .filter((id): id is string => !!id && id !== "local"),
    ),
  ];
  const channelCtx = { checker, nodeIdOf, canonicalDecl, enclosingId, locOf };

  return (sf: ts.SourceFile): FileFacts => {
    const decls: DeclFact[] = [];
    const calls: CallFact[] = [];
    const channelFacts: ChannelFact[] = [];
    const flows: FlowFact[] = [];
    const refs = new Map<string, RefFact>(); // one per from/to/access, first location wins
    const seen = new Set<string>();

    const flowOut = (expr: ts.Expression, owner: string | null) => {
      if (!owner) return;
      const type = checker.typeToString(checker.getTypeAtLocation(expr));
      for (const from of producers(expr)) flows.push({ from, to: owner, within: owner, type, loc: locOf(expr) });
    };

    decls.push({ id: rel(sf.fileName), name: path.basename(sf.fileName), tsKind: "SourceFile", containerId: null, loc: { file: rel(sf.fileName), line: 1, endLine: sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1 } });

    const visit = (node: ts.Node) => {
      if (isDecl(node) && !seen.has(declId(node))) {
        // Same id twice (e.g. two `on("x", …)` in one function): the first
        // wins, and calls into either resolve to it.
        seen.add(declId(node));
        const reg = registration(node);
        decls.push({
          id: declId(node),
          name: nameOf(node)!,
          tsKind: ts.SyntaxKind[node.kind],
          containerId: enclosingId(node),
          loc: { ...locOf(node), endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1 },
          ...(reg && { registration: reg }),
          ...(isFunctionValue(node) && { functionValue: true as const }),
          ...(ts.isBinaryExpression(node) && ts.isObjectLiteralExpression(node.right) && { objectValue: true as const }),
        });
        const bridge = bridgeReceiveOf(node, registration(node.parent)?.key ?? null, channelCtx);
        if (bridge) channelFacts.push(bridge);
      }
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && !isRequire(node)) {
        const signature = checker.getResolvedSignature(node);
        const callee = resolveCallee(node);
        const argTypes = (node.arguments ?? []).map((a) => checker.typeToString(checker.getTypeAtLocation(a)));
        calls.push({
          callerId: enclosingId(node),
          calleeId: callee === "local" ? null : callee,
          ...(callee === "local" && { localCallee: true as const }),
          calleeText: calleeText(node.expression),
          argTypes,
          ...argParams(node.arguments ?? []),
          returnType: signature ? checker.typeToString(checker.getReturnTypeOfSignature(signature)) : "unknown",
          loc: locOf(node),
        });
        if (ts.isCallExpression(node)) {
          const channel = channelFactOf(node, callee === "local" ? null : callee, channelCtx);
          if (channel) channelFacts.push(channel);
          const bridge = bridgeSendOf(node, callee === "local" ? null : callee, channelCtx);
          if (bridge) channelFacts.push(bridge);
        }
        if (callee && callee !== "local") {
          const within = enclosingId(node);
          (node.arguments ?? []).forEach((arg, i) => {
            for (const from of producers(arg)) {
              flows.push({ from, to: callee, within, type: argTypes[i], loc: locOf(arg) });
            }
          });
          // The receiver of a method call is an input too: `env.save()`.
          if (ts.isPropertyAccessExpression(node.expression)) {
            const receiver = node.expression.expression;
            const type = checker.typeToString(checker.getTypeAtLocation(receiver));
            for (const from of producers(receiver)) flows.push({ from, to: callee, within, type, loc: locOf(receiver) });
          }
        }
      }
      if (ts.isIdentifier(node)) {
        const ref = referenceOf(node, channelCtx);
        const key = ref && `${ref.from}|${ref.to}|${ref.access}`;
        if (ref && !refs.has(key!)) refs.set(key!, ref);
      }
      // A module-level variable holds its initializer's result: `const cfg = readConfig()`.
      if (ts.isVariableDeclaration(node) && node.initializer && isDecl(node) && !isFunctionValue(node)) {
        for (const from of producers(node.initializer)) {
          flows.push({ from, to: declId(node), within: enclosingId(node), type: checker.typeToString(checker.getTypeAtLocation(node)), loc: locOf(node) });
        }
      }
      if (ts.isReturnStatement(node) && node.expression) flowOut(node.expression, ownerOf(returningFunction(node)));
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) flowOut(node.body, ownerOf(node));
      // JSDoc isn't part of the regular tree: typedefs and @param/@returns types live there.
      for (const doc of jsDocOf(node)) visit(doc);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    return { file: rel(sf.fileName), imports: importsOf(sf), decls, calls, channelFacts, flows, refs: [...refs.values()], regions: regionsOf(sf, rel(sf.fileName)) };
  };

  // Project files this one imports or re-exports from.
  // Includes CommonJS `require("…")` and dynamic `import("…")`.
  function importsOf(sf: ts.SourceFile): string[] {
    const imports = new Set<string>();
    const add = (spec: ts.Expression | undefined) => {
      if (!spec || !ts.isStringLiteralLike(spec)) return;
      const resolved = ts.resolveModuleName(spec.text, sf.fileName, program.getCompilerOptions(), ts.sys).resolvedModule;
      if (resolved && projectFiles.has(path.resolve(resolved.resolvedFileName))) imports.add(rel(resolved.resolvedFileName));
    };
    const walk = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
      else if (ts.isCallExpression(node)) {
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
        if (isRequire || node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
    return [...imports];
  }

  // Arguments that are the caller's own parameters, so wrappers of wrappers
  // can be followed. Omitted when there are none.
  function argParams(args: readonly ts.Expression[]) {
    const params = args.map((a) => keyParamOf(a, channelCtx));
    return params.some(Boolean) ? { argParams: params } : {};
  }
}

// `module.exports = …` and `exports.x = …` / `module.exports.x = …` at the top
// level of a file: CommonJS declarations.
function commonJsExportName(node: ts.BinaryExpression): string | null {
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
  if (!ts.isExpressionStatement(node.parent) || !ts.isSourceFile(node.parent.parent)) return null;
  const isModuleExports = (e: ts.Expression) =>
    ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "module" && e.name.text === "exports";
  if (isModuleExports(node.left)) return "module.exports";
  const left = node.left;
  if (!ts.isPropertyAccessExpression(left)) return null;
  const target = left.expression;
  return (ts.isIdentifier(target) && target.text === "exports") || isModuleExports(target) ? left.name.text : null;
}

// `require("./m")` is an import (see importsOf), not a call worth an edge.
function isRequire(node: ts.CallExpression | ts.NewExpression): boolean {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require";
}

function isJsDocTypedef(node: ts.Node): node is ts.JSDocTypedefTag | ts.JSDocCallbackTag {
  return ts.isJSDocTypedefTag(node) || ts.isJSDocCallbackTag(node);
}

// The JSDoc comments attached to a node. `jsDoc` isn't in TS's public types,
// but it's what the public JSDoc helpers read.
function jsDocOf(node: ts.Node): ts.JSDoc[] {
  return (node as { jsDoc?: ts.JSDoc[] }).jsDoc ?? [];
}

function isFunctionValue(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node)) return ts.isArrowFunction(node.right) || ts.isFunctionExpression(node.right);
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

// The npm package a library file belongs to; null for files outside
// node_modules (vendored code in the repo is named by its path instead).
function packageOf(fileName: string): string | null {
  const parts = fileName.split(/[\\/]/);
  const i = parts.lastIndexOf("node_modules");
  if (i === -1) return null;
  return parts[i + 1].startsWith("@") ? `${parts[i + 1]}/${parts[i + 2]}` : parts[i + 1];
}
