import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/derive/index.js";
import { Graph } from "../src/graph/graph.js";
import { tsPlugin } from "../src/ingest/ts/index.js";
import type { Node } from "../src/schema/index.js";

const node = (id: string, parent: string | null, file?: string, tags?: Record<string, string>): Node => ({
  id, kind: "container", name: id, parent, loc: file ? { file, line: 1 } : null, external: false, ...(tags && { tags }),
});

describe("lenses", () => {
  const graph = Graph.from({
    nodes: [
      node("src/a/x.ts", null, "src/a/x.ts", { runtime: "main" }),
      node("src/a/x.ts#f", "src/a/x.ts", "src/a/x.ts"),
      node("src/b.ts", null, "src/b.ts"),
      node("root.ts", null, "root.ts", { runtime: "main" }),
      node("ext:lib", null),
    ],
    edges: [],
  });

  it("containment follows node.parent", () => {
    const lens = graph.lens("containment");
    expect(lens.roots().sort()).toEqual(["ext:lib", "root.ts", "src/a/x.ts", "src/b.ts"]);
    expect(lens.children("src/a/x.ts")).toEqual(["src/a/x.ts#f"]);
  });

  it("folder puts directories above top-level nodes", () => {
    const lens = graph.lens("folder");
    expect(lens.path("src/a/x.ts#f")).toEqual(["dir:src", "dir:src/a", "src/a/x.ts", "src/a/x.ts#f"]);
    expect(lens.children("dir:src").sort()).toEqual(["dir:src/a", "src/b.ts"]);
    expect(lens.node("dir:src/a")?.name).toBe("a");
    expect(lens.roots().sort()).toEqual(["dir:src", "ext:lib", "root.ts"]);
  });

  it("tag lenses group by a plugin tag, leaving untagged nodes as roots", () => {
    const lens = graph.lens("runtime");
    expect(lens.children("runtime:main").sort()).toEqual(["root.ts", "src/a/x.ts"]);
    expect(lens.roots().sort()).toEqual(["ext:lib", "runtime:main", "src/b.ts"]);
  });
});

describe("runtime tags (TS plugin)", () => {
  const lens = buildGraph(tsPlugin.index("test/fixtures/ipc/tsconfig.json")).lens("runtime");
  const runtimeOf = (file: string) => lens.parent(file);

  it("seeds files by the Electron APIs they call", () => {
    expect(runtimeOf("src/main.ts")).toBe("runtime:main");
    expect(runtimeOf("src/preload.ts")).toBe("runtime:preload");
  });

  it("gives imported files their importers' runtime, or shared", () => {
    expect(runtimeOf("src/format.ts")).toBe("runtime:main");
    expect(runtimeOf("src/util.ts")).toBe("runtime:shared");
  });
});
