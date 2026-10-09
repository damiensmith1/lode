import type { Node, NodeId } from "../schema/index.js";
import type { Graph } from "./graph.js";

// A hierarchy over the graph's nodes. Lenses only add grouping nodes above
// the containment tree; they never change edges. Group node ids are
// namespaced ("dir:src/main", "runtime:main") so they can't collide.
export interface Lens {
  name: string;
  node(id: NodeId): Node | undefined; // graph nodes and this lens's group nodes
  parent(id: NodeId): NodeId | null;
  children(id: NodeId): NodeId[];
  roots(): NodeId[];
  path(id: NodeId): NodeId[]; // root first, ending at id
}

// The plain containment tree: files, classes, functions inside them.
export function containmentLens(graph: Graph): Lens {
  return groupedLens("containment", graph, new Map(), () => null);
}

// Directories above top-level nodes, from their file path.
export function folderLens(graph: Graph): Lens {
  const groups = new Map<NodeId, Node>();
  const dirOf = (file: string): NodeId | null => {
    const slash = file.lastIndexOf("/");
    if (slash === -1) return null;
    const dir = file.slice(0, slash);
    const id = `dir:${dir}`;
    if (!groups.has(id)) {
      groups.set(id, { id, kind: "container", name: dir.slice(dir.lastIndexOf("/") + 1), parent: dirOf(dir), loc: null, external: false });
    }
    return id;
  };
  return groupedLens("folder", graph, groups, (node) => (node.loc ? dirOf(node.loc.file) : null));
}

// Groups top-level nodes by a plugin tag, e.g. "runtime". Untagged ones stay roots.
export function tagLens(graph: Graph, tag: string): Lens {
  const groups = new Map<NodeId, Node>();
  return groupedLens(tag, graph, groups, (node) => {
    const value = node.tags?.[tag];
    if (!value) return null;
    const id = `${tag}:${value}`;
    if (!groups.has(id)) groups.set(id, { id, kind: "container", name: value, parent: null, loc: null, external: false });
    return id;
  });
}

// Containment, with `groupOf` deciding where each top-level node hangs.
function groupedLens(name: string, graph: Graph, groups: Map<NodeId, Node>, groupOf: (node: Node) => NodeId | null): Lens {
  const parents = new Map<NodeId, NodeId | null>();
  const children = new Map<NodeId, NodeId[]>();
  const roots: NodeId[] = [];
  const place = (id: NodeId, parent: NodeId | null) => {
    parents.set(id, parent);
    if (parent === null) roots.push(id);
    else (children.get(parent) ?? children.set(parent, []).get(parent)!).push(id);
  };

  for (const node of graph.allNodes()) place(node.id, node.parent ?? groupOf(node));
  for (const group of groups.values()) place(group.id, group.parent); // groups are created above

  const lens: Lens = {
    name,
    node: (id) => groups.get(id) ?? graph.node(id),
    parent: (id) => parents.get(id) ?? null,
    children: (id) => children.get(id) ?? [],
    roots: () => roots,
    path: (id) => {
      const path: NodeId[] = [];
      for (let n: NodeId | null = id; n !== null; n = lens.parent(n)) path.unshift(n);
      return path;
    },
  };
  return lens;
}
