import type { Confidence, Edge, GraphData, Node, Region } from "../../src/schema/index.js";
import type { RubyCall, RubyDecl, RubyFacts } from "./extract.js";

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
const COMMON = new Set(
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
          const target = a.t === "const" ? this.resolveConst(a.v, c.nesting) : null;
          if (target) (c.name === "extend" ? cls.extends : cls.includes).push(target);
        }
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
        const found = this.findMethod(m, name, false, seen);
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

  // The class a receiver holds an instance of, and how sure that is.
  typeOf(call: RubyCall): { path: string; singleton: boolean; confidence: Confidence } | null {
    const r = call.recv;
    if (r.kind === "self") return call.owner ? { path: call.owner, singleton: call.singleton, confidence: "exact" } : null;
    if (r.kind === "const") {
      const path = this.resolveConst(r.text, call.nesting);
      return path ? { path, singleton: true, confidence: "exact" } : null;
    }
    if (r.kind === "call" && r.const) {
      const path = this.resolveConst(r.const, call.nesting);
      return path && this.instanceReturns.has(r.method) ? { path, singleton: false, confidence: "inferred" } : null;
    }
    if (r.kind === "ivar" || r.kind === "lvar") {
      const facts = this.factsOf(call);
      const scope = r.kind === "ivar" ? `@${call.owner}` : call.from;
      const held = facts?.assigns.find((a) => a.scope === scope && a.name === r.text);
      if (held) {
        const path = this.resolveConst(held.const, held.nesting);
        if (path && (held.method === "" || this.instanceReturns.has(held.method))) return { path, singleton: held.method === "", confidence: "inferred" };
      }
    }
    if (r.kind === "ivar" || r.kind === "lvar" || r.kind === "ident") {
      // By name: user, @user, current_user, admin_user → User.
      const words = r.text.replace(/^@+/, "").replace(/[?!]$/, "").split("_").filter(Boolean);
      for (let i = 0; i < words.length; i++) {
        const path = this.resolveConst(words.slice(i).map(capitalize).join(""), call.nesting);
        if (path && this.classes.get(path)?.kind === "class") return { path, singleton: false, confidence: "inferred" };
      }
    }
    return null;
  }

  private byFile = new Map<string, RubyFacts>();
  private factsOf(call: RubyCall) {
    if (!this.byFile.size) for (const f of this.facts) this.byFile.set(f.file, f);
    return this.byFile.get(this.decls.get(call.from)?.file ?? "");
  }

  resolve(call: RubyCall): { to: string; confidence: Confidence } | null {
    if (call.name === "super") {
      const sup = this.classes.get(call.owner)?.superclass;
      const found = sup && call.method ? this.findMethod(sup, call.method, call.singleton) : null;
      return found ? { to: found, confidence: "exact" } : null;
    }
    if (call.recv.kind === "none") {
      const found = this.findMethod(call.owner, call.name, call.singleton) ?? (call.owner ? this.findMethod("", call.name, false) : null);
      if (found) return { to: found, confidence: "exact" };
      // A module's method calling one its includer has.
      return this.classes.get(call.owner)?.kind === "module" && !call.bare ? this.unique(call.name) : null;
    }
    const type = this.typeOf(call);
    if (type) {
      const cls = this.classes.get(type.path);
      if (type.singleton && call.name === "new") {
        const init = this.findMethod(type.path, "initialize", false);
        const to = init ?? this.canonical(type.path);
        return to ? { to, confidence: type.confidence } : null;
      }
      const found = this.findMethod(type.path, call.name, type.singleton) ?? (type.singleton && cls ? this.singletonFallbacks.map((f) => f(cls, call.name)).find(Boolean) : null);
      if (found) return { to: found, confidence: type.confidence };
      // A class of ours without that method: the framework's (an
      // association, an attribute, ActiveRecord's own), not one of ours.
      if (cls?.decls.length) return null;
    }
    // An unknown chain (xml.at_css(…).content) is almost always a library value.
    // So is a constant that isn't ours (Rails.logger).
    return call.recv.kind === "call" || call.recv.kind === "const" ? null : this.unique(call.name);
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
      const hit = project.resolve(call);
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
export const camelize = (s: string) => s.split("/").map((part) => part.split("_").map(capitalize).join("")).join("::");
export const underscore = (path: string) =>
  path
    .split("::")
    .map((p) => p.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase())
    .join("/");
