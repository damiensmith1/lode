import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RubyArg, RubyCall, RubyPack, RubyProject } from "../ruby/index.js";
import { camelize } from "../ruby/link.js";
import { listFiles } from "../../src/query/git.js";

// Rails (and ActiveRecord on its own): what the framework connects by
// convention, as arrows and entries.
//   routes        config/routes.rb → controller actions (entries: routes, by verb and path)
//   callbacks     before_action :x, after_save :y, validate :z → the methods
//   associations  has_many :posts → Post
//   scopes        scope :active, -> { … } → a class method
//   concerns      class_methods do … end → class methods of the includer
//   finders       User.find / where.first / create … → a User
//   mailers       UserMailer.welcome(…) → UserMailer#welcome
//   jobs          SomeJob.perform_later / Worker.perform_async → #perform (entries: jobs)
//   rake          task :x do … end → a callable (entries: tasks)

const RELATION = "where not or rewhere order reorder in_order_of limit offset includes preload eager_load joins left_joins left_outer_joins references distinct select group having all none unscope only except merge lock readonly strict_loading extending from excluding without page per padding".split(" ");
const FINDERS = "new find find_by find_by! first first! last last! take take! sole find_sole_by second third create create! find_or_create_by find_or_create_by! find_or_initialize_by create_or_find_by build".split(" ");
const CALLBACK = /^(before|after|around|skip_before|skip_after|skip_around)_(action|filter|save|create|update|destroy|validation|commit|rollback|initialize|find|touch|create_commit|update_commit|destroy_commit|save_commit|enqueue|perform|deliver)$|^(validate|validates_with|rescue_from|helper_method)$/;
const ASSOCIATION = /^(has_many|has_one|belongs_to|has_and_belongs_to_many)$/;

export const railsPack: RubyPack = {
  name: "rails",

  detect(project) {
    if (project.files.has("config/routes.rb") || project.files.has("config/application.rb")) return true;
    const manifests = [...project.files].filter((f) => /(^|\/)Gemfile$|\.gemspec$/.test(f));
    return manifests.some((f) => /\b(rails|activerecord|activesupport|actionpack)\b/.test(read(project.root, f)));
  },

  prepare(project) {
    views(project);
    for (const f of FINDERS) project.instanceReturns.add(f);
    for (const m of RELATION) project.relationMethods.add(m);

    // Associations as typed methods: has_many :posts → user.posts is Posts
    // (a collection: scopes and finders apply), belongs_to :author,
    // class_name: "User" → post.author is a User. And delegate :name, to: :user.
    for (const f of project.facts) {
      for (const c of f.calls) {
        if (c.recv.kind !== "none" || !c.args?.length || !project.classes.get(c.owner)) continue;
        if (ASSOCIATION.test(c.name) && c.args[0].t === "sym") {
          if (pairValue(c.args, "polymorphic") || pairArg(c.args, "polymorphic")) continue;
          const many = c.name === "has_many" || c.name === "has_and_belongs_to_many";
          const written = pairValue(c.args, "class_name") ?? camelize(many ? singularize(c.args[0].v) : c.args[0].v);
          const target = project.resolveConst(written, c.nesting);
          if (target) (project.associations.get(c.owner) ?? project.associations.set(c.owner, new Map()).get(c.owner)!).set(c.args[0].v, { target, many });
        }
        if (c.name === "delegate") {
          const via = pairValue(c.args, "to");
          const prefix = pairValue(c.args, "prefix");
          if (!via) continue;
          for (const a of c.args) {
            if (a.t !== "sym") continue;
            const name = prefix === "true" ? `${via}_${a.v}` : prefix ? `${prefix}_${a.v}` : a.v;
            (project.delegates.get(c.owner) ?? project.delegates.set(c.owner, new Map()).get(c.owner)!).set(name, via);
          }
        }
      }
    }
    // Fixtures: users(:one) is a User (in tests).
    project.typeHooks.push((e, _base, ctx) => {
      if (e.recv || e.args?.[0]?.t !== "sym" || !/(^|\/)(test|spec)\//.test(ctx.file)) return null;
      const one = singularize(e.name);
      if (one === e.name) return null;
      const path = project.resolveConst(camelize(one), ctx.nesting);
      return path && project.classes.get(path)?.kind === "class" ? { path, singleton: false, confidence: "inferred" } : null;
    });
    // UserMailer.welcome(…): the instance method. SomeJob.perform_later(…): perform.
    project.singletonFallbacks.push((cls, name) => {
      if (/^(perform_later|perform_now|perform_async|perform_in|perform_at|perform_bulk|set)$/.test(name)) return project.findMethod(cls.path, "perform", false);
      if (project.inherits(cls.path, /(^|::)(ApplicationMailer|ActionMailer::Base|Mailer)$/)) return project.findMethod(cls.path, name, false);
      return null;
    });

    for (const facts of project.facts) {
      const blocks = facts.calls.filter((c) => c.block);
      for (const call of facts.calls) {
        if (call.recv.kind !== "none") continue;
        const first = call.args?.[0];
        // scope :active, -> { … } (or a block): a class method.
        if (call.name === "scope" && first?.t === "sym") {
          const lambda = call.args!.find((a): a is Extract<RubyArg, { t: "lambda" }> => a.t === "lambda");
          project.promote(call, facts.file, first.v, { singleton: true, ...(lambda && { range: lambda }) });
        }
        // class_methods do … end in a concern: its methods are the includer's class methods.
        if (call.name === "class_methods" && call.block) {
          const cls = project.classes.get(call.owner);
          if (!cls) continue;
          for (const [name, ids] of cls.methods) {
            const inside = ids.filter((id) => {
              const d = project.decls.get(id)!;
              return d.file === facts.file && d.line > call.block!.start && d.line <= call.block!.end;
            });
            if (inside.length) cls.includerSingleton.set(name, inside);
          }
        }
        // Rake: task :name do … end, in namespaces.
        if (call.name === "task" && call.block && /\.rake$|(^|\/)Rakefile$/.test(facts.file)) {
          const name = taskName(first);
          if (!name) continue;
          const spaces = blocks
            .filter((b) => b.name === "namespace" && b.recv.kind === "none" && b.block!.start < call.line && b.block!.end >= call.line)
            .sort((a, b) => a.line - b.line)
            .map((b) => taskName(b.args?.[0]))
            .filter(Boolean);
          const key = [...spaces, name].join(":");
          project.promote(call, facts.file, `task ${key}`, { registration: { call: "rake", key, category: "tasks" } });
        }
      }
    }
  },

  link(project) {
    for (const facts of project.facts) {
      const file = facts.file;
      for (const call of facts.calls) {
        if (call.recv.kind !== "none" || !call.args) continue;
        const from = project.decls.get(call.from);
        const inClass = from && (from.kind === "class" || from.kind === "module");
        // Callbacks: the symbols name methods (and if:/unless: conditions).
        if (inClass && CALLBACK.test(call.name)) {
          for (const sym of symbols(call.args, ["if", "unless", "with"])) {
            const to = project.findMethod(call.owner, sym, false);
            if (to) project.addEdge(call.from, to, file, call.line, "pattern");
          }
        }
        // Associations: has_many :posts → Post (or class_name:). Also in
        // methods: a concern's has_one_x that declares them.
        if (from && ASSOCIATION.test(call.name) && call.args[0]?.t === "sym") {
          const named = pairValue(call.args, "class_name");
          const written = named ?? camelize(call.name === "has_many" || call.name === "has_and_belongs_to_many" ? singularize(call.args[0].v) : call.args[0].v);
          const target = project.resolveConst(written, call.nesting);
          const to = target && project.canonical(target);
          if (to) project.addEdge(call.from, to, file, call.line, "pattern");
        }
      }
    }

    // Jobs: perform is what a queue calls.
    for (const cls of project.classes.values()) {
      if (cls.kind !== "class" || !project.inherits(cls.path, /(^|::)(ApplicationJob|ActiveJob::Base|Sidekiq::Job|Sidekiq::Worker)$/)) continue;
      const perform = cls.methods.get("perform")?.[0];
      if (perform) project.register(perform, { call: "job", key: cls.path, category: "jobs" });
    }

    routes(project);
    renders(project);
    assets(project);

    for (const file of project.files) {
      if (/^app\/(controllers|helpers|views)\/|^config\/routes(\.rb|\/)/.test(file)) project.tag(file, "web");
      else if (/^app\/(jobs|workers|sidekiq)\//.test(file)) project.tag(file, "jobs");
      else if (/^lib\/tasks\/|\.rake$/.test(file)) project.tag(file, "tasks");
    }
  },
};

// --- views ------------------------------------------------------------------------

// app/views/admin/users/show.html.erb → its controller's (Admin::UsersController),
// or a mailer's (app/views/user_mailer/…): the class whose code the view
// runs as, for its @variables and the methods it calls. Helpers
// (app/helpers) are available to every view.
const VIEW = /^app\/views\/(.+)\/([^/]+?)\.[^/]*(erb|jbuilder)$/;

function controllerOfView(project: RubyProject, file: string): string | null {
  const m = VIEW.exec(file);
  if (!m || m[1].startsWith("layouts")) return null;
  const base = camelize(m[1]);
  for (const c of [`${base}Controller`, base]) if (project.classes.get(c)?.decls.length) return c;
  return null;
}

function views(project: RubyProject) {
  for (const f of project.facts) {
    const owner = controllerOfView(project, f.file);
    if (!owner) continue;
    const nesting = owner.split("::").map((_, i, parts) => parts.slice(0, i + 1).join("::"));
    for (const c of f.calls) if (c.owner === "") Object.assign(c, { owner, nesting });
    for (const a of f.assigns) if (!a.scope.startsWith("@")) a.nesting = nesting;
  }
  const helpers = [...project.classes.values()].filter((c) => c.kind === "module" && c.decls.some((d) => d.file.startsWith("app/helpers/")));
  project.receiverless.push((call, file) => {
    if (!VIEW.test(file) && !/^app\/helpers\//.test(file)) return null;
    for (const h of helpers) {
      const hit = project.findMethod(h.path, call.name, false);
      if (hit) return hit;
    }
    return null;
  });
}

// A view's stylesheets and scripts, as imports (the web plugin reads the
// files): stylesheet_link_tag "application" → app/assets/stylesheets/
// application.css (or .scss, .sass, or the bundler's app/assets/builds);
// javascript_include_tag / javascript_import_module_tag "application" →
// app/javascript/application.js (or app/assets/javascripts, the builds).
function assets(project: RubyProject) {
  const views = project.facts.filter((f) => f.file.startsWith("app/views/"));
  if (!views.length) return;
  const all = new Set(listFiles(project.root));
  const pick = (dirs: string[], exts: string[], name: string) => dirs.flatMap((d) => exts.map((e) => `${d}/${name}.${e}`)).find((c) => all.has(c)) ?? null;
  for (const f of views) {
    for (const c of f.calls) {
      const style = c.name === "stylesheet_link_tag";
      if (c.recv.kind !== "none" || !(style || /^javascript_(include|import_module)_tag$/.test(c.name))) continue;
      for (const a of c.args ?? []) {
        if (a.t !== "str" && a.t !== "sym") continue;
        const name = a.v.replace(/\.(css|js)$/, "");
        const to = style
          ? pick(["app/assets/stylesheets", "app/assets/builds", "public"], ["css", "scss", "sass"], name)
          : pick(["app/javascript", "app/assets/javascripts", "app/assets/builds", "public"], ["js", "ts", "mjs"], name);
        if (to) project.edges.push({ kind: "imports", from: f.file, to, confidence: "pattern", loc: { file: f.file, line: c.line } });
      }
    }
  }
}

// An action renders its view (by name, or as `render :edit`, `render
// "posts/edit"`); a view renders partials (`render "form"` → _form, `render
// @comments` → comments/_comment).
function renders(project: RubyProject) {
  const files = [...project.files].filter((f) => VIEW.test(f) || /^app\/views\/layouts\//.test(f));
  const find = (dir: string, name: string, partial: boolean): string | null => {
    const [d, n] = name.includes("/") ? [name.split("/").slice(0, -1).join("/"), name.split("/").pop()!] : [dir, name];
    const want = `app/views/${d}/${partial ? "_" : ""}${n}.`;
    return files.find((f) => f.startsWith(want)) ?? null;
  };
  // Actions → their implicit views.
  for (const file of files) {
    const m = VIEW.exec(file);
    const owner = controllerOfView(project, file);
    if (!m || !owner || m[2].startsWith("_")) continue;
    const action = project.findMethod(owner, m[2].split(".")[0], false);
    const d = action && project.decls.get(action);
    if (d && project.decls.has(file)) project.addEdge(d.id, file, d.file, d.line, "pattern");
  }
  // Explicit renders.
  for (const f of project.facts) {
    const inView = VIEW.exec(f.file);
    const controller = /^app\/controllers\/(.+)_controller\.rb$/.exec(f.file);
    const dir = inView ? inView[1] : controller ? controller[1] : null;
    if (!dir) continue;
    for (const c of f.calls) {
      if (c.name !== "render" || c.recv.kind !== "none" || !c.args?.length) continue;
      const a = c.args[0];
      const named = a.t === "sym" || a.t === "str" ? a.v : a.t === "pair" && /^(partial|template|action)$/.test(a.k) && (a.v.t === "sym" || a.v.t === "str") ? a.v.v : null;
      const partial = !!inView || (a.t === "pair" && a.k === "partial");
      let target = named ? find(dir, named, partial) : null;
      // render @comments / render @post: the model's partial.
      if (!target && a.t === "other" && /^@?\w+$/.test(a.v)) {
        const plural = a.v.replace(/^@/, "");
        target = find(plural.endsWith("s") ? plural : `${plural}s`, singularize(plural), true);
      }
      if (target && project.decls.has(target)) project.addEdge(c.from, target, f.file, c.line, "pattern");
    }
  }
}

// --- routes -------------------------------------------------------------------

interface Context {
  module: string[]; // controller namespace (Admin)
  path: string; // URL prefix
  resource?: { name: string; singular: boolean; controller: string; part: "nested" | "member" | "collection" };
}

const VERBS = /^(get|post|put|patch|delete|match)$/;
const REST = {
  plural: [["index", "GET", ""], ["create", "POST", ""], ["new", "GET", "/new"], ["edit", "GET", "/:id/edit"], ["show", "GET", "/:id"], ["update", "PATCH", "/:id"], ["destroy", "DELETE", "/:id"]],
  singular: [["create", "POST", ""], ["new", "GET", "/new"], ["edit", "GET", "/edit"], ["show", "GET", ""], ["update", "PATCH", ""], ["destroy", "DELETE", ""]],
} as const;

function routes(project: RubyProject) {
  for (const facts of project.facts) {
    if (!/^config\/routes(\.rb$|\/)/.test(facts.file)) continue;
    const calls = facts.calls.filter((c) => c.recv.kind === "none" && c.args);
    const scoped = calls.filter((c) => c.block && /^(namespace|scope|resources|resource|member|collection|controller|constraints|defaults)$/.test(c.name));
    // Each call's context: the scoping blocks around it, outermost first.
    const contextOf = (call: RubyCall): Context => {
      const around = scoped.filter((b) => b !== call && b.block!.start <= call.line && b.block!.end >= call.line && b.line < call.line).sort((a, b) => a.line - b.line);
      let ctx: Context = { module: [], path: "" };
      for (const b of around) ctx = enter(ctx, b);
      return ctx;
    };
    const route = (call: RubyCall, controller: string, action: string, verb: string, url: string) => {
      const cls = project.resolveConst(controller, []);
      const to = cls && project.findMethod(cls, action, false);
      if (!to) return;
      project.addEdge(call.from, to, facts.file, call.line, "pattern");
      project.register(to, { call: verb, key: url || "/", category: "routes" });
    };

    for (const call of calls) {
      const ctx = contextOf(call);
      const args = call.args!;
      if (call.name === "resources" || call.name === "resource") {
        const singular = call.name === "resource";
        for (const a of args) {
          if (a.t !== "sym" && a.t !== "str") continue;
          const r = enter(ctx, { ...call, args: [a, ...args.filter((x) => x.t === "pair")] } as RubyCall);
          const only = list(pairArg(args, "only"));
          const except = list(pairArg(args, "except"));
          for (const [action, verb, suffix] of REST[singular ? "singular" : "plural"]) {
            if ((only && !only.includes(action)) || except?.includes(action)) continue;
            route(call, r.resource!.controller, action, verb, `${r.path}${suffix}`);
          }
        }
        continue;
      }
      if (call.name === "root") {
        const to = pairValue(args, "to") ?? (args[0]?.t === "str" ? args[0].v : null);
        const target = to && controllerAction(to, ctx);
        if (target) route(call, target.controller, target.action, "GET", ctx.path || "/");
        continue;
      }
      if (!VERBS.test(call.name)) continue;
      const verb = call.name === "match" ? (list(pairArg(args, "via"))?.join("|").toUpperCase() ?? "GET") : call.name.toUpperCase();
      // get "path", to: "c#a" · get "path" => "c#a" · get :preview (in a resource) · get "x", controller:, action:
      const first = args[0];
      const arrow = first?.t === "pair" && first.v.t === "str" && first.v.v.includes("#") ? first : null;
      const pathPart = arrow ? arrow.k : first && (first.t === "str" || first.t === "sym") ? first.v : "";
      const to = arrow ? (arrow.v as { v: string }).v : pairValue(args, "to");
      let target = to ? controllerAction(to, ctx) : null;
      const on = pairValue(args, "on");
      if (!target && ctx.resource) target = { controller: ctx.resource.controller, action: pairValue(args, "action") ?? pathPart.replace(/^\//, "").replace(/\/.*$/, "") };
      else if (!target && pairValue(args, "controller")) target = { controller: controllerName(pairValue(args, "controller")!, ctx), action: pairValue(args, "action") ?? pathPart };
      if (!target?.action) continue;
      const base = ctx.resource && (on === "member" || ctx.resource.part === "member") ? `${ctx.path}/:id` : ctx.path;
      route(call, target.controller, target.action, verb, `${base}/${pathPart.replace(/^\//, "")}`.replace(/\/$/, ""));
    }
  }
}

// What a scoping block adds to the context it's in.
function enter(ctx: Context, b: RubyCall): Context {
  const first = b.args?.[0];
  const name = first && (first.t === "sym" || first.t === "str") ? first.v : "";
  const nested = (c: Context) => (c.resource && c.resource.part === "nested" ? `${c.path}/:${singularize(c.resource.name)}_id` : c.path);
  switch (b.name) {
    case "namespace":
      return { module: [...ctx.module, camelize(name)], path: `${nested(ctx)}/${name}` };
    case "scope": {
      const mod = pairValue(b.args ?? [], "module");
      const prefix = pairValue(b.args ?? [], "path") ?? (first?.t === "str" ? first.v.replace(/^\//, "") : "");
      return { ...ctx, module: mod ? [...ctx.module, camelize(mod)] : ctx.module, path: prefix ? `${ctx.path}/${prefix}` : ctx.path };
    }
    case "resources":
    case "resource": {
      const singular = b.name === "resource";
      const controller = pairValue(b.args ?? [], "controller") ?? (singular ? pluralize(name) : name);
      return { module: ctx.module, path: `${nested(ctx)}/${pairValue(b.args ?? [], "path") ?? name}`, resource: { name, singular, controller: controllerName(controller, ctx), part: "nested" } };
    }
    case "member":
      return ctx.resource ? { ...ctx, resource: { ...ctx.resource, part: "member" } } : ctx;
    case "collection":
      return ctx.resource ? { ...ctx, resource: { ...ctx.resource, part: "collection" } } : ctx;
    case "controller":
      return name ? { ...ctx, resource: { name, singular: false, controller: controllerName(name, ctx), part: "collection" } } : ctx;
    default:
      return ctx;
  }
}

// "admin/users#index" → Admin::UsersController#index (inside namespaces too).
function controllerAction(to: string, ctx: Context): { controller: string; action: string } | null {
  const [controller, action] = to.split("#");
  return controller && action ? { controller: controllerName(controller, ctx), action } : null;
}

function controllerName(written: string, ctx: Context): string {
  return [...ctx.module, `${camelize(written)}Controller`].join("::");
}

// --- helpers --------------------------------------------------------------------

function read(root: string, file: string): string {
  const full = path.join(root, file);
  try {
    return existsSync(full) ? readFileSync(full, "utf8") : "";
  } catch {
    return "";
  }
}

function taskName(a: RubyArg | undefined): string | null {
  if (!a) return null;
  if (a.t === "sym" || a.t === "str") return a.v;
  if (a.t === "pair") return a.k; // task name: [:deps]
  return null;
}

// Method names in a DSL call: its symbols, and the symbols of some options.
function symbols(args: RubyArg[], keys: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (a.t === "sym") out.push(a.v);
    else if (a.t === "pair" && keys.includes(a.k)) for (const v of a.v.t === "array" ? a.v.items : [a.v]) if (v.t === "sym") out.push(v.v);
  }
  return out;
}

function pairArg(args: RubyArg[], key: string): RubyArg | undefined {
  return args.find((a): a is Extract<RubyArg, { t: "pair" }> => a.t === "pair" && a.k === key)?.v;
}

function pairValue(args: RubyArg[], key: string): string | null {
  const v = pairArg(args, key);
  return v && (v.t === "sym" || v.t === "str" || v.t === "const") ? v.v : null;
}

function list(a: RubyArg | undefined): string[] | null {
  if (!a) return null;
  if (a.t === "array") return a.items.flatMap((i) => (i.t === "sym" || i.t === "str" ? [i.v] : []));
  return a.t === "sym" || a.t === "str" ? [a.v] : null;
}

const IRREGULAR: Record<string, string> = { people: "person", children: "child", men: "man", women: "woman", mice: "mouse", data: "datum", media: "medium" };

export function singularize(word: string): string {
  if (IRREGULAR[word]) return IRREGULAR[word];
  if (/ies$/.test(word)) return word.replace(/ies$/, "y");
  if (/(ss|sh|ch|x|z)es$/.test(word)) return word.replace(/es$/, "");
  if (/ses$/.test(word)) return word.replace(/es$/, "");
  if (/s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  return word;
}

export function pluralize(word: string): string {
  const back = Object.entries(IRREGULAR).find(([, s]) => s === word);
  if (back) return back[0];
  if (/[^aeiou]y$/.test(word)) return word.replace(/y$/, "ies");
  if (/(s|sh|ch|x|z)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

