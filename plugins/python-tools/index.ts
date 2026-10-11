import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PyPack, PythonProject } from "../python/link.js";

// Python's everyday tools, by convention:
//   pytest   a test's (or fixture's) parameter is the fixture of that name,
//            from its file or a conftest.py above it: the test uses it, and
//            the parameter holds what the fixture returns or yields
//   CLIs     click / typer commands, argparse subcommands
//            (set_defaults(func=cmd_sync)), and pyproject's [project.scripts]
//            and [tool.poetry.scripts]: entries (tasks)

const TEST_FILE = /(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/;

export const pythonToolsPack: PyPack = {
  name: "python-tools",

  detect: () => true,

  prepare(project) {
    // Fixtures by the folder they're visible from.
    const fixtures = new Map<string, Map<string, string>>(); // folder (or file) → name → fixture
    for (const d of project.decls.values()) {
      if (d.kind !== "function") continue;
      const dec = d.decorators?.find((x) => /(^|\.)fixture$/.test(x.text));
      if (!dec) continue;
      const name = dec.args.find((a) => a.key === "name" && a.t === "str")?.v ?? d.name;
      const scope = d.file.endsWith("conftest.py") ? path.posix.dirname(d.file) : d.file;
      (fixtures.get(scope) ?? fixtures.set(scope, new Map()).get(scope)!).set(name, d.id);
    }
    if (!fixtures.size) return;
    const fixtureFor = (file: string, name: string): string | null => {
      const own = fixtures.get(file)?.get(name);
      if (own) return own;
      // conftest.py in its folder, then each folder above (the root's is ".").
      for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
        const hit = fixtures.get(dir)?.get(name);
        if (hit) return hit;
        if (dir === ".") return null;
      }
    };
    for (const d of project.decls.values()) {
      if (d.kind !== "function" || !TEST_FILE.test(d.file)) continue;
      for (const p of d.params ?? []) {
        if (p === "self" || p === "cls" || d.vars?.[p]) continue;
        const fixture = fixtureFor(d.file, p);
        if (!fixture || fixture === d.id) continue;
        (d.vars ??= {})[p] = { t: "result", id: fixture };
        project.addEdge(d.id, fixture, d.file, d.line, "pattern");
      }
    }
  },

  link(project) {
    for (const d of project.decls.values()) {
      if (d.kind !== "function") continue;
      // click: @cli.command(), @click.command("name"); typer: @app.command()
      const dec = d.decorators?.find((x) => /(^|\.)(command|group)$/.test(x.text) && !/(^|\.)(fixture|property)$/.test(x.text));
      if (dec) project.register(d.id, { call: "command", key: dec.args.find((a) => a.t === "str" && !a.key)?.v ?? d.name.replace(/_/g, "-"), category: "tasks" });
    }
    // argparse: sub.add_parser("sync") … s.set_defaults(func=cmd_sync)
    for (const f of project.facts) {
      for (const c of f.calls) {
        if (c.name !== "set_defaults") continue;
        for (const a of c.args) {
          if (!a.key || a.t !== "name") continue;
          const fn = project.evalPath(a.v.split("."), project.ctxOf(c.from));
          if (fn?.kind !== "decl" || project.decls.get(fn.id)?.kind !== "function") continue;
          const sub = f.calls.filter((p) => p.name === "add_parser" && p.from === c.from && p.line <= c.line && p.args[0]?.t === "str").at(-1);
          project.register(fn.id, { call: "command", key: sub?.args[0].v ?? null, category: "tasks" });
          project.addEdge(c.from, fn.id, f.file, c.line, "pattern");
        }
      }
    }
    // Console scripts: name = "pkg.module:function"
    const pyproject = read(project.root, "pyproject.toml");
    for (const section of pyproject.split(/^\[/m).filter((s) => /^(project\.scripts|tool\.poetry\.scripts)\]/.test(s))) {
      for (const [, name, module, fn] of section.matchAll(/^\s*["']?([\w.-]+)["']?\s*=\s*["']([\w.]+):([\w.]+)["']/gm)) {
        const file = project.resolveModule(module, "");
        const sym = file ? project.evalPath(fn.split("."), { file }) : null;
        if (sym?.kind === "decl") project.register(sym.id, { call: "script", key: name, category: "tasks" });
      }
    }
  },
};

function read(root: string, file: string): string {
  const full = path.join(root, file);
  try {
    return existsSync(full) ? readFileSync(full, "utf8") : "";
  } catch {
    return "";
  }
}
