import type { Confidence, Edge, GraphData, Node, Region } from "../../src/schema/index.js";
import type { RExpr, RubyCall, RubyDecl, RubyFacts } from "./extract.js";

// What something is: an instance of a class, the class (singleton), or a
// collection of instances (many: a relation, an association).
export interface RType {
  path: string;
  singleton: boolean;
  many?: boolean;
  confidence: Confidence;
}

// Where an expression is: the class self is, the lexical nesting, the
// declaration (for its locals) and file.
export interface TypeCtx {
  owner: string;
  singleton: boolean;
  nesting: string[];
  from: string;
  file: string;
}

// Every Ruby file's facts → the graph. Ruby has no types to follow, so a
// call is resolved the way a reader would:
//   self / no receiver   the method in this class, its mixins, its superclasses
//   User.find, User.new  the class method (or initialize) of that constant
//   user.save            what `user` was assigned (User.find(…) → a User),
//                        else its name (user, current_user → User)
//   anything else        the one method in the project with that name, if
//                        there is exactly one, it isn't a common name or a
//                        test helper, and the receiver isn't a known class
//                        (that one's method would have been found), an
//                        unknown chain or a library constant
// The first two are exact; the rest are marked inferred. A call that can't
// be resolved has no arrow rather than a wrong one. Packs (Rails…) add what
// a framework does by convention: routes, callbacks, finders, mailers.

export interface Registration {
  call: string; // what registers it ("route", "before_action", "rake")
  key: string | null; // what it's registered under ("GET /users")
  category?: string; // the entries category ("routes", "jobs", "tasks"); default "events"
}

export interface ClassInfo {
  path: string;
  kind: "class" | "module";
  decls: (RubyDecl & { file: string })[]; // every place it's opened
  methods: Map<string, string[]>; // instance methods by name
  singletonMethods: Map<string, string[]>; // class methods by name
  superclass: string | null; // resolved
  includes: string[]; // modules (resolved): include and prepend
  extends: string[]; // modules whose methods become class methods
  // Methods a module gives the class that includes it as class methods
  // (ActiveSupport::Concern's class_methods).
  includerSingleton: Map<string, string[]>;
}

export interface RubyPack {
  name: string;
  // Is the framework in this project?
  detect(project: RubyProject): boolean;
  // Before calls are resolved: new methods (blocks that are really
  // methods), mixins, what calls return.
  prepare?(project: RubyProject): void;
  // After: the framework's own links (routes → actions, callbacks), entries
  // and runtimes.
  link?(project: RubyProject): void;
}

// Common method names: a call to one of these on something of unknown type
// says nothing about which method it is.
export const COMMON = new Set(
  (
    "new initialize call each map select reject find filter detect collect inject reduce sum min max sort sort_by group_by count size length first last " +
    "to_s to_h to_a to_i to_f to_sym to_json to_param inspect hash eql? == equal? dup clone freeze frozen? tap then send public_send respond_to? " +
    "is_a? kind_of? instance_of? nil? present? blank? empty? any? none? all? include? key? fetch dig merge merge! update save save! create create! " +
    "destroy destroy! delete delete! reload valid? errors where order limit pluck exists? find_by find_by! build attributes assign_attributes " +
    "name id type value data params path url file read write open close start stop run perform process execute reset clear add push pop shift " +
    "unshift join split strip gsub sub match keys values items format parse load dump log info debug warn error raise puts print render " +
    "redirect_to head respond_to get set put post patch status body headers request response session cookies flash render_to_string " +
    // Ruby's own Array, Hash, String, Enumerable, Object…
    "map! select! reject! collect! filter_map flat_map each_with_index each_with_object each_slice each_cons each_key each_value each_pair " +
    "delete_if keep_if value? has_key? has_value? member? concat compact compact! flatten flatten! uniq uniq! sort! reverse reverse! rotate " +
    "slice slice! fill zip take_while drop_while partition chunk tally index rindex insert replace transform_values transform_keys " +
    "to_proc to_str to_ary to_hash freeze upcase downcase capitalize chomp chop lines bytes chars start_with? end_with? =~ <=> " +
    "lock unlock synchronize wait signal close? closed? json xml html text yaml csv min_by max_by sum_by group count_by"
  ).split(" "),
);

export class RubyProject {
  readonly decls = new Map<string, RubyDecl & { file: string }>();
  readonly classes = new Map<string, ClassInfo>();
  readonly constants = new Map<string, string>(); // path → decl id
  readonly files = new Set<string>();
  // What `Const.method(…)` gives back is an instance of Const (new, plus a
  // pack's: find, create…).
  readonly instanceReturns = new Set<string>(["new"]);
  // When `Const.name` isn't a class method: a pack's other answer (Rails
  // mailers: the instance method).
  readonly singletonFallbacks: ((cls: ClassInfo, name: string) => string | null)[] = [];
  // Packs: what a framework's collection methods give back (Rails: where,
  // order… a relation), its associations and delegations, and other ways
  // a call is typed (FactoryBot's create(:user), fixtures' users(:one)).
  readonly relationMethods = new Set<string>();
  readonly associations = new Map<string, Map<string, { target: string; many: boolean }>>();
  readonly delegates = new Map<string, Map<string, string>>();
  readonly attrReaders = new Map<string, Set<string>>();
  readonly typeHooks: ((e: Extract<RExpr, { k: "send" }>, base: RType | null, ctx: TypeCtx) => RType | null)[] = [];
  readonly edges: Edge[] = [];
  readonly registrations = new Map<string, Registration>();
  readonly tags = new Map<string, string>(); // file → runtime
  private readonly promoted = new Map<RubyCall, string>();

  constructor(
    readonly root: string,
    readonly facts: RubyFacts[],
  ) {
    for (const f of facts) {
      this.files.add(f.file);
      for (const d of f.decls) this.addDecl({ ...d, file: f.file });
    }
    // Mixins: include / extend / prepend in a class body.
    for (const f of facts) {
      for (const c of f.calls) {
        if (c.recv.kind !== "none" || !/^(include|extend|prepend)$/.test(c.name)) continue;
        const cls = this.classes.get(c.owner);
        const from = this.decls.get(c.from);
        if (!cls || !from || (from.kind !== "class" && from.kind !== "module")) continue;
        for (const a of c.args ?? []) {
          // extend self: the module's methods are its own class methods too.
          const target = a.t === "const" ? this.resolveConst(a.v, c.nesting) : a.t === "other" && a.v === "self" ? cls.path : null;
          if (target) (c.name === "extend" ? cls.extends : cls.includes).push(target);
        }
      }
    }
    // attr_reader / attr_accessor :repo → a reader for @repo; module_function: class methods too.
    for (const f of facts) {
      for (const c of f.calls) {
        if (c.recv.kind !== "none") continue;
        const cls = this.classes.get(c.owner);
        if (!cls) continue;
        if (/^attr_(reader|accessor)$/.test(c.name)) for (const a of c.args ?? []) if (a.t === "sym" || a.t === "str") (this.attrReaders.get(cls.path) ?? this.attrReaders.set(cls.path, new Set()).get(cls.path)!).add(a.v);
        if (c.name === "module_function" && cls.kind === "module" && !cls.extends.includes(cls.path)) cls.extends.push(cls.path);
      }
    }
    for (const cls of this.classes.values()) {
      const withSuper = cls.decls.find((d) => d.superclass);
      if (withSuper) this.classes.get(cls.path)!.superclass = this.resolveConst(withSuper.superclass!, withSuper.nesting ?? []);
    }
  }

  private addDecl(d: RubyDecl & { file: string }) {
    this.decls.set(d.id, d);
    if (d.kind === "class" || d.kind === "module") {
      const cls = this.classes.get(d.path) ?? this.newClass(d.path, d.kind);
      cls.decls.push(d);
    } else if (d.kind === "method") {
      const cls = this.classes.get(d.path) ?? this.newClass(d.path, "class"); // "" is Object (the top level)
      const map = d.singleton ? cls.singletonMethods : cls.methods;
      map.set(d.name, [...(map.get(d.name) ?? []), d.id]);
    } else if (d.kind === "constant") {
      const path = d.path ? `${d.path}::${d.name}` : d.name;
      if (!this.constants.has(path)) this.constants.set(path, d.id);
    }
  }

  private newClass(path: string, kind: "class" | "module"): ClassInfo {
    const cls: ClassInfo = { path, kind, decls: [], methods: new Map(), singletonMethods: new Map(), superclass: null, includes: [], extends: [], includerSingleton: new Map() };
    this.classes.set(path, cls);
    return cls;
  }

  // A constant as written, from where it's written: the lexical nesting
  // first (innermost out), then the top level.
  resolveConst(text: string, nesting: string[]): string | null {
    if (text.startsWith("::")) return this.known(text.slice(2)) ? text.slice(2) : null;
    for (let i = nesting.length - 1; i >= 0; i--) {
      const candidate = `${nesting[i]}::${text}`;
      if (this.known(candidate)) return candidate;
    }
    return this.known(text) ? text : null;
  }

  private known(path: string) {
    return (this.classes.get(path)?.decls.length ?? 0) > 0 || this.constants.has(path);
  }

  // The declaration that stands for a class: the one in the file Rails'
  // autoloader would load it from (Admin::UsersController →
  // admin/users_controller.rb), else the one with a superclass, else the first.
  canonical(path: string): string | null {
    const cls = this.classes.get(path);
    if (!cls?.decls.length) return this.constants.get(path) ?? null;
    const expected = `/${underscore(path)}.rb`;
    return (cls.decls.find((d) => `/${d.file}`.endsWith(expected)) ?? cls.decls.find((d) => d.superclass) ?? cls.decls[0]).id;
  }

  // A method on a class (or its class method), the way Ruby looks it up:
  // the class, then its prepended/included modules, then its superclass.
  findMethod(path: string, name: string, singleton: boolean, seen = new Set<string>()): string | null {
    if (seen.has(path)) return null;
    seen.add(path);
    const cls = this.classes.get(path);
    if (!cls) return null;
    if (singleton) {
      const own = cls.singletonMethods.get(name)?.[0];
      if (own) return own;
      for (const m of cls.extends) {
        // extend self / module_function: its own methods (already "seen").
        const found = m === path ? (cls.methods.get(name)?.[0] ?? null) : this.findMethod(m, name, false, seen);
        if (found) return found;
      }
      for (const m of cls.includes) {
        const found = this.classes.get(m)?.includerSingleton.get(name)?.[0];
        if (found) return found;
      }
      return cls.superclass ? this.findMethod(cls.superclass, name, true, seen) : null;
    }
    const own = cls.methods.get(name)?.[0];
    if (own) return own;
    for (const m of cls.includes) {
      const found = this.findMethod(m, name, false, seen);
      if (found) return found;
    }
    return cls.superclass ? this.findMethod(cls.superclass, name, false, seen) : null;
  }

  // Is `path` (or something it inherits from) `ancestor`? By last name too,
  // for framework classes that aren't in the project (ApplicationRecord's
  // superclass is ActiveRecord::Base).
  inherits(path: string, ancestor: RegExp, seen = new Set<string>()): boolean {
    if (seen.has(path)) return false;
    seen.add(path);
    if (ancestor.test(path)) return true;
    const cls = this.classes.get(path);
    if (!cls) return false;
    const written = cls.decls.find((d) => d.superclass)?.superclass;
    if (written && ancestor.test(written.replace(/^::/, ""))) return true;
    if ([...cls.includes, ...cls.extends].some((m) => ancestor.test(m))) return true;
    return !!cls.superclass && this.inherits(cls.superclass, ancestor, seen);
  }

  addEdge(from: string, to: string, file: string, line: number, confidence: Confidence, kind: Edge["kind"] = "calls") {
    if (from === to) return;
    this.edges.push({ kind, from, to, confidence, loc: { file, line } });
  }

  register(id: string, registration: Registration) {
    if (this.decls.has(id) && !this.registrations.has(id)) this.registrations.set(id, registration);
  }

  tag(file: string, runtime: string) {
    if (this.files.has(file)) this.tags.set(file, runtime);
  }

  // A DSL call whose block is really a method (rake's `task :x do … end`,
  // `scope :active, -> { … }`): a callable of its own, and the calls in the
  // block become its calls.
  promote(call: RubyCall, file: string, name: string, options: { singleton?: boolean; registration?: Registration; range?: { start: number; end: number } } = {}): string | null {
    const range = options.range ?? call.block;
    if (!range || this.promoted.has(call)) return this.promoted.get(call) ?? null;
    const singleton = options.singleton ?? false;
    let id = `${file}#${call.owner ? `${call.owner}.` : ""}${singleton ? "self." : ""}${name}`;
    if (this.decls.has(id)) id = `${id}~${call.line}`;
    this.addDecl({ id, name, kind: "method", path: call.owner, parent: call.from, line: call.line, endLine: range.end, file, ...(singleton && { singleton }), generated: call.name });
    this.promoted.set(call, id);
    const facts = this.facts.find((f) => f.file === file);
    for (const c of facts?.calls ?? []) {
      if (c !== call && c.from === call.from && c.line >= range.start && c.line <= range.end) c.from = id;
    }
    if (options.registration) this.register(id, options.registration);
    return id;
  }

  // --- resolving calls --------------------------------------------------------

  // --- typing --------------------------------------------------------------------

  // What an expression is: an instance of a class, the class itself, or
  // (`many`) a collection of instances: a Rails relation or association,
  // whose class methods (scopes) still apply. Exact when it's direct (self,
  // a constant); inferred through variables, returns and conventions.
  typeOfExpr(e: RExpr, ctx: TypeCtx, depth = 0): RType | null {
    if (depth > 10) return null;
    const inferred = (t: RType | null): RType | null => (t ? { ...t, confidence: "inferred" } : null);
    switch (e.k) {
      case "self":
        return ctx.owner ? { path: ctx.owner, singleton: ctx.singleton, confidence: "exact" } : null;
      case "const": {
        const path = this.resolveConst(e.text, ctx.nesting);
        return path ? { path, singleton: true, confidence: "exact" } : null;
      }
      case "ivar":
      case "lvar": {
        const scope = e.k === "ivar" ? `@${ctx.owner}` : ctx.from;
        const held = this.assignsOf(ctx.file).filter((a) => a.scope === scope && a.name === e.name);
        for (const a of held) {
          const t = this.typeOfExpr(a.value, { ...ctx, nesting: a.nesting }, depth + 1);
          if (t) return inferred(t);
        }
        return this.byName(e.name, ctx);
      }
      case "elem": {
        const of = this.typeOfExpr(e.of, ctx, depth + 1);
        return of ? { path: of.path, singleton: false, confidence: "inferred" } : null; // an element of a collection, or the thing itself (tap)
      }
      case "send": {
        // A bare name: a method of ours (self), else what its name says (current_user → User).
        const base = e.recv ? this.typeOfExpr(e.recv, ctx, depth + 1) : ctx.owner ? { path: ctx.owner, singleton: ctx.singleton, confidence: "exact" as Confidence } : null;
        for (const hook of this.typeHooks) {
          const hit = hook(e, base, ctx);
          if (hit) return hit;
        }
        if (!base) return e.recv ? null : this.byName(e.name, ctx);
        const t = this.sendType(base, e.name, depth);
        if (t) return t;
        return e.recv ? null : this.byName(e.name, ctx);
      }
      default:
        return null;
    }
  }

  // What sending `name` to something of type `base` gives.
  private sendType(base: RType, name: string, depth: number): RType | null {
    const cls = this.classes.get(base.path);
    if (name === "class" && !base.singleton) return { path: base.path, singleton: true, confidence: base.confidence };
    if (name === "new" && base.singleton) return { path: base.path, singleton: false, confidence: base.confidence };
    if (!base.singleton || base.many) {
      // An association (has_many :posts), an attr_reader, or a delegated method.
      const assoc = this.associations.get(base.path)?.get(name);
      if (assoc && !base.many) return { path: assoc.target, singleton: false, many: assoc.many, confidence: "inferred" };
      const reader = this.attrReaders.get(base.path)?.has(name);
      if (reader && !base.many) return this.typeOfExpr({ k: "ivar", name: `@${name.replace(/[?!=]$/, "")}` }, { owner: base.path, singleton: false, nesting: [base.path], from: "", file: "" }, depth + 1);
    }
    if (base.singleton || base.many) {
      if (this.instanceReturns.has(name)) return { path: base.path, singleton: false, confidence: "inferred" };
      if (this.relationMethods.has(name)) return { path: base.path, singleton: false, many: true, confidence: "inferred" };
    }
    // One of our methods: what it returns. On a collection, a class method
    // (a scope) gives the collection back unless it says otherwise.
    const method = this.findMethod(base.path, name, base.singleton || !!base.many) ?? (base.many ? null : null);
    if (method) {
      const d = this.decls.get(method)!;
      if (d.ret) {
        const t = this.typeOfExpr(d.ret, this.typeCtxOf(d.id), depth + 1);
        if (t) return { ...t, confidence: "inferred" };
      }
      if (base.many && d.generated === "scope") return { ...base, confidence: "inferred" };
      return null;
    }
    if (cls && base.singleton) {
      const fallback = this.singletonFallbacks.map((f) => f(cls, name)).find(Boolean);
      if (fallback) return null;
    }
    return null;
  }

  // user, @user, current_user, admin_user → User; posts → Post (many).
  private byName(name: string, ctx: TypeCtx): RType | null {
    const words = name.replace(/^@+/, "").replace(/[?!]$/, "").split("_").filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const tail = words.slice(i);
      const path = this.resolveConst(tail.map(capitalize).join(""), ctx.nesting);
      if (path && this.classes.get(path)?.kind === "class") return { path, singleton: false, confidence: "inferred" };
      const last = tail[tail.length - 1];
      const one = singular(last);
      if (one !== last) {
        const many = this.resolveConst([...tail.slice(0, -1), one].map(capitalize).join(""), ctx.nesting);
        if (many && this.classes.get(many)?.kind === "class") return { path: many, singleton: false, many: true, confidence: "inferred" };
      }
    }
    return null;
  }

  typeCtxOf(id: string): TypeCtx {
    const d = this.decls.get(id);
    const nesting = d ? this.nestingOf(d) : [];
    return { owner: d?.kind === "method" ? d.path : (d?.path ?? ""), singleton: !!d?.singleton, nesting, from: id, file: d?.file ?? "" };
  }

  private nestingOf(d: RubyDecl & { file: string }): string[] {
    const out: string[] = [];
    for (let p = d.kind === "method" ? d.parent : d.id; p; p = this.decls.get(p)?.parent ?? null) {
      const x = this.decls.get(p);
      if (x && (x.kind === "class" || x.kind === "module")) out.unshift(x.path);
    }
    return out;
  }

  private assigns = new Map<string, RubyFacts["assigns"]>();
  private assignsOf(file: string): RubyFacts["assigns"] {
    if (!this.assigns.size) for (const f of this.facts) this.assigns.set(f.file, f.assigns);
    if (file) return this.assigns.get(file) ?? [];
    return [...this.assigns.values()].flat(); // ivars set in another file reopening the class
  }

  // --- resolving calls --------------------------------------------------------

  resolve(call: RubyCall, file = ""): { to: string; confidence: Confidence } | null {
    if (call.name === "super") {
      const sup = this.classes.get(call.owner)?.superclass;
      const found = sup && call.method ? this.findMethod(sup, call.method, call.singleton) : null;
      return found ? { to: found, confidence: "exact" } : null;
    }
    // send(:foo), method(:foo), try(:foo): the method named.
    const named = /^(send|public_send|__send__|try|try!|method)$/.test(call.name) && call.args?.[0] && (call.args[0].t === "sym" || call.args[0].t === "str") ? call.args[0].v : null;
    const name = named ?? call.name;
    // In a class body (not in a def), self is the class: `set :x`, `register Foo`.
    const fromDecl = this.decls.get(call.from);
    const singleton = call.singleton || (!call.method && !call.inBlock && (fromDecl?.kind === "class" || fromDecl?.kind === "module"));
    const ctx: TypeCtx = { owner: call.owner, singleton, nesting: call.nesting, from: call.from, file };
    if (call.recv.kind === "none" || call.recv.kind === "self") {
      const found = this.findMethod(call.owner, name, singleton) ?? (call.owner ? this.topLevel(name, file) : this.topLevel(name, file));
      if (found) return { to: found, confidence: "exact" };
      // A model's own association (versions.where(…)): its class.
      const assoc = this.associations.get(call.owner)?.get(name);
      if (assoc && !call.singleton) {
        const to = this.canonical(assoc.target);
        if (to) return { to, confidence: "pattern" };
      }
      // A module's method calling one its includer has.
      return this.classes.get(call.owner)?.kind === "module" && !call.bare ? this.unique(name) : null;
    }
    const type = call.expr ? this.typeOfExpr(call.expr, ctx) : null;
    if (type) {
      const cls = this.classes.get(type.path);
      if (type.singleton && name === "new") {
        const init = this.findMethod(type.path, "initialize", false);
        const to = init ?? this.canonical(type.path);
        return to ? { to, confidence: type.confidence } : null;
      }
      const found =
        this.findMethod(type.path, name, type.singleton || !!type.many) ??
        (type.many ? this.findMethod(type.path, name, false) : null) ??
        this.delegated(type, name) ??
        (type.singleton && cls ? this.singletonFallbacks.map((f) => f(cls, name)).find(Boolean) : null);
      if (found) return { to: found, confidence: type.confidence };
      // A class of ours without that method: the framework's (an
      // association, an attribute, ActiveRecord's own), not one of ours.
      if (cls?.decls.length) return null;
    }
    // An unknown chain (xml.at_css(…).content) is almost always a library value.
    // So is a constant that isn't ours (Rails.logger).
    // Nor is a global ($stdout) or a literal ("x", [], {}).
    if (call.recv.kind === "other" && /^[$"'\[{:%\d]/.test(call.recv.text)) return null;
    return call.recv.kind === "call" || call.recv.kind === "const" ? null : this.unique(name);
  }

  // A top-level method (a script's, a spec's let): the one in this file first.
  private topLevel(name: string, file: string): string | null {
    const ids = this.classes.get("")?.methods.get(name);
    if (!ids?.length) return null;
    return ids.find((id) => this.decls.get(id)?.file === file) ?? ids[0];
  }

  // delegate :name, to: :user → the user's name.
  private delegated(type: RType, name: string): string | null {
    const via = this.delegates.get(type.path)?.get(name);
    if (!via || type.singleton) return null;
    const target = this.typeOfExpr({ k: "send", recv: { k: "self" }, name: via }, { owner: type.path, singleton: false, nesting: [type.path], from: "", file: "" });
    return target ? this.findMethod(target.path, name, target.singleton) : null;
  }

  // The one instance method in the project with this name.
  private methodsByName: Map<string, string[]> | null = null;
  private unique(name: string): { to: string; confidence: Confidence } | null {
    if (COMMON.has(name) || name.length < 4) return null;
    if (!this.methodsByName) {
      this.methodsByName = new Map();
      // Not test helpers: production code never calls them.
      const own = (id: string) => !/(^|\/)(test|spec|features)\//.test(this.decls.get(id)?.file ?? "");
      for (const cls of this.classes.values()) for (const [n, ids] of cls.methods) this.methodsByName.set(n, [...(this.methodsByName.get(n) ?? []), ...ids.filter(own)]);
    }
    const ids = this.methodsByName.get(name);
    return ids?.length === 1 ? { to: ids[0], confidence: "inferred" } : null;
  }
}

export function linkRuby(cached: RubyFacts[], root: string, packs: RubyPack[] = []): GraphData {
  const facts = structuredClone(cached); // packs re-home calls (promote); the session keeps the originals
  const project = new RubyProject(root, facts);
  const active = packs.filter((p) => p.detect(project));
  for (const p of active) p.prepare?.(project);

  for (const f of facts) {
    for (const call of f.calls) {
      if (call.recv.kind === "none" && /^(include|extend|prepend|require|require_relative|private|protected|public|attr_\w+|module_function)$/.test(call.name)) continue;
      const hit = project.resolve(call, f.file);
      if (hit) project.addEdge(call.from, hit.to, f.file, call.line, hit.confidence);
    }
  }
  for (const p of active) p.link?.(project);

  const nodes: Node[] = [];
  for (const d of project.decls.values()) {
    const kind = d.kind === "file" || d.kind === "class" || d.kind === "module" ? "container" : d.kind === "method" ? "callable" : "value";
    const registration = project.registrations.get(d.id);
    nodes.push({
      id: d.id,
      kind,
      name: d.name,
      parent: d.parent && project.decls.has(d.parent) ? d.parent : d.kind === "file" ? null : d.file,
      loc: { file: d.file, line: d.line, endLine: d.endLine },
      external: false,
      ...(d.kind === "file" && project.tags.has(d.file) && { tags: { runtime: project.tags.get(d.file)! } }),
      detail: {
        rubyKind: d.kind,
        ...(d.kind === "class" || d.kind === "module" ? { path: d.path } : {}),
        ...(d.superclass && { superclass: d.superclass }),
        ...(d.singleton && { singleton: true }),
        ...(d.generated && { generated: d.generated }),
        ...(registration && { registration }),
      },
    });
  }
  // One arrow per caller, line and target.
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

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const IRREGULAR: Record<string, string> = { people: "person", children: "child", men: "man", women: "woman", mice: "mouse", data: "datum", media: "medium", statuses: "status", addresses: "address", aliases: "alias" };
export function singular(word: string): string {
  if (IRREGULAR[word]) return IRREGULAR[word];
  if (/ies$/.test(word)) return word.replace(/ies$/, "y");
  if (/(ss|sh|ch|x|z)es$/.test(word)) return word.replace(/es$/, "");
  if (/s$/.test(word) && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}
export const camelize = (s: string) => s.split("/").map((part) => part.split("_").map(capitalize).join("")).join("::");
export const underscore = (path: string) =>
  path
    .split("::")
    .map((p) => p.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase())
    .join("/");
