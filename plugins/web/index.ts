import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { listFiles } from "../../src/query/git.js";
import type { Edge, GraphData, LanguagePlugin, Node, PluginSession } from "../../src/schema/index.js";

// Web files: HTML pages and stylesheets (CSS, SCSS, Sass, Less), as file
// nodes, and what each one pulls in, as `imports` edges:
//   HTML   <script src>, <link href> (stylesheets, modules), <iframe src>,
//          and <a href> to another page
//   CSS    @import, and SCSS / Sass @use and @forward (partials: _x.scss,
//          x/_index.scss)
// Targets are project files, by relative path or from the root ("/app.css",
// also tried under public/ and static/); URLs and libraries are left out.
// An edge to a file no plugin made a node for (an image) is dropped by the
// graph. Other plugins link into these too: TS/JS `import "./app.css"`,
// Rails' stylesheet_link_tag. No parser: what's matched is the tags and
// at-rules themselves, which is all a file's dependencies need.

const WEB_FILE = /\.(html?|css|scss|sass|less)$/i;
const MAX_BYTES = 1_000_000;

export interface WebOptions {
  // Files another plugin already reads (Django's templates are Python's).
  skip?: (file: string) => boolean;
}

interface WebFacts {
  file: string;
  lines: number;
  refs: { spec: string; line: number; style: boolean }[]; // style: a stylesheet's import (partials, extensions)
}

export const isWebFile = (file: string) => WEB_FILE.test(file) && !/(^|\/)(node_modules|vendor|dist|build)\//.test(file);

export function webPlugin(options: WebOptions = {}): LanguagePlugin {
  const owns = (file: string) => isWebFile(file) && !options.skip?.(file);
  const open = (projectPath: string, state?: unknown): PluginSession => {
    const root = rootOf(projectPath);
    let cache: Record<string, { hash: string; facts: WebFacts }> = isState(state) ? state.files : {};
    const files = () => {
      const hashes: Record<string, string> = {};
      for (const f of listFiles(root)) {
        if (!owns(f)) continue;
        try {
          const absolute = path.join(root, f);
          if (statSync(absolute).size <= MAX_BYTES) hashes[f] = createHash("sha1").update(readFileSync(absolute)).digest("hex");
        } catch {
          // Gone between listing and reading.
        }
      }
      return hashes;
    };
    const update = (changed?: string[]): GraphData => {
      const current = files();
      const redo = new Set(changed ?? Object.keys(current));
      const next: typeof cache = {};
      for (const [file, hash] of Object.entries(current)) {
        const cached = cache[file];
        next[file] = cached && cached.hash === hash && !redo.has(file) ? cached : { hash, facts: extract(file, readFileSync(path.join(root, file), "utf8")) };
      }
      cache = next;
      return link(Object.values(cache).map((c) => c.facts), new Set(listFiles(root)));
    };
    return { root: () => root, files, update, state: () => ({ files: cache }) };
  };
  return { name: "web", version: 1, index: (projectPath) => open(projectPath).update(), open };
}

// --- one file's references ------------------------------------------------------

export function extract(file: string, text: string): WebFacts {
  const refs: WebFacts["refs"] = [];
  const lineAt = (index: number) => text.slice(0, index).split("\n").length;
  const push = (spec: string | undefined, index: number, style: boolean) => {
    if (spec && local(spec)) refs.push({ spec, line: lineAt(index), style });
  };
  if (/\.html?$/i.test(file)) {
    // A tag's attribute: <script src>, <link href>, <iframe src>, <a href>.
    const tag = /<(script|link|iframe|a)\b[^>]*?\s(src|href)\s*=\s*(["'])([^"']+)\3/gi;
    for (let m = tag.exec(text); m; m = tag.exec(text)) {
      const [, name, , , spec] = m;
      // A link: another page only (not a #section or a download).
      if (name.toLowerCase() === "a" && !/\.html?([?#].*)?$/i.test(spec)) continue;
      push(spec, m.index, false);
    }
  } else {
    // @import "x"; @import url(x); @use "x" as y; @forward "x"; (Sass: no quotes or semicolons needed)
    const rule = /@(import|use|forward)\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\2/g;
    for (let m = rule.exec(text); m; m = rule.exec(text)) push(m[3], m.index, true);
  }
  return { file, lines: text.split("\n").length, refs };
}

// Not a URL, a library (sass:math, ~bootstrap) or a template's placeholder.
function local(spec: string): boolean {
  return !/^([a-z][a-z0-9+.-]*:|\/\/|#|~|data:)/i.test(spec) && !/[{}<>$]/.test(spec) && !spec.startsWith("@");
}

// --- the project's graph ----------------------------------------------------------

function link(facts: WebFacts[], projectFiles: Set<string>): GraphData {
  const nodes: Node[] = facts.map((f) => ({
    id: f.file,
    kind: "container",
    name: f.file.split("/").pop()!,
    parent: null,
    loc: { file: f.file, line: 1, endLine: f.lines },
    external: false,
    detail: { web: true },
  }));
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const f of facts) {
    for (const r of f.refs) {
      const to = resolve(r.spec, f.file, r.style, projectFiles);
      const key = `${to}|${r.line}`;
      if (!to || to === f.file || seen.has(`${f.file}|${key}`)) continue;
      seen.add(`${f.file}|${key}`);
      edges.push({ kind: "imports", from: f.file, to, confidence: "exact", loc: { file: f.file, line: r.line } });
    }
  }
  return { nodes, edges };
}

// A reference from `from` to a project file: relative to it, or from the
// root (and public/ or static/, where sites keep what "/" serves). A
// stylesheet's import also tries the extensions and partials Sass does.
export function resolve(spec: string, from: string, style: boolean, files: Set<string>): string | null {
  let clean: string;
  try {
    clean = decodeURI(spec.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  const bases = clean.startsWith("/") ? [clean.slice(1), `public${clean}`, `static${clean}`] : [path.posix.normalize(path.posix.join(path.posix.dirname(from), clean))];
  for (const base of bases) {
    if (base.startsWith("..")) continue;
    const candidates = [base];
    if (style) {
      const dir = path.posix.dirname(base);
      const name = path.posix.basename(base);
      const under = (n: string) => (dir === "." ? n : `${dir}/${n}`);
      for (const ext of ["scss", "sass", "css", "less"]) candidates.push(`${base}.${ext}`, under(`_${name}.${ext}`), `${base}/_index.${ext}`, `${base}/index.${ext}`);
    }
    const hit = candidates.find((c) => files.has(c));
    if (hit) return hit;
  }
  return null;
}

function rootOf(projectPath: string): string {
  const absolute = path.resolve(projectPath);
  return statSync(absolute).isDirectory() ? absolute : path.dirname(absolute);
}

function isState(value: unknown): value is { files: Record<string, { hash: string; facts: WebFacts }> } {
  return typeof value === "object" && value !== null && "files" in value;
}
