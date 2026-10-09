import { Graph } from "../graph/graph.js";
import type { GraphData } from "../schema/index.js";
import { deriveChannelFlows } from "./channels.js";

// Plugin output stays as-is; derived edges are computed from it and added on
// top, so analysis can be re-run without re-indexing.
export function buildGraph(data: GraphData): Graph {
  return Graph.from({ ...data, edges: [...data.edges, ...deriveChannelFlows(data.channels ?? [])] });
}
