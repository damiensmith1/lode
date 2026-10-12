import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GraphStore } from "../src/graph/store.js";
import { tsPlugin } from "../src/ingest/ts/index.js";
import { createService } from "../src/service/index.js";
import { canvasTools, type CanvasHost } from "../src/mcp/index.js";
import type { CanvasAction } from "../src/explain/index.js";

// The canvas toolkit a host mounts (lode-graph/mcp): tools check what's
// asked and hand the host canvas actions; the graph tools run on the
// canvas's project.
const tmp = mkdtempSync(path.join(os.tmpdir(), "lode-canvas-tools-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const service = createService(GraphStore.open(tsPlugin, "test/fixtures/ts-web", { cacheDir: tmp }));

function fakeHost() {
  const applied: { canvas: string; actions: CanvasAction[] }[] = [];
  const services: string[] = [];
  const host: CanvasHost = {
    list: async () => [
      { canvas: "flow:a", label: "page.tsx", folder: "/p", cards: 1, showing: true, focused: false },
      { canvas: "flow:b", label: "api", folder: "/p", cards: 0, showing: true, focused: true },
    ],
    read: async () => ({ markdown: "## Code\n…", cards: [{ name: "page.tsx", selected: true }, { name: "Web app", selected: false, note: true }] }),
    apply: async (canvas, actions) => (applied.push({ canvas, actions }), { cards: ["page.tsx"] }),
    service: (_canvas, folder) => {
      if (folder && folder !== "/wt") throw new Error(`no lode for ${folder}`);
      services.push(folder ?? "own");
      return service;
    },
  };
  const tools = Object.fromEntries(canvasTools(host).map((t) => [t.name, t]));
  return { tools, applied, services };
}

describe("canvas tools", () => {
  it("lists canvases, and defaults to the one in front", async () => {
    const { tools, applied } = fakeHost();
    expect(await tools.lode_canvases.run({})).toMatch(/flow:b — api · 0 cards · \/p · in front/);
    await tools.lode_close.run({ cards: ["page.tsx"] });
    expect(applied[0]).toEqual({ canvas: "flow:b", actions: [{ kind: "close", cards: ["page.tsx"] }] });
    await expect(tools.lode_canvas.run({ canvas: "flow:z" })).rejects.toThrow(/No canvas flow:z/);
  });

  it("reads a canvas: its cards, notes and the selection, then the context", async () => {
    const { tools } = fakeHost();
    expect(await tools.lode_canvas.run({ canvas: "flow:a" })).toMatch(/Cards: page.tsx \(selected\), Web app \(note\)[\s\S]*## Code/);
  });

  it("shows code by name (resolved to symbols) and draws notes, links and diagrams", async () => {
    const { tools, applied } = fakeHost();
    await tools.lode_show.run({ canvas: "flow:a", symbols: ["ProductCard", "nope-not-here"] });
    expect(applied[0].actions).toEqual([{ kind: "add", ids: ["next/components/card.tsx#ProductCard"] }]);
    await tools.lode_diagram.run({ notes: [{ id: "web", title: "Web", text: "**pages**" }, { id: "api", title: "API", text: "routes" }], links: [{ from: "web", to: "api", label: "fetch" }] });
    expect(applied[1].actions[0]).toMatchObject({ kind: "diagram", notes: [{ id: "web" }, { id: "api" }], links: [{ from: "web", to: "api", label: "fetch" }] });
    await tools.lode_note.run({ title: "Caveat", text: "eventually consistent", near: "API" });
    expect(applied[2].actions[0]).toEqual({ kind: "note", title: "Caveat", text: "eventually consistent", near: "API" });
    await tools.lode_changes_shown.run({ base: null });
    expect(applied[3].actions[0]).toEqual({ kind: "changes", base: null });
  });

  it("groups cards, ungroups, and arranges groups and cards in rows", async () => {
    const { tools, applied } = fakeHost();
    await tools.lode_group.run({ id: "web", title: "Web", cards: ["page.tsx", "Web app"], layout: "column" });
    expect(applied[0].actions).toEqual([{ kind: "group", id: "web", title: "Web", cards: ["page.tsx", "Web app"], layout: "column" }]);
    await tools.lode_group.run({ id: "web", cards: ["ProductCard"], layout: "sideways", add: true });
    expect(applied[1].actions).toEqual([{ kind: "group", id: "web", cards: ["ProductCard"], add: true }]);
    await tools.lode_arrange.run({ rows: [["web", "api"], [], ["db"]] });
    expect(applied[2].actions).toEqual([{ kind: "arrange", rows: [["web", "api"], ["db"]] }]);
    await expect(tools.lode_arrange.run({ rows: [] })).rejects.toThrow(/needs rows/);
    await tools.lode_ungroup.run({ id: "web" });
    expect(applied[3].actions).toEqual([{ kind: "ungroup", id: "web" }]);
  });

  it("code from another folder: found in its lode, added with its folder", async () => {
    const { tools, applied, services } = fakeHost();
    await tools.lode_show.run({ symbols: ["ProductCard"], folder: "/wt" });
    expect(services).toEqual(["/wt"]);
    expect(applied[0].actions).toEqual([{ kind: "add", ids: ["next/components/card.tsx#ProductCard"], folder: "/wt" }]);
    await expect(tools.lode_search.run({ query: "x", folder: "/elsewhere" })).rejects.toThrow(/no lode for \/elsewhere/);
  });

  it("the graph tools come along, each on a canvas's project", async () => {
    const { tools } = fakeHost();
    expect(await tools.lode_search.run({ query: "ProductCard", canvas: "flow:a" })).toMatch(/next\/components\/card.tsx#ProductCard/);
    expect(tools.lode_read.inputSchema.properties).toHaveProperty("canvas");
  });
});
