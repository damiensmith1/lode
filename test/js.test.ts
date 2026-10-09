import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/derive/index.js";
import { tsPlugin } from "../src/ingest/ts/index.js";

describe("plain JavaScript project (no config)", () => {
  const graph = buildGraph(tsPlugin.index("test/fixtures/js"));
  const edges = graph.toData().edges;
  const has = (e: Record<string, unknown>) => expect(edges).toContainEqual(expect.objectContaining(e));

  it("makes CommonJS exports into nodes", () => {
    expect(graph.node("lib/math.js#double")?.kind).toBe("callable");
    expect(graph.node("lib/math.js#version")?.kind).toBe("value");
    expect(graph.node("lib/store.js#module.exports")?.kind).toBe("container");
    expect(graph.childrenOf("lib/store.js#module.exports").map((n) => n.name).sort()).toEqual(["all", "push"]);
  });

  it("resolves calls through require and destructuring", () => {
    has({ kind: "calls", from: "app.js#run", to: "lib/math.js#double" });
    has({ kind: "calls", from: "app.js#run", to: "lib/store.js#module.exports.push" });
    has({ kind: "calls", from: "lib/math.js#double", to: "lib/math.js#add" });
  });

  it("treats require as an import, not a call", () => {
    expect(edges.some((e) => e.from.endsWith("#require") || e.to.endsWith("#require"))).toBe(false);
    expect(graph.lens("folder").path("lib/math.js#double")).toEqual(["dir:lib", "lib/math.js", "lib/math.js#double"]);
  });

  it("derives local and shared-state flows", () => {
    has({ kind: "flows", from: "lib/math.js#add", to: "lib/math.js#double", within: "app.js#run" });
    has({ kind: "flows", from: "lib/store.js#module.exports.push", to: "lib/store.js#module.exports.all", through: "lib/store.js#items" });
  });

  it("doesn't mistake a project method named push for a mutation", () => {
    expect(edges.some((e) => e.kind === "references" && e.access === "write" && e.to === "lib/store.js#module.exports")).toBe(false);
  });

  it("uses JSDoc types and typedefs", () => {
    expect(graph.node("esm/util.mjs#Note")?.kind).toBe("type");
    expect(graph.node("esm/util.mjs#Note.text")?.parent).toBe("esm/util.mjs#Note");
    has({ kind: "flows", from: "esm/util.mjs#makeNote", to: "esm/main.mjs#persist", type: "Note" });
    has({ kind: "references", access: "type", from: "esm/util.mjs#makeNote", to: "esm/util.mjs#Note" });
  });
});

describe("Electron renderer JS through the preload bridge", () => {
  const graph = buildGraph(tsPlugin.index("test/fixtures/ipc/tsconfig.json"));
  const flows = graph.toData().edges.filter((e) => e.kind === "flows" && e.via?.family === "electron-bridge");
  const bridge = "src/preload.ts#exposeInMainWorld:notes";

  it("links window.api calls to bridge members, with the return value coming back", () => {
    expect(flows).toContainEqual(expect.objectContaining({ from: "src/renderer.js#onSave", to: `${bridge}.save`, via: { family: "electron-bridge", key: "notes.save" } }));
    expect(flows).toContainEqual(expect.objectContaining({ from: `${bridge}.save`, to: "src/renderer.js#onSave" }));
  });

  it("connects end to end: renderer → bridge → main handler", () => {
    const next = (id: string) => graph.neighbors(id, "down", ["flows"]).map((e) => e.to);
    expect(next("src/renderer.js#onSave")).toContain(`${bridge}.save`);
    expect(next(`${bridge}.save`)).toContain("src/main.ts#registerIpc.handle:notes:save");
  });

  it("tags renderer files", () => {
    expect(graph.lens("runtime").parent("src/renderer.js")).toBe("runtime:renderer");
  });
});
