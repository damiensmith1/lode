import type { ChannelEndpoint, Edge, EdgeKind, GraphData, Node, NodeId, Region } from "../schema/index.js";
import { containmentLens, folderLens, type Lens, tagLens } from "./lens.js";

export type Direction = "up" | "down"; // up: what feeds a node; down: what it feeds

export class Graph {
  private readonly nodes = new Map<NodeId, Node>();
  private readonly outgoing = new Map<NodeId, Edge[]>();
  private readonly incoming = new Map<NodeId, Edge[]>();
  private readonly children = new Map<NodeId, NodeId[]>();
  private readonly withinIndex = new Map<NodeId, Edge[]>();
  private readonly lenses = new Map<string, Lens>();
  private endpoints: ChannelEndpoint[] = [];
  private regionsByFile = new Map<string, Region[]>();

  // Rejects data the core can't trust: duplicate ids, dangling parents or edges.
  static from(data: GraphData): Graph {
    const graph = new Graph();
    for (const node of data.nodes) {
      if (graph.nodes.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
      graph.nodes.set(node.id, node);
    }
    for (const node of data.nodes) {
      if (node.parent === null) continue;
      if (!graph.nodes.has(node.parent)) throw new Error(`node ${node.id} has unknown parent ${node.parent}`);
      push(graph.children, node.parent, node.id);
    }
    for (const edge of data.edges) {
      // An import of a file no plugin read (a stylesheet in a project
      // without the web plugin, say) is dropped, not an error.
      if (edge.kind === "imports" && (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to))) continue;
      for (const end of [edge.from, edge.to, edge.within, edge.through]) {
        if (end === undefined) continue;
        if (!graph.nodes.has(end)) throw new Error(`${edge.kind} edge references unknown node ${end}`);
      }
      push(graph.outgoing, edge.from, edge);
      push(graph.incoming, edge.to, edge);
      if (edge.within) push(graph.withinIndex, edge.within, edge);
    }
    graph.endpoints = (data.channels ?? []).filter((e) => graph.nodes.has(e.node));
    for (const r of data.regions ?? []) push(graph.regionsByFile, r.file, r);
    return graph;
  }

  node(id: NodeId): Node | undefined {
    return this.nodes.get(id);
  }

  allNodes(): Iterable<Node> {
    return this.nodes.values();
  }

  // A hierarchy to browse the graph by: "containment", "folder", or any tag
  // plugins put on nodes (e.g. "runtime"). Built on first use.
  lens(name: string): Lens {
    let lens = this.lenses.get(name);
    if (!lens) {
      lens = name === "containment" ? containmentLens(this) : name === "folder" ? folderLens(this) : tagLens(this, name);
      this.lenses.set(name, lens);
    }
    return lens;
  }

  childrenOf(id: NodeId): Node[] {
    return (this.children.get(id) ?? []).map((c) => this.nodes.get(c)!);
  }

  // One hop from `id`. Callers decide whether and where to keep going.
  neighbors(id: NodeId, direction: Direction, kinds?: EdgeKind[]): Edge[] {
    const edges = (direction === "up" ? this.incoming : this.outgoing).get(id) ?? [];
    return kinds ? edges.filter((e) => kinds.includes(e.kind)) : edges;
  }

  // Local flows that happen inside `id` (edges whose `within` is it).
  within(id: NodeId): Edge[] {
    return this.withinIndex.get(id) ?? [];
  }

  get size() {
    let edges = 0;
    for (const list of this.outgoing.values()) edges += list.length;
    return { nodes: this.nodes.size, edges };
  }

  // Foldable line ranges in a file, outermost first.
  regions(file: string): Region[] {
    return this.regionsByFile.get(file) ?? [];
  }

  // Both ends of every string-keyed channel, matched or not.
  channels(): ChannelEndpoint[] {
    return this.endpoints;
  }

  toData(): GraphData {
    return { nodes: [...this.nodes.values()], edges: [...this.outgoing.values()].flat() };
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
