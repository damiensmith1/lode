import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GraphStore } from "../graph/store.js";
import { Queries } from "../query/index.js";

// lode's methods with no transport attached: what views call, as plain async
// functions. The WebSocket server is one way to reach them; a host that runs
// Node itself (a VS Code extension, an Electron main process) can answer a
// view's messages with `call` directly, no server or port involved.
//
//   const service = createService(GraphStore.open(tsPlugin, folder));
//   webview.onDidReceiveMessage(async ({ id, method, params }) =>
//     webview.postMessage({ id, ...(await service.handle(method, params)) }));
//   service.onChanged((files) => webview.postMessage({ method: "changed", params: { files } }));

export interface ServiceOptions {
  // Where views' saved state goes when they use the service for it (the
  // default storage). Defaults to the store's cache directory.
  stateDir?: string;
}

export interface LodeService {
  methods: Readonly<Record<string, (params: Record<string, unknown>) => unknown>>;
  // Call a method; throws on an unknown method or a failure.
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  // The same, as a JSON-RPC style reply: { result } or { error }.
  handle(method: unknown, params?: unknown): Promise<{ result: unknown } | { error: string }>;
  // Re-index changed files; tells onChanged listeners when something did.
  refresh(): string[];
  onChanged(listener: (files: string[]) => void): () => void;
}

export function createService(store: GraphStore, options: ServiceOptions = {}): LodeService {
  const queries = new Queries(() => store.graph, store.root);
  const stateDir = options.stateDir ?? store.cacheDir;
  const listeners = new Set<(files: string[]) => void>();

  // Saved view state (a flow's cards, camera, …), one JSON file per key.
  // "layout-" is kept so state saved before keys existed still loads.
  const statePath = (key: unknown) => {
    if (typeof key !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(key) || key.startsWith(".")) throw new Error("bad state key");
    return path.join(stateDir, `layout-${key}.json`);
  };

  const methods: Record<string, (params: Record<string, unknown>) => unknown> = {
    loadState: async (p) => {
      try {
        return JSON.parse(await readFile(statePath(p.key), "utf8"));
      } catch {
        return null;
      }
    },
    saveState: async (p) => {
      const file = statePath(p.key);
      if (p.data === null || p.data === undefined) return void (await rm(file, { force: true }));
      const text = JSON.stringify(p.data);
      if (text.length > 2_000_000) throw new Error("state too large");
      await mkdir(stateDir, { recursive: true });
      await writeFile(file, text);
    },
    info: () => queries.info(),
    files: () => queries.files(),
    search: (p) => queries.search(String(p.query ?? "")),
    map: (p) => queries.map(String(p.lens ?? "runtime"), (p.parent as string | undefined) ?? null, Boolean(p.includeExternal)),
    source: (p) => queries.source(String(p.file)),
    graph: (p) => queries.tree(String(p.lens ?? "runtime")),
    block: (p) => queries.block(String(p.id)),
    entries: () => queries.entries(),
    symbolAt: (p) => queries.symbolAt(String(p.file), Number(p.line)),
  };

  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const fn = Object.hasOwn(methods, method) ? methods[method] : undefined;
    if (!fn) throw new Error(`unknown method ${method}`);
    return fn(params);
  };

  return {
    methods,
    call,
    handle: async (method, params) => {
      try {
        const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
        return { result: (await call(String(method), p)) ?? null };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    refresh: () => {
      const files = store.refresh();
      if (files.length) for (const listener of listeners) listener(files);
      return files;
    },
    onChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// Answer views over any message channel (a VS Code webview, an Electron
// IPC channel, a worker), speaking MessageConnection's protocol (see
// views/connection.ts). Returns a function that stops it.
export function serveMessages(
  service: LodeService,
  port: { send(message: unknown): void; listen(handler: (message: unknown) => void): () => void },
): () => void {
  const stopListening = port.listen((raw) => {
    const message = raw as { lode?: unknown; id?: unknown; method?: unknown; params?: unknown };
    if (!message || typeof message !== "object" || message.lode !== 1 || message.id === undefined) return;
    void service.handle(message.method, message.params).then((reply) => port.send({ lode: 1, id: message.id, ...reply }));
  });
  const stopChanges = service.onChanged((files) => port.send({ lode: 1, method: "changed", params: { files } }));
  return () => {
    stopListening();
    stopChanges();
  };
}
