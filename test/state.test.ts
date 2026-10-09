import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/derive/index.js";
import { tsPlugin } from "../src/ingest/ts/index.js";

describe("references and tier 2 flows", () => {
  const edges = buildGraph(tsPlugin.index("test/fixtures/basic/tsconfig.json")).toData().edges;
  const S = "src/state.ts#";
  const ref = (from: string, to: string, access: string) => expect.objectContaining({ kind: "references", from, to, access });

  it("records reads and writes of module state", () => {
    expect(edges).toContainEqual(ref(`${S}setCurrent`, `${S}current`, "write"));
    expect(edges).toContainEqual(ref(`${S}getCurrent`, `${S}current`, "read"));
  });

  it("treats mutating method calls as writes", () => {
    expect(edges).toContainEqual(ref(`${S}setCurrent`, `${S}cache`, "write"));
    expect(edges).toContainEqual(ref(`${S}lookup`, `${S}cache`, "read"));
  });

  it("records type references", () => {
    expect(edges).toContainEqual(ref(`${S}setCurrent`, "src/types.ts#Message", "type"));
  });

  it("records functions passed by reference", () => {
    expect(edges).toContainEqual(ref(`${S}wire`, `${S}setCurrent`, "read"));
  });

  it("derives writer-to-reader flows through shared state", () => {
    const through = (from: string, to: string, value: string) => expect.objectContaining({ kind: "flows", from, to, through: value });
    expect(edges).toContainEqual(through(`${S}setCurrent`, `${S}getCurrent`, `${S}current`));
    expect(edges).toContainEqual(through(`${S}setCurrent`, `${S}lookup`, `${S}cache`));
    expect(edges).toContainEqual(through(`${S}Counter.inc`, `${S}Counter.read`, `${S}Counter.count`));
  });

  it("doesn't derive flows into the writer itself", () => {
    expect(edges.some((e) => e.through && e.from === e.to)).toBe(false);
  });
});
