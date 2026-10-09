import { describe, expect, it } from "vitest";
import { Graph } from "../src/graph/graph.js";
import { tsPlugin } from "../src/ingest/ts/index.js";

describe("tsPlugin", () => {
  const graph = Graph.from(tsPlugin.index("test/fixtures/basic/tsconfig.json"));

  it("maps declarations to node kinds", () => {
    expect(graph.node("src/pipeline.ts")?.kind).toBe("container");
    expect(graph.node("src/pipeline.ts#Bus")?.kind).toBe("container");
    expect(graph.node("src/pipeline.ts#Bus.dispatch")?.kind).toBe("callable");
    expect(graph.node("src/types.ts#Envelope")?.kind).toBe("type");
    expect(graph.node("src/types.ts#Envelope.ts")?.kind).toBe("value");
    expect(graph.node("src/pipeline.ts#registerHandlers.on:message:send")?.kind).toBe("callable");
  });

  it("nests nodes under their containers", () => {
    expect(graph.childrenOf("src/pipeline.ts#Bus").map((n) => n.name)).toEqual(["dispatch"]);
  });

  it("emits typed call edges, walkable both ways", () => {
    const down = graph.neighbors("src/pipeline.ts#send", "down", ["calls"]);
    expect(down).toContainEqual(expect.objectContaining({ to: "src/pipeline.ts#enrich", args: ["Message"], returns: "Envelope" }));
    const up = graph.neighbors("src/pipeline.ts#send", "up", ["calls"]).map((e) => e.from);
    expect(up).toEqual(["src/pipeline.ts#registerHandlers.on:message:send"]);
  });

  it("groups library callees under external package containers", () => {
    expect(graph.node("ext:lib#DateConstructor.now")).toMatchObject({ external: true, parent: "ext:lib" });
    expect(graph.node("ext:lib")?.kind).toBe("container");
  });

  it("doesn't turn calls to locals or parameters into self-calls", () => {
    const self = graph.neighbors("src/pipeline.ts#withLocals", "down").filter((e) => e.to === "src/pipeline.ts#withLocals");
    expect(self).toEqual([]);
  });
});

describe("Graph.from", () => {
  const node = (id: string, parent: string | null = null) =>
    ({ id, kind: "callable", name: id, parent, loc: null, external: false }) as const;

  it("rejects duplicate ids, unknown parents and dangling edges", () => {
    expect(() => Graph.from({ nodes: [node("a"), node("a")], edges: [] })).toThrow(/duplicate/);
    expect(() => Graph.from({ nodes: [node("a", "missing")], edges: [] })).toThrow(/unknown parent/);
    expect(() =>
      Graph.from({ nodes: [node("a")], edges: [{ kind: "calls", from: "a", to: "b", confidence: "exact", loc: null }] }),
    ).toThrow(/unknown node b/);
  });
});
