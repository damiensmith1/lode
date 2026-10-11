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
    const urlFiles = project.facts.filter((f) => /(^|\/)urls\.py$|(^|\/)urls\/[^/]+\.py$/.test(f.file));
    for (const f of urlFiles) {
      for (const c of f.calls) {
        if (!/^(path|re_path|url)$/.test(c.name) || c.args[0]?.t !== "str" || c.args[1]?.t !== "call" || !/(^|\.)include$/.test(c.args[1].v)) continue;
        const included = includeArg(f.file, c.line, project);
        const target = included && project.resolveModule(included, f.file);
        if (target) includes.set(target, join(includes.get(f.file) ?? "", c.args[0].v));
      }
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
        const d = project.decls.get(sym.id)!;
        if (d.kind === "function") project.register(d.id, { call: "path", key, category: "routes" });
        else
          for (const m of ["get", "post", "put", "patch", "delete"]) {
            const handler = project.classMember(d.id, m);
            if (handler) project.register(handler, { call: m.toUpperCase(), key, category: "routes" });
          }
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
