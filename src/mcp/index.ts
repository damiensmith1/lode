import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ContextResult } from "../context/index.js";
import type { ChangesResult, EntriesResult, NodeRef } from "../query/types.js";
import type { LodeService } from "../service/index.js";

// lode as an MCP server (Model Context Protocol, over stdio): tools an
// agent (Claude Code, Cursor, Clance's agent…) calls to get precise context
// from the code graph instead of reading whole files. A thin layer over
// the service, like the WebSocket server. Speaks newline-delimited
// JSON-RPC 2.0: initialize, ping, tools/list, tools/call.

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string>;
}

export interface McpOptions {
  input?: Readable; // default stdin
  output?: Writable; // default stdout
  version?: string;
  log?: (message: string) => void; // default: stderr (stdout is the protocol)
}

// Tools for a host's canvases (its flow views), to mount on its own server.
export { canvasTools, type CanvasHost, type CanvasInfo } from "./canvas.js";

export function serveMcp(service: LodeService, options: McpOptions = {}): { close(): void } {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((m: string) => process.stderr.write(`lode mcp: ${m}\n`));
  const tools = lodeTools(service);
  const send = (message: unknown) => output.write(`${JSON.stringify(message)}\n`);

  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const { id, method, params = {} } = msg;
    const reply = (result: unknown) => id !== undefined && send({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => id !== undefined && send({ jsonrpc: "2.0", id, error: { code, message } });
    try {
      if (method === "initialize") {
        const asked = String(params.protocolVersion ?? "");
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "lode", version: options.version ?? "0.1.0" },
          instructions:
            "lode knows this codebase as a graph: what calls what, what flows where, what changed. Prefer lode_context or lode_read over reading whole files: they return the code that matters, with how it connects, sized to a token budget. lode_impact shows what the current changes touch.",
        });
      }
      if (method === "ping") return reply({});
      if (method?.startsWith("notifications/")) return; // initialized, cancelled: nothing to do
      if (method === "tools/list") return reply({ tools: tools.map(({ run: _, ...t }) => t) });
      if (method === "tools/call") {
        const tool = tools.find((t) => t.name === params.name);
        if (!tool) return fail(-32602, `unknown tool ${String(params.name)}`);
        try {
          const text = await tool.run((params.arguments as Record<string, unknown>) ?? {});
          return reply({ content: [{ type: "text", text }] });
        } catch (error) {
          // Tool errors go back to the model as a result it can read.
          return reply({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
        }
      }
      return fail(-32601, `unknown method ${String(method)}`);
    } catch (error) {
      log(error instanceof Error ? error.stack ?? error.message : String(error));
      return fail(-32603, error instanceof Error ? error.message : String(error));
    }
  });
  return { close: () => rl.close() };
}

// The tools, over the service's methods.
export function lodeTools(service: LodeService): Tool[] {
  const call = <T>(method: string, params: Record<string, unknown> = {}) => service.call(method, params) as Promise<T>;
  // A symbol by id ("src/a.ts#run") or by name ("run").
  const resolve = async (symbol: unknown): Promise<string> => {
    const s = String(symbol ?? "").trim();
    if (!s) throw new Error("no symbol given");
    if (s.includes("#") || /\.[a-z]+$/i.test(s)) return s;
    const found = await call<NodeRef[]>("search", { query: s });
    const exact = found.find((n) => n.name === s) ?? found[0];
    if (!exact) throw new Error(`no symbol named ${s}; try lode_search`);
    return exact.id;
  };
  const budget = (args: Record<string, unknown>, fallback: number) => (Number.isFinite(Number(args.budget)) && Number(args.budget) > 0 ? Number(args.budget) : fallback);
  const rank = (args: Record<string, unknown>) => (args.rank === "judge" ? "judge" : "graph");
  const md = (r: ContextResult) => r.markdown;

  return [
    {
      name: "lode_search",
      description: "Find symbols (functions, classes, types, variables) by name. Returns ids to pass to the other tools.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "A name or part of one" } }, required: ["query"] },
      run: async (args) => {
        const found = await call<NodeRef[]>("search", { query: String(args.query ?? "") });
        return found.length ? found.map((n) => `${n.id} — ${n.name} (${n.kind === "callable" ? "function" : n.kind}) ${n.file ?? ""}${n.line ? `:${n.line}` : ""}`).join("\n") : "Nothing matches.";
      },
    },
    {
      name: "lode_read",
      description: "Read a symbol with its surroundings: its full code, what it calls and what calls it (signatures and the connecting lines), and how they connect. Better than reading the whole file.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "A symbol id (src/a.ts#run) or name (run)" },
          hops: { type: "number", description: "How far out to include (default 1)" },
          budget: { type: "number", description: "About how many tokens (default 4000)" },
        },
        required: ["symbol"],
      },
      run: async (args) => md(await call<ContextResult>("context", { seeds: [await resolve(args.symbol)], hops: args.hops ?? 1, budget: budget(args, 4000) })),
    },
    {
      name: "lode_context",
      description:
        "The code that matters for a question or a set of symbols, as compact context: full code for the central pieces, signatures for neighbours, names further out, and how they connect. Deterministic by default; rank \"judge\" uses lode's model to choose (needs a key).",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: 'What you want to understand ("how are tabs created")' },
          symbols: { type: "array", items: { type: "string" }, description: "Symbol ids or names to start from" },
          hops: { type: "number", description: "How far out from them (default 1)" },
          direction: { type: "string", enum: ["down", "up", "both"], description: "Follow what they call, what calls them, or both" },
          budget: { type: "number", description: "About how many tokens (default 8000)" },
          rank: { type: "string", enum: ["graph", "judge"], description: "graph: deterministic (default); judge: model-chosen" },
        },
      },
      run: async (args) => {
        const symbols = Array.isArray(args.symbols) ? await Promise.all(args.symbols.map(resolve)) : undefined;
        if (!symbols?.length && !args.question) throw new Error("give a question or symbols");
        return md(
          await call<ContextResult>("context", {
            ...(symbols?.length && { seeds: symbols }),
            ...(args.question ? { question: String(args.question) } : {}),
            ...(args.hops !== undefined && { hops: Number(args.hops) }),
            ...(args.direction ? { direction: args.direction } : {}),
            budget: budget(args, 8000),
            rank: rank(args),
          }),
        );
      },
    },
    {
      name: "lode_impact",
      description: "What the uncommitted changes (or changes since a git ref) are and what they touch: the changed code with + and - lines, and the code that depends on it.",
      inputSchema: {
        type: "object",
        properties: {
          base: { type: "string", description: "A git ref (default HEAD: uncommitted changes)" },
          budget: { type: "number", description: "About how many tokens (default 8000)" },
          rank: { type: "string", enum: ["graph", "judge"], description: "judge: keep only what the model thinks is at risk (needs a key)" },
        },
      },
      run: async (args) => md(await call<ContextResult>("context", { changes: String(args.base ?? "HEAD"), budget: budget(args, 8000), rank: rank(args) })),
    },
    {
      name: "lode_changes",
      description: "List what changed in git since a ref (default HEAD): files, and the symbols changed in each, with line counts.",
      inputSchema: { type: "object", properties: { base: { type: "string", description: "A git ref (default HEAD)" } } },
      run: async (args) => {
        const r = await call<ChangesResult>("changes", { base: String(args.base ?? "HEAD") });
        if (r.error) throw new Error(r.error);
        if (!r.files.length) return `No changes since ${r.base}.`;
        return r.files
          .map((f) => [`${f.status} ${f.file} +${f.added} -${f.removed}`, ...f.symbols.filter((s) => s.added || s.removed).map((s) => `  ${s.node.id} +${s.added} -${s.removed}`)].join("\n"))
          .join("\n");
      },
    },
    {
      name: "lode_entries",
      description: "Where to start reading: what the outside world calls into (IPC handlers, events, exports nothing calls), by runtime.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        const r = await call<EntriesResult>("entries");
        return r.groups
          .map((g) => [`## ${g.runtime ?? "other"}`, ...g.categories.map((c) => `${c.name}:\n${c.entries.slice(0, 15).map((e) => `  ${e.node.id} — ${e.label}`).join("\n")}${c.entries.length > 15 ? `\n  (+${c.entries.length - 15} more)` : ""}`)].join("\n"))
          .join("\n\n");
      },
    },
  ];
}
