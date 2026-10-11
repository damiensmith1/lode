import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { ChannelEndpoint } from "../../schema/index.js";
import type { Registration } from "./registrations.js";

// What TS/JS frameworks connect by convention, read from each file's syntax
// and path. Routes are entries (by verb or kind, and path); navigation is a
// channel from where it's asked for to the page or screen it opens:
//   Next.js     app/**/page|layout|route.ts(x) and pages/** (pages/api/**),
//               server actions ("use server"), middleware, data functions
//   Expo Router app/** files (index, [id], (group), _layout)
//   navigation  <Link href|to="/x">, router.push/replace("/x"), redirect("/x"),
//               navigate("/x") → family "route"; navigation.navigate("Profile")
//               → "screen" (React Navigation)
//   routes      { path: "x", element: <C/> | Component: C | component: C }
//               (React Router, Angular, Vue Router); <X.Screen name component={C}>
//   Express     app.get("/x", handler, …) with named handlers (inline ones
//               are registrations already)
//   Nest        @Controller("users") + @Get(":id") (and @Post…, @MessagePattern,
//               @EventPattern, @Cron, @OnEvent, @Process, GraphQL @Query/@Mutation)

const VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export type Frameworks = Set<string>;

// The app a file belongs to (the folder of its nearest package.json): routes
// and screens are per app, so two apps' /posts don't link to each other.
const appFolders = new Map<string, string>();
export function appOf(file: string, root: string): string {
  const dir = path.dirname(file);
  const hit = appFolders.get(dir);
  if (hit !== undefined) return hit;
  let app = "";
  for (let d = dir; d.startsWith(root); d = path.dirname(d)) {
    if (existsSync(path.join(d, "package.json"))) {
      app = path.relative(root, d).split(path.sep).join("/");
      break;
    }
    if (d === root || d === path.dirname(d)) break;
  }
  appFolders.set(dir, app);
  return app;
}

// The frameworks a file's nearest package.json depends on.
const byFolder = new Map<string, Frameworks>();
export function frameworksOf(file: string, root: string): Frameworks {
  const dir = path.dirname(file);
  const hit = byFolder.get(dir);
  if (hit) return hit;
  let found: Frameworks | null = null;
  for (let d = dir; d.startsWith(root); d = path.dirname(d)) {
    const pkg = path.join(d, "package.json");
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, "utf8")) as Record<string, Record<string, string> | undefined>;
        const deps = { ...json.dependencies, ...json.devDependencies, ...json.peerDependencies };
        found = new Set(
          Object.keys(deps).flatMap((n) =>
            n === "next" ? ["next"] : n === "expo-router" ? ["expo-router"] : n === "nuxt" ? ["nuxt", "vue"] : n === "@sveltejs/kit" ? ["sveltekit"] : /^@remix-run\/(react|dev)$|^@react-router\/dev$/.test(n) ? ["remix", "react-router"] : /^react-router(-dom)?$/.test(n) ? ["react-router"] : n.startsWith("@react-navigation/") ? ["react-navigation"] : n === "express" ? ["express"] : n.startsWith("@nestjs/") ? ["nest"] : n === "@angular/core" ? ["angular"] : n === "vue" || n === "vue-router" ? ["vue"] : [],
          ),
        );
        if (found.size || d === root) break;
      } catch {
        // unreadable: keep looking up
      }
    }
    if (d === root || d === path.dirname(d)) break;
  }
  const result = found ?? new Set<string>();
  byFolder.set(dir, result);
  return result;
}

// --- file-based routes ------------------------------------------------------------

export interface FileRoute {
  kind: "page" | "layout" | "api" | "special";
  name: string; // what to call it: "page", "layout", "loading"…
  display: string; // /product/[handle]
  pattern: string; // /product/*
}

// A file's route under Next.js (app or pages router) or Expo Router.
export function fileRouteOf(rel: string, fw: Frameworks): FileRoute | null {
  const clean = (segments: string[]) => {
    const kept = segments.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@")); // (groups), @parallel slots
    const display = `/${kept.join("/")}`.replace(/\/index$|\/$/, "") || "/";
    const pattern = display.replace(/\[\[?\.{3}[^\]]+\]?\]/g, "**").replace(/\[[^\]]+\]|:\w+/g, "*");
    return { display, pattern };
  };
  if (fw.has("next")) {
    const app = /(?:^|\/)(?:src\/)?app\/(.*?)\/?(page|layout|route|loading|error|not-found|template|default|opengraph-image|twitter-image|icon|sitemap|robots|manifest)\.[cm]?[jt]sx?$/.exec(rel);
    if (app) {
      const { display, pattern } = clean(app[1] ? app[1].split("/") : []);
      const kind = app[2] === "page" ? "page" : app[2] === "layout" ? "layout" : app[2] === "route" ? "api" : "special";
      return { kind, name: app[2], display, pattern };
    }
    const pages = /(?:^|\/)(?:src\/)?pages\/(.+)\.[cm]?[jt]sx?$/.exec(rel);
    if (pages && !/(^|\/)_(app|document|error)$/.test(pages[1])) {
      const { display, pattern } = clean(pages[1].split("/"));
      return { kind: pages[1].startsWith("api/") ? "api" : "page", name: pages[1].startsWith("api/") ? "api" : "page", display, pattern };
    }
    if (/(?:^|\/)(?:src\/)?middleware\.[jt]s$/.test(rel)) return { kind: "special", name: "middleware", display: "/*", pattern: "/*" };
  }
  if (fw.has("nuxt")) {
    const page = /(?:^|\/)pages\/(.+)\.vue$/.exec(rel);
    if (page) return { kind: "page", name: "page", ...clean(page[1].split("/")) };
    const api = /(?:^|\/)server\/(api|routes)\/(.+?)(?:\.(get|post|put|patch|delete))?\.[jt]s$/.exec(rel);
    if (api) return { kind: "api", name: api[3]?.toUpperCase() ?? "api", ...clean([...(api[1] === "api" ? ["api"] : []), ...api[2].split("/")]) };
  }
  if (fw.has("sveltekit")) {
    const m = /(?:^|\/)src\/routes\/(?:(.*)\/)?\+(page|layout|server|error)(?:\.server)?\.(svelte|[jt]s)$/.exec(rel);
    if (m) {
      const segments = m[1] ? m[1].split("/") : [];
      const kind = m[2] === "server" ? "api" : m[2] === "page" ? "page" : m[2] === "layout" ? "layout" : "special";
      return { kind, name: m[2] === "server" ? "api" : m[2], ...clean(segments) };
    }
  }
  if (fw.has("remix")) {
    // Flat routes: app/routes/posts.$slug.tsx → /posts/:slug; _index → /; _layout. prefixes drop out.
    const m = /(?:^|\/)app\/routes\/(.+?)(?:\/route)?\.[jt]sx?$/.exec(rel);
    if (m) {
      const segments = m[1].split(".").filter((s) => s !== "_index" && !/^_/.test(s)).map((s) => (s.startsWith("$") ? (s === "$" ? "[...rest]" : `[${s.slice(1)}]`) : s.replace(/_$/, "")));
      return { kind: "page", name: "route", ...clean(segments) };
    }
  }
  if (fw.has("expo-router")) {
    const m = /(?:^|\/)(?:src\/)?app\/(.+)\.[jt]sx?$/.exec(rel);
    if (m && !/(^|\/)\+(html|native-intent)$/.test(m[1])) {
      const segments = m[1].split("/");
      const last = segments[segments.length - 1];
      if (last === "_layout") return { kind: "layout", name: "layout", ...clean(segments.slice(0, -1)) };
      if (last.startsWith("+")) return { kind: "special", name: last.slice(1), ...clean(segments.slice(0, -1)) };
      return { kind: "page", name: "screen", ...clean(segments) };
    }
  }
  return null;
}

// The file's default export, by name (function Foo / const Foo … export
// default Foo, also export default memo(Foo) / withAuth(Foo)).
export function defaultExportName(sf: ts.SourceFile): string | null {
  for (const s of sf.statements) {
    if (ts.isExportAssignment(s) && !s.isExportEquals) {
      let e: ts.Expression = s.expression;
      while (ts.isCallExpression(e) && e.arguments.length) e = e.arguments[0];
      if (ts.isIdentifier(e)) return e.text;
    }
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && hasModifier(s, ts.SyntaxKind.DefaultKeyword) && s.name) return s.name.text;
  }
  return null;
}

// export { FeedScreen as default } from "…" / export { default } from "…":
// the specifier, to resolve to the declaration in the other file.
export function reexportedDefault(sf: ts.SourceFile): ts.ExportSpecifier | null {
  for (const s of sf.statements) {
    if (!ts.isExportDeclaration(s) || !s.exportClause || !ts.isNamedExports(s.exportClause)) continue;
    const spec = s.exportClause.elements.find((e) => e.name.text === "default");
    if (spec) return spec;
  }
  return null;
}

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some((m) => m.kind === kind) ?? false;
}

function isExported(node: ts.Node): boolean {
  if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) return true;
  if (ts.isVariableDeclaration(node)) return hasModifier(node.parent.parent, ts.SyntaxKind.ExportKeyword);
  return false;
}

const directive = (body: ts.NodeArray<ts.Statement> | undefined, text: string) => {
  const first = body?.[0];
  return !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === text;
};

// What a declaration is to its framework, if anything: a page, a route
// handler, a server action, a Nest endpoint.
export function declRegistration(node: ts.Node, sf: ts.SourceFile, route: FileRoute | null, defaultName: string | null): Registration | null {
  const name = nameOfDecl(node);
  if (!name) return null;
  if (route) {
    if (route.kind === "api" && VERBS.has(name) && isExported(node)) return { call: name, key: route.display, category: "routes" };
    if (name === defaultName && (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isClassDeclaration(node)))
      return { call: route.name, key: route.display, category: "routes" };
    if (/^(getServerSideProps|getStaticProps|getStaticPaths|generateMetadata|generateStaticParams|loader|clientLoader|action|clientAction|load|actions)$/.test(name) && isExported(node)) return { call: name, key: route.display, category: "routes" };
  }
  // Angular lifecycle hooks: the framework calls them.
  if (ts.isMethodDeclaration(node) && /^ng[A-Z]\w+$/.test(name) && ts.isClassDeclaration(node.parent) && decoratorsOf(node.parent).some((d) => /^(Component|Directive|Pipe|Injectable)$/.test(d.name)))
    return { call: name, key: node.parent.name?.text ?? null, category: "events" };
  // Server actions: in a "use server" file, or a function that says so.
  const fnBody = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ? node.body?.statements : ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && ts.isBlock(node.initializer.body) ? node.initializer.body.statements : undefined;
  if ((directive(sf.statements, "use server") && isExported(node) && (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node))) || directive(fnBody, "use server"))
    return { call: "server action", key: name, category: "actions" };
  // Nest: @Get(":id") in a @Controller("users").
  if (ts.isMethodDeclaration(node)) {
    for (const d of decoratorsOf(node)) {
      const verb = /^(Get|Post|Put|Patch|Delete|Head|Options|All)$/.exec(d.name);
      if (verb) {
        const base = ts.isClassDeclaration(node.parent) ? decoratorsOf(node.parent).find((c) => c.name === "Controller")?.arg ?? "" : "";
        return { call: verb[1].toUpperCase(), key: `/${[base, d.arg ?? ""].map((p) => p.replace(/^\/|\/$/g, "")).filter(Boolean).join("/")}`, category: "routes" };
      }
      if (/^(MessagePattern|EventPattern|OnEvent|SubscribeMessage)$/.test(d.name)) return { call: d.name, key: d.arg, category: "events" };
      if (/^(Cron|Interval|Timeout|Process)$/.test(d.name)) return { call: d.name, key: d.arg, category: "jobs" };
      if (/^(Query|Mutation|Subscription|ResolveField)$/.test(d.name)) return { call: d.name, key: d.arg ?? name, category: "routes" };
    }
  }
  return null;
}

function nameOfDecl(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  return null;
}

function decoratorsOf(node: ts.Node): { name: string; arg: string | null }[] {
  const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
  return decorators.map((d) => {
    const e = d.expression;
    const call = ts.isCallExpression(e) ? e : null;
    const callee = call ? call.expression : e;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    const first = call?.arguments[0];
    return { name, arg: first && ts.isStringLiteralLike(first) ? first.text : null };
  });
}

// --- navigation and route tables ------------------------------------------------------

// Paths that aren't written out (ROUTES.HOME, paths.discussion.getHref(id)):
// the ingest's answer, from the type checker.
export type PathResolver = (e: ts.Expression) => { key: string; pattern: boolean } | null;

// A path as written: "/x", `/product/${id}` (→ /product/*), { pathname: "/x" }.
export function pathOf(e: ts.Expression | undefined, resolve?: PathResolver): { key: string; pattern: boolean } | null {
  if (!e) return null;
  if (ts.isStringLiteralLike(e)) return { key: e.text, pattern: false };
  if (ts.isTemplateExpression(e)) return { key: e.head.text + e.templateSpans.map((s) => `*${s.literal.text}`).join(""), pattern: true };
  if (ts.isObjectLiteralExpression(e)) {
    const p = e.properties.find((x) => ts.isPropertyAssignment(x) && ts.isIdentifier(x.name) && x.name.text === "pathname");
    return p && ts.isPropertyAssignment(p) ? pathOf(p.initializer, resolve) : null;
  }
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) return pathOf(e.expression, resolve);
  // Angular: router.navigate(["/article", slug])
  if (ts.isArrayLiteralExpression(e) && e.elements.length) {
    const parts = e.elements.map((x) => (ts.isStringLiteralLike(x) ? x.text : "*"));
    return { key: parts.join("/").replace(/\/{2,}/g, "/"), pattern: parts.includes("*") };
  }
  return resolve ? resolve(e) : null;
}

// Route keys match with params as wildcards: /product/[handle], /product/:handle → /product/*.
function routeKey(p: { key: string; pattern: boolean }): { key: string; pattern: boolean } {
  const key = p.key.split(/[?#]/)[0].replace(/\[\[?\.{3}[^\]]+\]?\]/g, "**").replace(/\[[^\]]+\]|:\w+/g, "*");
  const clean = key.length > 1 ? key.replace(/\/$/, "") : key;
  return { key: clean.startsWith("/") ? clean : `/${clean}`, pattern: p.pattern || clean.includes("*") };
}

export interface NavSend {
  family: "route" | "screen" | "route-name";
  key: string;
  pattern: boolean;
}

// Where a call or JSX element asks to go.
export function navigationOf(node: ts.Node, sf: ts.SourceFile, resolve?: PathResolver): NavSend | null {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    const receiver = ts.isPropertyAccessExpression(callee) ? callee.expression.getText(sf) : "";
    // router.push({ name: "article" }) / routerPush("article"): a named route.
    const arg = node.arguments[0];
    if (arg && ts.isObjectLiteralExpression(arg)) {
      const named = arg.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "name");
      if (named && ts.isStringLiteralLike(named.initializer) && /^(push|replace|navigate)$/.test(name)) return { family: "route-name", key: named.initializer.text, pattern: false };
    }
    if (arg && ts.isStringLiteralLike(arg) && /^[a-z][\w-]*$/.test(arg.text) && /(push|navigate|goto|redirect)/i.test(name) && !/^(push|replace)$/.test(name)) return { family: "route-name", key: arg.text, pattern: false };
    const first = pathOf(node.arguments[0], resolve);
    if (!first) return null;
    if (/^(redirect|permanentRedirect|navigate|navigateTo)$/.test(name) && !receiver && first.key.startsWith("/")) return { family: "route", ...routeKey(first) };
    if (/^(push|replace|navigate|navigateByUrl|prefetch)$/.test(name) && /(router|navigation|navigator|nav|history|navigate)$/i.test(receiver)) {
      if (first.key.startsWith("/")) return { family: "route", ...routeKey(first) };
      if (/^[A-Z][\w]*$/.test(first.key)) return { family: "screen", key: first.key, pattern: false };
    }
    return null;
  }
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    const tag = node.tagName.getText(sf);
    if (!/^(Link|NavLink|Navigate|Redirect|router-link|RouterLink|NuxtLink|a)$/.test(tag)) return null;
    for (const a of node.attributes.properties) {
      if (!ts.isJsxAttribute(a) || !/^(href|to)$/.test(a.name.getText(sf)) || !a.initializer) continue;
      const value = ts.isStringLiteral(a.initializer) ? a.initializer : ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined;
      const p = pathOf(value, resolve);
      if (p?.key.startsWith("/")) return { family: "route", ...routeKey(p) };
    }
  }
  return null;
}

// What a route's component expression names: <C/> → C; () => import("./x").then((m) => m.X) → m.X;
// () => import("./X.vue") → the import (its module).
function componentOf(e: ts.Expression): ts.Expression {
  if (ts.isJsxSelfClosingElement(e)) return e.tagName as ts.Expression;
  if (ts.isJsxElement(e)) return e.openingElement.tagName as ts.Expression;
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
    let found: ts.Expression | null = null;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && (ts.isArrowFunction(n.parent) || ts.isReturnStatement(n.parent))) found = n;
      else ts.forEachChild(n, visit);
    };
    visit(e.body);
    if (found) return found;
    const imp = (function find(n: ts.Node): ts.CallExpression | null {
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) return n;
      return ts.forEachChild(n, find) ?? null;
    })(e.body);
    if (imp) return imp;
  }
  return e;
}

// A route table entry: { path: "x", element: <C/> } / { path, component: C }
// / <Stack.Screen name="Profile" component={C} />: the component's expression and key.
export function routeEntryOf(node: ts.Node, sf: ts.SourceFile): { family: "route" | "screen"; key: string; pattern: boolean; component: ts.Expression; name?: string } | null {
  if (ts.isObjectLiteralExpression(node)) {
    const prop = (n: string) => node.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === n)?.initializer;
    const own = pathOf(prop("path"));
    const component = prop("component") ?? prop("Component") ?? prop("element") ?? prop("loadComponent") ?? prop("lazy");
    if (!own || !component) return null;
    // A child route's path is under its parents' (children: [{ path: "" }] of "editor" is /editor).
    const parts = [own.key];
    let pattern = own.pattern;
    for (let n: ts.Node = node; ; ) {
      const array = n.parent;
      const holder = array && ts.isArrayLiteralExpression(array) ? array.parent : undefined;
      if (!holder || !ts.isPropertyAssignment(holder) || !ts.isIdentifier(holder.name) || holder.name.text !== "children" || !ts.isObjectLiteralExpression(holder.parent)) break;
      const parentPath = holder.parent.properties.find((q): q is ts.PropertyAssignment => ts.isPropertyAssignment(q) && ts.isIdentifier(q.name) && q.name.text === "path");
      const pp = parentPath && pathOf(parentPath.initializer);
      if (pp) (parts.unshift(pp.key), (pattern ||= pp.pattern));
      n = holder.parent;
    }
    const joined = parts.map((x) => x.replace(/^\/|\/$/g, "")).filter(Boolean).join("/");
    const routeName = prop("name");
    return { family: "route", ...routeKey({ key: joined, pattern }), component: componentOf(component), ...(routeName && ts.isStringLiteralLike(routeName) && { name: routeName.text }) };
  }
  if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
    if (!/\.Screen$|^Screen$/.test(node.tagName.getText(sf))) return null;
    let name: string | null = null;
    let component: ts.Expression | undefined;
    for (const a of node.attributes.properties) {
      if (!ts.isJsxAttribute(a) || !a.initializer) continue;
      const attr = a.name.getText(sf);
      if (attr === "name" && ts.isStringLiteral(a.initializer)) name = a.initializer.text;
      if (attr === "component" && ts.isJsxExpression(a.initializer)) component = a.initializer.expression;
    }
    return name && component ? { family: "screen", key: name, pattern: false, component } : null;
  }
  return null;
}

export type { ChannelEndpoint };

// --- Angular components ---------------------------------------------------------------

export interface AngularComponent {
  selector: string | null;
  // What the template uses, each with its line (in the .ts for an inline
  // template; the decorator's line for a templateUrl).
  calls: { name: string; line: number }[]; // methods called from bindings: (click)="save()", {{ total() }}
  tags: { tag: string; line: number }[]; // elements that may be components: <app-article-meta>
  links: { key: string; pattern: boolean; line: number; family?: "route-name" }[]; // routerLink="/x", [routerLink]="['/article', x]"; by name: :to="{ name: 'x' }", <AppLink name="x">
}

export function angularComponentOf(node: ts.ClassDeclaration, sf: ts.SourceFile): AngularComponent | null {
  const decorator = (ts.getDecorators(node) ?? []).find((d) => ts.isCallExpression(d.expression) && ts.isIdentifier(d.expression.expression) && d.expression.expression.text === "Component");
  const options = decorator && ts.isCallExpression(decorator.expression) ? decorator.expression.arguments[0] : undefined;
  if (!options || !ts.isObjectLiteralExpression(options)) return null;
  const prop = (n: string) => options.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === n)?.initializer;
  const selectorInit = prop("selector");
  const selector = selectorInit && ts.isStringLiteralLike(selectorInit) ? selectorInit.text : null;
  const inline = prop("template");
  const url = prop("templateUrl");
  let html = "";
  let lineOf = (_offset: number) => sf.getLineAndCharacterOfPosition(decorator!.getStart(sf)).line + 1;
  if (inline && (ts.isNoSubstitutionTemplateLiteral(inline) || ts.isStringLiteral(inline) || ts.isTemplateExpression(inline))) {
    html = inline.getText(sf).slice(1, -1);
    const start = inline.getStart(sf) + 1;
    lineOf = (offset) => sf.getLineAndCharacterOfPosition(start + offset).line + 1;
  } else if (url && ts.isStringLiteralLike(url)) {
    try {
      html = readFileSync(path.join(path.dirname(sf.fileName), url.text), "utf8");
    } catch {
      return { selector, calls: [], tags: [], links: [] };
    }
  }
  return { selector, ...templateUses(html, lineOf) };
}

// What a template (Angular's or Vue's) uses: calls in its bindings and
// interpolations, the elements that may be components, and router links.
export function templateUses(html: string, lineOf: (offset: number) => number): Omit<AngularComponent, "selector"> {
  const calls: AngularComponent["calls"] = [];
  const tags: AngularComponent["tags"] = [];
  const links: AngularComponent["links"] = [];
  // Expressions: attribute values of bindings ((e), [p], @e, :p, v-on, v-bind, *ngX, v-if…) and {{ … }}.
  const exprs = /(?:\s(?:\(|\[|@|:|v-on:|v-bind:|v-(?:if|else-if|show|for|model)|\*ng\w+)[\w.:-]*\)?\]?\s*=\s*"([^"]*)")|\{\{([\s\S]*?)\}\}|@(?:if|for|switch)\s*\(([^)]*\))/g;
  for (let m = exprs.exec(html); m; m = exprs.exec(html)) {
    const expr = m[1] ?? m[2] ?? m[3] ?? "";
    const base = m.index + m[0].indexOf(expr);
    const call = /(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g;
    for (let c = call.exec(expr); c; c = call.exec(expr)) calls.push({ name: c[1], line: lineOf(base + c.index) });
    // A bare handler: @click="save" / (click)="save" is the method itself.
    if (/^\s*[a-zA-Z_$][\w$]*\s*$/.test(expr) && /^\s(?:\(|@|v-on:)/.test(m[0])) calls.push({ name: expr.trim(), line: lineOf(base) });
  }
  // Svelte: on:click={save} / onclick={save} / {total()} / {#if ok()}.
  const svelte = /\s(?:on:\w+|on\w+|bind:\w+)=\{\s*([a-zA-Z_$][\w$]*)\s*\}|\{[#:/@]?\w*\s*([^{}]*?)\}/g;
  for (let m = svelte.exec(html); m; m = svelte.exec(html)) {
    if (m[1]) calls.push({ name: m[1], line: lineOf(m.index) });
    else if (m[2]) for (const c of m[2].matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)) calls.push({ name: c[1], line: lineOf(m.index) });
  }
  const tag = /<([a-zA-Z][\w-]*)/g;
  for (let m = tag.exec(html); m; m = tag.exec(html)) if (m[1].includes("-") || /^[A-Z]/.test(m[1])) tags.push({ tag: m[1], line: lineOf(m.index) });
  const link = /\s(?:\[routerLink\]|routerLink|:to|to|href)\s*=\s*"([^"]+)"/g;
  for (let m = link.exec(html); m; m = link.exec(html)) {
    const raw = m[1].trim();
    const array = /^\[(.*)\]$/.exec(raw);
    const parts = array ? array[1].split(",").map((p) => p.trim()).map((p) => (/^['"`](.*)['"`]$/.exec(p)?.[1] ?? "*")) : [/^['"`](.*)['"`]$/.exec(raw)?.[1] ?? (raw.startsWith("/") ? raw : null)];
    if (parts.some((p) => p === null)) continue;
    const key = (parts as string[]).join("/").replace(/\/{2,}/g, "/");
    if (key.startsWith("/")) links.push({ key: key.replace(/:\w+/g, "*"), pattern: key.includes("*") || /:\w+/.test(key), line: lineOf(m.index) });
  }
  // Named routes: :to="{ name: 'article' }", and <SomethingLink name="article">.
  const named = /:to\s*=\s*"\{[^"]*\bname\s*:\s*'([\w-]+)'|<[\w-]*link\b[^>]*\sname\s*=\s*"([\w-]+)"/gi;
  for (let m = named.exec(html); m; m = named.exec(html)) links.push({ key: m[1] ?? m[2], pattern: false, line: lineOf(m.index), family: "route-name" });
  return { calls, tags, links };
}
