import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/derive/index.js";
import { deriveChannelFlows } from "../src/derive/channels.js";
import { keysOf } from "../src/ingest/ts/channels.js";
import { tsPlugin } from "../src/ingest/ts/index.js";
import type { ChannelEndpoint } from "../src/schema/index.js";

const loc = { file: "f.ts", line: 1 };
const ep = (node: string, role: "send" | "receive", key: string, more: Partial<ChannelEndpoint> = {}): ChannelEndpoint =>
  ({ node, role, family: "ipc", key, pattern: false, loc, ...more });

describe("deriveChannelFlows", () => {
  it("matches exact keys within a family", () => {
    const edges = deriveChannelFlows([ep("a", "send", "x", { payload: "Note" }), ep("b", "receive", "x"), ep("c", "receive", "y")]);
    expect(edges).toEqual([
      expect.objectContaining({ kind: "flows", from: "a", to: "b", confidence: "exact", type: "Note", via: { family: "ipc", key: "x" } }),
    ]);
  });

  it("never matches across families", () => {
    expect(deriveChannelFlows([ep("a", "send", "x"), ep("b", "receive", "x", { family: "other" })])).toEqual([]);
  });

  it("matches patterns with pattern confidence", () => {
    const edges = deriveChannelFlows([ep("a", "send", "topic:*:update", { pattern: true }), ep("b", "receive", "topic:42:update")]);
    expect(edges).toEqual([expect.objectContaining({ from: "a", to: "b", confidence: "pattern", via: { family: "ipc", key: "topic:42:update" } })]);
    expect(deriveChannelFlows([ep("a", "send", "topic:*", { pattern: true }), ep("b", "receive", "other:1")])).toEqual([]);
  });

  it("adds the reply edge when the sender awaits one", () => {
    const edges = deriveChannelFlows([ep("a", "send", "x", { awaitsReply: true }), ep("b", "receive", "x", { returns: "Note" })]);
    expect(edges).toContainEqual(expect.objectContaining({ from: "b", to: "a", type: "Note", reply: true }));
    expect(edges.find((e) => e.from === "a")?.reply).toBeUndefined();
  });
});

describe("keysOf", () => {
  it("reads literals, unions and template literals", () => {
    expect(keysOf('"a"')).toEqual([{ value: "a", pattern: false }]);
    expect(keysOf('"a" | "b"').map((k) => k.value)).toEqual(["a", "b"]);
    expect(keysOf("`topic:${string}:update`")).toEqual([{ value: "topic:*:update", pattern: true }]);
    expect(keysOf("string")).toEqual([]);
  });
});

describe("Electron IPC end to end", () => {
  const graph = buildGraph(tsPlugin.index("test/fixtures/ipc/tsconfig.json"));
  const flows = graph.toData().edges.filter((e) => e.kind === "flows");
  const bridge = "src/preload.ts#exposeInMainWorld:notes";

  it("makes exposed preload functions into nodes", () => {
    expect(graph.childrenOf(bridge).map((n) => n.name).sort()).toEqual(["clear", "onCleared", "save"]);
  });

  it("links invoke to handle, with the reply flowing back", () => {
    const handler = "src/main.ts#registerIpc.handle:notes:save";
    expect(flows).toContainEqual(expect.objectContaining({ from: `${bridge}.save`, to: handler, type: "string" }));
    expect(flows).toContainEqual(expect.objectContaining({ from: handler, to: `${bridge}.save`, type: "Note" }));
  });

  it("links send to on", () => {
    expect(flows).toContainEqual(expect.objectContaining({ from: `${bridge}.clear`, to: "src/main.ts#registerIpc.on:notes:clear" }));
  });

  it("follows the key through a wrapper to its caller", () => {
    expect(flows).toContainEqual(
      expect.objectContaining({ from: "src/main.ts#registerIpc.on:notes:clear", to: `${bridge}.onCleared.on:notes:cleared`, via: { family: "electron-ipc:to-renderer", key: "notes:cleared" } }),
    );
  });
});
