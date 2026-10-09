import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/derive/index.js";
import { tsPlugin } from "../src/ingest/ts/index.js";

describe("tier 1 flows", () => {
  const graph = buildGraph(tsPlugin.index("test/fixtures/basic/tsconfig.json"));
  const flows = graph.toData().edges.filter((e) => e.kind === "flows" && e.within);
  const P = "src/pipeline.ts#";

  it("follows a call's result through a local into the next call", () => {
    expect(flows).toContainEqual(expect.objectContaining({ from: `${P}enrich`, to: `${P}Bus.dispatch`, within: `${P}send`, type: "Envelope" }));
  });

  it("follows nested calls", () => {
    expect(flows).toContainEqual(expect.objectContaining({ from: `${P}enrich`, to: `${P}Bus.dispatch`, within: `${P}relay` }));
  });

  it("follows a call's result out as the return value", () => {
    expect(flows).toContainEqual(expect.objectContaining({ from: `${P}enrich`, to: `${P}prepare`, within: `${P}prepare`, type: "Envelope" }));
    // arrow expression bodies count as returns
    expect(flows).toContainEqual(expect.objectContaining({ from: `${P}Bus.dispatch`, to: `${P}relay`, within: `${P}relay` }));
  });

  it("follows await, destructuring and object literals", () => {
    expect(flows).toContainEqual(expect.objectContaining({ from: `${P}load`, to: `${P}Bus.dispatch`, within: `${P}fromStorage` }));
  });

  it("treats a method call's receiver as an input", () => {
    expect(flows).toContainEqual(expect.objectContaining({ from: `${P}makeBus`, to: `${P}Bus.dispatch`, within: `${P}viaReceiver`, type: "Bus" }));
    expect(flows).toContainEqual(expect.objectContaining({ from: `${P}prepare`, to: `${P}Bus.dispatch`, within: `${P}viaReceiver` }));
  });

  it("emits one edge per producer per argument", () => {
    const pairs = flows.map((e) => `${e.from}>${e.to}@${e.within}:${e.loc?.line}`);
    expect(pairs.length).toBe(new Set(pairs).size);
  });

  it("doesn't credit an anonymous callback's return to the enclosing function", () => {
    expect(flows.some((e) => e.from === `${P}enrich` && e.to === `${P}fromStorage`)).toBe(false);
  });
});
