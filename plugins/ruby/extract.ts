import type { Region } from "../../src/schema/index.js";
import { endLineOf, lineOf, type SyntaxNode, type Tree } from "../treesitter/index.js";

// One Ruby file's facts, from its syntax alone: what it declares (classes,
// modules, methods, constants), every call and what it's called on, the
// assignments that say what a variable holds (`user = User.find(id)`), and
// its folds. Nothing here looks at another file: the linker does that.

export interface RubyDecl {
  id: string; // "<file>#<Const::Path>.<method>"; class methods "…self.<name>"
  name: string;
  kind: "file" | "class" | "module" | "method" | "constant";
  path: string; // the constant path it's in (a class: its own), "" at the top
  parent: string | null;
  line: number;
  endLine: number;
  singleton?: boolean; // methods: a class method
  superclass?: string; // classes: as written
  nesting?: string[]; // classes: lexical nesting, for resolving the superclass
  generated?: string; // a method a call defines (define_method)
}

// An argument, simplified: what DSLs (routes, callbacks, associations) need.
export type RubyArg =
  | { t: "sym" | "str" | "const" | "ident" | "other"; v: string }
  | { t: "pair"; k: string; v: RubyArg }
  | { t: "array"; items: RubyArg[] }
  | { t: "lambda"; start: number; end: number };

export type Receiver =
  | { kind: "none" | "self" }
  | { kind: "const"; text: string } // User, Admin::User
  | { kind: "ivar" | "lvar" | "ident"; text: string } // @user, user (a local), current_user (a method)
  | { kind: "call"; const?: string; method: string; text: string } // User.find(1)…, x.y…
  | { kind: "other"; text: string };

export interface RubyCall {
  from: string; // the declaration it's in (a method, or a class/module/file body)
  name: string;
  recv: Receiver;
  line: number;
  owner: string; // the constant path of the class it's in ("" at the top)
  nesting: string[]; // lexical nesting, innermost last
  singleton: boolean; // in a class method (self is the class)
  method?: string; // the method it's in (for super)
  args?: RubyArg[]; // receiverless calls only (the DSL ones)
  block?: { start: number; end: number; params: string[] };
  bare?: true; // `save` alone: maybe a local the parser couldn't tell
}

// What a variable was assigned: `user = User.find(id)`, `@post = Post.new`.
export interface RubyAssign {
  scope: string; // locals: the declaration; ivars: the class path
  name: string;
  const: string;
  method: string; // what was called on it ("new", "find", "" for the constant itself)
  nesting: string[];
}

export interface RubyFacts {
  file: string;
  decls: RubyDecl[];
  calls: RubyCall[];
  assigns: RubyAssign[];
  requires: string[];
  regions: Region[];
}

interface Scope {
  decl: string; // calls here are from this
  owner: string;
  nesting: string[];
  singleton: boolean;
  method?: string;
  locals: Set<string>;
}

// Identifiers in these places aren't calls (names, parameters, targets).
const NOT_A_CALL = new Set([
  "method", "singleton_method", "method_parameters", "lambda_parameters", "block_parameters", "optional_parameter", "keyword_parameter",
  "splat_parameter", "hash_splat_parameter", "block_parameter", "destructured_parameter", "alias", "undef", "scope_resolution",
  "exception_variable", "for", "left_assignment_list", "rest_assignment", "destructured_left_assignment", "keyword_pattern",
  "array_pattern", "hash_pattern", "find_pattern", "as_pattern", "alternative_pattern", "in_clause", "variable_reference_pattern",
]);

export function extractRuby(tree: Tree, file: string, text: string): RubyFacts {
  const lines = text.split("\n");
  while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines.pop();
  const decls: RubyDecl[] = [];
  const ids = new Set<string>();
  const calls: RubyCall[] = [];
  const assigns: RubyAssign[] = [];
  const requires: string[] = [];
  const fileDecl: RubyDecl = { id: file, name: file.split("/").pop()!, kind: "file", path: "", parent: null, line: 1, endLine: lines.length };
  decls.push(fileDecl);
  ids.add(file);

  const declare = (d: RubyDecl): RubyDecl => {
    let id = d.id;
    if (ids.has(id)) {
      // A class reopened in the same file is the same class.
      const same = decls.find((o) => o.id === id);
      if (same && (d.kind === "class" || d.kind === "module") && same.kind === d.kind) return same;
      id = `${d.id}~${d.line}`; // a method defined twice: both kept
    }
    ids.add(id);
    const decl = { ...d, id };
    decls.push(decl);
    return decl;
  };
  const methodId = (owner: string, singleton: boolean, name: string) => `${file}#${owner ? `${owner}.` : ""}${singleton ? "self." : ""}${name}`;

  const visit = (node: SyntaxNode, scope: Scope): void => {
    switch (node.type) {
      case "class":
      case "module": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) break;
        const written = nameNode.text;
        const path = written.startsWith("::") ? written.slice(2) : scope.owner ? `${scope.owner}::${written}` : written;
        const superNode = node.type === "class" ? node.childForFieldName("superclass")?.namedChildren[0] : null;
        const decl = declare({
          id: `${file}#${path}`,
          name: path.split("::").pop()!,
          kind: node.type,
          path,
          parent: scope.decl,
          line: lineOf(node),
          endLine: endLineOf(node),
          ...(superNode && /^(::)?[A-Z][\w:]*$/.test(superNode.text) && { superclass: superNode.text, nesting: scope.nesting }),
        });
        if (superNode) visit(superNode, scope); // Struct.new(…) and friends are calls
        const inner: Scope = { decl: decl.id, owner: path, nesting: [...scope.nesting, path], singleton: false, locals: new Set() };
        visitChildren(node.childForFieldName("body"), inner);
        return;
      }
      case "singleton_class": {
        // class << self: what's inside is the class's own.
        visitChildren(node.childForFieldName("body"), { ...scope, singleton: true, locals: new Set() });
        return;
      }
      case "method":
      case "singleton_method": {
        const name = node.childForFieldName("name")?.text;
        if (!name) break;
        const object = node.type === "singleton_method" ? node.childForFieldName("object")?.text : undefined;
        const singleton = scope.singleton || object !== undefined;
        const owner = object && object !== "self" ? (scope.owner ? `${scope.owner}::${object}` : object) : scope.owner;
        const decl = declare({ id: methodId(owner, singleton, name), name, kind: "method", path: owner, parent: scope.decl, line: lineOf(node), endLine: endLineOf(node), ...(singleton && { singleton }) });
        const locals = new Set<string>(paramNames(node.childForFieldName("parameters")));
        const inner: Scope = { decl: decl.id, owner, nesting: scope.nesting, singleton, method: name, locals };
        const skip = new Set([node.childForFieldName("name")?.id, node.childForFieldName("object")?.id]);
        for (const child of node.namedChildren) if (child && child.type !== "method_parameters" && !skip.has(child.id)) visit(child, inner);
        return;
      }
      case "call": {
        visitCall(node, scope);
        return;
      }
      case "super":
      case "zsuper": {
        calls.push({ from: scope.decl, name: "super", recv: { kind: "none" }, line: lineOf(node), owner: scope.owner, nesting: scope.nesting, singleton: scope.singleton, ...(scope.method && { method: scope.method }) });
        break;
      }
      case "identifier": {
        // A bare name that isn't a local: a call with no receiver or arguments.
        const parent = node.parent;
        if (!scope.locals.has(node.text) && parent && !NOT_A_CALL.has(parent.type) && !isField(parent, "left", node) && !isField(parent, "name", node)) {
          calls.push({ from: scope.decl, name: node.text, recv: { kind: "none" }, line: lineOf(node), owner: scope.owner, nesting: scope.nesting, singleton: scope.singleton, bare: true, ...(scope.method && { method: scope.method }) });
        }
        return;
      }
      case "assignment":
      case "operator_assignment": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (right) visit(right, scope);
        if (left?.type === "identifier") scope.locals.add(left.text);
        else if (left?.type === "constant" && node.type === "assignment" && !scope.method) {
          declare({ id: `${file}#${scope.owner ? `${scope.owner}::` : ""}${left.text}`, name: left.text, kind: "constant", path: scope.owner, parent: scope.decl, line: lineOf(node), endLine: endLineOf(node) });
        } else if (left?.type === "left_assignment_list") {
          for (const n of left.descendantsOfType("identifier")) if (n) scope.locals.add(n.text);
        } else if (left) visit(left, scope);
        // What it holds, when that's plain: User.new, User.find(…), User.
        if (left && right && (left.type === "identifier" || left.type === "instance_variable")) {
          const held = constCall(right);
          if (held) assigns.push({ scope: left.type === "instance_variable" ? `@${scope.owner}` : scope.decl, name: left.text, const: held.const, method: held.method, nesting: scope.nesting });
        }
        return;
      }
      case "do_block":
      case "block":
      case "lambda": {
        const locals = new Set(scope.locals);
        for (const p of paramNames(node.childForFieldName("parameters"))) locals.add(p);
        visitChildren(node, { ...scope, locals }, ["block_parameters", "lambda_parameters"]);
        return;
      }
      case "block_argument": {
        // select(&:credit?): a call to credit? on each element.
        const sym = node.namedChildren[0];
        if (sym?.type === "simple_symbol") calls.push({ from: scope.decl, name: sym.text.slice(1), recv: { kind: "other", text: node.text }, line: lineOf(node), owner: scope.owner, nesting: scope.nesting, singleton: scope.singleton, ...(scope.method && { method: scope.method }) });
        break;
      }
      case "rescue": {
        const variable = node.childForFieldName("variable");
        if (variable) for (const n of variable.descendantsOfType("identifier")) if (n) scope.locals.add(n.text);
        break;
      }
      case "for": {
        const pattern = node.childForFieldName("pattern");
        if (pattern) for (const n of [pattern, ...pattern.descendantsOfType("identifier")]) if (n?.type === "identifier") scope.locals.add(n.text);
        break;
      }
    }
    visitChildren(node, scope);
  };

  const visitChildren = (node: SyntaxNode | null, scope: Scope, skip: string[] = []) => {
    if (!node) return;
    for (const child of node.namedChildren) if (child && !skip.includes(child.type)) visit(child, scope);
  };

  const visitCall = (node: SyntaxNode, scope: Scope) => {
    const methodNode = node.childForFieldName("method");
    const receiverNode = node.childForFieldName("receiver");
    const argsNode = node.childForFieldName("arguments");
    const blockNode = node.childForFieldName("block");
    const name = methodNode?.text ?? "call"; // foo.() is foo.call
    const recv = receiverOf(receiverNode, scope);
    const call: RubyCall = { from: scope.decl, name, recv, line: lineOf(methodNode ?? node), owner: scope.owner, nesting: scope.nesting, singleton: scope.singleton, ...(scope.method && { method: scope.method }) };
    if (recv.kind === "none") {
      call.args = argsNode ? argsNode.namedChildren.filter((a): a is SyntaxNode => !!a).map(argOf) : [];
      if (name === "require" || name === "require_relative") {
        const target = call.args[0];
        if (target?.t === "str") requires.push(name === "require_relative" ? relative(file, target.v) : target.v);
      }
    }
    if (blockNode) call.block = { start: lineOf(blockNode), end: endLineOf(blockNode), params: paramNames(blockNode.childForFieldName("parameters")) };
    calls.push(call);

    // define_method(:name) { … } in a class body: a method.
    if (name === "define_method" && recv.kind === "none" && !scope.method && call.args?.[0] && (call.args[0].t === "sym" || call.args[0].t === "str")) {
      const defined = call.args[0].v;
      const decl = declare({ id: methodId(scope.owner, scope.singleton, defined), name: defined, kind: "method", path: scope.owner, parent: scope.decl, line: lineOf(node), endLine: endLineOf(node), generated: "define_method", ...(scope.singleton && { singleton: true }) });
      const inner: Scope = { ...scope, decl: decl.id, method: defined, locals: new Set() };
      if (argsNode) visitChildren(argsNode, inner);
      if (blockNode) visit(blockNode, inner);
      return;
    }
    if (receiverNode && recv.kind !== "lvar" && recv.kind !== "ivar" && recv.kind !== "const" && recv.kind !== "self") visit(receiverNode, scope);
    if (argsNode) visitChildren(argsNode, scope);
    if (blockNode) visit(blockNode, scope);
  };

  const receiverOf = (n: SyntaxNode | null, scope: Scope): Receiver => {
    if (!n) return { kind: "none" };
    if (n.type === "self") return { kind: "self" };
    if (n.type === "constant" || n.type === "scope_resolution") return { kind: "const", text: n.text };
    if (n.type === "instance_variable") return { kind: "ivar", text: n.text };
    if (n.type === "identifier") return { kind: scope.locals.has(n.text) ? "lvar" : "ident", text: n.text };
    if (n.type === "call") {
      const inner = constCall(n);
      return { kind: "call", method: n.childForFieldName("method")?.text ?? "", text: clip(n.text), ...(inner?.const && { const: inner.const }) };
    }
    if (n.type === "parenthesized_statements" && n.namedChildCount === 1) return receiverOf(n.namedChildren[0], scope);
    return { kind: "other", text: clip(n.text) };
  };

  visitChildren(tree.rootNode, { decl: file, owner: "", nesting: [], singleton: false, locals: new Set() });

  return { file, decls, calls, assigns, requires, regions: regionsOf(tree.rootNode, file, lines) };
}

// `User.new(…)`, `User.find(…)`, `Admin::User` → { const, method }.
function constCall(n: SyntaxNode): { const: string; method: string } | null {
  if (n.type === "constant" || n.type === "scope_resolution") return { const: n.text, method: "" };
  if (n.type !== "call") return null;
  const receiver = n.childForFieldName("receiver");
  const method = n.childForFieldName("method")?.text ?? "";
  if (receiver && (receiver.type === "constant" || receiver.type === "scope_resolution")) return { const: receiver.text, method };
  return null;
}

function argOf(n: SyntaxNode): RubyArg {
  switch (n.type) {
    case "simple_symbol":
      return { t: "sym", v: n.text.slice(1) };
    case "hash_key_symbol":
      return { t: "sym", v: n.text };
    case "delimited_symbol":
      return { t: "sym", v: n.text.slice(2, -1) };
    case "string":
      return n.namedChildren.every((c) => c?.type === "string_content") ? { t: "str", v: n.namedChildren.map((c) => c!.text).join("") } : { t: "other", v: clip(n.text) };
    case "constant":
    case "scope_resolution":
      return { t: "const", v: n.text };
    case "identifier":
      return { t: "ident", v: n.text };
    case "pair": {
      const key = n.childForFieldName("key");
      const value = n.childForFieldName("value");
      const k = key ? (key.type === "string" ? key.namedChildren.map((c) => c?.text ?? "").join("") : key.text.replace(/^:|:$/g, "")) : "";
      return { t: "pair", k, v: value ? argOf(value) : { t: "other", v: "" } };
    }
    case "array":
      return { t: "array", items: n.namedChildren.filter((c): c is SyntaxNode => !!c).map(argOf) };
    case "lambda":
      return { t: "lambda", start: lineOf(n), end: endLineOf(n) };
    default:
      return { t: "other", v: clip(n.text) };
  }
}

function paramNames(params: SyntaxNode | null): string[] {
  if (!params) return [];
  const names: string[] = [];
  for (const p of params.namedChildren) {
    if (!p) continue;
    if (p.type === "identifier") names.push(p.text);
    else {
      const name = p.childForFieldName("name");
      if (name) names.push(name.text);
      else for (const n of p.descendantsOfType("identifier")) if (n) names.push(n.text);
    }
  }
  return names;
}

const isField = (parent: SyntaxNode, field: string, node: SyntaxNode) => parent.childForFieldName(field)?.id === node.id;
const clip = (s: string) => (s.length > 80 ? `${s.slice(0, 77)}…` : s);

function relative(file: string, target: string): string {
  const parts = file.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  const joined = parts.join("/");
  return joined.endsWith(".rb") ? joined : `${joined}.rb`;
}

// Folds: class, module and method bodies, blocks (do … end, { … } over
// several lines), if/case/loops/begin, multi-line hashes, arrays, strings,
// heredocs and argument lists, runs of comments, and the requires at the top.
const BLOCKS = new Set(["class", "module", "singleton_class", "method", "singleton_method", "do_block", "block", "lambda", "if", "unless", "while", "until", "for", "case", "case_match", "begin", "else", "elsif", "when", "rescue", "ensure"]);
const LITERALS = new Set(["hash", "array", "string", "heredoc_body", "string_array", "symbol_array"]);

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

  // Runs of 2+ comment lines: keep the first, fold the rest.
  let runStart = 0;
  for (let i = 0; i <= lines.length; i++) {
    const comment = i < lines.length && lines[i].trim().startsWith("#");
    if (comment && !runStart) runStart = i + 1;
    if (!comment && runStart) {
      if (i - runStart >= 1) add(runStart, i, "comment");
      runStart = 0;
    }
  }

  // The requires at the top: the first heads them.
  const req = lines.map((l, i) => (/^\s*require(_relative)?\b/.test(l) ? i + 1 : 0)).filter(Boolean);
  if (req.length >= 2 && req[req.length - 1] - req[0] < req.length + 3) add(req[0], req[req.length - 1], "imports");

  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}
