import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { Graph } from "../graph/graph.js";
import { gitChanges, listFiles, validBase } from "./git.js";
import type { Edge, Node, NodeId } from "../schema/index.js";
import type {
  Annotation,
  BlockLink,
  ChangedSymbol,
  ChangesResult,
  CodeBlock,
  EntriesResult,
  EntryCategory,
  EntryPoint,
  FileChange,
  FileEntry,
  FileView,
  GraphDump,
  GraphEdge,
  GraphNode,
  LinkKind,
  MapEdge,
  MapResult,
  NodeRef,
  ProjectInfo,
} from "./types.js";

export type * from "./types.js";

// Deterministic queries: what a view needs, computed from the graph alone.
// A model-backed query layer can sit on top and decide what to expand.
export class Queries {
  constructor(
    readonly graph: () => Graph,
    private readonly root: string,
  ) {}

  // What changed in the working tree since `base` (git), by file and by
  // the declaration each change is in: a top-level function, class, method,
  // type or variable (not a callback nested inside a function, a type's
  // member or a class field), or the file itself for top-level code. New
  // files are their own symbol.
  async changes(base = "HEAD"): Promise<ChangesResult> {
    if (!validBase(base)) return { base, error: `not a ref: ${base}`, files: [] };
    let files: FileChange[];
    try {
      files = await gitChanges(this.root, base);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { base, error: /not a git repository/i.test(message) ? "not a git repository" : (message.split("\n").find((l) => /fatal|error/i.test(l)) ?? message), files: [] };
    }
    const g = this.graph();
    for (const f of files) {
      const fileNode = g.node(f.file);
      f.indexed = !!fileNode && !fileNode.external;
      if (!f.indexed || f.status === "deleted") continue;
      if (f.status === "added" || f.status === "untracked") {
        f.symbols = [{ node: this.ref(fileNode!), added: f.added, removed: f.removed }];
        continue;
      }
      const decls = [...g.allNodes()].filter((n) => !n.external && n.loc?.file === f.file && n.id !== f.file && n.kind !== "block" && n.loc.endLine);
      const nestedInCallable = (n: Node): boolean => {
        for (let p = n.parent ? g.node(n.parent) : undefined; p; p = p.parent ? g.node(p.parent) : undefined) if (p.kind === "callable") return true;
        return false;
      };
      // Not interface/type members or class fields: they count toward
      // their interface or class (methods stay their own).
      const member = (n: Node) => {
        const parent = n.parent ? g.node(n.parent) : undefined;
        return !!parent && parent.id !== f.file && (parent.kind === "type" || n.kind !== "callable");
      };
      const top = decls.filter((n) => !nestedInCallable(n) && !member(n));
      // The deepest top declaration around a line (a method over its class).
      const at = (line: number) => {
        let best: Node | undefined;
        for (const n of top) if (n.loc!.line <= line && n.loc!.endLine! >= line && (!best || n.loc!.line >= best.loc!.line)) best = n;
        return best ?? fileNode!;
      };
      const bySymbol = new Map<string, ChangedSymbol>();
      const count = (n: Node, added: number, removed: number) => {
        const s = bySymbol.get(n.id) ?? { node: this.ref(n), added: 0, removed: 0 };
        s.added += added;
        s.removed += removed;
        bySymbol.set(n.id, s);
      };
      for (const h of f.hunks) {
        for (let line = h.start; line < h.start + h.added; line++) count(at(line), 1, 0);
        // Removed lines count toward what's around where they were: the
        // replacement's first line, or the line after a pure removal.
        if (h.removed.length) count(at(h.added ? h.start : h.start + 1), 0, h.removed.length);
      }
      // The hierarchy: each symbol under the nearest listed declaration
      // around it (a method under its class), which is listed even when
      // only its children changed.
      const topIds = new Set(top.map((n) => n.id));
      const parentOf = new Map<string, string>();
      const place = (id: string) => {
        for (let p = g.node(id)?.parent; p && p !== f.file; p = g.node(p)?.parent) {
          if (!topIds.has(p)) continue;
          parentOf.set(id, p);
          if (!bySymbol.has(p)) {
            count(g.node(p)!, 0, 0);
            place(p);
          }
          return;
        }
      };
      for (const id of [...bySymbol.keys()]) place(id);
      for (const [id, sym] of bySymbol) if (parentOf.has(id)) sym.parent = parentOf.get(id);
      f.symbols = [...bySymbol.values()].sort((a, b) => (a.node.line ?? 0) - (b.node.line ?? 0));
    }
    return { base, files: files.sort((a, b) => a.file.localeCompare(b.file)) };
  }

  info(): ProjectInfo {
    const g = this.graph();
    return { root: this.root, ...g.size, files: this.files().filter((f) => f.indexed).length, lenses: ["runtime", "folder", "containment"] };
  }

  // Every file in the project: the graph's (TS/JS) and the rest (README,
  // JSON, CSS, …: not ignored by git, or outside node_modules/.git/dist
  // when it isn't a repository), which open as text.
  files(): FileEntry[] {
    const g = this.graph();
    const files = new Map<string, FileEntry>();
    for (const n of g.allNodes()) {
      if (n.parent === null && !n.external && n.loc && n.id === n.loc.file) files.set(n.id, { file: n.id, runtime: n.tags?.runtime, indexed: true });
    }
    for (const file of listFiles(this.root)) if (!files.has(file)) files.set(file, { file, indexed: false });
    return [...files.values()].sort((a, b) => a.file.localeCompare(b.file));
  }

  // A project file lode can show and edit: in the graph, or listed above.
  isProjectFile(file: string): boolean {
    const n = this.graph().node(file);
    if (n && !n.external && n.id === n.loc?.file) return true;
    return !file.includes("#") && listFiles(this.root).includes(file);
  }

  // Symbols whose name matches, best matches first.
  search(query: string, limit = 30): NodeRef[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const scored: { node: Node; score: number }[] = [];
    for (const n of this.graph().allNodes()) {
      if (n.external || n.kind === "block") continue;
      const name = n.name.toLowerCase();
      const score = name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : n.id.toLowerCase().includes(q) ? 3 : -1;
      if (score >= 0) scored.push({ node: n, score });
    }
    scored.sort((a, b) => a.score - b.score || a.node.id.length - b.node.id.length);
    return scored.slice(0, limit).map((s) => this.ref(s.node));
  }

  // Where to start reading: what the outside world (another process, the
  // UI, the runtime itself) calls into, grouped by runtime and kind.
  entries(): EntriesResult {
    const g = this.graph();
    const byRuntime = new Map<string | null, Map<string, EntryPoint[]>>();
    const taken = new Set<NodeId>();
    const add = (category: string, node: Node, label: string, detail = `${node.loc?.file.split("/").pop() ?? ""}:${node.loc?.line ?? ""}`) => {
      if (node.external || taken.has(node.id)) return;
      taken.add(node.id);
      const ref = this.ref(node);
      const runtime = ref.runtime ?? null;
      const cats = byRuntime.get(runtime) ?? byRuntime.set(runtime, new Map()).get(runtime)!;
      (cats.get(category) ?? cats.set(category, []).get(category)!).push({ node: ref, label, detail });
    };

    // Files that run project code as soon as they load.
    const onLoad = new Map<NodeId, number>();
    for (const n of g.allNodes()) {
      if (n.parent !== null || n.external || !n.loc || n.id !== n.loc.file) continue;
      const calls = g.neighbors(n.id, "down", ["calls"]).filter((e) => !g.node(e.to)?.external).length;
      if (calls >= 2) onLoad.set(n.id, calls);
    }
    for (const [id, calls] of [...onLoad].sort((a, b) => b[1] - a[1])) add("on load", g.node(id)!, id, `${calls} calls when it loads`);

    // Channel receivers: handlers in another process, and the bridge API.
    const CHANNEL_CATEGORIES: [RegExp, string][] = [
      [/invoke|to-main/, "ipc handlers"],
      [/to-renderer/, "messages from main"],
      [/bridge/, "bridge api"],
    ];
    const receivers = g.channels().filter((e) => e.role === "receive").sort((a, b) => a.key.localeCompare(b.key));
    for (const e of receivers) {
      const category = CHANNEL_CATEGORIES.find(([re]) => re.test(e.family))?.[1] ?? "channels";
      const node = g.node(e.node);
      if (node) add(category, node, e.key);
    }

    // Other registered callbacks: app events, hotkeys, listeners. Timers and
    // tests aren't ways in.
    const NOT_ENTRIES = /^(setTimeout|setInterval|setImmediate|queueMicrotask|nextTick|requestAnimationFrame|requestIdleCallback|describe|it|test|before\w*|after\w*|then|exposeIn\w*World)$/;
    for (const n of g.allNodes()) {
      const reg = n.detail?.registration as { call: string; key: string | null } | undefined;
      if (reg && !NOT_ENTRIES.test(reg.call)) add("events", n, reg.key ? `${reg.call} ${reg.key}` : reg.call);
    }

    // Functions nothing in the project reaches: called by a framework, HTML,
    // or from outside. Last, and folded.
    for (const n of g.allNodes()) {
      if (n.kind !== "callable" || n.external || !n.loc || n.detail?.registration) continue;
      const reached = g.neighbors(n.id, "up").some((e) => e.kind === "calls" || (e.kind === "flows" && e.via && !e.reply) || (e.kind === "references" && e.access === "read"));
      if (!reached) add("not called in the project", n, `${n.name}()`);
    }

    const ORDER = ["on load", "ipc handlers", "messages from main", "bridge api", "events", "channels", "not called in the project"];
    const RUNTIME_ORDER = ["main", "preload", "renderer", "shared"];
    const groups = [...byRuntime]
      .map(([runtime, cats]) => ({
        runtime,
        categories: ORDER.filter((c) => cats.has(c)).map((name): EntryCategory => ({ name, collapsed: name === "not called in the project", entries: cats.get(name)! })),
      }))
      .sort((a, b) => rank(RUNTIME_ORDER, a.runtime) - rank(RUNTIME_ORDER, b.runtime));

    const summary = this.map("runtime").edges.map((e) => ({ ...e, from: e.from.replace(/^runtime:/, ""), to: e.to.replace(/^runtime:/, "") }));
    return { summary, groups };
  }

  // The innermost node whose declaration spans `line` in `file`, or the file
  // itself. What a code view is "in" at a cursor or scroll position.
  symbolAt(file: string, line: number): NodeRef | null {
    let best: Node | undefined;
    for (const n of this.graph().allNodes()) {
      const loc = n.loc;
      if (n.external || !loc || loc.file !== file || loc.line > line || (loc.endLine ?? loc.line) < line) continue;
      const span = (loc.endLine ?? loc.line) - loc.line;
      const bestSpan = best ? (best.loc!.endLine ?? best.loc!.line) - best.loc!.line : Infinity;
      if (span < bestSpan || (span === bestSpan && n.kind === "callable")) best = n;
    }
    best ??= this.graph().node(file);
    return best ? this.ref(best) : null;
  }

  // Every project node in a lens tree (library code left out) and the edges
  // between them merged per pair, for views that lay out the whole graph.
  tree(lensName = "runtime"): GraphDump {
    const g = this.graph();
    const lens = g.lens(lensName);
    const nodes: GraphNode[] = [];
    const included = new Set<NodeId>();
    const visit = (id: NodeId, parent: NodeId | null, depth: number) => {
      const n = lens.node(id);
      if (!n || n.external) return;
      included.add(id);
      nodes.push({
        id,
        name: n.name,
        kind: n.kind,
        parent,
        depth,
        ...(n.loc && { file: n.loc.file, line: n.loc.line }),
        ...(n.loc?.endLine && { endLine: n.loc.endLine }),
      });
      const children = lens.children(id).map((c) => lens.node(c)!).filter(Boolean);
      children.sort((a, b) => (a.loc && b.loc ? a.loc.file.localeCompare(b.loc.file) || a.loc.line - b.loc.line : a.name.localeCompare(b.name)));
      for (const c of children) visit(c.id, id, depth + 1);
    };
    for (const root of lens.roots()) visit(root, null, 0);

    const merged = new Map<string, GraphEdge>();
    for (const e of g.toData().edges) {
      const kind = linkKind(e);
      if (!kind || kind === "local" || !included.has(e.from) || !included.has(e.to) || e.from === e.to) continue;
      const key = `${e.from}|${e.to}|${kind}`;
      const m = merged.get(key);
      if (m) m.count++;
      else merged.set(key, { from: e.from, to: e.to, kind, count: 1 });
    }
    return { lens: lensName, nodes, edges: [...merged.values()] };
  }

  // Groups at one level of a lens, and the edges between them merged.
  map(lensName: string, parentId: NodeId | null = null, includeExternal = false): MapResult {
    const g = this.graph();
    const lens = g.lens(lensName);
    const ids = (parentId ? lens.children(parentId) : lens.roots()).filter((id) => includeExternal || !lens.node(id)?.external);
    const groupSet = new Set(ids);
    const depth = parentId ? lens.path(parentId).length : 0;

    const groupOf = new Map<NodeId, NodeId | null>();
    const group = (id: NodeId) => {
      if (!groupOf.has(id)) {
        const p = lens.path(id);
        const candidate = p[depth];
        groupOf.set(id, candidate && groupSet.has(candidate) && (!parentId || p[depth - 1] === parentId) ? candidate : null);
      }
      return groupOf.get(id)!;
    };

    const merged = new Map<string, MapEdge>();
    for (const e of g.toData().edges) {
      const kind = linkKind(e);
      if (!kind || kind === "local") continue;
      const a = group(e.from);
      const b = group(e.to);
      if (!a || !b || a === b) continue;
      const key = `${a}|${b}|${kind}`;
      const m = merged.get(key);
      if (m) m.count++;
      else merged.set(key, { from: a, to: b, kind, count: 1 });
    }

    const parent = parentId ? lens.node(parentId) : undefined;
    return {
      lens: lensName,
      parent: parent ? this.ref(parent) : null,
      path: parentId ? lens.path(parentId).map((p) => this.ref(lens.node(p)!)) : [],
      groups: ids.map((id) => ({ node: this.ref(lens.node(id)!), children: lens.children(id).length })),
      edges: [...merged.values()].sort((a, b) => b.count - a.count),
    };
  }

  // A source file with lode's inline annotations and the symbols in it.
  source(file: string): FileView | null {
    const text = this.readText(file);
    if (text === null) return null;
    const g = this.graph();
    const annotations: Annotation[] = [];
    const seen = new Set<string>();
    const add = (a: Annotation) => {
      const key = `${a.line}|${a.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        annotations.push(a);
      }
    };
    for (const e of g.toData().edges) {
      if (e.loc?.file !== file) continue;
      const to = g.node(e.to);
      if (!to) continue;
      if (e.kind === "flows" && e.via && !e.reply && g.node(e.from)?.loc?.file === file) {
        add({ line: e.loc.line, kind: "channel", text: `${e.via.family.startsWith("electron-bridge") ? "bridge" : "ipc"} ⇢ ${to.name}`, target: to.id });
      } else if (e.kind === "flows" && e.within && e.to !== e.within && !to.external) {
        const from = g.node(e.from);
        if (from && !from.external) add({ line: e.loc.line, kind: "local", text: `← ${from.name}`, target: from.id });
      } else if (e.kind === "references" && e.access === "write" && to.kind === "value") {
        const readers = this.accessors(to.id, "read").length;
        add({ line: e.loc.line, kind: "state", text: `writes ${to.name} · ${readers} readers`, target: to.id });
      }
    }
    const symbols = [...g.allNodes()]
      .filter((n) => !n.external && n.loc?.file === file && n.id !== file)
      .map((n) => this.ref(n))
      .sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    return { file, text, annotations: annotations.sort((a, b) => a.line - b.line), symbols };
  }

  // A node's code as a block: its lines (a file: the whole file), which of
  // them lead where, who leads to it, and the foldable regions inside it.
  block(id: NodeId): CodeBlock | null {
    const g = this.graph();
    const node = g.node(id);
    if (!node && this.isProjectFile(id)) return this.textBlock(id);
    if (!node?.loc || node.external) return null;
    const file = node.loc.file;
    const text = this.readText(file);
    if (text === null) return null;
    const source = text.split("\n");
    while (source.length > 1 && source[source.length - 1].trim() === "") source.pop();

    const callers: CodeBlock["callers"] = [];
    const seenCallers = new Set<string>();
    // What leads here: calls, IPC senders, code passing it as a callback,
    // writers of a value, users of a type.
    const leadsHere = (e: Edge): { kind: LinkKind; label?: string } | null => {
      if (e.kind === "calls") return { kind: "calls" };
      if (e.kind === "flows" && e.via) return e.reply ? null : { kind: "channel", label: e.via.key };
      if (e.kind !== "references") return null;
      if (e.access === "read" && node.kind === "callable") return { kind: "calls", label: "passes it" };
      if (e.access === "write" && node.kind === "value") return { kind: "state", label: "writes it" };
      if (e.access === "type" && node.kind === "type") return { kind: "calls", label: "uses it" };
      return null;
    };
    for (const e of g.neighbors(id, "up")) {
      const lead = leadsHere(e);
      const from = g.node(e.from);
      if (!lead || !from || from.external || !e.loc || seenCallers.has(from.id)) continue;
      seenCallers.add(from.id);
      callers.push({ node: this.ref(from), line: e.loc.line, ...lead });
    }

    const isFile = node.id === file;
    const start = isFile ? 1 : node.loc.line;
    const end = isFile ? source.length : (node.loc.endLine ?? start);
    const lines = [];
    for (let n = start; n <= end; n++) lines.push({ n, text: source[n - 1] ?? "" });

    // Links leave from lines in this block: its own and its nested nodes'.
    const inside = new Set<NodeId>();
    const walk = (n: NodeId) => (inside.add(n), g.childrenOf(n).forEach((c) => walk(c.id)));
    walk(id);
    const links: BlockLink[] = [];
    const seen = new Set<string>();
    const add = (l: BlockLink) => {
      const key = `${l.line}|${l.target.id}|${l.kind}`;
      if (seen.has(key) || l.line < start || l.line > end) return;
      seen.add(key);
      links.push(l);
    };
    for (const from of inside) {
      for (const e of g.neighbors(from, "down")) {
        const to = g.node(e.to);
        if (!to || to.external || !e.loc || e.loc.file !== file || to.id === id) continue;
        if (e.kind === "calls") add({ line: e.loc.line, kind: "calls", target: this.ref(to) });
        else if (e.kind === "flows" && e.via && !e.reply) add({ line: e.loc.line, kind: "channel", target: this.ref(to), label: e.via.key });
        else if (e.kind === "references" && e.access === "write" && to.kind === "value") add({ line: e.loc.line, kind: "state", target: this.ref(to), label: "writes" });
        else if (e.kind === "references" && e.access === "read" && to.kind === "callable") add({ line: e.loc.line, kind: "calls", target: this.ref(to), label: "passes" });
      }
    }
    // A value leads to whoever reads it.
    if (node.kind === "value") {
      for (const reader of this.accessors(id, "read")) {
        const r = g.node(reader);
        if (r) add({ line: start, kind: "state", target: this.ref(r), label: "read by" });
      }
    }

    // Foldable regions, tagged with the declaration whose body they are.
    const declsByEnd = new Map<number, Node[]>();
    for (const d of inside) {
      const n = g.node(d)!;
      if (d === id || !n.loc?.endLine) continue;
      declsByEnd.set(n.loc.endLine, [...(declsByEnd.get(n.loc.endLine) ?? []), n]);
    }
    const regions = g
      .regions(file)
      .filter((r) => r.start >= start && r.end <= end)
      .map((r) => {
        const decl = declsByEnd.get(r.end)?.find((d) => r.start >= d.loc!.line && r.start <= d.loc!.line + 5);
        return { start: r.start, end: r.end, kind: r.kind, ...(decl && { node: this.ref(decl) }) };
      });

    const reg = node.detail?.registration as { call: string; key: string | null } | undefined;
    return {
      node: this.ref(node),
      outline: isFile,
      lines,
      links: links.sort((a, b) => a.line - b.line),
      callers,
      ...(reg && { trigger: reg.key ? `${reg.call} ${reg.key}` : reg.call }),
      regions,
    };
  }

  // A project file's text; real paths on both sides, so neither `..` nor a
  // symlink can leave the project.
  private readText(file: string): string | null {
    try {
      const root = realpathSync(this.root);
      const absolute = realpathSync(path.resolve(this.root, file));
      if (!absolute.startsWith(root + path.sep)) return null;
      if (statSync(absolute).size > 4_000_000) return null; // too big to show
      return readFileSync(absolute, "utf8");
    } catch {
      return null;
    }
  }

  // A file outside the graph, as plain lines: no links or callers. Markdown
  // headings fold into their sections.
  private textBlock(file: string): CodeBlock | null {
    const text = this.readText(file);
    if (text === null || text.includes("\0")) return null; // binary
    const source = text.split(/\r?\n/);
    while (source.length > 1 && source[source.length - 1].trim() === "") source.pop();
    const regions: CodeBlock["regions"] = [];
    if (/\.(md|markdown|mdx)$/i.test(file)) {
      const headings: { line: number; level: number }[] = [];
      let fenced = false;
      source.forEach((l, i) => {
        if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
        const m = !fenced && /^(#{1,6})\s/.exec(l);
        if (m) headings.push({ line: i + 1, level: m[1].length });
      });
      headings.forEach((h, i) => {
        const next = headings.slice(i + 1).find((o) => o.level <= h.level);
        let end = next ? next.line - 1 : source.length;
        while (end > h.line && source[end - 1].trim() === "") end--;
        if (end > h.line) regions.push({ start: h.line, end, kind: "block" });
      });
    }
    return {
      node: { id: file, name: path.basename(file), kind: "container", file, line: 1, endLine: source.length, external: false },
      outline: true,
      lines: source.map((t, i) => ({ n: i + 1, text: t })),
      links: [],
      callers: [],
      regions,
    };
  }

  ref(node: Node): NodeRef {
    const runtime = this.graph().lens("runtime").path(node.id)[0];
    return {
      id: node.id,
      name: node.name,
      kind: node.kind,
      ...(node.loc && { file: node.loc.file, line: node.loc.line }),
      ...(node.loc?.endLine && { endLine: node.loc.endLine }),
      external: node.external,
      ...(runtime?.startsWith("runtime:") && { runtime: runtime.slice("runtime:".length) }),
    };
  }

  private pathOf(id: NodeId): NodeRef[] {
    const lens = this.graph().lens("runtime");
    return lens.path(id).map((p) => this.ref(lens.node(p)!));
  }

  private accessors(value: NodeId, access: "read" | "write"): NodeId[] {
    const nodes = new Set<NodeId>();
    for (const e of this.graph().neighbors(value, "up", ["references"])) if (e.access === access) nodes.add(e.from);
    return [...nodes];
  }
}

function rank(order: string[], value: string | null): number {
  const i = value === null ? -1 : order.indexOf(value);
  return i === -1 ? order.length : i;
}

// Replies are the far end of a request, not a separate connection.
function linkKind(e: Edge): LinkKind | null {
  if (e.reply) return null;
  if (e.kind === "calls") return "calls";
  if (e.kind === "flows") return e.via ? "channel" : e.through ? "state" : "local";
  return null;
}
