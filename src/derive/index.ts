import { Graph } from "../graph/graph.js";
import type { GraphData } from "../schema/index.js";
import { deriveChannelFlows } from "./channels.js";
import { deriveStateFlows } from "./state.js";

// Plugin output stays as-is; derived edges are computed from it and added on
// top, so analysis can be re-run without re-indexing.
export function buildGraph(data: GraphData): Graph {
  const derived = [...deriveChannelFlows(data.channels ?? []), ...deriveStateFlows(data)];
  return Graph.from({ ...data, edges: [...data.edges, ...derived] });
}
