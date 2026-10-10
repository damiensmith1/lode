import { askFlow, lexicalCandidates } from "../ask/index.js";
import type { Judge } from "../ask/judge.js";
import type { Queries } from "../query/index.js";
import type { CodeBlock, DiffHunk, LinkKind } from "../query/types.js";

// Context for a language model: the slice of the codebase that matters for
// something, formatted compactly. Where the slice starts (seeds) comes from
// symbols you name, your canvas, git changes, or a question; it grows a few
// hops along the graph; then a token budget decides how much of each piece
// goes in: full code at the centre (unrelated folds collapsed), the
// signature and connecting line one hop out, names further out, and the
// connections spelled out as edges.
//
// Deterministic by default (rank "graph": same commit and request, same
// output). rank "judge" lets a Judge (Jev) pick a question's seeds and
// steps, or score what a change puts at risk.

export interface ContextRequest {
  seeds?: string[]; // node ids (or files)
  question?: string;
  changes?: string | true; // git ref (true: HEAD): changed symbols and what depends on them
  canvas?: { cards: { id: string; note?: string; range?: [number, number] }[]; arrows?: { from: string; to: string; line: number; kind?: string }[] };
  hops?: number; // how far out from the seeds (default 1; 2 for changes)
  direction?: "down" | "up" | "both"; // follow calls, callers, or both (default: both; up for changes)
  budget?: number; // tokens, about (default 8000)
  rank?: "graph" | "judge";
}

export interface ContextItem {
  id: string;
  name: string;
  kind: string;
  file?: string;
  line?: number;
  endLine?: number;
  distance: number; // hops from a seed
  detail: "full" | "signature" | "name";
  via?: string; // how it connects: "called from addTab: `…`"
  note?: string;
  text: string; // what went into the markdown for it
}

export interface ContextResult {
  title: string;
  markdown: string;
  items: ContextItem[];
  edges: { from: string; to: string; line: number; kind: LinkKind | string }[];
  tokens: number;
  dropped: number; // items left out for the budget
}

const tokensOf = (text: string) => Math.ceil(text.length / 4);

export async function contextFor(request: ContextRequest, queries: Queries, judge?: Judge): Promise<ContextResult> {
  const g = queries.graph();
  const budget = request.budget ?? 8000;
  const rank = request.rank ?? "graph";
  const blocks = new Map<string, CodeBlock | null>();
  const blockOf = (id: string) => {
    if (!blocks.has(id)) blocks.set(id, queries.block(id));
    return blocks.get(id)!;
  };
  const lines = new Map<string, string[] | null>();
  const lineAt = (file: string | undefined, line: number | undefined) => {
    if (!file || !line) return "";
    if (!lines.has(file)) lines.set(file, queries.linesOf(file));
    return (lines.get(file)?.[line - 1] ?? "").trim().slice(0, 160);
  };

  // --- seeds ------------------------------------------------------------------
  const seeds: { id: string; note?: string; range?: [number, number] }[] = [];
  let title = "";
  let hunksByFile = new Map<string, DiffHunk[]>();
  let direction = request.direction ?? "both";
  let hops = request.hops ?? 1;
  const edges: ContextResult["edges"] = [];

  if (request.canvas) {
    title = "the cards on a lode canvas";
    seeds.push(...request.canvas.cards);
    for (const a of request.canvas.arrows ?? []) edges.push({ from: a.from, to: a.to, line: a.line, kind: a.kind ?? "calls" });
    hops = request.hops ?? 0;
  }
  if (request.seeds?.length) {
    title ||= request.seeds.map((id) => g.node(id)?.name ?? id).join(", ");
    for (const id of request.seeds) seeds.push({ id });
  }
  if (request.changes) {
    const base = request.changes === true ? "HEAD" : request.changes;
    const changes = await queries.changes(base);
    if (changes.error) throw new Error(changes.error);
    hunksByFile = new Map(changes.files.map((f) => [f.file, f.hunks]));
    title ||= `the changes since ${base}`;
    direction = request.direction ?? "up";
    hops = request.hops ?? 2;
    if (rank === "judge" && judge) {
      const plan = await askFlow("what most likely breaks from these changes", queries, judge, { route: "breakage", base });
      for (const c of plan.cards) seeds.push({ id: c.id, note: c.note });
      hops = request.hops ?? 0; // the judge already chose what's at risk
    } else {
      for (const f of changes.files) for (const s of f.symbols) if (s.added || s.removed) seeds.push({ id: s.node.id, note: `changed · +${s.added} −${s.removed}` });
    }
  }
  if (request.question) {
    title ||= request.question;
    if (rank === "judge" && judge) {
      const plan = await askFlow(request.question, queries, judge);
      for (const c of plan.cards) seeds.push({ id: c.id, note: c.note });
      hops = request.hops ?? 1; // the flow's cards in full, their neighbours as signatures
      direction = request.direction ?? "down";
    } else {
      for (const n of lexicalCandidates(request.question, queries, 3)) seeds.push({ id: n.id, note: "matches the question" });
      direction = request.direction ?? "down";
    }
  }

  // --- grow along the graph -------------------------------------------------------
  // Breadth first from the seeds; each item remembers how it was reached.
  const found = new Map<string, { distance: number; via?: string; note?: string; range?: [number, number] }>();
  for (const s of seeds) if (!found.has(s.id) && blockOf(baseId(s.id))) found.set(s.id, { distance: 0, note: s.note, range: s.range });
  let frontier = [...found.keys()];
  for (let hop = 1; hop <= hops && frontier.length; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      const block = blockOf(baseId(id));
      if (!block) continue;
      if (direction !== "up") {
        for (const l of block.links) {
          if (l.target.external || l.label === "read by" || found.has(l.target.id) || !g.node(l.target.id) || l.target.id === l.target.file) continue;
          // State it writes: module-level state, not some class's fields.
          if (l.kind === "state" && g.node(l.target.id)!.parent !== l.target.file) continue;
          found.set(l.target.id, { distance: hop, via: `called from ${block.node.name}: \`${lineAt(block.node.file, l.line)}\`` });
          edges.push({ from: id, to: l.target.id, line: l.line, kind: l.kind });
          next.push(l.target.id);
        }
      }
      if (direction !== "down") {
        const users = [...block.callers.map((c) => ({ node: c.node, line: c.line, kind: c.kind as string })), ...block.links.filter((l) => l.label === "read by").map((l) => ({ node: l.target, line: l.target.line ?? 0, kind: "state" }))];
        for (const u of users) {
          if (u.node.external || found.has(u.node.id) || inside(u.node.id, block.node.id)) continue;
          found.set(u.node.id, { distance: hop, via: `uses ${block.node.name}: \`${lineAt(u.node.file, u.line)}\`` });
          edges.push({ from: u.node.id, to: id, line: u.line, kind: u.kind });
          next.push(u.node.id);
        }
      }
    }
    frontier = next;
  }
  // Edges between seeds too (the canvas brings its own).
  if (!request.canvas) {
    const ids = new Set(found.keys());
    for (const id of found.keys()) {
      const block = blockOf(baseId(id));
      for (const l of block?.links ?? []) if (ids.has(l.target.id) && !edges.some((e) => e.from === id && e.to === l.target.id)) edges.push({ from: id, to: l.target.id, line: l.line, kind: l.kind });
    }
  }

  // --- rank and fit the budget -------------------------------------------------------
  // Seeds in their order, then by distance, then by how connected each is
  // to the rest of the slice.
  // Utilities (called from many places, or one- or two-letter names like
  // `$`) go last: they rarely explain anything.
  const degree = (id: string) => edges.filter((e) => e.from === id || e.to === id).length;
  const generic = (id: string) => {
    const n = g.node(baseId(id));
    return !!n && (n.name.length <= 2 || g.neighbors(n.id, "up").filter((e) => e.kind === "calls").length >= 12);
  };
  const order = [...found.entries()].map(([id, f], i) => ({ id, ...f, i }));
  // Test code after the code it tests (unless the question is about tests).
  const testy = (id: string) => !/\btests?\b|spec/i.test(request.question ?? "") && isTest(g.node(baseId(id))?.loc?.file ?? baseId(id));
  order.sort((a, b) => a.distance - b.distance || (a.distance === 0 ? a.i - b.i : Number(testy(a.id)) - Number(testy(b.id)) || Number(generic(a.id)) - Number(generic(b.id)) || degree(b.id) - degree(a.id)));

  const items: ContextItem[] = [];
  const changed = hunksByFile.size > 0;
  // The header's fixed part now; each connection is paid for when both its
  // ends are in (a listing of every candidate's edges could fill the budget
  // on its own).
  let used = tokensOf(header(title, 0, [], g, changed)) + 40;
  const placedIds = new Set<string>();
  const edgeCost = (id: string) => edges.filter((e) => (e.from === id && placedIds.has(e.to)) || (e.to === id && placedIds.has(e.from))).length * 12;
  let dropped = 0;
  for (const o of order) {
    const block = blockOf(baseId(o.id));
    if (!block) continue;
    const n = block.node;
    const want: ContextItem["detail"] = o.distance === 0 ? "full" : o.distance === 1 ? "signature" : "name";
    const levels: ContextItem["detail"][] = want === "full" ? ["full", "signature", "name"] : want === "signature" ? ["signature", "name"] : ["name"];
    let placed = false;
    for (const detail of levels) {
      const text = render(detail, block, o.range, o.via, hunksByFile.get(n.file ?? "") ?? []);
      const cost = tokensOf(text) + edgeCost(o.id);
      if (used + cost > budget) continue;
      used += cost;
      placedIds.add(o.id);
      items.push({ id: o.id, name: n.name, kind: n.kind, file: n.file, line: n.line, endLine: n.endLine, distance: o.distance, detail, ...(o.via && { via: o.via }), ...(o.note && { note: o.note }), text });
      placed = true;
      break;
    }
    if (!placed) dropped++;
  }

  const kept = new Set(items.map((i) => i.id));
  const shownEdges = edges.filter((e) => kept.has(e.from) && kept.has(e.to));
  const markdown = [
    header(title, items.length, shownEdges, g, changed),
    ...section("Code", items.filter((i) => i.detail === "full")),
    ...section("Nearby", items.filter((i) => i.detail === "signature")),
    ...section("Also related", items.filter((i) => i.detail === "name")),
    ...(dropped ? ["", `_${dropped} more left out to fit the budget._`] : []),
  ].join("\n");
  return { title, markdown, items, edges: shownEdges, tokens: tokensOf(markdown), dropped };

  function inside(id: string, ancestor: string) {
    for (let n = g.node(id); n; n = n.parent ? g.node(n.parent) : undefined) if (n.id === ancestor) return true;
    return false;
  }

  // One item at a level of detail: full code (folds collapsed unless they
  // hold something that connects or changed), a signature and how it
  // connects, or just a name and place.
  function render(detail: ContextItem["detail"], block: CodeBlock, range: [number, number] | undefined, via: string | undefined, hunks: DiffHunk[]): string {
    const n = block.node;
    const where = `${n.file ?? ""}${n.line ? `:${n.line}` : ""}`;
    const kind = n.kind === "callable" ? "function" : n.kind;
    if (detail === "name") return `- \`${n.name}\` (${kind}) ${where}${via ? ` · ${via.split(":")[0]}` : ""}`;
    const first = block.lines[0]?.n ?? 1;
    if (detail === "signature") {
      const sig: string[] = [];
      for (const l of block.lines) {
        sig.push(l.text.trimEnd());
        if (/[{=]\s*$|\)\s*:?[^,]*$/.test(l.text) || sig.length >= 3) break;
      }
      return `- \`${sig.join(" ").replace(/\s+/g, " ").replace(/\{\s*$/, "").trim()}\` — ${where}${via ? `\n  ${via}` : ""}`;
    }
    const [from, to] = range ?? [first, block.lines[block.lines.length - 1]?.n ?? first];
    const added = new Set<number>();
    const removedAt = new Map<number, string[]>();
    for (const h of hunks) {
      for (let l = h.start; l < h.start + h.added; l++) added.add(l);
      if (h.removed.length) removedAt.set(h.added ? h.start : h.start + 1, h.removed);
    }
    const keepOpen = (start: number, end: number) => {
      for (let l = start; l <= end; l++) if (added.has(l) || removedAt.has(l)) return true;
      return false;
    };
    // Outermost folds inside the range, collapsed unless they hold changes.
    const folds = block.regions
      .filter((r) => r.start >= from && r.end <= to && !(r.start <= from && r.end >= to) && r.end - r.start > 3)
      .filter((r, _, all) => !all.some((o) => o !== r && o.start <= r.start && o.end >= r.end && !(o.start === r.start && o.end === r.end)))
      .filter((r) => !keepOpen(r.start + 1, r.end));
    const changedLines = added.size > 0 || removedAt.size > 0;
    const hidden = new Map<number, number>(); // fold start → end
    for (const f of folds) hidden.set(f.start, f.end);
    const out: string[] = [];
    const width = String(to).length;
    for (let l = from; l <= to; l++) {
      for (const r of removedAt.get(l) ?? []) out.push(`${" ".repeat(width)} - ${r}`);
      const text = block.lines[l - first]?.text ?? "";
      const mark = changedLines ? (added.has(l) ? "+ " : "  ") : "";
      const fold = hidden.get(l);
      out.push(`${String(l).padStart(width)} ${mark}${text}${fold ? ` ⋯ ${fold - l} lines` : ""}`);
      if (fold) l = fold;
    }
    const lang = /\.(m?tsx?|cts)$/.test(n.file ?? "") ? "ts" : /\.(m?jsx?|cjs)$/.test(n.file ?? "") ? "js" : (n.file ?? "").split(".").pop() ?? "";
    return [`### ${n.name} — ${where}${n.endLine && n.endLine !== n.line ? `-${n.endLine}` : ""} (${kind})`, ...(via ? [`_${via}_`] : []), "```" + lang, ...out, "```"].join("\n");
  }
}

// Test files: test/, tests/, __tests__/, spec/, *.test.*, *.spec.*.
export function isTest(file: string): boolean {
  return /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[a-z]+$/i.test(file);
}

// A fragment card's key (node@start-end) names its node.
function baseId(id: string): string {
  return id.replace(/@\d+-\d+$/, "");
}

function header(title: string, count: number, edges: ContextResult["edges"], g: ReturnType<Queries["graph"]>, changed: boolean): string {
  const name = (id: string) => g.node(baseId(id))?.name ?? baseId(id);
  const verb = (k: string) => (k === "channel" ? "sends to" : k === "state" ? "shares state with" : "calls");
  return [
    `# Context: ${title}`,
    "",
    `${count} piece${count === 1 ? "" : "s"} of code, chosen from lode's graph. ⋯ marks folded lines${changed ? "; lines marked + were added and - removed by the changes" : ""}.`,
    ...(edges.length ? ["", "How they connect:", ...edges.map((e) => `- ${name(e.from)} ${verb(String(e.kind))} ${name(e.to)} (line ${e.line})`)] : []),
  ].join("\n");
}

function section(heading: string, items: ContextItem[]): string[] {
  if (!items.length) return [];
  return ["", `## ${heading}`, ...items.map((i) => (i.note && i.detail === "full" ? i.text.replace(/\n/, `\n> ${i.note}\n`) : i.text))];
}
