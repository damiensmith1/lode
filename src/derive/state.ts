import type { Edge, GraphData, NodeId } from "../schema/index.js";

// Tier 2: data passing through shared state. For each value node (module
// state, class field), every node that writes it flows to every other node
// that reads it. Reads and writes come from the plugin's references edges.
export function deriveStateFlows(data: GraphData): Edge[] {
  const values = new Set(data.nodes.filter((n) => n.kind === "value").map((n) => n.id));
  const writers = new Map<NodeId, Set<NodeId>>();
  const readers = new Map<NodeId, Set<NodeId>>();
  const types = new Map<NodeId, string | undefined>();

  for (const e of data.edges) {
    if (e.kind !== "references" || !values.has(e.to)) continue;
    if (e.access === "write") add(writers, e.to, e.from);
    else if (e.access === "read") add(readers, e.to, e.from);
    if (!types.has(e.to)) types.set(e.to, e.type);
  }

  const edges: Edge[] = [];
  for (const [value, ws] of writers) {
    for (const writer of ws) {
      for (const reader of readers.get(value) ?? []) {
        if (reader === writer) continue;
        edges.push({ kind: "flows", from: writer, to: reader, confidence: "exact", loc: null, type: types.get(value), through: value });
      }
    }
  }
  return edges;
}

function add(map: Map<NodeId, Set<NodeId>>, key: NodeId, value: NodeId) {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}
