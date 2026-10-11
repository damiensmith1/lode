import type { Confidence, Edge, GraphData, Node, Region } from "../../src/schema/index.js";
import type { PyCall, PyDecl, PyFacts, PyImport, TypeRef } from "./extract.js";

// Every Python file's facts → the graph. Names resolve the way Python
// does: the enclosing functions, then the module, then what it imports
// (absolute or relative, through packages' __init__.py and `import *`).
// Attributes resolve through modules, classes and their bases, and
// instances: a variable's class comes from its annotation (`repo: Repo`),
// what it was assigned (`repo = Repo()`, `user = repo.get(1)` with `get`
// annotated `-> User`), or `self.repo` set in a method. Those resolved
// through a variable's type are marked inferred; the rest are exact. A call
// on something unknown links only to the one project method with that name,
// if there's exactly one and it isn't a common name or a test helper.
// Packs add frameworks' conventions (routes, tasks, Django's urls and ORM).

export interface Registration {
  call: string;
  key: string | null;
  category?: string;
}

export type Sym = { kind: "module"; file: string } | { kind: "decl"; id: string } | { kind: "instance"; cls: string };

export interface Ctx {
  file: string;
  fn?: string; // the function we're in
  cls?: string; // the class `self` is
}

export interface PyPack {
  name: string;
  detect(project: PythonProject): boolean;
  prepare?(project: PythonProject): void;
  link?(project: PythonProject): void;
}

const COMMON = new Set(
  (
    "get set add append extend pop update items keys values copy clear remove discard insert index count sort sorted reverse join split strip lstrip rstrip " +
    "format encode decode read write close open run start stop send save delete create filter exclude all first last exists order_by values_list annotate " +
    "aggregate select_related prefetch_related process handle execute call apply map dumps loads load dump info debug warning warn error exception critical " +
    "log setdefault replace lower upper title startswith endswith find render validate clean is_valid json text content raise_for_status wait result submit " +
    "cancel done put patch post head options fetch fetchone fetchall commit rollback flush refresh add_all query scalars scalar one one_or_none " +
    "__init__ __call__ __enter__ __exit__ __aenter__ __aexit__ __str__ __repr__ __eq__ __hash__ __len__ __iter__ __next__ __getitem__ __setitem__ " +
    "isoformat strftime now today total_seconds group match search sub compile mkdir exists is_file is_dir iterdir glob resolve with_suffix"
  ).split(" "),
);

export class PythonProject {
  readonly decls = new Map<string, PyDecl & { file: string }>();
  readonly files = new Set<string>();
  readonly byFile = new Map<string, PyFacts>();
  readonly edges: Edge[] = [];
  readonly registrations = new Map<string, Registration>();
  readonly tags = new Map<string, string>();
  // Packs: what a call returns when the code can't tell (Django's
  // User.objects.get(…) → a User), and attributes of things that aren't
  // classes (a Celery task's .delay → the task).
  readonly callTypes: ((callee: string[], ctx: Ctx) => Sym | null)[] = [];
  readonly memberHooks: ((base: Sym, name: string) => string | null)[] = [];
  private readonly members = new Map<string, Map<string, string>>(); // a module's or class's declarations by name
  private readonly imports = new Map<string, Map<string, PyImport[]>>(); // file → local name → imports
  private readonly starImports = new Map<string, string[]>(); // file → modules it imports * from
  private readonly paths: string[];

  constructor(
    readonly root: string,
    readonly facts: PyFacts[],
  ) {
    for (const f of facts) {
      this.files.add(f.file);
      this.byFile.set(f.file, f);
      const imports = new Map<string, PyImport[]>();
      for (const i of f.imports) {
        if (i.local === "*") this.starImports.set(f.file, [...(this.starImports.get(f.file) ?? []), i.module]);
        else imports.set(i.local, [...(imports.get(i.local) ?? []), i]);
      }
      this.imports.set(f.file, imports);
      for (const d of f.decls) {
        this.decls.set(d.id, { ...d, file: f.file });
        if (d.parent && d.kind !== "file") {
          const map = this.members.get(d.parent) ?? this.members.set(d.parent, new Map()).get(d.parent)!;
          if (!map.has(d.name)) map.set(d.name, d.id);
        }
      }
    }
    this.paths = [...this.files];
  }

  // --- modules ----------------------------------------------------------------

  // A module as written ("pkg.sub", ".models", "..core") from `from`'s file:
  // the file it is, or null (a library).
  resolveModule(module: string, from: string): string | null {
    const dots = /^\.*/.exec(module)![0].length;
    const rest = module.slice(dots).replace(/\./g, "/");
    if (dots) {
      let base = from.split("/").slice(0, -1);
      for (let i = 1; i < dots; i++) base = base.slice(0, -1);
      const dir = base.join("/");
      const at = (p: string) => (dir ? `${dir}/${p}` : p);
      for (const c of rest ? [at(`${rest}.py`), at(`${rest}/__init__.py`)] : [at("__init__.py")]) if (this.files.has(c)) return c;
      return null;
    }
    if (!rest) return null;
    const matches = this.paths.filter((p) => p === `${rest}.py` || p.endsWith(`/${rest}.py`) || p === `${rest}/__init__.py` || p.endsWith(`/${rest}/__init__.py`));
    if (matches.length <= 1) return matches[0] ?? null;
    // Several (a src/ layout and a copy, two `utils`): the shallowest, then the nearest.
    const shared = (p: string) => p.split("/").findIndex((part, i) => part !== from.split("/")[i]);
    return matches.sort((a, b) => a.split("/").length - b.split("/").length || shared(b) - shared(a))[0];
  }

  // --- names ------------------------------------------------------------------

  // What `name` is at `ctx`: a local function, a module-level declaration,
  // or an import.
  resolveName(name: string, ctx: Ctx, depth = 0): Sym | null {
    for (let fn = ctx.fn; fn; fn = this.decls.get(fn)?.parent ?? undefined) {
      const d = this.decls.get(fn);
      if (!d || d.kind !== "function") break;
      const local = this.members.get(fn)?.get(name);
      if (local) return { kind: "decl", id: local };
    }
    return this.moduleMember(ctx.file, name, depth);
  }

  private moduleMember(file: string, name: string, depth = 0): Sym | null {
    if (depth > 8) return null;
    const own = this.members.get(file)?.get(name);
    if (own) return { kind: "decl", id: own };
    for (const i of this.imports.get(file)?.get(name) ?? []) {
      const target = this.importTarget(i, file, depth + 1);
      if (target) return target;
    }
    for (const m of this.starImports.get(file) ?? []) {
      const mod = this.resolveModule(m, file);
      const hit = mod && this.moduleMember(mod, name, depth + 1);
      if (hit) return hit;
    }
    // A submodule of a package: `import pkg` then `pkg.sub`.
    if (file.endsWith("__init__.py")) {
      const dir = file.slice(0, -"__init__.py".length);
      for (const c of [`${dir}${name}.py`, `${dir}${name}/__init__.py`]) if (this.files.has(c)) return { kind: "module", file: c };
    }
    return null;
  }

  private importTarget(i: PyImport, file: string, depth: number): Sym | null {
    if (!i.name) {
      // import a.b as c → module a.b; import a.b → a (a.b reached as an attribute)
      const mod = this.resolveModule(i.local === i.module.split(".")[0] ? i.module.split(".")[0] : i.module, file);
      return mod ? { kind: "module", file: mod } : null;
    }
    const mod = this.resolveModule(i.module, file);
    if (mod) {
      const hit = this.moduleMember(mod, i.name, depth);
      if (hit) return hit;
    }
    // from pkg import sub (a module)
    const sub = this.resolveModule(i.module.endsWith(".") ? `${i.module}${i.name}` : `${i.module}.${i.name}`, file);
    return sub ? { kind: "module", file: sub } : null;
  }

  // --- attributes ---------------------------------------------------------------

  member(base: Sym, name: string, depth = 0): Sym | null {
    if (depth > 8) return null;
    if (base.kind === "module") return this.moduleMember(base.file, name, depth + 1);
    const cls = base.kind === "instance" ? base.cls : base.id;
    const d = this.decls.get(cls);
    if (d?.kind === "class") {
      const hit = this.classMember(cls, name);
      if (hit) return { kind: "decl", id: hit };
      // An attribute: self.x on an instance; on the class, one set in its body (objects = Manager()).
      const attr = this.classAttr(cls, name);
      if (attr && (base.kind === "instance" || attr.scope === cls || this.decls.get(attr.scope)?.kind === "class")) return this.evalRef(attr.ref, this.ctxOf(attr.scope), depth + 1);
    }
    if (d?.kind === "variable" && d.value) {
      const v = this.evalRef(d.value, { file: d.file }, depth + 1);
      return v ? this.member(v, name, depth + 1) : null;
    }
    for (const hook of this.memberHooks) {
      const hit = hook(base, name);
      if (hit) return { kind: "decl", id: hit };
    }
    return null;
  }

  // A class's method (or nested class), through its bases in order.
  classMember(cls: string, name: string, seen = new Set<string>()): string | null {
    if (seen.has(cls)) return null;
    seen.add(cls);
    const own = this.members.get(cls)?.get(name);
    if (own) return own;
    for (const base of this.bases(cls)) {
      const hit = this.classMember(base, name, seen);
      if (hit) return hit;
    }
    return null;
  }

  private classAttr(cls: string, name: string, seen = new Set<string>()): { ref: TypeRef; scope: string } | null {
    if (seen.has(cls)) return null;
    seen.add(cls);
    const own = this.decls.get(cls)?.attrs?.[name];
    if (own) return own;
    for (const base of this.bases(cls)) {
      const hit = this.classAttr(base, name, seen);
      if (hit) return hit;
    }
    return null;
  }

  private basesCache = new Map<string, string[]>();
  bases(cls: string): string[] {
    const hit = this.basesCache.get(cls);
    if (hit) return hit;
    this.basesCache.set(cls, []);
    const d = this.decls.get(cls);
    const out: string[] = [];
    for (const b of d?.bases ?? []) {
      const sym = this.evalPath(b.split("."), { file: d!.file });
      if (sym?.kind === "decl" && this.decls.get(sym.id)?.kind === "class") out.push(sym.id);
    }
    this.basesCache.set(cls, out);
    return out;
  }

  // Does `cls` (or a base) have a written base matching `re` (Django's
  // models.Model, Celery's Task), in the project or not?
  inherits(cls: string, re: RegExp, seen = new Set<string>()): boolean {
    if (seen.has(cls)) return false;
    seen.add(cls);
    const d = this.decls.get(cls);
    if (d?.bases?.some((b) => re.test(b))) return true;
    return this.bases(cls).some((b) => this.inherits(b, re, seen));
  }

  // --- values -------------------------------------------------------------------

  ctxOf(id: string): Ctx {
    const d = this.decls.get(id);
    if (!d) return { file: id.split("#")[0] };
    if (d.kind === "function") return { file: d.file, fn: d.id, ...(d.classOf && { cls: d.classOf }) };
    return { file: d.file };
  }

  // What a dotted path is at `ctx`: self.repo.get, os.path, models.User.
  evalPath(parts: string[], ctx: Ctx, depth = 0): Sym | null {
    if (!parts.length || depth > 8) return null;
    let sym: Sym | null;
    const [head, ...rest] = parts;
    if (head === "self" && ctx.cls) sym = { kind: "instance", cls: ctx.cls };
    else if (head === "cls" && ctx.cls) sym = { kind: "decl", id: ctx.cls };
    else {
      const local = this.localVar(head, ctx);
      sym = local ? this.evalRef(local.ref, local.ctx, depth + 1) : this.resolveName(head, ctx);
    }
    for (const part of rest) {
      if (!sym) return null;
      sym = this.member(sym, part, depth + 1);
    }
    return sym;
  }

  private localVar(name: string, ctx: Ctx): { ref: TypeRef; ctx: Ctx } | null {
    for (let fn = ctx.fn; fn; fn = this.decls.get(fn)?.parent ?? undefined) {
      const d = this.decls.get(fn);
      if (!d || d.kind !== "function") break;
      const ref = d.vars?.[name];
      if (ref) return { ref, ctx: this.ctxOf(fn) };
    }
    return null;
  }

  // What a value is: an annotation names a class (an instance of it); a call
  // gives an instance of the class called, or what the function called is
  // annotated to return.
  evalRef(ref: TypeRef, ctx: Ctx, depth = 0): Sym | null {
    if (depth > 8) return null;
    if (ref.t === "var") return this.evalPath([ref.name], ctx, depth + 1);
    if (ref.t === "path") return this.evalPath(ref.parts, ctx, depth + 1);
    if (ref.t === "result") return this.resultOf(ref.id, depth + 1);
    if (ref.t === "item") {
      // That position of a tuple a call returns.
      if (ref.of.t !== "call") return null;
      const fn = this.evalPath(ref.of.text.split("."), ctx, depth + 1);
      const d = fn?.kind === "decl" ? this.decls.get(fn.id) : undefined;
      const item = d?.items?.[ref.index];
      return item && !(item.t === "var" && !item.name) ? this.evalRef(item, this.ctxOf(d!.id), depth + 1) : null;
    }
    const parts = ref.text.split(".");
    if (ref.t === "type") {
      const sym = this.evalPath(parts, { file: ctx.file }, depth + 1) ?? this.evalPath(parts, ctx, depth + 1);
      return sym?.kind === "decl" && this.decls.get(sym.id)?.kind === "class" ? { kind: "instance", cls: sym.id } : null;
    }
    for (const hook of this.callTypes) {
      const hit = hook(parts, ctx);
      if (hit) return hit;
    }
    const called = this.evalPath(parts, ctx, depth + 1);
    if (called?.kind !== "decl") return null;
    const d = this.decls.get(called.id)!;
    if (d.kind === "class") return { kind: "instance", cls: d.id };
    return d.kind === "function" ? this.resultOf(d.id, depth + 1) : null;
  }

  // What calling a function gives: its return annotation, else what its
  // first return (or a fixture's yield) gives.
  resultOf(fn: string, depth = 0): Sym | null {
    const d = this.decls.get(fn);
    if (!d || d.kind !== "function" || depth > 8) return null;
    if (d.returns) return this.evalRef({ t: "type", text: d.returns }, this.ctxOf(d.id), depth + 1);
    return d.ret ? this.evalRef(d.ret, this.ctxOf(d.id), depth + 1) : null;
  }

  // --- calls ----------------------------------------------------------------------

  // `guess`: fall back to the one method with that name (calls only).
  resolve(call: PyCall, guess = true): { to: string; confidence: Confidence } | null {
    const ctx = this.ctxOf(call.from);
    const target = (sym: Sym | null): string | null => {
      if (sym?.kind !== "decl") return null;
      const d = this.decls.get(sym.id)!;
      if (d.kind === "function") return d.id;
      if (d.kind === "class") return this.classMember(d.id, "__init__") ?? d.id;
      return null;
    };
    const r = call.recv;
    if (r.kind === "none") {
      const to = target(this.evalPath([call.name], ctx));
      return to ? { to, confidence: "exact" } : null;
    }
    if (r.kind === "super") {
      const cls = ctx.cls;
      for (const base of cls ? this.bases(cls) : []) {
        const hit = this.classMember(base, call.name);
        if (hit) return { to: hit, confidence: "exact" };
      }
      return null;
    }
    let base: Sym | null = null;
    let inferred = false;
    if (r.kind === "path") {
      base = this.evalPath(r.parts, ctx);
      inferred = r.parts[0] !== "self" && r.parts[0] !== "cls" && !!this.localVar(r.parts[0], ctx);
      // A library's module or class (os.path, json, requests): not ours.
      if (!base && !this.localVar(r.parts[0], ctx) && r.parts[0] !== "self" && this.importsLibrary(r.parts[0], ctx)) return null;
    } else if (r.kind === "call") {
      base = this.evalRef({ t: "call", text: r.callee }, ctx);
      inferred = true;
    }
    if (base) {
      const to = target(this.member(base, call.name));
      if (to) return { to, confidence: inferred || base.kind === "instance" ? "inferred" : "exact" };
      // One of our classes or modules without it: the framework's.
      if (base.kind !== "decl" || this.decls.get(base.id)?.kind !== "variable") return null;
    }
    return r.kind === "call" || !guess ? null : this.unique(call.name);
  }

  private importsLibrary(name: string, ctx: Ctx): boolean {
    const imps = this.imports.get(ctx.file)?.get(name);
    return !!imps?.length && !this.moduleMember(ctx.file, name);
  }

  private methodsByName: Map<string, string[]> | null = null;
  private unique(name: string): { to: string; confidence: Confidence } | null {
    if (COMMON.has(name) || name.length < 4 || name.startsWith("__")) return null;
    if (!this.methodsByName) {
      this.methodsByName = new Map();
      for (const d of this.decls.values()) {
        if (d.kind !== "function" || !d.classOf || /(^|\/)(tests?|testing)\/|(^|\/)test_[^/]*\.py$|_test\.py$|conftest\.py$/.test(d.file)) continue;
        this.methodsByName.set(d.name, [...(this.methodsByName.get(d.name) ?? []), d.id]);
      }
    }
    const ids = this.methodsByName.get(name);
    return ids?.length === 1 ? { to: ids[0], confidence: "inferred" } : null;
  }

  addEdge(from: string, to: string, file: string, line: number, confidence: Confidence) {
    if (from !== to) this.edges.push({ kind: "calls", from, to, confidence, loc: { file, line } });
  }

  // `from` passes the function `to` along (a callback, a thread's target):
  // shown as "passes it", like TS.
  addRef(from: string, to: string, file: string, line: number) {
    if (from !== to) this.edges.push({ kind: "references", from, to, confidence: "exact", access: "read", loc: { file, line } });
  }

  // The classes that implement an abstract method (an ABC's, a Protocol's):
  // a call to it may run any of them. Only when there are a few.
  implementations(method: string): string[] {
    const d = this.decls.get(method);
    if (!d?.abstract || !d.classOf) return [];
    if (!this.subclasses) {
      this.subclasses = new Map();
      for (const c of this.decls.values()) if (c.kind === "class") for (const b of this.bases(c.id)) this.subclasses.set(b, [...(this.subclasses.get(b) ?? []), c.id]);
    }
    const found: string[] = [];
    const seen = new Set<string>();
    for (let queue = [...(this.subclasses.get(d.classOf) ?? [])]; queue.length; ) {
      const cls = queue.shift()!;
      if (seen.has(cls)) continue;
      seen.add(cls);
      const own = this.members.get(cls)?.get(d.name);
      if (own && !this.decls.get(own)?.abstract) found.push(own);
      queue.push(...(this.subclasses.get(cls) ?? []));
    }
    return found.length <= 4 ? found : [];
  }
  private subclasses: Map<string, string[]> | null = null;

  register(id: string, registration: Registration) {
    if (this.decls.has(id) && !this.registrations.has(id)) this.registrations.set(id, registration);
  }

  tag(file: string, runtime: string) {
    if (this.files.has(file)) this.tags.set(file, runtime);
  }
}

export function linkPython(cached: PyFacts[], root: string, packs: PyPack[] = []): GraphData {
  const facts = structuredClone(cached); // packs fill in variables (pytest fixtures); the session keeps the originals
  const project = new PythonProject(root, facts);
  const active = packs.filter((p) => p.detect(project));
  for (const p of active) p.prepare?.(project);
  const property = /(^|\.)(property|cached_property|computed_field)$/;
  for (const f of facts) {
    for (const call of f.calls) {
      const hit = project.resolve(call);
      if (hit) {
        project.addEdge(call.from, hit.to, f.file, call.line, hit.confidence);
        for (const impl of project.implementations(hit.to)) project.addEdge(call.from, impl, f.file, call.line, "inferred");
      }
      // Functions handed over as values: Thread(target=work), submit(fn), callbacks.
      for (const a of call.args) {
        if (a.t !== "name") continue;
        const sym = project.evalPath(a.v.split("."), project.ctxOf(call.from));
        const fn = sym?.kind === "decl" ? project.decls.get(sym.id) : undefined;
        // (A property passed along is a read of it, not the function.)
        if (fn?.kind === "function" && !fn.decorators?.some((d) => property.test(d.text))) project.addRef(call.from, fn.id, f.file, call.line);
      }
    }
    // obj.name read: a @property runs.
    for (const r of f.reads ?? []) {
      const hit = project.resolve({ from: r.from, name: r.name, recv: r.recv, line: r.line, args: [] }, false);
      if (hit && project.decls.get(hit.to)?.decorators?.some((d) => property.test(d.text))) project.addEdge(r.from, hit.to, f.file, r.line, hit.confidence);
    }
  }
  for (const p of active) p.link?.(project);

  const nodes: Node[] = [];
  for (const d of project.decls.values()) {
    const registration = project.registrations.get(d.id);
    nodes.push({
      id: d.id,
      kind: d.kind === "file" || d.kind === "class" ? "container" : d.kind === "function" ? "callable" : "value",
      name: d.name,
      parent: d.parent,
      loc: { file: d.file, line: d.line, endLine: d.endLine },
      external: false,
      ...(d.kind === "file" && project.tags.has(d.file) && { tags: { runtime: project.tags.get(d.file)! } }),
      detail: {
        pyKind: d.kind,
        ...(d.decorators?.length && { decorators: d.decorators.map((x) => x.text) }),
        ...(registration && { registration }),
      },
    });
  }
  const seen = new Set<string>();
  const edges = project.edges.filter((e) => {
    const key = `${e.kind}|${e.from}|${e.to}|${e.loc?.line}`;
    if (seen.has(key) || !project.decls.has(e.from) || !project.decls.has(e.to)) return false;
    seen.add(key);
    return true;
  });
  const regions: Region[] = facts.flatMap((f) => f.regions);
  return { nodes, edges, regions };
}
