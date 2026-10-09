import { beforeAll, describe, expect, it } from "vitest";
import { buildGraph } from "../src/derive/index.js";
import type { Graph } from "../src/graph/graph.js";
import { ingestTsProject } from "../src/ingest/ts/ingest.js";
import type { TsFacts } from "../src/ingest/ts/facts.js";
import { tsPlugin } from "../src/ingest/ts/index.js";

// Real-codebase checks against glance (read-only).
// Run with: LODE_GLANCE_TSCONFIG=<path to glance/tsconfig.json> npm test
const tsconfig = process.env.LODE_GLANCE_TSCONFIG;

describe.skipIf(!tsconfig)("glance", () => {
  let facts: TsFacts;
  let graph: Graph;
  beforeAll(() => {
    facts = ingestTsProject(tsconfig!);
    graph = buildGraph(tsPlugin.index(tsconfig!));
  });

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

  it("resolves almost every call in TypeScript", () => {
    const ts = facts.calls.filter((c) => c.loc.file.endsWith(".ts"));
    const unresolved = ts.filter((c) => !c.calleeId && !c.localCallee).length;
    expect(unresolved / ts.length).toBeLessThan(0.02);
  });

  it("resolves most calls in untyped JavaScript", () => {
    // Bridge calls (window.api.x) resolve through channel flows instead; the
    // rest unresolved are methods on untyped values (e.preventDefault()).
    const js = facts.calls.filter((c) => c.loc.file.endsWith(".js") && !/^(window\.)?clance/.test(c.calleeText));
    const unresolved = js.filter((c) => !c.calleeId && !c.localCallee).length;
    expect(unresolved / js.length).toBeLessThan(0.3);
  });

  it("builds a valid graph", () => {
    expect(graph.size.nodes).toBeGreaterThan(1000);
    expect(graph.size.edges).toBeGreaterThan(2000);
  });

  it("links IPC senders to handlers, through wrappers", () => {
    const flows = graph.toData().edges.filter((e) => e.kind === "flows");
    expect(flows.length).toBeGreaterThan(250);
    // startRecording -> sendToHud(...) -> webContents.send("dictation:start")
    expect(flows).toContainEqual(
      expect.objectContaining({
        from: "src/main/dictation.ts#startRecording",
        to: "src/preload/dictationHud.ts#exposeInMainWorld:clanceDictation.onStart",
        via: { family: "electron-ipc:to-renderer", key: "dictation:start" },
      }),
    );
  });

  it("indexes the renderer's JavaScript and follows it through the bridge to main", () => {
    const next = (id: string) => graph.neighbors(id, "down", ["flows"]).map((e) => e.to);
    const member = "src/preload/mainWindow.ts#exposeInMainWorld:clanceApp.docConfirmUnsaved";
    expect(next("src/mainWindow/Shell.js#confirmUnsaved")).toContain(member);
    expect(next(member)).toContain("src/main/index.ts#handle:doc:confirm-unsaved");
  });

  it("places every file in a runtime, and skips vendored bundles", () => {
    const runtime = graph.lens("runtime");
    expect(runtime.roots().filter((r) => !r.includes(":"))).toEqual([]); // no untagged files
    expect(runtime.children("runtime:renderer").length).toBeGreaterThan(30);
    expect(graph.node("src/shared/vendor/xterm/xterm.js")).toBeUndefined();
  });
});
