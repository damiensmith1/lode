import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { GraphStore } from "../src/graph/store.js";
import { tsPlugin } from "../src/ingest/ts/index.js";
import { Queries } from "../src/query/index.js";
import { startServer } from "../src/server/index.js";

const cacheDir = mkdtempSync(path.join(os.tmpdir(), "lode-query-"));
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));
const store = GraphStore.open(tsPlugin, "test/fixtures/ipc", { cacheDir });
const q = new Queries(() => store.graph, store.root);

describe("queries", () => {
  it("block: a type is reached from what uses it", () => {
    const b = q.block("src/main.ts#Note")!;
    expect(b.callers).toContainEqual(expect.objectContaining({ label: "uses it", node: expect.objectContaining({ name: "saveNote" }) }));
  });

  it("block: unknown and library nodes return null", () => {
    expect(q.block("nope")).toBeNull();
  });

  it("map: groups at one level with edges merged between them", () => {
    const m = q.map("runtime");
    expect(m.groups.map((g) => g.node.id).sort()).toEqual(["runtime:main", "runtime:preload", "runtime:renderer", "runtime:shared"]);
    expect(m.edges).toContainEqual(expect.objectContaining({ from: "runtime:renderer", to: "runtime:preload", kind: "channel" }));
    const inner = q.map("runtime", "runtime:main");
    expect(inner.path.map((p) => p.id)).toEqual(["runtime:main"]);
    expect(inner.groups.map((g) => g.node.id)).toEqual(expect.arrayContaining(["src/main.ts", "src/format.ts"]));
  });

  it("symbolAt: the innermost declaration around a line, else the file", () => {
    const save = q.symbolAt("src/main.ts", 9);
    expect(save?.id).toBe("src/main.ts#saveNote");
    expect(save?.endLine).toBeGreaterThan(save!.line!);
    expect(q.symbolAt("src/main.ts", 17)?.id).toBe("src/main.ts#registerIpc.handle:notes:save");
    expect(q.symbolAt("src/main.ts", 2)?.id).toBe("src/main.ts");
  });

  it("search ranks exact and prefix matches first", () => {
    expect(q.search("save")[0].name).toBe("save");
  });

  it("source: annotations and symbols, and never outside the project", () => {
    const view = q.source("src/main.ts")!;
    expect(view.text).toContain("registerIpc");
    expect(view.symbols.map((s) => s.name)).toContain("saveNote");
    expect(view.annotations).toContainEqual(expect.objectContaining({ kind: "channel" }));
    expect(q.source("../package.json")).toBeNull();
  });
});

describe("server", () => {
  it("answers JSON-RPC over a WebSocket", async () => {
    const server = await startServer({ store, port: 0 });
    const socket = new WebSocket(server.rpcUrl);
    await new Promise((resolve) => socket.once("open", resolve));
    const call = (id: number, method: string, params = {}) =>
      new Promise<Record<string, unknown>>((resolve) => {
        socket.on("message", (raw) => {
          const msg = JSON.parse(String(raw));
          if (msg.id === id) resolve(msg);
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const info = await call(1, "info");
    expect(info.result).toMatchObject({ files: expect.any(Number), nodes: expect.any(Number) });
    const block = await call(2, "block", { id: "src/util.ts#stamp" });
    expect(block.result).toMatchObject({ node: { name: "stamp" } });
    expect((await call(3, "nope")).error).toMatch(/unknown method/);
    socket.close();
    await server.close();
  });

  it("refuses connections without the token or from other origins", async () => {
    const server = await startServer({ store, port: 0 });
    const refused = (url: string, headers: Record<string, string> = {}) =>
      new Promise<boolean>((resolve) => {
        const s = new WebSocket(url, { headers });
        s.once("open", () => (s.close(), resolve(false)));
        s.once("error", () => resolve(true));
      });
    expect(await refused(`ws://127.0.0.1:${server.port}/rpc`)).toBe(true);
    expect(await refused(`ws://127.0.0.1:${server.port}/rpc?token=wrong`)).toBe(true);
    expect(await refused(server.rpcUrl, { Origin: "https://evil.example" })).toBe(true);
    expect(await refused(server.rpcUrl, { Origin: `http://127.0.0.1:${server.port}` })).toBe(false);
    await server.close();
  });
});

describe("tree query", () => {
  it("lists the lens tree parents-first with depths, and merged edges", () => {
    const t = q.tree("runtime");
    const seen = new Set<string>();
    for (const n of t.nodes) {
      if (n.parent) expect(seen.has(n.parent)).toBe(true);
      seen.add(n.id);
    }
    expect(t.nodes.find((n) => n.id === "src/main.ts")).toMatchObject({ parent: "runtime:main", depth: 1 });
    expect(t.nodes.some((n) => n.id.startsWith("ext:"))).toBe(false);
    expect(t.edges).toContainEqual(expect.objectContaining({ kind: "channel", from: "src/preload.ts#exposeInMainWorld:notes.clear" }));
  });
});

describe("block query", () => {
  it("returns a node's lines, the lines that lead somewhere, and its callers", () => {
    const b = q.block("src/main.ts#registerIpc")!;
    expect(b.outline).toBe(false);
    expect(b.lines.map((l) => l.n)).toEqual([16, 17, 18, 19]);
    expect(b.lines[0].text).toContain("export function registerIpc");
    // links leave from lines inside it, including from callbacks defined there
    expect(b.links).toContainEqual(expect.objectContaining({ line: 17, kind: "calls", target: expect.objectContaining({ name: "saveNote" }) }));
    expect(b.links).toContainEqual(expect.objectContaining({ line: 18, kind: "channel", label: "notes:cleared" }));
  });

  it("knows who leads to a block, with the line in the caller", () => {
    const b = q.block("src/main.ts#saveNote")!;
    expect(b.callers).toContainEqual(expect.objectContaining({ node: expect.objectContaining({ name: "handle:notes:save" }), line: 17 }));
  });

  it("counts passing a function along as leading to it, from both ends", () => {
    const basic = GraphStore.open(tsPlugin, "test/fixtures/basic", { cacheDir: path.join(cacheDir, "basic") });
    const qb = new Queries(() => basic.graph, basic.root);
    expect(qb.block("src/state.ts#wire")!.links).toContainEqual(expect.objectContaining({ label: "passes", target: expect.objectContaining({ name: "setCurrent" }) }));
    expect(qb.block("src/state.ts#setCurrent")!.callers).toContainEqual(expect.objectContaining({ label: "passes it", node: expect.objectContaining({ name: "wire" }) }));
  });

  it("gives files as an outline of their members", () => {
    const b = q.block("src/main.ts")!;
    expect(b.outline).toBe(true);
    expect(b.links.map((l) => l.target.name)).toEqual(expect.arrayContaining(["saveNote", "registerIpc"]));
  });
});

describe("entries query", () => {
  it("groups ways in by runtime and kind", () => {
    const r = q.entries();
    const cat = (runtime: string, name: string) => r.groups.find((g) => g.runtime === runtime)?.categories.find((c) => c.name === name)?.entries ?? [];
    expect(cat("main", "ipc handlers").map((e) => e.label).sort()).toEqual(["notes:clear", "notes:save"]);
    expect(cat("preload", "bridge api").map((e) => e.label)).toEqual(expect.arrayContaining(["notes.save", "notes.clear"]));
    expect(cat("renderer", "events").map((e) => e.label)).toContain("onCleared");
    expect(cat("preload", "messages from main").map((e) => e.label)).toEqual(["notes:cleared"]);
    expect(r.summary).toContainEqual(expect.objectContaining({ from: "renderer", to: "preload", kind: "channel" }));
  });

  it("leaves timers out, and folds what nothing calls", () => {
    const all = q.entries().groups.flatMap((g) => g.categories);
    expect(all.flatMap((c) => c.entries).some((e) => /^setTimeout/.test(e.node.name))).toBe(false);
    expect(all.filter((c) => c.name === "not called in the project").every((c) => c.collapsed)).toBe(true);
  });
});
