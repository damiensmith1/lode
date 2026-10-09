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
  it("focus: steps in source order, local flows, and links both ways", () => {
    const f = q.focus("src/main.ts#registerIpc.on:notes:clear")!;
    expect(f.node.runtime).toBe("main");
    expect(f.steps.map((s) => s.label)).toEqual(["notify()"]);
    expect(f.up).toContainEqual(expect.objectContaining({ kind: "channel", label: "notes:clear", node: expect.objectContaining({ name: "clear" }) }));
    expect(f.down).toContainEqual(expect.objectContaining({ kind: "channel", label: "notes:cleared" }));
    expect(f.hidden.libraryCalls).toBe(1); // Date.now()
  });

  it("focus: unknown nodes return null", () => {
    expect(q.focus("nope")).toBeNull();
  });

  it("map: groups at one level with edges merged between them", () => {
    const m = q.map("runtime");
    expect(m.groups.map((g) => g.node.id).sort()).toEqual(["runtime:main", "runtime:preload", "runtime:renderer", "runtime:shared"]);
    expect(m.edges).toContainEqual(expect.objectContaining({ from: "runtime:renderer", to: "runtime:preload", kind: "channel" }));
    const inner = q.map("runtime", "runtime:main");
    expect(inner.path.map((p) => p.id)).toEqual(["runtime:main"]);
    expect(inner.groups.map((g) => g.node.id)).toEqual(expect.arrayContaining(["src/main.ts", "src/format.ts"]));
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
    const focus = await call(2, "focus", { id: "src/util.ts#stamp" });
    expect(focus.result).toMatchObject({ node: { name: "stamp" } });
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
