import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Graph } from "../graph/graph.js";
import type { Edge, Node, NodeId } from "../schema/index.js";
import type {
  Annotation,
  FileEntry,
  FileView,
  FocusResult,
  Link,
  LinkKind,
  LocalFlow,
  MapEdge,
  MapResult,
  NodeRef,
  ProjectInfo,
  Step,
} from "./types.js";

export type * from "./types.js";

// Deterministic queries: what a view needs, computed from the graph alone.
// A model-backed query layer can sit on top and decide what to expand.
export class Queries {
  constructor(
    readonly graph: () => Graph,
    private readonly root: string,
  ) {}

  info(): ProjectInfo {
    const g = this.graph();
    return { root: this.root, ...g.size, files: this.files().length, lenses: ["runtime", "folder", "containment"] };
  }

  files(): FileEntry[] {
    const g = this.graph();
    const files: FileEntry[] = [];
    for (const n of g.allNodes()) {
      if (n.parent === null && !n.external && n.loc && n.id === n.loc.file) files.push({ file: n.id, runtime: n.tags?.runtime });
    }
    return files.sort((a, b) => a.file.localeCompare(b.file));
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

  focus(id: NodeId): FocusResult | null {
    const g = this.graph();
    const node = g.node(id);
    if (!node) return null;

    // Steps: the project calls it makes, plus callbacks defined inside it.
    const calls = g.neighbors(id, "down", ["calls"]);
    const steps: Step[] = [];
    let libraryCalls = 0;
    for (const e of calls) {
      const target = g.node(e.to);
      if (!target || target.external) {
        libraryCalls++;
        continue;
      }
      steps.push({ label: `${target.name}()`, target: this.ref(target), line: e.loc?.line ?? 0 });
    }
    for (const child of g.childrenOf(id)) {
      if (child.kind === "callable" && child.detail?.registration) {
        steps.push({ label: child.name, target: this.ref(child), line: child.loc?.line ?? 0, callback: true });
      }
    }
    steps.sort((a, b) => a.line - b.line);

    // Local flows, mapped onto steps (the first step calling each producer).
    const stepOf = (target: NodeId) => steps.findIndex((s) => s.target?.id === target);
    const flows: LocalFlow[] = [];
    const seenFlows = new Set<string>();
    for (const e of g.within(id)) {
      const from = stepOf(e.from);
      const to = e.to === id ? "return" : stepOf(e.to);
      const key = `${from}>${to}`;
      if (from < 0 || to === -1 || from === to || seenFlows.has(key)) continue;
      seenFlows.add(key);
      flows.push({ from, to, type: e.type });
    }

    const up = new LinkSet(this);
    const down = new LinkSet(this);
    for (const e of g.neighbors(id, "up")) {
      if (e.kind === "calls") up.add(e.from, "calls", undefined, e.args?.join(", "));
      else if (e.kind === "flows" && e.via) up.add(e.from, "channel", e.via.key, e.type);
      else if (e.kind === "references" && e.access === "read" && g.node(e.to)?.kind === "callable") up.add(e.from, "calls", "passes it");
    }
    for (const e of g.neighbors(id, "down")) {
      if (e.kind === "calls" && !g.node(e.to)?.external) down.add(e.to, "calls", undefined, e.returns);
      else if (e.kind === "flows" && e.via) down.add(e.to, "channel", e.via.key, e.type);
      else if (e.kind === "references" && e.to !== id && g.node(e.to)?.kind === "value") {
        const readers = this.accessors(e.to, "read").filter((r) => r !== id).length;
        const writers = this.accessors(e.to, "write").filter((w) => w !== id).length;
        if (e.access === "write") down.add(e.to, "state", "writes", e.type, `${readers} readers`);
        else if (e.access === "read" && writers > 0) up.add(e.to, "state", "reads", e.type, `${writers} writers`);
      }
    }

    return { node: this.ref(node), path: this.pathOf(id), steps, flows, up: up.list(), down: down.list(), hidden: { libraryCalls } };
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
    let text: string;
    try {
      // Real paths on both sides, so neither `..` nor a symlink leaves the project.
      const root = realpathSync(this.root);
      const absolute = realpathSync(path.resolve(this.root, file));
      if (!absolute.startsWith(root + path.sep)) return null;
      text = readFileSync(absolute, "utf8");
    } catch {
      return null;
    }
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
      if (e.kind === "flows" && e.via && g.node(e.from)?.loc?.file === file) {
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

  ref(node: Node): NodeRef {
    const runtime = this.graph().lens("runtime").path(node.id)[0];
    return {
      id: node.id,
      name: node.name,
      kind: node.kind,
      ...(node.loc && { file: node.loc.file, line: node.loc.line }),
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

// Links to the same node and kind merge, counting the edges behind them.
class LinkSet {
  private readonly links = new Map<string, Link>();
  constructor(private readonly queries: Queries) {}

  add(id: NodeId, kind: LinkKind, label?: string, type?: string, detail?: string) {
    const key = `${id}|${kind}|${label ?? ""}`;
    const existing = this.links.get(key);
    if (existing) {
      existing.count++;
      return;
    }
    const node = this.queries.graph().node(id);
    if (!node) return;
    this.links.set(key, { node: this.queries.ref(node), kind, ...(label && { label }), ...(type && { type }), count: 1, ...(detail && { detail }) });
  }

  // Channels first (they cross boundaries), then state, then calls.
  list(): Link[] {
    const order: Record<LinkKind, number> = { channel: 0, state: 1, calls: 2, local: 3 };
    return [...this.links.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.node.name.localeCompare(b.node.name));
  }
}

function linkKind(e: Edge): LinkKind | null {
  if (e.kind === "calls") return "calls";
  if (e.kind === "flows") return e.via ? "channel" : e.through ? "state" : "local";
  return null;
}
