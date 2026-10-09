import { describe, expect, it } from "vitest";
import { ingestTsProject } from "../src/ingest/ts/ingest.js";

// Real-codebase checks against glance (read-only).
// Run with: LODE_GLANCE_TSCONFIG=<path to glance/tsconfig.json> npm test
const tsconfig = process.env.LODE_GLANCE_TSCONFIG;

describe.skipIf(!tsconfig)("glance", () => {
  const facts = ingestTsProject(tsconfig!);

  it("resolves calls between modules", () => {
    expect(facts.calls).toContainEqual(
      expect.objectContaining({
        callerId: "src/main/ptyManager.ts#createPtySession.onData@L174",
        calleeId: "src/main/ptyManager.ts#appendToBuffer",
        argTypes: ["PtySession", "string"],
      }),
    );
  });

  it("keeps IPC channel names as literal argument types", () => {
    const send = facts.calls.find((c) => c.calleeId === "ext:electron#WebContents.send" && c.argTypes[0] === '"terminal:data"');
    expect(send?.loc.file).toBe("src/main/ptyManager.ts");
  });

  it("turns IPC handlers into nodes keyed by channel", () => {
    const handlers = facts.decls.filter((d) => d.registration?.call === "handle");
    expect(handlers.length).toBeGreaterThan(100);
    expect(handlers.every((d) => d.registration?.key)).toBe(true);
  });

  it("resolves almost every call", () => {
    const unresolved = facts.calls.filter((c) => !c.calleeId && !c.localCallee).length;
    expect(unresolved / facts.calls.length).toBeLessThan(0.02);
  });
});

describe.skipIf(!tsconfig)("glance graph", () => {
  it("builds a valid graph", async () => {
    const { Graph } = await import("../src/graph/graph.js");
    const { tsPlugin } = await import("../src/ingest/ts/index.js");
    const graph = Graph.from(tsPlugin.index(tsconfig!));
    expect(graph.size.nodes).toBeGreaterThan(1000);
    expect(graph.size.edges).toBeGreaterThan(2000);
  });
});
