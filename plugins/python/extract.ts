import type { Region } from "../../src/schema/index.js";
import { endLineOf, lineOf, type SyntaxNode, type Tree } from "../treesitter/index.js";

// One Python file's facts, from its syntax alone: what it declares
// (classes, functions, methods, module variables), what it imports, every
// call and what it's called on, what each variable holds (from type
// annotations and assignments: `user: User`, `repo = Repo()`), decorators
// and their arguments, and its folds. Nothing here looks at another file.

// What a value is, as written: a type annotation, the result of calling
// something, another variable, an attribute (self.items), or what a known
// function gives (a pytest fixture's value).
export type TypeRef = { t: "type"; text: string } | { t: "call"; text: string } | { t: "var"; name: string } | { t: "path"; parts: string[] } | { t: "result"; id: string } | { t: "item"; of: TypeRef; index: number };

export interface PyArg {
  key?: string; // keyword argument
  t: "str" | "name" | "call" | "other"; // a string, a dotted name, a call (its callee), anything else
  v: string;
}

export interface PyDecorator {
  text: string; // the decorator's callee, dotted: "app.get", "shared_task"
  args: PyArg[]; // when it's called: @app.get("/users")
}

export interface PyDecl {
  id: string; // "<file>#<Class.method>", "<file>" for the module
  name: string;
  kind: "file" | "class" | "function" | "variable";
  qual: string; // the dotted name within the module ("Service.run"), "" for the module
  parent: string | null;
  line: number;
  endLine: number;
  classOf?: string; // functions: the id of the class it's a method of
  bases?: string[]; // classes: as written ("Base", "models.Model")
  decorators?: PyDecorator[];
  returns?: string; // functions: the return annotation
  vars?: Record<string, TypeRef>; // functions: what parameters and locals hold
  params?: string[]; // functions: parameter names, in order (pytest fixtures are injected by name)
  ret?: TypeRef; // functions without a return annotation: what the first return (or yield) gives
  items?: TypeRef[]; // functions returning a tuple: each position (`-> tuple[A, B]`, or `return a, b`)
  abstract?: true; // functions: @abstractmethod, or a body that's only `...`, `pass` or `raise NotImplementedError`
  attrs?: Record<string, { ref: TypeRef; scope: string }>; // classes: self.x, and the method it's assigned in
  value?: TypeRef; // module variables: what they hold (app = FastAPI())
  args?: PyArg[]; // module variables assigned a call: its arguments (APIRouter(prefix="/x"))
}

export interface PyImport {
  local: string; // the name it binds here
  module: string; // as written: "pkg.sub", ".models", "..core"
  name?: string; // from x import name; absent for import x
}

export type PyReceiver =
  | { kind: "none" } // foo()
  | { kind: "path"; parts: string[] } // self.repo.get(), os.path.join(), user.save()
  | { kind: "call"; callee: string } // Repo().get(), repo.find(1).save()
  | { kind: "super" } // super().save()
  | { kind: "other" };

export interface PyCall {
  from: string; // the innermost declaration it's in
  name: string; // the function or method called
  recv: PyReceiver;
  line: number;
  args: PyArg[];
}

export interface PyFacts {
  file: string;
  decls: PyDecl[];
  imports: PyImport[];
  calls: PyCall[];
  // Attributes read without a call (obj.name): a @property runs code there.
  reads: { from: string; name: string; recv: PyReceiver; line: number }[];
  regions: Region[];
}

export function extractPython(tree: Tree, file: string, text: string): PyFacts {
  const lines = text.split("\n");
  while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines.pop();
  const decls: PyDecl[] = [{ id: file, name: file.split("/").pop()!, kind: "file", qual: "", parent: null, line: 1, endLine: lines.length }];
  const byId = new Map(decls.map((d) => [d.id, d]));
  const imports: PyImport[] = [];
  const calls: PyCall[] = [];
  const reads: PyFacts["reads"] = [];

  const declare = (d: PyDecl): PyDecl => {
    let id = d.id;
    if (byId.has(id)) id = `${d.id}~${d.line}`; // redefined: both kept
    const decl = { ...d, id };
    decls.push(decl);
    byId.set(id, decl);
    return decl;
  };

  interface Scope {
    decl: PyDecl; // calls here are from this
    qual: string; // dotted name prefix
    cls?: PyDecl; // the class we're directly in (for methods)
    method?: PyDecl; // the function we're in (for its variables)
  }

  const visit = (node: SyntaxNode, scope: Scope): void => {
    switch (node.type) {
      case "decorated_definition": {
        const def = node.childForFieldName("definition");
        if (!def) break;
        const decorators = node.namedChildren.filter((c): c is SyntaxNode => c?.type === "decorator").map(decoratorOf);
        // The decorators' own calls (@app.get("/x")) aren't the function's calls.
        defineFrom(def, scope, decorators, node);
        return;
      }
      case "class_definition":
      case "function_definition":
        defineFrom(node, scope, [], node);
        return;
      case "import_statement": {
        for (const n of node.namedChildren) {
          if (!n) continue;
          if (n.type === "dotted_name") imports.push({ local: n.text.split(".")[0], module: n.text.split(".")[0] });
          else if (n.type === "aliased_import") imports.push({ local: n.childForFieldName("alias")!.text, module: n.childForFieldName("name")!.text });
        }
        return;
      }
      case "import_from_statement": {
        const module = node.childForFieldName("module_name")?.text ?? "";
        for (const n of node.childrenForFieldName("name")) {
          if (!n) continue;
          if (n.type === "dotted_name") imports.push({ local: n.text, module, name: n.text });
          else if (n.type === "aliased_import") imports.push({ local: n.childForFieldName("alias")!.text, module, name: n.childForFieldName("name")!.text });
        }
        if (node.namedChildren.some((c) => c?.type === "wildcard_import")) imports.push({ local: "*", module, name: "*" });
        return;
      }
      case "assignment": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        const type = node.childForFieldName("type");
        const ref: TypeRef | undefined = type ? { t: "type", text: typeText(type) } : right ? refOf(right) : undefined;
        if (left?.type === "identifier") {
          if (scope.method) {
            if (ref) (scope.method.vars ??= {})[left.text] = ref;
          } else if (scope.cls && scope.decl === scope.cls) {
            // A field in the class body (a dataclass's, a model's): `members: Counts = field(…)`.
            if (ref) (scope.cls.attrs ??= {})[left.text] ??= { ref, scope: scope.cls.id };
          } else if (!scope.cls && scope.decl.kind === "file") {
            declare({
              id: `${file}#${left.text}`,
              name: left.text,
              kind: "variable",
              qual: left.text,
              parent: scope.decl.id,
              line: lineOf(node),
              endLine: endLineOf(node),
              ...(ref && { value: ref }),
              ...(right?.type === "call" && { args: argsOf(right.childForFieldName("arguments")) }),
            });
          }
        } else if ((left?.type === "pattern_list" || left?.type === "tuple_pattern") && scope.method && right?.type === "call" && ref) {
          // f, judge = make(…): each name is that position of what make returns.
          left.namedChildren.forEach((n, index) => {
            if (n?.type === "identifier") (scope.method!.vars ??= {})[n.text] = { t: "item", of: ref, index };
          });
        } else if (left?.type === "attribute" && left.childForFieldName("object")?.text === "self" && scope.cls && scope.method && ref) {
          (scope.cls.attrs ??= {})[left.childForFieldName("attribute")!.text] ??= { ref, scope: scope.method.id };
        }
        break; // the right side's calls
      }
      case "for_statement":
      case "for_in_clause": {
        // A loop variable is an element of what it loops over (a list[X]
        // annotation already reads as X; dict.values() and .items() as the values).
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (scope.method && left && right) {
          const fn = right.type === "call" ? right.childForFieldName("function") : null;
          const over = fn?.type === "attribute" && /^(values|items)$/.test(fn.childForFieldName("attribute")!.text) ? fn.childForFieldName("object")! : right;
          const ref = refOf(over);
          const target = left.type === "identifier" ? left : left.type === "pattern_list" || left.type === "tuple_pattern" ? left.namedChildren.filter((c) => c?.type === "identifier").at(-1) : null;
          if (ref && target) (scope.method.vars ??= {})[target.text] ??= ref;
        }
        break;
      }
      case "as_pattern": {
        // with open_store() as s: s is what the call gives (its return annotation;
        // a context manager's Iterator[Store] reads as Store).
        const target = node.childForFieldName("alias")?.namedChildren[0];
        const value = node.namedChildren[0];
        const ref = value && refOf(value);
        if (scope.method && target?.type === "identifier" && ref) (scope.method.vars ??= {})[target.text] ??= ref;
        break;
      }
      case "return_statement":
      case "yield": {
        // What an unannotated function gives back: its first return (a
        // fixture's yield) that says.
        const value = node.namedChildren[0];
        const ref = value && value.type !== "expression_list" ? refOf(value) : undefined;
        if (scope.method && !scope.method.returns && !scope.method.ret && ref) scope.method.ret = ref;
        // return a, b: each position, for whoever unpacks it.
        if (scope.method && !scope.method.items && (value?.type === "expression_list" || value?.type === "tuple")) {
          const items = value.namedChildren.map((c) => (c ? refOf(c) : undefined));
          if (items.some(Boolean)) scope.method.items = items.map((r) => r ?? { t: "var", name: "" });
        }
        break;
      }
      case "attribute": {
        // obj.name read, not called or assigned: maybe a property.
        const parent = node.parent;
        const called = parent?.type === "call" && parent.childForFieldName("function")?.id === node.id;
        const assigned = parent?.type === "assignment" && parent.childForFieldName("left")?.id === node.id;
        const object = node.childForFieldName("object")!;
        const parts = dotted(object);
        if (!called && !assigned && parts && parent?.type !== "attribute") reads.push({ from: scope.decl.id, name: node.childForFieldName("attribute")!.text, recv: { kind: "path", parts }, line: lineOf(node) });
        break;
      }
      case "call": {
        const fn = node.childForFieldName("function");
        if (fn) {
          const callee = calleeOf(fn);
          if (callee) calls.push({ from: scope.decl.id, ...callee, line: lineOf(node), args: argsOf(node.childForFieldName("arguments")) });
        }
        break;
      }
    }
    for (const c of node.namedChildren) if (c) visit(c, scope);
  };

  // A class or function (with its decorators, if any). The declaration
  // spans its decorators, so a route's `@app.get("/x")` is on its card.
  const defineFrom = (def: SyntaxNode, scope: Scope, decorators: PyDecorator[], outer: SyntaxNode) => {
    const name = def.childForFieldName("name")?.text;
    if (!name) return;
    const qual = scope.qual ? `${scope.qual}.${name}` : name;
    if (def.type === "class_definition") {
      const bases = (def.childForFieldName("superclasses")?.namedChildren ?? []).filter((c): c is SyntaxNode => !!c && (c.type === "identifier" || c.type === "attribute")).map((c) => c.text);
      const decl = declare({ id: `${file}#${qual}`, name, kind: "class", qual, parent: scope.decl.id, line: lineOf(outer), endLine: endLineOf(outer), bases, ...(decorators.length && { decorators }) });
      visit(def.childForFieldName("body")!, { decl, qual, cls: decl });
      return;
    }
    const vars: Record<string, TypeRef> = {};
    const params: string[] = [];
    for (const p of def.childForFieldName("parameters")?.namedChildren ?? []) {
      if (!p) continue;
      const pname = p.type === "identifier" ? p.text : (p.childForFieldName("name") ?? p.namedChildren.find((c) => c?.type === "identifier"))?.text;
      const ptype = p.childForFieldName("type");
      if (pname) params.push(pname);
      if (pname && ptype) vars[pname] = { t: "type", text: typeText(ptype) };
    }
    const returns = def.childForFieldName("return_type");
    const tupleItems = returns && /^(?:typing\.)?(?:tuple|Tuple)\[(.+)\]$/.exec(returns.text.trim())?.[1].split(",").map((t) => t.trim());
    const decl = declare({
      id: `${file}#${qual}`,
      name,
      kind: "function",
      qual,
      parent: scope.decl.id,
      line: lineOf(outer),
      endLine: endLineOf(outer),
      ...(scope.cls && { classOf: scope.cls.id }),
      ...(decorators.length && { decorators }),
      ...(returns && { returns: typeText(returns) }),
      ...(isAbstract(def, decorators) && { abstract: true as const }),
      ...(tupleItems && !tupleItems.includes("...") && { items: tupleItems.map((text): TypeRef => ({ t: "type", text: text.replace(/^["']|["']$/g, "") })) }),
      params,
      vars,
    });
    const inner: Scope = { decl, qual, method: decl, ...(scope.cls && { cls: scope.cls }) };
    // Defaults are calls the function depends on (FastAPI's Depends(get_db)).
    for (const p of def.childForFieldName("parameters")?.namedChildren ?? []) {
      const value = p?.childForFieldName("value");
      if (value) visit(value, inner);
    }
    visit(def.childForFieldName("body")!, inner);
  };

  for (const c of tree.rootNode.namedChildren) if (c) visit(c, { decl: decls[0], qual: "" });
  return { file, decls, imports, calls, reads, regions: regionsOf(tree.rootNode, file, lines) };
}

// A method that's only declared: @abstractmethod, or a body of just a
// docstring and `...`, `pass` or `raise NotImplementedError`.
function isAbstract(def: SyntaxNode, decorators: PyDecorator[]): boolean {
  if (decorators.some((d) => /(^|\.)abstractmethod$/.test(d.text))) return true;
  const body = (def.childForFieldName("body")?.namedChildren ?? []).filter((c): c is SyntaxNode => !!c && c.type !== "comment");
  const real = body.filter((c) => !(c.type === "expression_statement" && c.namedChildren[0]?.type === "string"));
  return real.length === 1 && /^(\.\.\.|pass|raise NotImplementedError(\(.*\))?)$/.test(real[0].text.trim());
}

// What a call calls: its name and what it's called on.
function calleeOf(fn: SyntaxNode): { name: string; recv: PyReceiver } | null {
  if (fn.type === "identifier") return { name: fn.text, recv: { kind: "none" } };
  if (fn.type !== "attribute") return null;
  const name = fn.childForFieldName("attribute")!.text;
  const object = fn.childForFieldName("object")!;
  const parts = dotted(object);
  if (parts) return { name, recv: { kind: "path", parts } };
  if (object.type === "call") {
    const inner = object.childForFieldName("function");
    if (inner?.type === "identifier" && inner.text === "super") return { name, recv: { kind: "super" } };
    const innerParts = inner && dotted(inner);
    if (innerParts) return { name, recv: { kind: "call", callee: innerParts.join(".") } };
  }
  return { name, recv: { kind: "other" } };
}

// a.b.c as ["a", "b", "c"], or null when it isn't a plain dotted name.
function dotted(n: SyntaxNode): string[] | null {
  if (n.type === "identifier") return [n.text];
  if (n.type !== "attribute") return null;
  const head = dotted(n.childForFieldName("object")!);
  return head ? [...head, n.childForFieldName("attribute")!.text] : null;
}

function refOf(n: SyntaxNode): TypeRef | undefined {
  if (n.type === "identifier") return { t: "var", name: n.text };
  if (n.type === "attribute") {
    const parts = dotted(n);
    if (parts) return { t: "path", parts };
  }
  if (n.type === "call") {
    const fn = n.childForFieldName("function");
    const parts = fn && dotted(fn);
    if (parts) return { t: "call", text: parts.join(".") };
  }
  if (n.type === "await") return n.namedChildren[0] ? refOf(n.namedChildren[0]) : undefined;
  return undefined;
}

// The class an annotation names: `User`, `"User"`, `Optional[User]`,
// `User | None`, `list[User]` → User (a list of them calls like one).
function typeText(n: SyntaxNode): string {
  const text = n.text.replace(/^["']|["']$/g, "");
  const inner = /^(?:typing\.)?(?:Optional|List|list|Sequence|Iterable|Iterator|set|Set|frozenset|tuple|Type|type|Awaitable|Annotated|Generator|AsyncIterator)\[\s*([\w.]+)/.exec(text);
  if (inner) return inner[1];
  // A mapping reads as its values: dict[str, Topic] → Topic.
  const mapping = /^(?:typing\.)?(?:dict|Dict|Mapping|MutableMapping|defaultdict|OrderedDict)\[[^,\]]+,\s*([\w.]+)/.exec(text);
  if (mapping) return mapping[1];
  return text.split("|")[0].trim().replace(/\[.*$/, "");
}

function decoratorOf(d: SyntaxNode): PyDecorator {
  const e = d.namedChildren[0]!;
  if (e.type === "call") return { text: (dotted(e.childForFieldName("function")!) ?? []).join("."), args: argsOf(e.childForFieldName("arguments")) };
  return { text: (dotted(e) ?? [e.text]).join("."), args: [] };
}

function argsOf(list: SyntaxNode | null): PyArg[] {
  if (!list) return [];
  return list.namedChildren
    .filter((a): a is SyntaxNode => !!a)
    .slice(0, 12)
    .map((a) => {
      if (a.type === "keyword_argument") return { key: a.childForFieldName("name")!.text, ...argValue(a.childForFieldName("value")!) };
      return argValue(a);
    });
}

function argValue(n: SyntaxNode): { t: PyArg["t"]; v: string } {
  if (n.type === "string" && n.namedChildren.every((c) => c?.type === "string_start" || c?.type === "string_content" || c?.type === "string_end"))
    return { t: "str", v: n.namedChildren.filter((c) => c?.type === "string_content").map((c) => c!.text).join("") };
  const parts = dotted(n);
  if (parts) return { t: "name", v: parts.join(".") };
  if (n.type === "call") {
    const fn = n.childForFieldName("function");
    const p = fn && dotted(fn);
    if (p) return { t: "call", v: p.join(".") };
  }
  return { t: "other", v: n.text.slice(0, 80) };
}

// Folds: class and function bodies, control flow, multi-line literals
// (dicts, lists, docstrings) and argument lists, comment runs, the imports.
const BLOCKS = new Set(["class_definition", "function_definition", "decorated_definition", "if_statement", "elif_clause", "else_clause", "for_statement", "while_statement", "try_statement", "except_clause", "finally_clause", "with_statement", "match_statement", "case_clause"]);
const LITERALS = new Set(["dictionary", "list", "set", "tuple", "string", "list_comprehension", "dictionary_comprehension"]);

function regionsOf(root: SyntaxNode, file: string, lines: string[]): Region[] {
  const seen = new Set<string>();
  const out: Region[] = [];
  const add = (start: number, end: number, kind: Region["kind"]) => {
    const key = `${start}:${end}`;
    if (end <= start || seen.has(key)) return;
    seen.add(key);
    out.push({ file, start, end, kind });
  };
  const visit = (n: SyntaxNode) => {
    if (BLOCKS.has(n.type)) add(lineOf(n), endLineOf(n), "block");
    else if (LITERALS.has(n.type)) add(lineOf(n), endLineOf(n), "literal");
    else if (n.type === "argument_list" && n.namedChildCount) add(lineOf(n), endLineOf(n), "args");
    for (const c of n.namedChildren) if (c) visit(c);
  };
  visit(root);
  let runStart = 0;
  for (let i = 0; i <= lines.length; i++) {
    const comment = i < lines.length && lines[i].trim().startsWith("#");
    if (comment && !runStart) runStart = i + 1;
    if (!comment && runStart) {
      if (i - runStart >= 1) add(runStart, i, "comment");
      runStart = 0;
    }
  }
  const imports = root.namedChildren.filter((c): c is SyntaxNode => c?.type === "import_statement" || c?.type === "import_from_statement");
  if (imports.length >= 2) add(lineOf(imports[0]), endLineOf(imports[imports.length - 1]), "imports");
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}
