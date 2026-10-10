import { realpathSync, watch as watchFiles } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GraphStore } from "../graph/store.js";
import { Queries } from "../query/index.js";
import { askFlow } from "../ask/index.js";
import { jevJudge, type Judge } from "../ask/judge.js";
import { contextFor, type ContextRequest } from "../context/index.js";

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
  // What judges "/" questions (see src/ask). Default: Jev, when
  // TYPESAFE_API_KEY is set (read when a question comes in).
  judge?: Judge;
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
  // Watch the project folder and refresh on changes (debounced), so views
  // update as files change. Returns a function that stops watching.
  watch(options?: WatchOptions): () => void;
  onChanged(listener: (files: string[]) => void): () => void;
}

// A change to a file, as cards make them: lines start..end (1-based,
// inclusive) as they were (`expected`), replaced by `lines` (any number).
export interface LineEdit {
  start: number;
  end: number;
  expected: string[];
  lines: string[];
}

export type EditResult = { ok: true; files: string[] } | { ok: false; reason: "conflict" | "not found" | "overlap"; message: string };

export interface WatchOptions {
  debounceMs?: number; // default 250
  // Paths (relative to the project) to ignore. Default: node_modules,
  // .git, dist, out at any depth.
  ignore?: (relativePath: string) => boolean;
}

const IGNORED = /(^|[\\/])(node_modules|\.git|dist|out)([\\/]|$)/;

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

  // Project files only: resolved for real, inside the root, and listed
  // (in the graph, or a file git doesn't ignore).
  const projectFile = (file: unknown) => {
    if (typeof file !== "string" || !queries.isProjectFile(file)) return null;
    try {
      const root = realpathSync(store.root);
      const absolute = realpathSync(path.resolve(store.root, file));
      return absolute.startsWith(root + path.sep) ? absolute : null;
    } catch {
      return null;
    }
  };

  // Apply line edits to one file, but only if every edited span still reads
  // as the editor last saw it; otherwise nothing is written. Bottom-up, so
  // earlier spans keep their line numbers. Re-indexes right away.
  const editFile = async (file: unknown, edits: LineEdit[]): Promise<EditResult> => {
    const absolute = projectFile(file);
    if (!absolute) return { ok: false, reason: "not found", message: `not a project file: ${String(file)}` };
    const original = await readFile(absolute, "utf8");
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    const lines = original.split(/\r?\n/);
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i];
      if (!(e.start >= 1 && e.end >= e.start - 1 && e.end <= lines.length)) return { ok: false, reason: "conflict", message: `lines ${e.start}-${e.end} aren't in the file any more` };
      if (i > 0 && e.end >= sorted[i - 1].start) return { ok: false, reason: "overlap", message: "edits overlap" };
      const now = lines.slice(e.start - 1, e.end);
      if (now.length !== e.expected.length || now.some((l, k) => l !== e.expected[k]))
        return { ok: false, reason: "conflict", message: `${String(file)} changed since it was shown (lines ${e.start}-${e.end})` };
    }
    for (const e of sorted) lines.splice(e.start - 1, e.end - e.start + 1, ...e.lines);
    await writeFile(absolute, lines.join(eol));
    const files = service.refresh();
    if (!files.length) for (const listener of listeners) listener([String(file)]);
    return { ok: true, files: files.length ? files : [String(file)] };
  };

  // The judge for "/" questions and judged context: the host's, or Jev
  // when a key is set (read when needed).
  const judgeOf = () => options.judge ?? (process.env.TYPESAFE_API_KEY ? jevJudge({ apiKey: process.env.TYPESAFE_API_KEY }) : null);

  const methods: Record<string, (params: Record<string, unknown>) => unknown> = {
    editFile: (p) => {
      const edits = Array.isArray(p.edits) ? p.edits : [];
      const valid = (e: unknown): e is LineEdit => {
        const x = e as LineEdit;
        const strings = (a: unknown) => Array.isArray(a) && a.every((l) => typeof l === "string" && !/[\r\n]/.test(l));
        return !!x && Number.isInteger(x.start) && Number.isInteger(x.end) && strings(x.expected) && strings(x.lines);
      };
      if (!edits.length || !edits.every(valid)) throw new Error("bad edits");
      return editFile(p.file, edits);
    },
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
    changes: (p) => queries.changes(typeof p.base === "string" && p.base ? p.base : "HEAD"),
    // Context for a language model: a slice of the code, formatted (see
    // src/context). Deterministic unless rank is "judge".
    context: (p) => {
      const request = p as ContextRequest;
      if (request.rank === "judge" && !judgeOf()) throw new Error("rank \"judge\" needs a model: set TYPESAFE_API_KEY (Jev)");
      return contextFor(request, queries, judgeOf() ?? undefined);
    },
    // Build a flow for a question ("how do we create tabs?").
    ask: (p) => {
      const question = String(p.question ?? "").trim().slice(0, 500);
      if (!question) throw new Error("ask: no question");
      const judge = judgeOf();
      if (!judge) throw new Error("Asking needs a model: set TYPESAFE_API_KEY (Jev) in the environment or lode's .env");
      return askFlow(question, queries, judge, { base: typeof p.base === "string" && p.base ? p.base : "HEAD" });
    },
    symbolAt: (p) => queries.symbolAt(String(p.file), Number(p.line)),
  };

  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const fn = Object.hasOwn(methods, method) ? methods[method] : undefined;
    if (!fn) throw new Error(`unknown method ${method}`);
    return fn(params);
  };

  const service: LodeService = {
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
    watch: (watchOptions = {}) => {
      const ignore = watchOptions.ignore ?? ((name: string) => IGNORED.test(name));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const touched = new Set<string>();
      const watcher = watchFiles(store.root, { recursive: true }, (_event, name) => {
        if (!name || ignore(String(name))) return;
        touched.add(String(name).split(path.sep).join("/"));
        clearTimeout(timer);
        timer = setTimeout(() => {
          // Code files re-index (and tell listeners); other files (README,
          // JSON) aren't in the graph, but views showing them or their
          // changes still need to hear about it.
          const names = [...touched];
          touched.clear();
          if (!service.refresh().length) for (const listener of listeners) listener(names);
        }, watchOptions.debounceMs ?? 250);
      });
      return () => {
        clearTimeout(timer);
        watcher.close();
      };
    },
    onChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return service;
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
