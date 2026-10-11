import { stemmer as porter } from "stemmer";
import type { Node } from "../schema/index.js";
import type { Queries } from "../query/index.js";
import type { FlowPlan, FlowRoute, NodeRef } from "../query/types.js";
import type { Judge, JudgeAnswer, JudgeQuestion } from "./judge.js";

// Building a flow for a question ("show me how we create the tabs", "what
// most likely breaks from these changes"). Code owns the workflow and the
// graph supplies every candidate; the judge (Jev by default) only makes
// narrow typed judgments about them: what kind of question it is, where to
// start, whether each next step belongs. Notes are written by code from
// facts and those scores. See docs/design.md, "Asking for a flow".

export interface AskOptions {
  route?: FlowRoute; // skip routing: treat the question as this kind
  budget?: number; // most cards in a flow (default 12)
  hops?: number; // how far to follow from the start (default 2)
  base?: string; // git ref for change questions (default HEAD)
}

const ROUTES: Record<FlowRoute, string> = {
  how: "How something works or gets done in the code (a feature, a process, a behaviour)",
  breakage: "What could break, or what is affected, because of the current code changes",
  changes: "What the current code changes are, or a walk through them",
  callers: "What uses, calls or depends on a specific thing",
  where: "Where something is defined, handled or configured",
  other: "None of these: not a question about this code",
};

// English function words: in a small project's comments "the" can be rare
// enough to look meaningful. Only grammar: no words about code or intent.
const FUNCTION_WORDS = new Set(
  "the a an and or but of to in on at by for with from into onto as is are was were be been being am do does did doing has have had having it its this that these those there here what which who whom whose when where why how than then so if not no nor can could would should will shall may might must me my we our us you your he she they them their i".split(" "),
);

// Symbols a question is about, by its words, over everything about each
// symbol: its name, path, doc comment and code (BM25: a word counts more
// the rarer it is in the project). A symbol the question names
// exactly ("validate_postings", "showAll") comes first. Classes, functions,
// methods and top-level values; not files, nor what's nested in a function.
// Deterministic; the first step of asking (Jev judges these), and a
// question's seeds when no model is used.
export function lexicalCandidates(question: string, queries: Queries, limit = 40): NodeRef[] {
  const g = queries.graph();
  const index = indexOf(queries);
  // Each word, or if the code never uses it (a typo: "balence",
  // "tempaltes"), the code's words it's a slip of, counting a little less.
  const words = [...new Set(tokens(question).filter((w) => !FUNCTION_WORDS.has(w)).map(stem))].flatMap((w) => (index.df.has(w) ? [{ w, weight: 1 }] : nearWords(w, index).map((n) => ({ w: n, weight: 0.8 }))));
  const named = new Set((question.match(/[A-Za-z_$][\w$?!]*/g) ?? []).filter((w) => /[a-z][A-Z]|[_$\d]|[?!]$/.test(w)));
  const scored: { node: Node; score: number }[] = [];
  for (const doc of index.docs) {
    let score = named.has(doc.node.name) && doc.node.name.length > 2 ? 1000 : 0;
    for (const { w, weight } of words) {
      const f = doc.tf.get(w);
      if (!f) continue;
      const df = index.df.get(w)!;
      score += weight * Math.log(1 + (index.docs.length - df + 0.5) / (df + 0.5)) * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (doc.length / index.avg))));
    }
    if (score > 0) scored.push({ node: doc.node, score });
  }
  scored.sort((a, b) => b.score - a.score || a.node.id.length - b.node.id.length);
  return scored.slice(0, limit).map((s) => queries.ref(s.node));
}

// The code's words within one edit of `word` (two for a long word; a
// swapped pair of letters is one edit), at most a few, the commonest first.
// Short words are left alone: "wrk" is too close to too much.
function nearWords(word: string, index: WordIndex): string[] {
  const max = word.length >= 8 ? 2 : word.length >= 4 ? 1 : 0;
  if (!max) return [];
  const near: string[] = [];
  for (const term of index.df.keys()) if (Math.abs(term.length - word.length) <= max && term.length >= 3 && edits(word, term, max) <= max) near.push(term);
  return near.sort((a, b) => index.df.get(b)! - index.df.get(a)!).slice(0, 3);
}

// Edit distance with transpositions (optimal string alignment), giving up
// past `max`.
function edits(a: string, b: string, max: number): number {
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      row.push(d);
      best = Math.min(best, d);
    }
    if (best > max) return best;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

interface WordIndex {
  docs: { node: Node; tf: Map<string, number>; length: number }[];
  df: Map<string, number>;
  avg: number;
}

// Built once per graph (a new graph after an update gets a new one).
const indexes = new WeakMap<object, WordIndex>();

function indexOf(queries: Queries): WordIndex {
  const g = queries.graph();
  const hit = indexes.get(g);
  if (hit) return hit;
  const nested = (n: Node) => {
    for (let p = n.parent ? g.node(n.parent) : undefined; p; p = p.parent ? g.node(p.parent) : undefined) if (p.kind === "callable") return true;
    return false;
  };
  const docs: WordIndex["docs"] = [];
  for (const n of g.allNodes()) {
    if (n.external || !n.loc || n.kind === "block" || n.id === n.loc.file || nested(n)) continue;
    // A class's fields aren't where to start; its class or methods are.
    if (n.kind === "value" && n.parent && n.parent !== n.loc.file) continue;
    const tf = new Map<string, number>();
    for (const w of tokens(symbolText(queries, n, n.kind === "callable" ? 80 : 20)).map(stem)) tf.set(w, (tf.get(w) ?? 0) + 1);
    // The name counts most: it's what the symbol is (once in its code, three more times here).
    for (const w of tokens(n.name).map(stem)) tf.set(w, (tf.get(w) ?? 0) + 3);
    docs.push({ node: n, tf, length: [...tf.values()].reduce((a, b) => a + b, 0) });
  }
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const index = { docs, df, avg: docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length) };
  indexes.set(g, index);
  return index;
}

// A symbol as text: its path, the comment above it, and its first `lines`
// lines of code.
function symbolText(queries: Queries, n: Node, lines: number): string {
  const source = queries.linesOf(n.loc!.file) ?? [];
  let from = n.loc!.line - 1;
  while (from > 0 && /^\s*(#|\/\/|\*|\/\*)/.test(source[from - 1] ?? "")) from--;
  const to = Math.min(n.loc!.endLine ?? n.loc!.line, n.loc!.line - 1 + lines);
  return [n.loc!.file, ...source.slice(from, to)].join("\n");
}

export async function askFlow(question: string, queries: Queries, judge: Judge, options: AskOptions = {}): Promise<FlowPlan> {
  const started = Date.now();
  const budget = options.budget ?? 12;
  let requests = 0;
  const ask = (state: unknown, questions: Record<string, JudgeQuestion>) => (requests++, judge.ask(state, questions));
  const g = queries.graph();
  const lines = new Map<string, string[] | null>();
  const lineAt = (file: string | undefined, line: number | undefined) => {
    if (!file || !line) return "";
    if (!lines.has(file)) lines.set(file, queries.linesOf(file));
    return (lines.get(file)?.[line - 1] ?? "").trim().slice(0, 140);
  };
  const describe = (n: { id: string; name: string; kind: string; file?: string; line?: number }) =>
    `${n.name} (${n.kind === "callable" ? "function" : n.kind}) ${n.file ?? ""}${n.line ? `:${n.line}` : ""} — ${lineAt(n.file, n.line)}`;
  const done = (route: FlowRoute, cards: FlowPlan["cards"], message?: string): FlowPlan => ({
    question,
    route,
    answered: cards.length > 0,
    ...(message && { message }),
    cards,
    requests,
    ms: Date.now() - started,
  });

  const shortlist = lexicalCandidates(question, queries, 40);
  const ids = shortlist.map((_, i) => `S${i + 1}`);
  const candidate = (n: NodeRef) => {
    const text = symbolText(queries, g.node(n.id)!, 8).split("\n").slice(1).map((l) => l.trim()).filter(Boolean).join(" ⏎ ");
    return `${n.name} (${n.kind === "callable" ? "function" : n.kind}) ${n.id} — ${text.slice(0, 400)}`;
  };

  // 2. Route + start, in one request (speculative: the start questions are
  // used only for routes that need them).
  const first = await ask(
    { question, candidates: shortlist.map((n, i) => `${ids[i]}| ${candidate(n)}`) },
    {
      route: { type: "choice", instructions: "What kind of question is `question`, about this codebase?", criteria: ROUTES },
      ...(shortlist.length && {
        start: { type: "choice", instructions: "Which candidate is the best place to start answering `question`?", criteria: Object.fromEntries(ids.map((id) => [id, null])) },
        answerable: {
          type: "noul",
          instructions: "Is any candidate directly about what `question` asks?",
          criteria: { true: "At least one candidate is a piece of code that does or defines what the question is about", false: "None of the candidates is about it; they only share words" },
        },
      }),
      ...Object.fromEntries(
        shortlist.map((_, i) => [
          `rel${i}`,
          {
            type: "noul",
            instructions: `Is \`candidates[${i}]\` directly part of what \`question\` asks about?`,
            criteria: { true: "It does or defines the thing the question is about", false: "It is unrelated, or only shares a word with the question" },
          } satisfies JudgeQuestion,
        ]),
      ),
    },
  );
  const route = options.route ?? ((first.route as Extract<JudgeAnswer, { type: "choice" }>).choice as FlowRoute);

  if (route === "breakage" || route === "changes") return done(route, await changesFlow(route), undefined);
  if (route === "other") return done(route, [], "That doesn't look like a question about this code.");
  if (!shortlist.length) return done(route, [], "Nothing in the code matches those words.");

  const relevance = new Map(shortlist.map((n, i) => [n.id, (first[`rel${i}`] as Extract<JudgeAnswer, { type: "noul" }>).noul]));
  const startChoice = first.start as Extract<JudgeAnswer, { type: "choice" }>;
  const answerable = (first.answerable as Extract<JudgeAnswer, { type: "noul" }>).noul;
  const best = [...relevance.entries()].sort((a, b) => b[1] - a[1]);
  if (answerable < 0.3 && (best[0]?.[1] ?? 0) < 0.5) return done(route, [], "Nothing in the code seems to be about that.");

  // Starts: the chosen one, plus clearly relevant others (up to three).
  const startId = shortlist[ids.indexOf(startChoice.choice)]?.id;
  const starts = [...new Set([startId, ...best.filter(([, p]) => p >= 0.6).map(([id]) => id)].filter(Boolean) as string[])].slice(0, 3);
  const kept = new Map<string, { note: string; score?: number; step: number }>();
  for (const id of starts) {
    const p = relevance.get(id);
    kept.set(id, { note: id === startId ? `start here${p !== undefined ? ` · relevance ${pct(p)}` : ""}` : `relevant · ${pct(p ?? 0)}`, step: 0, ...(p !== undefined && { score: p }) });
  }

  // A utility (called from many places, or a one- or two-letter name like
  // `$`) isn't a step of anything in particular: kept only if clearly so.
  const fanIn = (id: string) => g.neighbors(id, "up").filter((e) => e.kind === "calls").length;
  const generic = (node: NodeRef) => node.name.length <= 2 || fanIn(node.id) >= 12;

  // 3. Follow: callees for "how" / "where", callers for "callers". Each hop
  // is one request: a noul per next symbol, kept above a threshold.
  const direction = route === "callers" ? "up" : "down";
  let frontier = starts;
  for (let hop = 0; hop < (options.hops ?? (route === "where" ? 1 : 2)) && kept.size < budget && frontier.length; hop++) {
    const next = new Map<string, { node: NodeRef; via: string; line: string }>();
    for (const id of frontier) {
      const block = queries.block(id);
      if (!block) continue;
      const from = block.node.name;
      if (direction === "down") {
        for (const l of block.links) {
          if (l.target.external || kept.has(l.target.id) || next.has(l.target.id) || l.label === "read by") continue;
          const target = g.node(l.target.id);
          if (!target || target.id === target.loc?.file) continue;
          next.set(l.target.id, { node: l.target, via: from, line: lineAt(block.node.file, l.line) });
        }
      } else {
        for (const c of block.callers) {
          if (c.node.external || kept.has(c.node.id) || next.has(c.node.id)) continue;
          next.set(c.node.id, { node: c.node, via: from, line: lineAt(c.node.file, c.line) });
        }
      }
    }
    const candidates = [...next.values()].slice(0, 60);
    if (!candidates.length) break;
    const answers = await ask(
      {
        question,
        flow_so_far: [...kept.keys()].map((id) => g.node(id)?.name ?? id),
        next: candidates.map((c) => `${describe(c.node)} · ${direction === "down" ? `reached from ${c.via}` : `calls ${c.via}`}: ${c.line}`),
      },
      Object.fromEntries(
        candidates.map((_, i) => [
          `n${i}`,
          {
            type: "noul",
            instructions: `Does \`next[${i}]\` do a step of what \`question\` asks about, so it belongs in a walkthrough that answers it?`,
            criteria: { true: "It carries out part of the thing asked about", false: "A generic helper, logging, formatting, or a step unrelated to the question" },
          } satisfies JudgeQuestion,
        ]),
      ),
    );
    const ranked = candidates
      .map((c, i) => ({ c, p: (answers[`n${i}`] as Extract<JudgeAnswer, { type: "noul" }>).noul }))
      .filter((x) => x.p >= (generic(x.c.node) ? 0.9 : 0.6));
    ranked.sort((a, b) => b.p - a.p);
    frontier = [];
    for (const { c, p } of ranked) {
      if (kept.size >= budget) break;
      kept.set(c.node.id, { note: `${direction === "down" ? `from ${c.via}` : `calls ${c.via}`} · relevance ${pct(p)}`, score: p, step: hop + 1 });
      frontier.push(c.node.id);
    }
  }
  return done(route, [...kept].map(([id, k]) => ({ id, ...k })));

  // What changed, and (for breakage) what depends on it, scored for risk.
  async function changesFlow(kind: "breakage" | "changes"): Promise<FlowPlan["cards"]> {
    const result = await queries.changes(options.base ?? "HEAD");
    const changed = result.files.flatMap((f) => f.symbols.filter((s) => s.added || s.removed).map((s) => ({ s, f })));
    const changedCards = changed.map(({ s }) => ({ id: s.node.id, note: `changed · +${s.added} −${s.removed}`, step: 0 }));
    if (kind === "changes" || !changed.length) return changedCards.slice(0, budget);
    // Dependents: what calls or reads each changed symbol (outside it).
    const changedIds = new Set(changed.map(({ s }) => s.node.id));
    const dependents = new Map<string, { node: NodeRef; uses: string; line: string }>();
    for (const { s } of changed) {
      const block = queries.block(s.node.id);
      if (!block) continue;
      const users = [...block.callers.map((c) => ({ node: c.node, line: c.line })), ...block.links.filter((l) => l.label === "read by").map((l) => ({ node: l.target, line: 0 }))];
      const inside = (id: string) => {
        for (let n = g.node(id); n; n = n.parent ? g.node(n.parent) : undefined) if (n.id === s.node.id) return true;
        return false;
      };
      for (const u of users) {
        if (u.node.external || changedIds.has(u.node.id) || dependents.has(u.node.id) || inside(u.node.id)) continue;
        dependents.set(u.node.id, { node: u.node, uses: s.node.name, line: lineAt(u.node.file, u.line || u.node.line) });
      }
    }
    const list = [...dependents.values()].slice(0, 60);
    if (!list.length) return changedCards.slice(0, budget);
    // The changes themselves, briefly: each changed symbol's new lines.
    const diffs: Record<string, string> = {};
    for (const { s, f } of changed.slice(0, 20)) {
      const touched = f.hunks
        .flatMap((h) => [...h.removed.map((l) => `- ${l}`), ...Array.from({ length: h.added }, (_, k) => `+ ${lineAt(f.file, h.start + k)}`)])
        .slice(0, 12)
        .join("\n");
      diffs[s.node.name] = touched;
    }
    const answers = await ask(
      { question, changes: diffs, dependents: list.map((d) => `${describe(d.node)} · uses ${d.uses}: ${d.line}`) },
      Object.fromEntries(
        list.map((d, i) => [
          `d${i}`,
          {
            type: "score",
            instructions: `How likely is \`dependents[${i}]\` to break or need updating because of the change to ${d.uses} (see \`changes\`)?`,
            criteria: ["Unaffected: it doesn't rely on anything the change touched", "Might be affected: it relies on something near the change", "Likely breaks or needs updating: it relies on exactly what changed"],
          } satisfies JudgeQuestion,
        ]),
      ),
    );
    const risky = list
      .map((d, i) => ({ d, s: (answers[`d${i}`] as Extract<JudgeAnswer, { type: "score" }>).score }))
      .filter((x) => x.s >= 0.8)
      .sort((a, b) => b.s - a.s);
    const room = Math.max(0, budget - Math.min(changedCards.length, Math.ceil(budget / 3)));
    const kept = risky.slice(0, room);
    // The changed symbols the risky ones depend on, then the risky ones.
    const usedNames = new Set(kept.map((k) => k.d.uses));
    const changedFirst = changedCards.filter((c) => usedNames.has(g.node(c.id)?.name ?? ""));
    return [
      ...changedFirst,
      ...kept.map(({ d, s }) => ({ id: d.node.id, note: `uses changed ${d.uses} · ${s >= 1.5 ? "likely breaks" : "might be affected"}`, score: s / 2, step: 1 })),
    ];
  }
}

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

// Lower-case word pieces: camelCase, snake_case, paths.
function tokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}

// A word without its ending (Porter: save, saved, saving, saves → save).
const stem = (w: string) => porter(w);
