import path from "node:path";
import ts from "typescript";
import type { CallFact, DeclFact, FileFacts, FlowFact, Location, RefFact, TsFacts } from "./facts.js";
import { returningFunction, sourceCalls } from "./flows.js";
import { isVueVirtual, loadProject, realFile, withProjectResolution, type Project } from "./project.js";
import { readFileSync } from "node:fs";
import { referenceOf } from "./refs.js";
import { regionsOf } from "./regions.js";
import { bridgeReceiveOf, bridgeSendOf, channelFactOf, type ChannelFact, keyParamOf, resolveEndpoints } from "./channels.js";
import { type Registration, registrationOf } from "./registrations.js";
import { angularComponentOf, appOf, declRegistration, defaultExportName, fileRouteOf, frameworksOf, navigationOf, pathOf, type PathResolver, reexportedDefault, routeEntryOf, templateUses } from "./frameworks.js";
import type { ChannelEndpoint } from "../../schema/index.js";

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
  const program = ts.createProgram(project.files, project.options, withProjectResolution(ts.createCompilerHost(project.options), project.root, project.options));
  const extract = createExtractor(program, project);
  return mergeFacts(project.files.map((f) => extract(program.getSourceFile(f)!)));
}

export function mergeFacts(files: FileFacts[]): TsFacts {
  const calls = [...files.flatMap((f) => f.calls), ...templateCalls(files)];
  return {
    decls: withNamedRegistrations(files),
    calls,
    flows: files.flatMap((f) => f.flows),
    refs: files.flatMap((f) => f.refs),
    regions: files.flatMap((f) => f.regions),
    imports: Object.fromEntries(files.map((f) => [f.file, f.imports])),
    channels: [...resolveEndpoints(files.flatMap((f) => f.channelFacts), calls), ...files.flatMap((f) => f.endpoints ?? [])],
  };
}

const VERB_NAMES = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

// Elements in templates that are components elsewhere (<app-article-meta>,
// <ArticleCard>, <article-card>): a call from the component using them.
function templateCalls(files: FileFacts[]): CallFact[] {
  const bySelector = new Map<string, string>();
  for (const f of files) for (const s of f.selectors ?? []) bySelector.set(s.selector.toLowerCase(), s.id);
  if (!bySelector.size) return [];
  return files.flatMap((f) =>
    (f.templateTags ?? []).flatMap((t) => {
      const id = bySelector.get(t.tag.toLowerCase()) ?? bySelector.get(t.tag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/^./, (c) => c.toUpperCase()).toLowerCase());
      return id && id !== t.from ? [{ callerId: t.from, calleeId: id, calleeText: t.tag, argTypes: [], returnType: "", loc: { file: f.file, line: t.line } }] : [];
    }),
  );
}

// Handlers registered by name in another file (app.get("/x", listUsers))
// get their registration here, where every file's declarations are.
function withNamedRegistrations(files: FileFacts[]): DeclFact[] {
  const named = new Map(files.flatMap((f) => f.namedRegistrations ?? []).map((r) => [r.id, r.registration]));
  // Express: a router's routes are under every prefix it's mounted at, up the
  // chain (articles router in api, api at "/api": /api/articles).
  const parents = new Map<string, { parent: string; prefix: string }>();
  for (const m of files.flatMap((f) => f.mounts ?? [])) if (!parents.has(m.child)) parents.set(m.child, { parent: m.parent, prefix: m.prefix });
  const prefixOf = (router: string, seen = new Set<string>()): string => {
    const up = parents.get(router);
    if (!up || seen.has(router)) return "";
    seen.add(router);
    return prefixOf(up.parent, seen) + up.prefix;
  };
  const join = (...parts: string[]) => `/${parts.map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")}`;
  for (const r of files.flatMap((f) => f.routerRoutes ?? [])) {
    const prefix = prefixOf(r.router);
    if (!prefix) continue;
    for (const h of r.handlers) named.set(h, { call: r.verb, key: join(prefix, r.path), category: "routes" });
  }
  const decls = files.flatMap((f) => f.decls);
  // Named registrations fill in; a mounted router's full path replaces a route's own.
  return named.size ? decls.map((d) => (named.has(d.id) && (!d.registration || d.registration.category === "routes") ? { ...d, registration: named.get(d.id)! } : d)) : decls;
}

// Facts for one file. Needs the whole program, since resolving names and
// types reaches into other files.
export function createExtractor(program: ts.Program, project: Project): (sf: ts.SourceFile) => FileFacts {
  const { root } = project;
  const checker = program.getTypeChecker();
  const projectFiles = new Set(project.files);

  const rel = (fileName: string) => path.relative(root, realFile(fileName)).split(path.sep).join("/");
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
    const endpoints: ChannelEndpoint[] = [];
    const namedRegistrations: NonNullable<FileFacts["namedRegistrations"]> = [];
    const selectors: NonNullable<FileFacts["selectors"]> = [];
    const templateTags: NonNullable<FileFacts["templateTags"]> = [];
    const fw = frameworksOf(sf.fileName, root);
    const app = appOf(realFile(sf.fileName), root);
    const route = fileRouteOf(rel(sf.fileName), fw);
    const defaultName = defaultExportName(sf);
    // A route file whose page is re-exported from elsewhere: the page is that declaration.
    const reexport = route && (route.kind === "page" || route.kind === "layout") ? reexportedDefault(sf) : null;
    // A symbol's declaration, if it's a node.
    const declOf = (e: ts.Node): string | null => {
      // import("./X.vue") / import("./page"): the module, as its file's node.
      if (ts.isCallExpression(e) && e.expression.kind === ts.SyntaxKind.ImportKeyword && e.arguments[0]) {
        const mod = checker.getSymbolAtLocation(e.arguments[0]);
        const file = mod?.valueDeclaration && ts.isSourceFile(mod.valueDeclaration) ? mod.valueDeclaration : null;
        return file && isProjectFile(file) ? rel(file.fileName) : null;
      }
      let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const found = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      // export default router / export default Router().use(…): what it exports.
      if (found && ts.isExportAssignment(found)) return ts.isIdentifier(found.expression) ? declOf(found.expression) : `${rel(found.getSourceFile().fileName)}::default`;
      const decl = found && canonicalDecl(found);
      return decl && isDecl(decl) ? declId(decl) : null;
    };
    // An Express router's identity: the variable holding it, or (an anonymous
    // default export) its file's default. Chains (Router().use(a).use(b)) are the root's.
    const routerOf = (receiver: ts.Expression): string | null => {
      let e = receiver;
      while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) e = e.expression.expression;
      if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) return declOf(e);
      let top: ts.Node = e;
      while (top.parent && (ts.isPropertyAccessExpression(top.parent) || (ts.isCallExpression(top.parent) && top.parent.expression === top))) top = top.parent;
      if (ts.isVariableDeclaration(top.parent) && isDecl(top.parent)) return declId(top.parent);
      if (ts.isExportAssignment(top.parent)) return `${rel(sf.fileName)}::default`;
      return null;
    };
    // A path the code computes from something static: a constant the checker
    // knows (ROUTES.HOME: "/home"), a helper that returns a template
    // (getHref: (id) => `/app/discussions/${id}`), a variable holding one.
    const resolvePath = (e: ts.Expression, depth = 0): ReturnType<PathResolver> => {
      if (depth > 4) return null;
      const type = checker.getTypeAtLocation(e);
      if (type.isStringLiteral()) return { key: type.value, pattern: false };
      const next: PathResolver = (x) => resolvePath(x, depth + 1);
      const target = ts.isCallExpression(e) ? e.expression : e;
      let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(target) ? target.name : target);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const decl = symbol?.valueDeclaration;
      if (!decl) return null;
      const init = ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl) ? decl.initializer : ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) ? decl : undefined;
      if (!init) return null;
      if (!ts.isCallExpression(e)) return ts.isFunctionDeclaration(init) || ts.isMethodDeclaration(init) ? null : pathOf(init, next);
      // A call: what the function returns.
      const fn = ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isFunctionDeclaration(init) || ts.isMethodDeclaration(init) ? init : null;
      const body = fn?.body;
      if (!body) return null;
      if (!ts.isBlock(body)) return pathOf(body, next);
      const ret = body.statements.find(ts.isReturnStatement);
      return ret?.expression ? pathOf(ret.expression, next) : null;
    };
    const mounts: NonNullable<FileFacts["mounts"]> = [];
    const routerRoutes: NonNullable<FileFacts["routerRoutes"]> = [];

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
        const reg = registration(node) ?? declRegistration(node, sf, route, defaultName);
        // A page or screen is where navigation to its path arrives.
        if (reg && route && (route.kind === "page" || route.kind === "api") && reg.key === route.display && (reg.call === route.name || VERB_NAMES.has(reg.call))) {
          endpoints.push({ node: declId(node), role: "receive", family: "route", key: route.pattern, pattern: route.pattern.includes("*"), loc: locOf(node) });
        }
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
      // Angular: what a component's template uses: its methods, child components, router links.
      if (ts.isClassDeclaration(node) && node.name && isDecl(node)) {
        const component = angularComponentOf(node, sf);
        if (component) {
          const id = declId(node);
          const file = rel(sf.fileName);
          const members = new Set(node.members.flatMap((m) => (m.name && ts.isIdentifier(m.name) ? [m.name.text] : [])));
          for (const c of component.calls) if (members.has(c.name)) calls.push({ callerId: id, calleeId: `${id}.${c.name}`, calleeText: c.name, argTypes: [], returnType: "", loc: { file, line: c.line } });
          if (component.selector) selectors.push({ selector: component.selector, id });
          for (const t of component.tags) templateTags.push({ from: id, tag: t.tag, line: t.line });
          for (const l of component.links) endpoints.push({ node: id, role: "send", family: l.family ?? "route", key: l.key, pattern: l.pattern, loc: { file, line: l.line } });
        }
      }
      // Navigation: where this asks to go, and route tables saying what's where.
      const nav = navigationOf(node, sf, resolvePath);
      if (nav) endpoints.push({ node: enclosingId(node), role: "send", family: nav.family, key: nav.key, pattern: nav.pattern, loc: locOf(node) });
      const entry = routeEntryOf(node, sf);
      const target = entry && declOf(entry.component);
      if (entry && target) {
        endpoints.push({ node: target, role: "receive", family: entry.family, key: entry.key, pattern: entry.pattern, loc: locOf(node) });
        if (entry.name) endpoints.push({ node: target, role: "receive", family: "route-name", key: entry.name, pattern: false, loc: locOf(node) });
      }
      // Express: app.get("/users", auth, listUsers): named handlers are routes;
      // which router it's on, and where routers are mounted, give the full path.
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && /^(get|post|put|patch|delete|all)$/.test(node.expression.name.text) && node.arguments.length >= 2) {
        const first = node.arguments[0];
        if (ts.isStringLiteralLike(first) && first.text.startsWith("/")) {
          const verb = node.expression.name.text.toUpperCase();
          const last = node.arguments[node.arguments.length - 1];
          const id = ts.isIdentifier(last) || ts.isPropertyAccessExpression(last) ? declOf(last) : null;
          if (id) namedRegistrations.push({ id, registration: { call: verb, key: first.text, category: "routes" } });
          const handlers = node.arguments.slice(1).map((a) => (isDecl(a) ? declId(a) : id && a === last ? id : null)).filter((x): x is string => !!x);
          const router = routerOf(node.expression.expression);
          if (router && handlers.length) routerRoutes.push({ router, verb, path: first.text, handlers });
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "use" && node.arguments.length) {
        const first = node.arguments[0];
        const prefix = ts.isStringLiteralLike(first) ? first.text : "";
        const parent = routerOf(node.expression.expression);
        for (const a of node.arguments.slice(prefix ? 1 : 0)) {
          const child = ts.isIdentifier(a) || ts.isPropertyAccessExpression(a) ? declOf(a) : null;
          if (parent && child) mounts.push({ parent, child, prefix });
        }
      }
      // JSX: <UserCard user={u} /> renders UserCard, a call in all but syntax.
      // Components are capitalised (lower-case tags are HTML elements).
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && /^[A-Z]|\./.test(node.tagName.getText(sf))) {
        const tag = ts.isPropertyAccessExpression(node.tagName) ? node.tagName.name : node.tagName;
        let symbol = checker.getSymbolAtLocation(tag);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        const found = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
        const decl = found && canonicalDecl(found);
        if (decl && isDecl(decl)) {
          calls.push({ callerId: enclosingId(node), calleeId: declId(decl), calleeText: node.tagName.getText(sf), argTypes: [], returnType: "JSX.Element", loc: locOf(node) });
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
    // Vue: the component's template uses its script's functions, child components and router links.
    if (isVueVirtual(sf.fileName)) vueTemplate();
    function vueTemplate() {
      const real = realFile(sf.fileName);
      let text = "";
      try {
        text = readFileSync(real, "utf8");
      } catch {
        return;
      }
      // Vue: the <template>; Svelte: everything outside <script> and <style>.
      const m = /<template\b[^>]*>([\s\S]*)<\/template>/.exec(text) ?? (real.endsWith(".svelte") ? ([text, text.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, (x) => x.replace(/[^\n]/g, " "))] as unknown as RegExpExecArray) : null);
      if (!m) return;
      const start = m.index ?? 0;
      const offset = m[0].indexOf(m[1]) >= 0 ? m[0].indexOf(m[1]) : 0;
      const lineAt = (at: number) => sf.getLineAndCharacterOfPosition(Math.min(start + offset + at, sf.getEnd())).line + 1;
      const uses = templateUses(m[1], lineAt);
      const file = rel(sf.fileName);
      // Names in the script's scope: its own functions and what it imports.
      const scope = new Map<string, ts.Node>();
      for (const s of sf.statements) {
        if (ts.isFunctionDeclaration(s) && s.name) scope.set(s.name.text, s);
        if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) scope.set(d.name.text, d);
        if (ts.isImportDeclaration(s) && s.importClause) {
          if (s.importClause.name) scope.set(s.importClause.name.text, s.importClause.name);
          const named = s.importClause.namedBindings;
          if (named && ts.isNamedImports(named)) for (const e of named.elements) scope.set(e.name.text, e.name);
        }
      }
      const target = (name: string): string | null => {
        const n = scope.get(name);
        if (!n) return null;
        if (isDecl(n)) return declId(n);
        // A default import of another component: its file.
        const imp = n.parent && ts.isImportClause(n.parent) ? n.parent.parent : null;
        if (imp && ts.isImportDeclaration(imp)) {
          const mod = checker.getSymbolAtLocation(imp.moduleSpecifier);
          const f = mod?.valueDeclaration && ts.isSourceFile(mod.valueDeclaration) ? mod.valueDeclaration : null;
          if (f && isProjectFile(f) && isVueVirtual(f.fileName)) return rel(f.fileName);
        }
        return declOf(n);
      };
      const pascal = (tag: string) => tag.replace(/(^|-)([a-z])/g, (_, __, c: string) => c.toUpperCase());
      for (const c of uses.calls) {
        const id = target(c.name);
        if (id) calls.push({ callerId: file, calleeId: id, calleeText: c.name, argTypes: [], returnType: "", loc: { file, line: c.line } });
      }
      for (const t of uses.tags) {
        const id = target(pascal(t.tag));
        if (id && id !== file) calls.push({ callerId: file, calleeId: id, calleeText: t.tag, argTypes: [], returnType: "", loc: { file, line: t.line } });
      }
      for (const l of uses.links) endpoints.push({ node: file, role: "send", family: l.family ?? "route", key: l.key, pattern: l.pattern, loc: { file, line: l.line } });
      // A page that is a component file (Nuxt's pages/*.vue, SvelteKit's +page.svelte): the file receives its route.
      if (route && (route.kind === "page" || route.kind === "layout")) {
        const own = decls.find((d) => d.id === file);
        if (own && !own.registration) own.registration = { call: route.name, key: route.display, category: "routes" };
        if (route.kind === "page") endpoints.push({ node: file, role: "receive", family: "route", key: route.pattern, pattern: route.pattern.includes("*"), loc: { file, line: 1 } });
      }
    }
    if (reexport && route) {
      let symbol = checker.getSymbolAtLocation(reexport.propertyName ?? reexport.name);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const found = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      const decl = found && canonicalDecl(found);
      if (decl && isDecl(decl)) {
        const id = declId(decl);
        namedRegistrations.push({ id, registration: { call: route.name, key: route.display, category: "routes" } });
        if (route.kind === "page") endpoints.push({ node: id, role: "receive", family: "route", key: route.pattern, pattern: route.pattern.includes("*"), loc: locOf(reexport) });
      }
    }
    return {
      file: rel(sf.fileName),
      imports: importsOf(sf),
      decls,
      calls,
      channelFacts,
      flows,
      refs: [...refs.values()],
      regions: regionsOf(sf, rel(sf.fileName)),
      ...(endpoints.length && { endpoints: endpoints.map((e) => (/^(route|screen|route-name)$/.test(e.family) ? { ...e, family: `${e.family}@${app}` } : e)) }),
      ...(namedRegistrations.length && { namedRegistrations }),
      ...(selectors.length && { selectors }),
      ...(mounts.length && { mounts }),
      ...(routerRoutes.length && { routerRoutes }),
      ...(templateTags.length && { templateTags }),
    };
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
