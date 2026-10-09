import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGraph } from "../derive/index.js";
import type { GraphData, LanguagePlugin, PluginSession } from "../schema/index.js";
import type { Graph } from "./graph.js";

const FORMAT = 1;

interface CacheFile {
  format: number;
  plugin: string;
  pluginVersion: number;
  projectPath: string;
  files: Record<string, string>; // relative path -> content hash at index time
  data: GraphData; // plugin output only; derived edges are recomputed on load
  pluginState: unknown;
}

export interface StoreOptions {
  // Where the cache lives. Defaults to ~/.cache/lode/<project hash>, never
  // inside the project being indexed.
  cacheDir?: string;
}

// The current graph for one project: held in memory, saved to disk, and
// patched when files change. Opening a project whose files haven't changed
// since the last save loads the graph without running the plugin at all.
export class GraphStore {
  graph: Graph;
  private files: Record<string, string>;
  private data: GraphData;

  private constructor(
    private readonly plugin: LanguagePlugin,
    private readonly projectPath: string,
    private readonly session: PluginSession,
    private readonly cachePath: string,
    cached: CacheFile | null,
  ) {
    this.files = cached?.files ?? {};
    this.data = cached?.data ?? { nodes: [], edges: [] };
    this.graph = buildGraph(this.data);
  }

  static open(plugin: LanguagePlugin, projectPath: string, options: StoreOptions = {}): GraphStore {
    const absolute = path.resolve(projectPath);
    const cachePath = path.join(options.cacheDir ?? defaultCacheDir(absolute), "graph.json");
    const cached = readCache(cachePath, plugin, absolute);
    const store = new GraphStore(plugin, absolute, plugin.open(absolute, cached?.pluginState), cachePath, cached);
    if (cached) store.refresh();
    else store.rebuild();
    return store;
  }

  // Re-hash the project's files and re-index the ones that changed, were
  // added or were removed. Returns those files; empty means nothing to do.
  refresh(): string[] {
    const current = this.session.files();
    const changed = Object.keys(current).filter((f) => this.files[f] !== current[f]);
    const removed = Object.keys(this.files).filter((f) => !(f in current));
    const all = [...changed, ...removed];
    if (all.length) this.apply(this.session.update(all), current);
    return all;
  }

  // Index everything from scratch.
  rebuild(): void {
    const current = this.session.files();
    this.apply(this.session.update(), current);
  }

  private apply(data: GraphData, files: Record<string, string>) {
    this.graph = buildGraph(data); // validates before anything is replaced
    this.data = data;
    this.files = files;
    this.save();
  }

  private save() {
    const cache: CacheFile = {
      format: FORMAT,
      plugin: this.plugin.name,
      pluginVersion: this.plugin.version,
      projectPath: this.projectPath,
      files: this.files,
      data: this.data,
      pluginState: this.session.state(),
    };
    mkdirSync(path.dirname(this.cachePath), { recursive: true });
    const tmp = `${this.cachePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, this.cachePath); // atomic: a crash never leaves half a cache
  }
}

function readCache(cachePath: string, plugin: LanguagePlugin, projectPath: string): CacheFile | null {
  if (!existsSync(cachePath)) return null;
  try {
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as CacheFile;
    const valid =
      cache.format === FORMAT &&
      cache.plugin === plugin.name &&
      cache.pluginVersion === plugin.version &&
      cache.projectPath === projectPath;
    return valid ? cache : null;
  } catch {
    return null; // unreadable cache: rebuild
  }
}

function defaultCacheDir(projectPath: string): string {
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  const id = createHash("sha1").update(projectPath).digest("hex").slice(0, 16);
  return path.join(base, "lode", id);
}
