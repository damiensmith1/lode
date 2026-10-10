import { contextFor, type ContextRequest } from "../context/index.js";
import type { Queries } from "../query/index.js";
import type { NodeRef } from "../query/types.js";
import type { ChatBlock, ChatMessage, ChatModel, ChatTool } from "./model.js";

// Explaining what's on a flow, and building it out, in conversation. The
// model gets the cards as context (contextFor: their code, connections,
// notes, diffs) and three tools over the graph: search, read, and
// add_to_flow, which is how it changes the canvas: only ever with real
// graph nodes, which the view then opens and links like any card.

export interface ExplainRequest {
  // The conversation so far, the last one the user's new message.
  messages: { role: "user" | "assistant"; text: string }[];
  // What's on the canvas (or the selected part): the context.
  canvas?: ContextRequest["canvas"];
  changes?: string; // a git ref, when the flow shows changes
  focus?: string[]; // card ids the user picked (a selection): what "these" means
  question?: string; // the question the flow was built for, if any
  budget?: number; // context tokens (default 12000)
  model?: string; // which model answers this one (default: the ChatModel's own)
}

export type ExplainEvent =
  | { type: "text"; text: string } // a piece of the answer
  | { type: "tool"; name: string; summary: string } // the model reading the graph
  | { type: "add"; ids: string[] }; // cards to put on the canvas

export interface ExplainResult {
  text: string;
  added: string[];
  tools: number;
  ms: number;
}

const MAX_ROUNDS = 6; // model turns (each tool use is another)
const MAX_ADD = 10; // cards it may add per message

const SYSTEM = `You are lode's explainer. lode shows code as a flow: cards of real code on a canvas, connected by arrows (calls, IPC messages, shared state). The user is looking at some cards and asking about them.

How to answer:
- Lead with the answer in one or two sentences. Then, only if it helps, a few short bullets or numbered steps (in the order the code runs). Keep it under about 180 words unless the user asks for more detail.
- Ground every claim in the code you've been given. Refer to code by its exact name in backticks, like \`addTab\` (they become links to the cards): only real identifiers, not expressions or whole lines. Use a line number only when pointing at one specific line.
- Call out what's surprising, risky or easy to miss. With changes shown, lines marked + were added and - removed: say what changed and what it affects.
- The cards' code is below already: don't read it again, except that folded lines (⋯ N lines) are hidden: read the symbol (or the inner one) before saying what folded code does. If you need something that isn't there, use the tools, or say you don't know.
- No preamble, no recap of the question, no closing offers.

Tools:
- search finds symbols by name; read gives a symbol's code with what it calls and what calls it.
- add_to_flow puts symbols on the user's canvas as cards. Use it when they ask to show, add, include or build out more of the flow (or when one or two more cards would clearly help them follow your explanation). Add only what matters, at most ${MAX_ADD} at a time, and say what you added.`;

export async function explain(request: ExplainRequest, queries: Queries, model: ChatModel, onEvent: (e: ExplainEvent) => void = () => {}, signal?: AbortSignal): Promise<ExplainResult> {
  const started = Date.now();
  const g = queries.graph();

  // The context: the canvas (or selection), with the diff when shown.
  const context = request.canvas?.cards.length
    ? (await contextFor({ canvas: request.canvas, ...(request.changes && { changes: request.changes }), budget: request.budget ?? 12_000 }, queries)).markdown
    : "(The canvas is empty: use the tools to find what the user is asking about.)";
  const name = (id: string) => g.node(id.replace(/@\d+-\d+$/, ""))?.name ?? id;
  const about = [
    request.question ? `This flow was built for the question: "${request.question}".` : "",
    request.focus?.length ? `The user has selected these cards and is asking about them: ${request.focus.map((id) => `\`${name(id)}\``).join(", ")}.` : "",
    "What's on the canvas:",
    context,
  ]
    .filter(Boolean)
    .join("\n\n");

  // A symbol by id or name. A name several symbols share ("start") means
  // the one in a file already on the canvas, if there is one.
  const canvasFiles = new Set((request.canvas?.cards ?? []).map((c) => g.node(c.id.replace(/@\d+-\d+$/, ""))?.loc?.file).filter(Boolean));
  const resolve = (s: string): NodeRef | null => {
    const id = s.trim();
    const node = g.node(id);
    if (node && !node.external) return queries.ref(node);
    const name = id.replace(/^.*#/, "").replace(/\(\)$/, "");
    const found = queries.search(name, 30);
    const exact = found.filter((n) => n.name === name);
    return exact.find((n) => canvasFiles.has(n.file)) ?? exact[0] ?? found[0] ?? null;
  };

  const tools: ChatTool[] = [
    {
      name: "search",
      description: "Find symbols (functions, classes, types, variables) by name. Returns ids and where they are.",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    {
      name: "read",
      description: "Read a symbol's code, with the signatures of what it calls and what calls it, and how they connect.",
      input_schema: { type: "object", properties: { symbol: { type: "string", description: "An id (src/a.ts#run) or a name (run)" }, hops: { type: "number" } }, required: ["symbol"] },
    },
    {
      name: "add_to_flow",
      description: `Put symbols on the user's canvas as cards (they link up with the cards already there). At most ${MAX_ADD} per message.`,
      input_schema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" }, description: "Ids or names" } }, required: ["symbols"] },
    },
  ];

  const added: string[] = [];
  let toolCount = 0;
  const run = async (block: Extract<ChatBlock, { type: "tool_use" }>): Promise<string> => {
    toolCount++;
    const input = block.input;
    if (block.name === "search") {
      const query = String(input.query ?? "");
      onEvent({ type: "tool", name: "search", summary: `searching “${query}”` });
      const found = queries.search(query, 15);
      return found.length ? found.map((n) => `${n.id} — ${n.name} (${n.kind}) ${n.file ?? ""}${n.line ? `:${n.line}` : ""}`).join("\n") : "Nothing matches.";
    }
    if (block.name === "read") {
      const ref = resolve(String(input.symbol ?? ""));
      if (!ref) return `No symbol ${String(input.symbol)}; try search.`;
      onEvent({ type: "tool", name: "read", summary: `reading \`${ref.name}\`` });
      return (await contextFor({ seeds: [ref.id], hops: Number(input.hops ?? 1), budget: 3000 }, queries)).markdown;
    }
    if (block.name === "add_to_flow") {
      const wanted = Array.isArray(input.symbols) ? input.symbols.map(String) : [];
      const refs = wanted.map(resolve).filter((r): r is NodeRef => !!r && !added.includes(r.id));
      const room = MAX_ADD - added.length;
      const take = refs.slice(0, Math.max(0, room));
      if (!take.length) return room > 0 ? `None of those are symbols in this project: ${wanted.join(", ")}` : `Already added ${MAX_ADD} cards this message.`;
      added.push(...take.map((r) => r.id));
      onEvent({ type: "add", ids: take.map((r) => r.id) });
      return `Added to the canvas: ${take.map((r) => r.name).join(", ")}.${refs.length > take.length ? ` (${refs.length - take.length} over the limit were left out.)` : ""}`;
    }
    return `Unknown tool ${block.name}.`;
  };

  const messages: ChatMessage[] = request.messages.slice(-16).map((m) => ({ role: m.role, content: m.text }));
  let text = "";
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const turn = await model.chat({
      system: [SYSTEM, about],
      messages,
      tools: round < MAX_ROUNDS - 1 ? tools : [], // the last round answers
      ...(request.model && { model: request.model }),
      onText: (delta) => {
        text += delta;
        onEvent({ type: "text", text: delta });
      },
      signal,
    });
    // Empty text blocks (a turn that went straight to a tool) can't be sent back.
    const said = turn.content.filter((b) => b.type !== "text" || b.text.trim());
    if (said.length) messages.push({ role: "assistant", content: said });
    const calls = turn.content.filter((b): b is Extract<ChatBlock, { type: "tool_use" }> => b.type === "tool_use");
    if (turn.stop !== "tool_use" || !calls.length) break;
    const results: ChatBlock[] = [];
    for (const call of calls) {
      try {
        results.push({ type: "tool_result", tool_use_id: call.id, content: await run(call) });
      } catch (error) {
        results.push({ type: "tool_result", tool_use_id: call.id, content: error instanceof Error ? error.message : String(error), is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
    if (text && !text.endsWith("\n")) {
      text += "\n\n";
      onEvent({ type: "text", text: "\n\n" });
    }
  }
  return { text: text.trim(), added, tools: toolCount, ms: Date.now() - started };
}
