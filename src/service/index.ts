import { realpathSync, watch as watchFiles } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GraphStore } from "../graph/store.js";
import { Queries } from "../query/index.js";
import { askFlow } from "../ask/index.js";
import { jevJudge, type Judge } from "../ask/judge.js";
import { contextFor, type ContextRequest } from "../context/index.js";
import { explain, type ExplainRequest } from "../explain/index.js";
import type { ChatModel } from "../explain/model.js";
import { chooseModel, providersFromEnv, type ExplainProviders } from "../explain/providers.js";

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
  // What explains flows (see src/explain): exactly these providers, by
  // name, each a ChatModel and the models it offers; a question picks one
  // as "provider:model". Unset: every provider the environment has a key
  // for (see providersFromEnv: Anthropic, OpenAI or a compatible server,
  // OpenRouter), so a host that passes providers decides alone what's used.
  providers?: ExplainProviders;
  // Shorthand for one provider ("default") answering with its own default.
  model?: ChatModel;
  // The model a question gets when it doesn't pick one ("provider:model").
  // Default: LODE_EXPLAIN_MODEL, else the first provider's first model.
  defaultModel?: string;
  // Which models a request may ask for ("provider:model"); unset: any the
  // providers offer, or name.
  models?: string[];
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
  // Events pushed while a method runs (an explanation streaming in), for
  // transports to forward: { name, payload }.
  onEvent(listener: (name: string, payload: unknown) => void): () => void;
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
  const eventListeners = new Set<(name: string, payload: unknown) => void>();
  const running = new Map<string, AbortController>(); // explanations, by stream id
  const emit = (name: string, payload: unknown) => eventListeners.forEach((l) => l(name, payload));

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

  // The providers that explain: the host's, or the environment's (read
  // when needed, so .env changes show after a restart).
  const explainProviders = (): { providers: ExplainProviders; notes: string[]; fallback?: string } => {
    if (options.providers) return { providers: options.providers, notes: [], fallback: options.defaultModel };
    if (options.model) return { providers: { default: { label: "Default", model: options.model, models: (options.models ?? []).map((id) => ({ id: id.replace(/^default:/, ""), label: id.replace(/^default:/, "") })) } }, notes: [], fallback: options.defaultModel };
    const { providers, notes } = providersFromEnv();
    return { providers, notes, fallback: options.defaultModel ?? process.env.LODE_EXPLAIN_MODEL };
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
    // Explain cards, answer follow-ups, add cards; streamed as "explain"
    // events tagged with the caller's `stream` id.
    explain: (p) => {
      const request = p.request as ExplainRequest;
      if (!Array.isArray(request?.messages) || !request.messages.length) throw new Error("explain: no messages");
      if (request.model !== undefined && (typeof request.model !== "string" || !/^[\w.:/-]{1,120}$/.test(request.model))) throw new Error("explain: bad model name");
      const { providers, notes, fallback } = explainProviders();
      if (!Object.keys(providers).length)
        throw new Error(["Explaining needs a model: set ANTHROPIC_API_KEY, OPENAI_API_KEY (+ LODE_OPENAI_MODELS) or OPENROUTER_API_KEY (+ LODE_OPENROUTER_MODELS) in lode's .env", ...notes].join(". "));
      const choice = chooseModel(providers, request.model, fallback);
      if (!choice) throw new Error(`explain: no provider offers ${request.model} (${Object.keys(providers).join(", ")})`);
      const ref = `${choice.provider}:${choice.model}`;
      if (options.models && !options.models.includes(ref)) throw new Error(`explain: model ${ref} isn't allowed here (${options.models.join(", ")})`);
      const model = providers[choice.provider].model;
      const stream = String(p.stream ?? "");
      const abort = new AbortController();
      if (stream) running.set(stream, abort);
      return explain({ ...request, ...(choice.model && { model: choice.model }) }, queries, model, (event) => emit("explain", { stream, event }), abort.signal)
        .then((result) => ({ ...result, model: ref }))
        .finally(() => running.delete(stream));
    },
    // Which names (as written in prose: "addTab", "Queries.changes",
    // "this.save()") are real symbols: { name: id }. A name several symbols
    // share counts only in a `prefer`red file; anything else is left out.
    resolve: (p) => {
      const names = Array.isArray(p.names) ? p.names.map(String).slice(0, 200) : [];
      const prefer = new Set(Array.isArray(p.prefer) ? p.prefer.map(String) : []);
      const g = store.graph;
      const out: Record<string, string> = {};
      for (const raw of names) {
        const name = raw.replace(/\(\)$/, "").replace(/^this\./, "");
        if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(name) && !name.includes("#")) continue;
        const direct = g.node(name);
        if (direct && !direct.external) {
          out[raw] = direct.id;
          continue;
        }
        const matches = [...g.allNodes()].filter((n) => !n.external && n.loc && n.kind !== "block" && n.id !== n.loc.file && (n.id.endsWith(`#${name}`) || (!name.includes(".") && n.name === name)));
        // A plain word ("block", "changes") is usually prose: only a name
        // one symbol in the whole project has.
        if (/^[a-z]+$/.test(name) && matches.length !== 1) continue;
        const preferred = matches.filter((n) => prefer.has(n.loc!.file));
        const pick = preferred.length === 1 ? preferred[0] : matches.length === 1 ? matches[0] : preferred.find((n) => n.id.endsWith(`#${name}`)) ?? matches.find((n) => n.id.endsWith(`#${name}`) && matches.length <= 3);
        if (pick) out[raw] = pick.id;
      }
      return out;
    },
    // What the explain panel can offer, by provider: { providers: [{ id,
    // label, models: [{ id: "provider:model", label }] }], default, notes }.
    // No keys or URLs.
    explainModels: () => {
      const { providers, notes, fallback } = explainProviders();
      const allowed = (ref: string) => !options.models || options.models.includes(ref);
      const list = Object.entries(providers).map(([id, p]) => ({ id, label: p.label, models: p.models.map((m) => ({ id: `${id}:${m.id}`, label: m.label })).filter((m) => allowed(m.id)) }));
      const choice = chooseModel(providers, undefined, fallback);
      return { providers: list.filter((p) => p.models.length), default: choice ? `${choice.provider}:${choice.model}` : undefined, notes };
    },
    // Stop an explanation that's still running (its `stream` id).
    explainCancel: (p) => {
      running.get(String(p.stream ?? ""))?.abort();
      return true;
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
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
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
  const stopEvents = service.onEvent((name, payload) => port.send({ lode: 1, method: "event", params: { name, payload } }));
  return () => {
    stopListening();
    stopChanges();
    stopEvents();
  };
}
