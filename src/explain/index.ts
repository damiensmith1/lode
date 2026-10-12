import { askFlow } from "../ask/index.js";
import type { Judge } from "../ask/judge.js";
import { contextFor, type ContextRequest } from "../context/index.js";
import type { Queries } from "../query/index.js";
import type { FlowPlan, NodeRef } from "../query/types.js";
import type { ChatBlock, ChatMessage, ChatModel, ChatTool } from "./model.js";

// Explaining what's on a flow, and working the canvas, in conversation. The
// model gets the cards as context (contextFor: their code, connections,
// notes, diffs) and tools over the graph (search, read) and over the
// canvas: add cards, expand one, open or close a fold, close cards, select,
// focus, fit, show changes, build a whole flow (Jev, via askFlow), open a
// new tab (only when the user asks for one). Canvas tools change nothing
// here: each becomes an action, checked against the graph and the cards,
// that the view carries out.

export interface ExplainRequest {
  // The conversation so far, the last one the user's new message.
  messages: { role: "user" | "assistant"; text: string }[];
  // What's on the canvas (or the selected part): the context.
  canvas?: ContextRequest["canvas"];
  // Every card on the canvas (keys), when the context is only part of it:
  // what canvas tools may refer to. Default: the context's cards.
  cards?: string[];
  changes?: string; // a git ref, when the flow shows changes
  focus?: string[]; // card ids the user picked (a selection): what "these" means
  question?: string; // the question the flow was built for, if any
  budget?: number; // context tokens (default 12000)
  model?: string; // which model answers this one (default: the ChatModel's own)
}

// Something for the view to do to the canvas. Cards are card keys (node
// ids, or node@start-end for part of one).
export type CanvasAction =
  | { kind: "add"; ids: string[] }
  | { kind: "expand"; card: string }
  | { kind: "fold"; card: string; start: number; end: number; open: boolean }
  | { kind: "close"; cards: string[] }
  | { kind: "select"; cards: string[] }
  | { kind: "focus"; cards: string[] }
  | { kind: "fit" }
  | { kind: "changes"; base: string | null }
  | { kind: "plan"; plan: FlowPlan }
  | { kind: "tab"; question?: string }
  // Cards that aren't code: a title and text (Markdown; the host renders
  // it), e.g. a box in a system design. `id` names it for links and for
  // updating it (a note with that id is replaced); `near`: a card to put it
  // beside.
  | { kind: "note"; id?: string; title: string; text: string; near?: string }
  // An arrow between any two cards (notes or code), with a label.
  | { kind: "link"; from: string; to: string; label?: string }
  // Notes and links at once, laid out left to right along the links (a
  // diagram): links may also name cards already on the canvas.
  | { kind: "diagram"; notes: { id: string; title: string; text: string }[]; links: { from: string; to: string; label?: string }[] };

export type ExplainEvent =
  | { type: "text"; text: string } // a piece of the answer
  | { type: "tool"; name: string; summary: string } // the model reading the graph
  | { type: "action"; action: CanvasAction; summary: string }; // something to do to the canvas

export interface ExplainResult {
  text: string;
  added: string[];
  actions: CanvasAction[];
  tools: number;
  ms: number;
}

export interface ExplainOptions {
  signal?: AbortSignal;
  judge?: Judge; // for build_flow (Jev); without one the model builds flows card by card
}

const MAX_ROUNDS = 8; // model turns (each tool use is another)
const MAX_ADD = 12; // cards it may add per message
const MAX_ACTIONS = 16; // canvas actions per message

// Did the user ask for a new tab? Only then may the model open one.
export const askedForTab = (text: string) => /\b(new|another|separate|different|fresh|its own)\s+(flow\s+)?tab\b|\bin\s+a\s+tab\b|\bopen\s+(a\s+)?tab\b/i.test(text);

const SYSTEM = `You are lode's explainer. lode shows code as a flow: cards of real code on a canvas, connected by arrows (calls, IPC messages, shared state). The user is looking at some cards and asking about them, or asking you to work the canvas for them.

How to answer:
- Lead with the answer in one or two sentences. Then, only if it helps, a few short bullets or numbered steps (in the order the code runs). Keep it under about 180 words unless the user asks for more detail.
- Ground every claim in the code you've been given. Refer to code by its exact name in backticks, like \`addTab\` (they become links to the cards): only real identifiers, not expressions or whole lines. Use a line number only when pointing at one specific line.
- Call out what's surprising, risky or easy to miss. With changes shown, lines marked + were added and - removed: say what changed and what it affects.
- The cards' code is below already: don't read it again, except that folded lines (⋯ N lines) are hidden: read the symbol (or the inner one), or open the fold, before saying what folded code does. If you need something that isn't there, use the tools, or say you don't know.
- No preamble, no recap of the question, no closing offers.

Reading the graph: search finds symbols by name; read gives a symbol's code with what it calls and what calls it.

Working the canvas: do what the user asks. Unasked, make only small moves that clearly help them follow you (adding one or two cards, focusing the ones you're talking about).
- add_cards puts symbols on the canvas as cards (at most ${MAX_ADD} a message). build_flow builds a whole flow for a question (where it starts and the steps that follow) onto this canvas: use it when they want to see how something works end to end.
- expand shows all of a card's lines and opens everything it leads to. open_fold / close_fold open or close a folded part, by the card and the line the fold starts on. close_cards removes cards. select, focus and fit point their attention and move the view. show_changes turns the git diff on or off.
- New tabs only when the user explicitly asks for a new tab (open_tab, or build_flow with new_tab). Otherwise everything happens on this canvas.
- You can't edit code. If they ask, say so.
- Refer to cards by name or id. When they only asked you to do something, do it and say in a sentence what you did: no explanation they didn't ask for.`;

export async function explain(request: ExplainRequest, queries: Queries, model: ChatModel, onEvent: (e: ExplainEvent) => void = () => {}, signalOrOptions?: AbortSignal | ExplainOptions): Promise<ExplainResult> {
  const options: ExplainOptions = signalOrOptions instanceof AbortSignal ? { signal: signalOrOptions } : (signalOrOptions ?? {});
  const started = Date.now();
  const g = queries.graph();
  const base = (key: string) => key.replace(/@\d+-\d+$/, "");
  const nameOf = (key: string) => g.node(base(key))?.name ?? key;

  // The cards on the canvas (and, as this message adds some, will be).
  const cards = new Set(request.cards ?? request.canvas?.cards.map((c) => c.id) ?? []);

  // The context: the canvas (or selection), with the diff when shown.
  const context = request.canvas?.cards.length
    ? (await contextFor({ canvas: request.canvas, ...(request.changes && { changes: request.changes }), budget: request.budget ?? 12_000 }, queries)).markdown
    : "(The canvas is empty: use the tools to find what the user is asking about.)";
  const about = [
    request.question ? `This flow was built for the question: "${request.question}".` : "",
    request.focus?.length ? `The user has selected these cards and is asking about them: ${request.focus.map((id) => `\`${nameOf(id)}\``).join(", ")}.` : "",
    cards.size ? `Cards on the canvas (name: id), for the canvas tools:\n${[...cards].map((k) => `- ${nameOf(k)}: ${k}`).join("\n")}` : "",
    request.changes ? `The canvas shows git changes since ${request.changes}.` : "The canvas doesn't show git changes.",
    "What's in view:",
    context,
  ]
    .filter(Boolean)
    .join("\n\n");

  // A symbol by id or name. A name several symbols share ("start") means
  // the one in a file already on the canvas, if there is one.
  const canvasFiles = new Set([...cards].map((c) => g.node(base(c))?.loc?.file).filter(Boolean));
  const resolve = (s: string): NodeRef | null => {
    const id = s.trim();
    const node = g.node(id);
    if (node && !node.external) return queries.ref(node);
    const name = id.replace(/^.*#/, "").replace(/\(\)$/, "");
    const found = queries.search(name, 30);
    const exact = found.filter((n) => n.name === name);
    return exact.find((n) => canvasFiles.has(n.file)) ?? exact[0] ?? found[0] ?? null;
  };
  // A card on the canvas by key, node id or name.
  const cardOf = (s: unknown): string | null => {
    const want = String(s ?? "").trim().replace(/\(\)$/, "");
    if (cards.has(want)) return want;
    return [...cards].find((k) => base(k) === want) ?? [...cards].find((k) => nameOf(k) === want || base(k).endsWith(`#${want}`)) ?? null;
  };
  const cardsOf = (list: unknown) => {
    const found: string[] = [];
    const missing: string[] = [];
    for (const item of (Array.isArray(list) ? list : [list]).map(String)) {
      const k = cardOf(item);
      if (k) found.includes(k) || found.push(k);
      else missing.push(item);
    }
    return { found, missing };
  };
  // A fold in a card, by the line it starts on (inside the card's lines,
  // and not the card itself).
  const foldOf = (key: string, line: number) => {
    const block = queries.block(base(key));
    if (!block) return null;
    const range = /@(\d+)-(\d+)$/.exec(key);
    const from = range ? Number(range[1]) : (block.lines[0]?.n ?? 0);
    const to = range ? Number(range[2]) : (block.lines[block.lines.length - 1]?.n ?? 0);
    return block.regions.find((r) => r.start === line && r.start >= from && r.end <= to && !(r.start === from && r.end === to)) ?? null;
  };

  const lastUser = [...request.messages].reverse().find((m) => m.role === "user")?.text ?? "";
  const tabsAllowed = askedForTab(lastUser);

  const card = { type: "string", description: "A card on the canvas: its name or id" };
  const cardList = { type: "array", items: { type: "string" }, description: "Cards on the canvas: names or ids" };
  const tools: ChatTool[] = [
    { name: "search", description: "Find symbols (functions, classes, types, variables) by name. Returns ids and where they are.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    {
      name: "read",
      description: "Read a symbol's code, with the signatures of what it calls and what calls it, and how they connect.",
      input_schema: { type: "object", properties: { symbol: { type: "string", description: "An id (src/a.ts#run) or a name (run)" }, hops: { type: "number" } }, required: ["symbol"] },
    },
    {
      name: "add_cards",
      description: `Put symbols on the canvas as cards (they link up with the cards already there). At most ${MAX_ADD} per message.`,
      input_schema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" }, description: "Ids or names" } }, required: ["symbols"] },
    },
    {
      name: "build_flow",
      description: "Build a whole flow for a question about the code (where it starts and the steps that follow) onto this canvas. new_tab only if the user explicitly asked for a new tab.",
      input_schema: { type: "object", properties: { question: { type: "string" }, new_tab: { type: "boolean" } }, required: ["question"] },
    },
    { name: "expand", description: "Expand a card: all its lines, and everything it leads to (calls, nested declarations) opened beside it.", input_schema: { type: "object", properties: { card }, required: ["card"] } },
    {
      name: "open_fold",
      description: "Open a folded part of a card (⋯ N lines), by the line the fold starts on: small ones open in place, others as their own card.",
      input_schema: { type: "object", properties: { card, line: { type: "number" } }, required: ["card", "line"] },
    },
    { name: "close_fold", description: "Close an opened fold in a card, by the line it starts on.", input_schema: { type: "object", properties: { card, line: { type: "number" } }, required: ["card", "line"] } },
    { name: "close_cards", description: "Remove cards from the canvas.", input_schema: { type: "object", properties: { cards: cardList }, required: ["cards"] } },
    { name: "select", description: "Select cards (highlight them for the user).", input_schema: { type: "object", properties: { cards: cardList }, required: ["cards"] } },
    { name: "focus", description: "Move the view to these cards.", input_schema: { type: "object", properties: { cards: cardList }, required: ["cards"] } },
    { name: "fit", description: "Zoom the view to show every card.", input_schema: { type: "object", properties: {} } },
    {
      name: "show_changes",
      description: "Show or hide git changes on the cards (added and removed lines), against a ref (default HEAD: uncommitted).",
      input_schema: { type: "object", properties: { on: { type: "boolean" }, base: { type: "string" } }, required: ["on"] },
    },
    {
      name: "open_tab",
      description: "Open a new flow tab, optionally building a flow for a question in it. Only when the user explicitly asked for a new tab.",
      input_schema: { type: "object", properties: { question: { type: "string" } } },
    },
  ];

  const added: string[] = [];
  const actions: CanvasAction[] = [];
  let toolCount = 0;
  const act = (action: CanvasAction, summary: string) => {
    if (actions.length >= MAX_ACTIONS) throw new Error(`That's ${MAX_ACTIONS} canvas actions this message: stop and tell the user what you did.`);
    actions.push(action);
    onEvent({ type: "action", action, summary });
    return `Done: ${summary}.`;
  };

  const run = async (block: Extract<ChatBlock, { type: "tool_use" }>): Promise<string> => {
    toolCount++;
    const input = block.input;
    switch (block.name) {
      case "search": {
        const query = String(input.query ?? "");
        onEvent({ type: "tool", name: "search", summary: `searching “${query}”` });
        const found = queries.search(query, 15);
        return found.length ? found.map((n) => `${n.id} — ${n.name} (${n.kind}) ${n.file ?? ""}${n.line ? `:${n.line}` : ""}`).join("\n") : "Nothing matches.";
      }
      case "read": {
        const ref = resolve(String(input.symbol ?? ""));
        if (!ref) return `No symbol ${String(input.symbol)}; try search.`;
        onEvent({ type: "tool", name: "read", summary: `reading \`${ref.name}\`` });
        return (await contextFor({ seeds: [ref.id], hops: Number(input.hops ?? 1), budget: 3000 }, queries)).markdown;
      }
      case "add_cards": {
        const wanted = Array.isArray(input.symbols) ? input.symbols.map(String) : [];
        const refs = wanted.map(resolve).filter((r): r is NodeRef => !!r);
        const fresh = refs.filter((r, i) => !cards.has(r.id) && refs.findIndex((o) => o.id === r.id) === i);
        const take = fresh.slice(0, Math.max(0, MAX_ADD - added.length));
        if (!take.length) return !refs.length ? `None of those are symbols in this project: ${wanted.join(", ")}` : fresh.length ? `Already added ${MAX_ADD} cards this message.` : "Those are already on the canvas.";
        for (const r of take) (added.push(r.id), cards.add(r.id));
        act({ kind: "add", ids: take.map((r) => r.id) }, `added ${take.map((r) => r.name).join(", ")}`);
        return `Added to the canvas: ${take.map((r) => r.name).join(", ")}.${fresh.length > take.length ? ` (${fresh.length - take.length} over the limit were left out.)` : ""}`;
      }
      case "build_flow": {
        const question = String(input.question ?? "").trim();
        if (!question) return "build_flow needs a question.";
        if (input.new_tab && !tabsAllowed) return "The user didn't ask for a new tab: build it on this canvas (new_tab false).";
        if (input.new_tab) return act({ kind: "tab", question }, `opened a new tab for “${question}”`);
        if (!options.judge) return "build_flow isn't available here (no flow builder configured): use search, read and add_cards instead.";
        onEvent({ type: "tool", name: "build_flow", summary: `building a flow for “${question}”` });
        const plan = await askFlow(question, queries, options.judge);
        if (!plan.answered || !plan.cards.length) return `No flow for that: ${plan.message ?? "nothing matched"}.`;
        for (const c of plan.cards) if (!cards.has(c.id)) (added.push(c.id), cards.add(c.id));
        act({ kind: "plan", plan }, `built a flow for “${question}”`);
        return `Built a flow of ${plan.cards.length} cards (in reading order): ${plan.cards.map((c) => `${g.node(c.id)?.name ?? c.id} (${c.id}): ${c.note}`).join("; ")}.`;
      }
      case "expand": {
        const k = cardOf(input.card);
        if (!k) return `No card ${String(input.card)} on the canvas.`;
        // What's now on the canvas goes back to the model too: the card's
        // whole code, and what it leads to.
        const done = act({ kind: "expand", card: k }, `expanded ${nameOf(k)}`);
        return `${done}\n\n${(await contextFor({ seeds: [base(k)], hops: 1, budget: 3000 }, queries)).markdown}`;
      }
      case "open_fold":
      case "close_fold": {
        const k = cardOf(input.card);
        if (!k) return `No card ${String(input.card)} on the canvas.`;
        const r = foldOf(k, Number(input.line));
        if (!r) return `${nameOf(k)} has no fold starting on line ${String(input.line)}.`;
        const open = block.name === "open_fold";
        const done = act({ kind: "fold", card: k, start: r.start, end: r.end, open }, `${open ? "opened" : "closed"} lines ${r.start}–${r.end} of ${nameOf(k)}`);
        if (!open) return done;
        // The lines it revealed, so the model can read what it opened.
        const file = g.node(base(k))?.loc?.file;
        const source = file ? (queries.linesOf(file) ?? []) : [];
        const shown = source.slice(r.start - 1, Math.min(r.end, r.start + 149)).map((l, i) => `${String(r.start + i).padStart(4)}  ${l}`);
        return `${done}\n\n\`\`\`\n${shown.join("\n")}${r.end > r.start + 149 ? `\n… (${r.end - r.start - 149} more lines: read the symbol for them)` : ""}\n\`\`\``;
      }
      case "close_cards": {
        const { found, missing } = cardsOf(input.cards);
        if (!found.length) return `None of those are on the canvas: ${missing.join(", ")}`;
        for (const k of found) cards.delete(k);
        return act({ kind: "close", cards: found }, `closed ${found.map(nameOf).join(", ")}`) + (missing.length ? ` (Not on the canvas: ${missing.join(", ")}.)` : "");
      }
      case "select":
      case "focus": {
        const { found, missing } = cardsOf(input.cards);
        if (!found.length) return `None of those are on the canvas: ${missing.join(", ")}`;
        return act({ kind: block.name, cards: found }, `${block.name === "select" ? "selected" : "focused on"} ${found.map(nameOf).join(", ")}`) + (missing.length ? ` (Not on the canvas: ${missing.join(", ")}.)` : "");
      }
      case "fit":
        return act({ kind: "fit" }, "fit the view to every card");
      case "show_changes": {
        const on = input.on !== false;
        const ref = String(input.base ?? "HEAD");
        return act({ kind: "changes", base: on ? ref : null }, on ? `showing changes since ${ref}` : "hid the changes");
      }
      case "open_tab": {
        if (!tabsAllowed) return "The user didn't ask for a new tab: work on this canvas instead.";
        const question = input.question ? String(input.question) : undefined;
        return act({ kind: "tab", ...(question && { question }) }, question ? `opened a new tab for “${question}”` : "opened a new tab");
      }
    }
    return `Unknown tool ${block.name}.`;
  };

  const messages: ChatMessage[] = request.messages.slice(-16).map((m) => ({ role: m.role, content: m.text }));
  let text = "";
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let streamed = false;
    const turn = await model.chat({
      system: [SYSTEM, about],
      messages,
      tools: round < MAX_ROUNDS - 1 ? tools : [], // the last round answers
      ...(request.model && { model: request.model }),
      onText: (delta) => {
        streamed = true;
        text += delta;
        onEvent({ type: "text", text: delta });
      },
      signal: options.signal,
    });
    // A model that doesn't stream: its text comes with the turn.
    if (!streamed) {
      const said = turn.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      if (said) {
        text += said;
        onEvent({ type: "text", text: said });
      }
    }
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
  return { text: text.trim(), added, actions, tools: toolCount, ms: Date.now() - started };
}
