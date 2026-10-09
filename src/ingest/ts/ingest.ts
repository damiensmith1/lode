import path from "node:path";
import ts from "typescript";
import type { CallFact, DeclFact, FileFacts, FlowFact, Location, RefFact, TsFacts } from "./facts.js";
import { returningFunction, sourceCalls } from "./flows.js";
import { referenceOf } from "./refs.js";
import { channelFactOf, type ChannelFact, keyParamOf, resolveEndpoints } from "./channels.js";
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

export interface Project {
  root: string;
  options: ts.CompilerOptions;
  files: string[]; // absolute paths of the project's own source files
}

export function loadProject(tsconfigPath: string): Project {
  const root = path.dirname(path.resolve(tsconfigPath));
  const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  return { root, options: parsed.options, files: parsed.fileNames.map((f) => path.resolve(f)) };
}

// Whole project in one pass. Sessions (session.ts) use the pieces below to
// re-extract only what changed.
export function ingestTsProject(tsconfigPath: string): TsFacts {
  const project = loadProject(tsconfigPath);
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
    return ts.isVariableDeclaration(object.parent) && object.parent.initializer === object && isDecl(object.parent);
  };

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
    const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!decl) return null;
    if (isProjectFile(decl.getSourceFile()) && !isDecl(decl)) return "local";
    return declId(decl);
  };

  const nodeIdOf = (node: ts.Node) => (isDecl(node) ? declId(node) : null);

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
  const channelCtx = { checker, nodeIdOf, enclosingId, locOf };

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

    decls.push({ id: rel(sf.fileName), name: path.basename(sf.fileName), tsKind: "SourceFile", containerId: null, loc: { file: rel(sf.fileName), line: 1 } });

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
          loc: locOf(node),
          ...(reg && { registration: reg }),
          ...(isFunctionValue(node) && { functionValue: true as const }),
        });
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
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
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    return { file: rel(sf.fileName), decls, calls, channelFacts, flows, refs: [...refs.values()] };
  };

  // Arguments that are the caller's own parameters, so wrappers of wrappers
  // can be followed. Omitted when there are none.
  function argParams(args: readonly ts.Expression[]) {
    const params = args.map((a) => keyParamOf(a, channelCtx));
    return params.some(Boolean) ? { argParams: params } : {};
  }
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
