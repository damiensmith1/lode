import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphStore } from "../src/graph/store.js";
import { tsPlugin } from "../src/ingest/ts/index.js";
import type { LanguagePlugin } from "../src/schema/index.js";

// A scratch project in a temp dir, so tests can edit files freely.
let dir: string;
let tsconfig: string;
let cacheDir: string;
const write = (file: string, content: string) => writeFileSync(path.join(dir, file), content);

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lode-store-"));
  cacheDir = path.join(dir, ".cache");
  tsconfig = path.join(dir, "tsconfig.json");
  write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext" }, include: ["*.ts"] }));
  write("make.ts", "export function make() { return 1; }\n");
  write("use.ts", 'import { make } from "./make.js";\nexport function take(x: unknown) {}\nexport function use() { take(make()); }\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Counts how often the plugin has to do real work.
function counting(plugin: LanguagePlugin) {
  const counts = { updates: [] as (string[] | undefined)[] };
  const wrapped: LanguagePlugin = {
    ...plugin,
    open(projectPath, state) {
      const session = plugin.open(projectPath, state);
      return { ...session, update: (changed) => (counts.updates.push(changed), session.update(changed)) };
    },
  };
  return { plugin: wrapped, counts };
}

describe("GraphStore", () => {
  it("indexes on first open and saves the graph", () => {
    const store = GraphStore.open(tsPlugin, tsconfig, { cacheDir });
    expect(store.graph.neighbors("use.ts#use", "down").map((e) => e.to)).toContain("make.ts#make");
  });

  it("reopens from cache without re-indexing when nothing changed", () => {
    GraphStore.open(tsPlugin, tsconfig, { cacheDir });
    const { plugin, counts } = counting(tsPlugin);
    const store = GraphStore.open(plugin, tsconfig, { cacheDir });
    expect(counts.updates).toEqual([]);
    expect(store.graph.node("make.ts#make")).toBeDefined();
  });

  it("re-indexes only changed files on reopen", () => {
    GraphStore.open(tsPlugin, tsconfig, { cacheDir });
    write("make.ts", "export function make() { return 1; }\nexport function extra() {}\n");
    const { plugin, counts } = counting(tsPlugin);
    const store = GraphStore.open(plugin, tsconfig, { cacheDir });
    expect(counts.updates).toEqual([["make.ts"]]);
    expect(store.graph.node("make.ts#extra")).toBeDefined();
  });

  it("refreshes importers when a file they depend on changes", () => {
    const store = GraphStore.open(tsPlugin, tsconfig, { cacheDir });
    const argOf = () => store.graph.neighbors("use.ts#use", "down").find((e) => e.to === "use.ts#take")?.args;
    expect(argOf()).toEqual(["number"]);
    write("make.ts", 'export function make() { return "one"; }\n');
    expect(store.refresh()).toEqual(["make.ts"]);
    expect(argOf()).toEqual(["string"]); // use.ts wasn't edited, but its facts changed
  });

  it("drops removed files and picks up new ones", () => {
    const store = GraphStore.open(tsPlugin, tsconfig, { cacheDir });
    write("extra.ts", "export function added() {}\n");
    unlinkSync(path.join(dir, "use.ts"));
    expect(store.refresh().sort()).toEqual(["extra.ts", "use.ts"]);
    expect(store.graph.node("extra.ts#added")).toBeDefined();
    expect(store.graph.node("use.ts#use")).toBeUndefined();
  });

  it("rebuilds when the plugin version changes", () => {
    GraphStore.open(tsPlugin, tsconfig, { cacheDir });
    const { plugin, counts } = counting({ ...tsPlugin, version: tsPlugin.version + 1 });
    GraphStore.open(plugin, tsconfig, { cacheDir });
    expect(counts.updates).toEqual([undefined]);
  });
});
