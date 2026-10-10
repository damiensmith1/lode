import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { contextFor, isTest } from "../src/context/index.js";
import { GraphStore } from "../src/graph/store.js";
import { tsPlugin } from "../src/ingest/ts/index.js";
import { serveMcp } from "../src/mcp/index.js";
import { Queries } from "../src/query/index.js";
import { createService } from "../src/service/index.js";

const cacheDir = mkdtempSync(path.join(os.tmpdir(), "lode-context-"));
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));
const store = GraphStore.open(tsPlugin, "test/fixtures/ipc", { cacheDir });
const queries = new Queries(() => store.graph, store.root);

describe("context for LLMs", () => {
  it("a symbol: its full code, neighbours as signatures, connections as edges", async () => {
    const r = await contextFor({ seeds: ["src/main.ts#saveNote"] }, queries);
    expect(r.items[0]).toMatchObject({ id: "src/main.ts#saveNote", detail: "full", distance: 0 });
    expect(r.items.slice(1).every((i) => i.distance === 1 && i.detail === "signature")).toBe(true);
    expect(r.markdown).toMatch(/^# Context: saveNote/);
    expect(r.markdown).toContain("### saveNote — src/main.ts:7");
    expect(r.markdown).toMatch(/## Nearby/);
    expect(r.edges.length).toBeGreaterThan(0);
  });

  it("is deterministic", async () => {
    const a = await contextFor({ question: "how is a note saved", hops: 2 }, queries);
    const b = await contextFor({ question: "how is a note saved", hops: 2 }, queries);
    expect(a.markdown).toBe(b.markdown);
    expect(a.items[0].name).toMatch(/[Nn]ote/);
  });

  it("fits the budget by giving less detail, then leaving things out", async () => {
    const roomy = await contextFor({ seeds: ["src/main.ts#registerIpc"], hops: 2 }, queries);
    const tight = await contextFor({ seeds: ["src/main.ts#registerIpc"], hops: 2, budget: 150 }, queries);
    expect(tight.tokens).toBeLessThanOrEqual(220);
    expect(tight.items.length + tight.dropped).toBe(roomy.items.length + roomy.dropped);
    expect(tight.dropped + tight.items.filter((i) => i.detail === "name").length).toBeGreaterThan(0);
  });

  it("connections among candidates that don't fit never crowd out the code", async () => {
    const r = await contextFor({ seeds: ["src/main.ts#registerIpc"], hops: 3, budget: 300 }, queries);
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.edges.every((e) => r.items.some((i) => i.id === e.from) && r.items.some((i) => i.id === e.to))).toBe(true);
  });

  it("a canvas: exactly its cards, with its arrows and notes", async () => {
    const r = await contextFor({ canvas: { cards: [{ id: "src/main.ts#saveNote", note: "start here" }, { id: "src/main.ts#registerIpc" }], arrows: [{ from: "src/main.ts#registerIpc", to: "src/main.ts#saveNote", line: 20 }] } }, queries);
    expect(r.items.map((i) => i.id)).toEqual(["src/main.ts#saveNote", "src/main.ts#registerIpc"]);
    expect(r.markdown).toContain("> start here");
    expect(r.markdown).toContain("registerIpc calls saveNote (line 20)");
  });
});

describe("test files", () => {
  it("are recognised by folder or name", () => {
    expect(["test/a.ts", "src/__tests__/b.ts", "src/c.test.ts", "spec/d.js", "e.spec.tsx"].every(isTest)).toBe(true);
    expect(["src/testing.ts", "src/latest.ts", "contest/x.ts"].some(isTest)).toBe(false);
  });
});

describe("MCP server", () => {
  it("initializes, lists tools and answers calls over stdio", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const server = serveMcp(createService(store), { input, output, log: () => {} });
    const replies: Record<number, { result?: { [k: string]: unknown }; error?: { code: number } }> = {};
    let buffer = "";
    output.on("data", (d) => {
      buffer += d;
      for (let i; (i = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(i + 1)) {
        const msg = JSON.parse(buffer.slice(0, i));
        replies[msg.id] = msg;
      }
    });
    const send = (m: unknown) => input.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lode_read", arguments: { symbol: "saveNote" } } });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "lode_read", arguments: { symbol: "nothingByThisName" } } });
    send({ jsonrpc: "2.0", id: 5, method: "no/such" });
    await new Promise((r) => setTimeout(r, 400));
    server.close();
    expect(replies[1].result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "lode" } });
    expect((replies[2].result!.tools as { name: string }[]).map((t) => t.name)).toEqual(["lode_search", "lode_read", "lode_context", "lode_impact", "lode_changes", "lode_entries"]);
    expect(JSON.stringify(replies[3].result)).toContain("saveNote");
    expect(replies[4].result).toMatchObject({ isError: true });
    expect(replies[5].error?.code).toBe(-32601);
  });
});
