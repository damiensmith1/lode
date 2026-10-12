import type { CanvasAction } from "../explain/index.js";
import type { FlowPlan } from "../query/types.js";
import { lodeTools, type Tool } from "./index.js";

// Tools for an agent to see and draw on a host's lode canvases (its flow
// views), for hosts to mount on their own MCP server: Clance gives its
// Claude sessions these. lode only defines them and checks what's asked;
// the canvases are the host's, reached through a CanvasHost. Each tool's
// `canvas` is a canvas id from lode_canvases; without one, the host's
// default (the one in front, say). The graph tools (lodeTools) come along,
// each on the project of the canvas it's given.
//
//   const tools = canvasTools(host);
//   for (const t of tools) server.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema }, (args) => t.run(args));

export interface CanvasInfo {
  canvas: string; // the id the other tools take
  label: string;
  folder: string; // its project
  cards: number;
  question?: string; // the question it was built for
  showing: boolean; // visible
  focused: boolean; // the one in front
}

export interface CanvasHost {
  // The open canvases.
  list(): Promise<CanvasInfo[]>;
  // The default when a tool isn't given one (the one in front, say).
  default?(all: CanvasInfo[]): CanvasInfo | undefined;
  // One canvas's cards, as context (flow.context) and as a list.
  read(canvas: string, budget: number): Promise<{ markdown: string; cards: { name: string; selected: boolean; note?: boolean }[]; question?: string }>;
  // Do these to it (flow.apply, one undo step), and say what's on it now.
  apply(canvas: string, actions: CanvasAction[]): Promise<{ cards: string[] }>;
  // The project's lode for a canvas (the service, or anything with call).
  service(canvas: string): { call(method: string, params?: Record<string, unknown>): Promise<unknown> };
}

const canvasProp = { type: "string", description: "A canvas id, from lode_canvases (default: the one in front)" };
const cardsProp = { type: "array", items: { type: "string" }, description: "Cards on the canvas, by name (Journal.post, a note's title) or id" };
const MAX_ADD = 12; // cards one call may add

export function canvasTools(host: CanvasHost): Tool[] {
  const pick = async (canvas: unknown): Promise<CanvasInfo> => {
    const all = await host.list();
    if (!all.length) throw new Error("No lode canvas is open.");
    if (canvas) {
      const hit = all.find((c) => c.canvas === canvas);
      if (!hit) throw new Error(`No canvas ${String(canvas)}; lode_canvases lists them.`);
      return hit;
    }
    return host.default?.(all) ?? all.find((c) => c.focused) ?? all.find((c) => c.showing) ?? all[0];
  };
  const apply = async (canvas: unknown, actions: CanvasAction[]) => {
    const c = await pick(canvas);
    const r = await host.apply(c.canvas, actions);
    return `${c.canvas} now has ${r.cards.length} card${r.cards.length === 1 ? "" : "s"}: ${r.cards.join(", ")}`;
  };
  // A symbol by id ("src/a.ts#run", a file) or by name ("run").
  const resolve = async (canvas: string, symbol: string): Promise<string | null> => {
    const s = symbol.trim();
    if (!s) return null;
    if (s.includes("#") || /\.[a-z]+$/i.test(s)) return s;
    const found = (await host.service(canvas).call("search", { query: s })) as { id: string; name: string }[];
    return (found.find((n) => n.name === s) ?? found[0])?.id ?? null;
  };
  const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

  const tools: Tool[] = [
    {
      name: "lode_canvases",
      description: "List the open lode canvases: code read as cards, linked by what calls what. Each has an id (pass it as `canvas` to the other lode tools), its project folder, how many cards, the question it was built for, and whether it's the one in front.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        const all = await host.list();
        if (!all.length) return "No lode canvases are open.";
        return all.map((c) => `${c.canvas} — ${c.label} · ${c.cards} card${c.cards === 1 ? "" : "s"} · ${c.folder}${c.question ? ` · built for "${c.question}"` : ""}${c.focused ? " · in front" : c.showing ? " · showing" : ""}`).join("\n");
      },
    },
    {
      name: "lode_canvas",
      description: 'What\'s on a lode canvas: its cards\' code (the selected ones first, when several are), how they connect, any git changes shown, notes drawn on it, and the question it was built for. Call it before answering about "this flow", "these cards", "what I\'m looking at".',
      inputSchema: { type: "object", properties: { canvas: canvasProp, budget: { type: "number", description: "About how many tokens (default 12000)" } } },
      run: async (args) => {
        const c = await pick(args.canvas);
        const r = await host.read(c.canvas, Number(args.budget) > 0 ? Number(args.budget) : 12_000);
        if (!r.cards.length) return `${c.canvas} (${c.label}) is empty: lode_show, lode_build_flow or lode_diagram put cards on it.`;
        const header = [`Canvas ${c.canvas} — ${c.label}, in ${c.folder}${r.question ? `, built for "${r.question}"` : ""}.`, `Cards: ${r.cards.map((k) => `${k.name}${k.note ? " (note)" : ""}${k.selected ? " (selected)" : ""}`).join(", ")}`].join("\n");
        return `${header}\n\n${r.markdown}`;
      },
    },
    {
      name: "lode_show",
      description: "Put code on a lode canvas as cards (functions, classes, files), beside what's there, linked where they call each other. By id or name; lode_search finds them.",
      inputSchema: { type: "object", properties: { canvas: canvasProp, symbols: { type: "array", items: { type: "string" }, description: "Symbol ids (src/a.ts#run) or names (run)" } }, required: ["symbols"] },
      run: async (args) => {
        const c = await pick(args.canvas);
        const asked = strings(args.symbols).slice(0, MAX_ADD);
        const ids = (await Promise.all(asked.map((s) => resolve(c.canvas, s)))).filter((id): id is string => !!id);
        if (!ids.length) throw new Error(`None of ${asked.join(", ")} is a symbol in ${c.folder}; try lode_search.`);
        return apply(c.canvas, [{ kind: "add", ids }]);
      },
    },
    {
      name: "lode_build_flow",
      description: 'Build the flow that answers a question ("how is a transfer posted?") and lay it out on a lode canvas: where to start and each step after, as linked cards with a note on why each is there. mode "pass" (default: quick) or "crawl" (reads more of the project; slower).',
      inputSchema: { type: "object", properties: { canvas: canvasProp, question: { type: "string", description: "What the flow should show" }, mode: { type: "string", enum: ["pass", "crawl"], description: "How lode finds it" } }, required: ["question"] },
      run: async (args) => {
        const c = await pick(args.canvas);
        const plan = (await host.service(c.canvas).call("ask", { question: String(args.question ?? ""), ...(args.mode === "pass" || args.mode === "crawl" ? { mode: args.mode } : {}) })) as FlowPlan;
        if (!plan.answered || !plan.cards.length) throw new Error(`lode couldn't build a flow for that: ${plan.message ?? "nothing found"}`);
        return apply(c.canvas, [{ kind: "plan", plan }]);
      },
    },
    {
      name: "lode_note",
      description: "Put a note on a lode canvas: a card with a title and Markdown text, for what code can't show (a component of a design, a step in an explanation, a caveat). Give it an id to link to it or replace it later; `near` puts it beside a card.",
      inputSchema: { type: "object", properties: { canvas: canvasProp, title: { type: "string" }, text: { type: "string", description: "Markdown" }, id: { type: "string", description: "Names it, for lode_link (and replaces the note with this id)" }, near: { type: "string", description: "A card to put it beside" } }, required: ["title", "text"] },
      run: async (args) => apply(args.canvas, [{ kind: "note", title: String(args.title ?? ""), text: String(args.text ?? ""), ...(args.id ? { id: String(args.id) } : {}), ...(args.near ? { near: String(args.near) } : {}) }]),
    },
    {
      name: "lode_link",
      description: "Draw an arrow between two cards on a lode canvas (notes or code), with a label (\"calls\", \"reads\", \"sends events\").",
      inputSchema: { type: "object", properties: { canvas: canvasProp, from: { type: "string" }, to: { type: "string" }, label: { type: "string" } }, required: ["from", "to"] },
      run: async (args) => apply(args.canvas, [{ kind: "link", from: String(args.from ?? ""), to: String(args.to ?? ""), ...(args.label ? { label: String(args.label) } : {}) }]),
    },
    {
      name: "lode_diagram",
      description: "Draw a diagram on a lode canvas: notes (boxes with a title and Markdown text) and labelled arrows, laid out left to right along the arrows, e.g. a system design or how the parts of a flow talk. Arrows may also point at cards already on the canvas (by name), tying the design to the real code.",
      inputSchema: {
        type: "object",
        properties: {
          canvas: canvasProp,
          notes: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, text: { type: "string" } }, required: ["id", "title", "text"] }, description: "The boxes" },
          links: { type: "array", items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, label: { type: "string" } }, required: ["from", "to"] }, description: "Arrows between notes (by id) or cards (by name)" },
        },
        required: ["notes"],
      },
      run: async (args) => {
        const notes = (Array.isArray(args.notes) ? args.notes : []).slice(0, 24).map((n: Record<string, unknown>) => ({ id: String(n.id ?? ""), title: String(n.title ?? ""), text: String(n.text ?? "") })).filter((n) => n.id && n.title);
        const links = (Array.isArray(args.links) ? args.links : []).map((l: Record<string, unknown>) => ({ from: String(l.from ?? ""), to: String(l.to ?? ""), ...(l.label ? { label: String(l.label) } : {}) }));
        if (!notes.length) throw new Error("A diagram needs notes (id, title, text).");
        return apply(args.canvas, [{ kind: "diagram", notes, links }]);
      },
    },
    ...([
      ["lode_expand", "Expand a card on a lode canvas: all its lines, and everything it leads to (what it calls, its methods) opened as cards beside it."],
      ["lode_close", "Close cards on a lode canvas."],
      ["lode_select", "Select cards on a lode canvas, to point the user at them (lode_canvas reads the selection first)."],
      ["lode_focus", "Move a lode canvas's view to these cards."],
    ] as const).map(([name, description]): Tool => ({
      name,
      description,
      inputSchema: { type: "object", properties: { canvas: canvasProp, cards: cardsProp }, required: ["cards"] },
      run: async (args) => {
        const cards = strings(args.cards);
        const kind = name.slice("lode_".length) as "expand" | "close" | "select" | "focus";
        return apply(args.canvas, kind === "expand" ? cards.map((card) => ({ kind, card })) : [{ kind, cards }]);
      },
    })),
    {
      name: "lode_changes_shown",
      description: "Show or hide git changes on a lode canvas's cards: added and changed lines marked, removed ones struck through.",
      inputSchema: { type: "object", properties: { canvas: canvasProp, base: { type: ["string", "null"], description: "A git ref (HEAD: uncommitted changes), or null to hide them" } } },
      run: async (args) => apply(args.canvas, [{ kind: "changes", base: args.base === null ? null : String(args.base ?? "HEAD") }]),
    },
  ];

  // The graph, on a canvas's project: lodeTools, each given `canvas`.
  const describing = lodeTools({ call: async () => null } as never);
  for (const t of describing) {
    tools.push({
      name: t.name,
      description: `${t.description} On the project of a lode canvas (\`canvas\`, default the one in front).`,
      inputSchema: { ...t.inputSchema, properties: { ...((t.inputSchema.properties as Record<string, unknown>) ?? {}), canvas: canvasProp } },
      run: async (args) => {
        const c = await pick(args.canvas);
        return lodeTools(host.service(c.canvas) as never).find((x) => x.name === t.name)!.run(args);
      },
    });
  }
  return tools;
}
