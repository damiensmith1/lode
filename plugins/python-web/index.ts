import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PyArg } from "../python/extract.js";
import type { PyPack, PythonProject, Sym } from "../python/link.js";

// Python web frameworks and task queues: what they connect by convention,
// as arrows and entries.
//   routes      @app.get("/x"), @router.post(…), @bp.route(…) (FastAPI,
//               Flask, Starlette), with APIRouter(prefix=…) / Blueprint(url_prefix=…)
//   django      urls.py path()/re_path() → views (function or class-based),
//               with include() prefixes; Model.objects.get(…) → an instance;
//               management commands; @receiver signals
//   tasks       @shared_task / @app.task (Celery, Dramatiq's @actor):
//               entries; task.delay(…) / .apply_async(…) / .send(…) → the task

const VERB = /(^|\.)(get|post|put|patch|delete|head|options|route|api_route|websocket)$/;
const TASK = /(^|\.)(shared_task|task|actor|job|periodic_task)$/;
const FINDERS = /^(get|create|first|last|earliest|latest|get_or_create|update_or_create|filter|exclude|all|select_related|prefetch_related|order_by|annotate|in_bulk)$/;

export const pythonWebPack: PyPack = {
  name: "python-web",

  detect(project) {
    const manifests = [...project.files].length ? ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile"].map((f) => read(project.root, f)).join("\n") : "";
    if (/\b(django|fastapi|flask|starlette|celery|dramatiq|rq)\b/i.test(manifests)) return true;
    return project.facts.some((f) => f.imports.some((i) => /^(django|fastapi|flask|starlette|celery|dramatiq)\b/.test(i.module)));
  },

  prepare(project) {
    // EntryQuerySet.as_manager() / Manager.from_queryset(QS)(): the queryset's methods.
    project.callTypes.push((callee, ctx) => {
      if (callee[callee.length - 1] !== "as_manager") return null;
      const qs = project.evalPath(callee.slice(0, -1), ctx);
      return qs?.kind === "decl" && project.decls.get(qs.id)?.kind === "class" ? { kind: "instance", cls: qs.id } : null;
    });
    // Model.objects.<finder>(…) gives a Model (or rows of them, which call like one).
    project.callTypes.push((callee, ctx) => {
      const at = callee.lastIndexOf("objects");
      if (at < 1 || !FINDERS.test(callee[callee.length - 1])) return null;
      const model = project.evalPath(callee.slice(0, at), ctx);
      return model?.kind === "decl" && project.decls.get(model.id)?.kind === "class" ? { kind: "instance", cls: model.id } : null;
    });
    // task.delay(…) and friends run the task.
    project.memberHooks.push((base: Sym, name) => {
      if (base.kind !== "decl" || !/^(delay|apply_async|send|send_with_options|s|si|signature|enqueue)$/.test(name)) return null;
      const d = project.decls.get(base.id);
      return d?.kind === "function" && d.decorators?.some((x) => TASK.test(x.text)) ? d.id : null;
    });
  },

  link(project) {
    // Routes by decorator.
    for (const d of project.decls.values()) {
      if (d.kind !== "function") continue;
      for (const dec of d.decorators ?? []) {
        if (VERB.test(dec.text) && dec.args[0]?.t === "str" && dec.text.includes(".")) {
          const verb = /\.(route|api_route)$/.test(dec.text) ? (methodsOf(dec.args) ?? "GET") : dec.text.split(".").pop()!.toUpperCase();
          const prefix = prefixOf(project, dec.text.split(".").slice(0, -1), d.file);
          project.register(d.id, { call: verb, key: join(prefix, dec.args[0].v), category: "routes" });
        } else if (TASK.test(dec.text)) {
          project.register(d.id, { call: "task", key: d.qual, category: "jobs" });
        } else if (/(^|\.)receiver$/.test(dec.text) && dec.args[0]) {
          project.register(d.id, { call: "signal", key: dec.args[0].v, category: "events" });
        }
      }
    }

    // FastAPI dependencies: Depends(get_db) runs get_db for the endpoint.
    for (const f of project.facts) {
      for (const c of f.calls) {
        if (c.name !== "Depends" || c.args[0]?.t !== "name") continue;
        const dep = project.evalPath(c.args[0].v.split("."), project.ctxOf(c.from));
        if (dep?.kind === "decl" && project.decls.get(dep.id)?.kind === "function") project.addEdge(c.from, dep.id, f.file, c.line, "pattern");
      }
    }

    // Django urls: path("x/", view) / re_path / url, under include() prefixes.
    const includes = new Map<string, string>(); // urls file → its prefix
    const namespaces = new Map<string, string>(); // urls file → its namespace (include(…, namespace=) or its app_name)
    const urlFiles = project.facts.filter((f) => /(^|\/)urls\.py$|(^|\/)urls\/[^/]+\.py$/.test(f.file));
    for (const f of urlFiles) {
      for (const c of f.calls) {
        if (!/^(path|re_path|url)$/.test(c.name) || c.args[0]?.t !== "str" || c.args[1]?.t !== "call" || !/(^|\.)include$/.test(c.args[1].v)) continue;
        const included = includeArg(f.file, c.line, project);
        const target = included && project.resolveModule(included, f.file);
        if (target) {
          includes.set(target, join(includes.get(f.file) ?? "", c.args[0].v));
          const ns = /namespace\s*=\s*["'](\w+)["']/.exec(read(project.root, f.file).split("\n")[c.line - 1] ?? "")?.[1];
          if (ns) namespaces.set(target, ns);
        }
      }
    }
    // path(…, name="entry") → the view: by "blog:entry" (namespaced) and, when
    // only one urls file uses it, by "entry".
    const urlNames = new Map<string, string>();
    const bare = new Map<string, string | null>();
    const namespaceOf = (file: string) => namespaces.get(file) ?? project.facts.find((x) => x.file === file)?.decls.find((d) => d.kind === "variable" && d.name === "app_name")?.text;
    // How many urls files name each route, resolved or not (a TemplateView is
    // a name too): a bare name links only when there's one.
    const named = new Map<string, number>();
    for (const f of urlFiles) for (const c of f.calls) {
      const n = /^(path|re_path|url)$/.test(c.name) ? c.args.find((a) => a.key === "name" && a.t === "str")?.v : undefined;
      if (n) named.set(n, (named.get(n) ?? 0) + 1);
    }
    for (const f of urlFiles) {
      for (const c of f.calls) {
        if (!/^(path|re_path|url)$/.test(c.name) || c.args[0]?.t !== "str" || !c.args[1]) continue;
        const view = c.args[1];
        const parts = view.t === "call" && view.v.endsWith(".as_view") ? view.v.split(".").slice(0, -1) : view.t === "name" ? view.v.split(".") : null;
        const sym = parts && project.evalPath(parts, project.ctxOf(c.from));
        if (sym?.kind !== "decl") continue;
        const key = join(includes.get(f.file) ?? "", c.args[0].v.replace(/^\^|\$$/g, ""));
        project.addEdge(c.from, sym.id, f.file, c.line, "pattern");
        const urlName = c.args.find((a) => a.key === "name" && a.t === "str")?.v;
        if (urlName) {
          const ns = namespaceOf(f.file);
          if (ns) urlNames.set(`${ns}:${urlName}`, sym.id);
          bare.set(urlName, named.get(urlName) === 1 ? sym.id : null);
        }
        const d = project.decls.get(sym.id)!;
        if (d.kind === "function") project.register(d.id, { call: "path", key, category: "routes" });
        else
          for (const m of ["get", "post", "put", "patch", "delete"]) {
            const handler = project.classMember(d.id, m);
            if (handler) project.register(handler, { call: m.toUpperCase(), key, category: "routes" });
          }
      }
    }

    // Templates: a view renders one (render(request, "blog/entry.html"),
    // template_name = …); a template extends and includes others, and links
    // to views by URL name ({% url 'entry' %}).
    const templates = new Map<string, string>(); // "blog/entry.html" → its file
    for (const f of project.facts) {
      const m = /(?:^|\/)templates\/(.+)$/.exec(f.file);
      if (m && f.template) templates.set(m[1], f.file);
    }
    if (templates.size) {
      for (const f of project.facts) {
        for (const t of f.template ?? []) {
          const to = t.kind === "url" ? (t.name.includes(":") ? urlNames.get(t.name.split(":").slice(-2).join(":")) : (bare.get(t.name) ?? undefined)) : templates.get(t.name);
          if (to) project.addEdge(f.file, to, f.file, t.line, "pattern");
        }
        for (const c of f.calls) {
          if (!/^(render|render_to_response|render_to_string|render_template|TemplateResponse|get_template|select_template)$/.test(c.name)) continue;
          const name = c.args.find((a) => a.t === "str" && templates.has(a.v))?.v;
          if (name) project.addEdge(c.from, templates.get(name)!, f.file, c.line, "pattern");
        }
      }
      for (const d of project.decls.values()) {
        const name = d.kind === "class" ? d.strings?.template_name : undefined;
        if (name && templates.has(name)) project.addEdge(d.id, templates.get(name)!, d.file, d.line, "pattern");
      }
    }

    // Django management commands: <app>/management/commands/<name>.py → Command.handle.
    for (const f of project.facts) {
      const m = /\/management\/commands\/([^/]+)\.py$/.exec(f.file);
      if (!m) continue;
      const cmd = f.decls.find((d) => d.kind === "class" && d.name === "Command");
      const handle = cmd && project.classMember(cmd.id, "handle");
      if (handle) project.register(handle, { call: "manage.py", key: m[1], category: "tasks" });
    }

    // (After commands and routes, which name these more precisely.)
    // Django calls these on the classes it drives: views' hooks, models',
    // forms', admins', apps', commands'.
    const DJANGO_BASE = /(^|\.)(\w*View|\w*Mixin|Model|Form|ModelForm|ModelAdmin|AppConfig|BaseCommand|LabelCommand|Serializer|ModelSerializer|ViewSet|ModelViewSet|APIView|Feed|Sitemap|Middleware\w*|Field|Widget|Storage|TestCase)$/;
    const HOOK = /^(get|post|put|patch|delete|head|options|dispatch|setup|get_queryset|get_object|get_context_data|get_template_names|get_success_url|form_valid|form_invalid|get_form|get_form_kwargs|get_initial|get_redirect_url|save|delete|clean|clean_\w+|full_clean|validate|__str__|get_absolute_url|ready|handle|handle_label|add_arguments|items|item_\w+|location|lastmod|has_\w+_permission|get_\w+_display|save_model|get_list_display|create|update|perform_\w+|to_representation|to_internal_value|process_request|process_response|process_view|__call__)$/;
    for (const d of project.decls.values()) {
      if (d.kind !== "function" || !d.classOf || !HOOK.test(d.name) || project.registrations.has(d.id)) continue;
      if (project.inherits(d.classOf, DJANGO_BASE)) project.register(d.id, { call: "django", key: `${project.decls.get(d.classOf)?.name}.${d.name}`, category: "events" });
    }

    // A file that declares routes serves the web, wherever it is (main.py).
    const routed = new Set([...project.registrations].filter(([, r]) => r.category === "routes").map(([id]) => project.decls.get(id)!.file));
    for (const file of project.files) {
      if (routed.has(file) || /(^|\/)(views?|urls|api|routers?|routes|endpoints|controllers)(\.py$|\/)/.test(file)) project.tag(file, "web");
      else if (/(^|\/)(tasks|workers?|jobs)(\.py$|\/)/.test(file)) project.tag(file, "jobs");
      else if (/\/management\/commands\//.test(file)) project.tag(file, "tasks");
    }
  },
};

// The prefix of the router or blueprint a route hangs off: router =
// APIRouter(prefix="/users"), bp = Blueprint("x", __name__, url_prefix="/x").
function prefixOf(project: PythonProject, receiver: string[], file: string): string {
  const sym = project.evalPath(receiver, { file });
  if (sym?.kind !== "decl") return "";
  const d = project.decls.get(sym.id);
  return d?.args?.find((a) => a.key === "prefix" || a.key === "url_prefix")?.v ?? "";
}

function methodsOf(args: PyArg[]): string | null {
  const m = args.find((a) => a.key === "methods");
  return m ? (m.v.match(/[A-Za-z]+/g) ?? []).map((x) => x.toUpperCase()).join("|") || null : null;
}

// include("blog.urls") as written on that line (the arg is a call, so its string isn't kept).
function includeArg(file: string, line: number, project: PythonProject): string | null {
  const text = read(project.root, file).split("\n")[line - 1] ?? "";
  return /include\(\s*["']([\w.]+)["']/.exec(text)?.[1] ?? null;
}

function join(prefix: string, p: string): string {
  const joined = `/${[prefix, p].map((x) => x.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")}`;
  return joined;
}

function read(root: string, file: string): string {
  const full = path.join(root, file);
  try {
    return existsSync(full) ? readFileSync(full, "utf8") : "";
  } catch {
    return "";
  }
}
