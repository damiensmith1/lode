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

export type AskMode = "pass" | "crawl";

export interface AskOptions {
  mode?: AskMode; // how the flow is found (default "pass"; see askFlow)
  route?: FlowRoute; // skip routing: treat the question as this kind
  budget?: number; // most cards in a flow (default 12)
  hops?: number; // pass: how far to follow from the start (default 2)
  rounds?: number; // crawl: rounds at most (default 8)
  beam?: number; // crawl: what each round opens (default 6)
  timeMs?: number; // crawl: no new round after this (default 3000)
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

// A flow for a question, by the mode asked for (default "pass"):
//   pass   the best word matches over every symbol (BM25, forgiving typos),
//          one Jev request to pick where to start and what matters, then
//          the graph followed from there. Fast; what the eval measures best.
//   crawl  from the top of the project and the best word matches, rounds
//          that open the most promising few (a folder, a class, what a
//          function calls) with Jev judging what's inside, then a pass that
//          picks the start and marks core and supporting cards. Slower,
//          reads more of the project.
export async function askFlow(question: string, queries: Queries, judge: Judge, options: AskOptions = {}): Promise<FlowPlan> {
  return options.mode === "crawl" ? crawlFlow(question, queries, judge, options) : passFlow(question, queries, judge, options);
}

async function passFlow(question: string, queries: Queries, judge: Judge, options: AskOptions = {}): Promise<FlowPlan> {
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
          // Who imports a file isn't a step in what runs.
          if (c.kind === "imports" || c.node.external || kept.has(c.node.id) || next.has(c.node.id)) continue;
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
      const users = [...block.callers.filter((c) => c.kind !== "imports").map((c) => ({ node: c.node, line: c.line })), ...block.links.filter((l) => l.label === "read by").map((l) => ({ node: l.target, line: 0 }))];
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

async function crawlFlow(question: string, queries: Queries, judge: Judge, options: AskOptions = {}): Promise<FlowPlan> {
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

  // 1. Where to look: the top of the project (its folders and top-level
  // files) and the best word matches (lexicalCandidates), judged in one
  // request together with the route.
  const tree = projectTree(queries);
  const scores = new Map<string, number>();
  // `starts`: in the first request, also which of these is the best place
  // to start (the named symbols and word matches, judged directly).
  const judgeItems = async (ids: string[], first = false, starts: string[] = []): Promise<{ route?: JudgeAnswer; start?: JudgeAnswer }> => {
    let route: JudgeAnswer | undefined;
    let start: JudgeAnswer | undefined;
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
    if (first && !chunks.length) chunks.push([]);
    await Promise.all(
      chunks.map(async (chunk, c) => {
        const answers = await ask(
          // Labelled, so a choice (I12) names the item it means.
          { question, items: chunk.map((id, i) => `I${i}| ${tree.describe(id)}`) },
          {
            ...(first && c === 0 && !options.route && { route: { type: "choice", instructions: "What kind of question is `question`, about this codebase?", criteria: ROUTES } }),
            ...(first && c === 0 && starts.length && {
              start: { type: "choice", instructions: "Which of `items` is the best place to start reading to answer `question`?", criteria: Object.fromEntries(starts.map((id) => [`I${chunk.indexOf(id)}`, null])) },
            }),
            ...Object.fromEntries(
              chunk.map((id, i) => [
                `i${i}`,
                tree.isContainer(id)
                  ? { type: "noul", instructions: `Is the code that answers \`question\` likely inside \`items[${i}]\`?`, criteria: { true: "Something in it does or defines what the question is about (even in different words)", false: "Nothing in it is about that" } }
                  : { type: "noul", instructions: `Does \`items[${i}]\` do or define part of what \`question\` asks about?`, criteria: { true: "It carries out part of the thing asked about (even in different words)", false: "Unrelated, a generic helper, or only shares a word with the question" } },
              ]),
            ),
          } as Record<string, JudgeQuestion>,
        );
        if (answers.route) route = answers.route;
        if (answers.start) start = answers.start;
        chunk.forEach((id, i) => scores.set(id, (answers[`i${i}`] as Extract<JudgeAnswer, { type: "noul" }>).noul));
      }),
    );
    return { route, start };
  };
  const hints = lexicalCandidates(question, queries, 40).map((n) => n.id);
  const anchors = namedSymbols(question, queries);
  // Named symbols and word matches first: they're the start's candidates,
  // so they go in the first chunk.
  let fresh = [...new Set([...anchors, ...hints, ...tree.children("", "down")])];
  const startCandidates = [...new Set([...anchors, ...hints])].filter((id) => fresh.indexOf(id) < 200);
  const { route: routed, start: firstStart } = await judgeItems(fresh, true, startCandidates);
  // The choice names an item of the first chunk, which is `fresh`'s start.
  const picked = fresh[Number((firstStart as Extract<JudgeAnswer, { type: "choice" }> | undefined)?.choice.slice(1) ?? NaN)];
  const chosen = picked && startCandidates.includes(picked) ? picked : undefined;
  const route = options.route ?? ((routed as Extract<JudgeAnswer, { type: "choice" }> | undefined)?.choice as FlowRoute | undefined) ?? "how";

  if (route === "breakage" || route === "changes") return done(route, await changesFlow(route), undefined);
  if (route === "other") return done(route, [], "That doesn't look like a question about this code.");
  // A symbol the question names is part of the answer, whatever the judge
  // thought of its one-line description; "what calls X" is answered from
  // the graph: X and its callers.
  for (const id of anchors) scores.set(id, Math.max(scores.get(id) ?? 0, 0.95));
  if (route === "callers" && anchors.length) return done(route, await callersFlow(anchors[0]));

  // 2. Crawl: each round opens the most promising few (a folder's files, a
  // file's or class's members, what a function calls, or for "what calls
  // X", what calls it) and judges what's inside, in one request. Ranked,
  // not cut off: the best few are opened even when every score is modest.
  const direction = route === "callers" ? "up" : "down";
  const opened = new Set<string>();
  for (let round = 0; round < (options.rounds ?? 8) && Date.now() - started < (options.timeMs ?? 3000); round++) {
    const beam = [...scores]
      .filter(([id, p]) => !opened.has(id) && (tree.isContainer(id) ? p >= 0.15 : p >= 0.5) && tree.children(id, direction).length)
      .sort((a, b) => b[1] - a[1])
      .slice(0, options.beam ?? 6);
    // A member that scored well opens its class (or file) too: its
    // siblings are likely part of it. A word match is often such a member,
    // reached without its parent ever being opened.
    const parents = [...scores]
      .filter(([id, p]) => p >= 0.7 && !tree.isContainer(id))
      .map(([id]) => g.node(id)?.parent)
      .filter((parent): parent is string => !!parent && !opened.has(parent) && tree.isContainer(parent))
      .filter((parent, i, all) => all.indexOf(parent) === i)
      .slice(0, 4);
    if (!beam.length && !parents.length) break;
    fresh = [];
    for (const [id] of beam) (opened.add(id), fresh.push(...tree.children(id, direction)));
    for (const id of parents) (opened.add(id), fresh.push(...tree.children(id, direction)));
    fresh = [...new Set(fresh)].filter((id) => !scores.has(id));
    if (fresh.length) await judgeItems(fresh);
  }

  // 3. What matters: the best symbols found, each scored for how central it
  // is (core, supporting, incidental). The start was chosen in the first
  // request, directly over what the question names and its word matches:
  // the crawl adds what's around it, and never moves it.
  const found = [...scores].filter(([id]) => g.node(id)).sort((a, b) => b[1] - a[1]);
  if (!found.length || found[0][1] < 0.3) return done(route, [], "Nothing in the code seems to be about that.");
  // The pool: what the question names, the best of the word matches as
  // judged directly (so a deep crawl can't crowd them out), then the best
  // of everything found.
  const direct = hints.filter((id) => scores.has(id)).sort((a, b) => scores.get(b)! - scores.get(a)!).slice(0, 10);
  const pool = [...new Set([...(chosen ? [chosen] : []), ...anchors, ...direct, ...found.map(([id]) => id)])].slice(0, 25);
  const final = await ask(
    { question, candidates: pool.map((id, i) => `C${i}| ${tree.describe(id)}`) },
    {
      ...(!chosen && { start: { type: "choice", instructions: "Which candidate is the best place to start reading to answer `question`?", criteria: Object.fromEntries(pool.map((_, i) => [`C${i}`, null])) } }),
      ...Object.fromEntries(
        pool.map((_, i) => [
          `m${i}`,
          { type: "score", instructions: `How central is \`candidates[${i}]\` to answering \`question\`?`, criteria: ["Incidental: not needed to understand it", "Supporting: helps, but not the heart of it", "Core: the answer can't be understood without it"] } satisfies JudgeQuestion,
        ]),
      ),
    },
  );
  const startId = chosen ?? pool[Number((final.start as Extract<JudgeAnswer, { type: "choice" }> | undefined)?.choice.slice(1) ?? 0)] ?? pool[0];
  const central = new Map(pool.map((id, i) => [id, (final[`m${i}`] as Extract<JudgeAnswer, { type: "score" }>).score])); // 0–2
  const kept = [startId, ...pool.filter((id) => id !== startId && central.get(id)! >= 0.6).sort((a, b) => central.get(b)! - central.get(a)!)].slice(0, budget);

  // What triggers it: one hop of what calls the start (a route, a
  // controller action, an IPC handler, the public method), so the flow
  // shows how it begins, not just what follows. For "what calls X" the
  // crawl went that way already.
  const triggers: string[] = [];
  if (direction === "down") {
    const callers = [...new Set(g.neighbors(startId, "up", ["calls"]).map((e) => e.from))].filter((id) => !kept.includes(id) && g.node(id) && !g.node(id)!.external).slice(0, 20);
    if (callers.length) {
      const answers = await ask(
        { question, start: tree.describe(startId), callers: callers.map(tree.describe) },
        Object.fromEntries(
          callers.map((_, i) => [
            `t${i}`,
            { type: "noul", instructions: `Is \`callers[${i}]\` how what \`question\` asks about gets started (it calls \`start\`)?`, criteria: { true: "It triggers or leads into the thing asked about", false: "An unrelated use of it, a test, or a generic helper" } } satisfies JudgeQuestion,
          ]),
        ),
      );
      triggers.push(
        ...callers
          .map((id, i) => ({ id, p: (answers[`t${i}`] as Extract<JudgeAnswer, { type: "noul" }>).noul }))
          .filter((t) => t.p >= 0.5)
          .sort((a, b) => b.p - a.p)
          .slice(0, 2)
          .map((t) => (scores.set(t.id, Math.max(scores.get(t.id) ?? 0, t.p)), t.id)),
      );
    }
  }

  // Reading order: what triggers it, then steps along the calls from the
  // start (or toward it, for callers); what isn't connected comes after.
  const first = triggers.length ? 1 : 0;
  const steps = new Map<string, { step: number; via?: string }>([[startId, { step: first }], ...triggers.map((id): [string, { step: number }] => [id, { step: 0 }])]);
  for (let queue = [startId]; queue.length; ) {
    const id = queue.shift()!;
    for (const e of g.neighbors(id, direction, ["calls"])) {
      const next = direction === "down" ? e.to : e.from;
      if (!kept.includes(next) || steps.has(next)) continue;
      steps.set(next, { step: steps.get(id)!.step + 1, via: g.node(id)?.name });
      queue.push(next);
    }
  }
  const last = Math.max(...[...steps.values()].map((s) => s.step));
  const startName = g.node(startId)?.name;
  const cards = [...triggers, ...kept].map((id) => {
    const m = central.get(id) ?? 0;
    const importance: "core" | "supporting" = m >= 1.2 ? "core" : "supporting";
    const at = steps.get(id);
    const role = id === startId ? "start here" : triggers.includes(id) ? `triggers it: calls ${startName}` : importance;
    const note = [role, at?.via && `${direction === "down" ? "from" : "calls"} ${at.via}`, `relevance ${pct(scores.get(id) ?? 0)}`].filter(Boolean).join(" · ");
    return { id, note, score: m / 2, step: at?.step ?? last + 1, importance };
  });
  cards.sort((a, b) => a.step - b.step || b.score - a.score);
  return done(route, cards);

  // "What calls X": X, then everything that calls it, ranked by the judge
  // (real uses before tests and helpers), up to the budget.
  async function callersFlow(id: string): Promise<FlowPlan["cards"]> {
    const name = g.node(id)?.name ?? id;
    const callers = [...new Set(g.neighbors(id, "up", ["calls"]).map((e) => e.from))].filter((c) => c !== id && g.node(c) && !g.node(c)!.external).slice(0, 60);
    const ranked = callers.length
      ? await ask(
          { question, symbol: tree.describe(id), callers: callers.map(tree.describe) },
          Object.fromEntries(
            callers.map((_, i) => [
              `c${i}`,
              { type: "noul", instructions: `Is \`callers[${i}]\` a use of \`symbol\` worth showing to answer \`question\`?`, criteria: { true: "A real use of it in the project", false: "A test, or a trivial or generic use" } } satisfies JudgeQuestion,
            ]),
          ),
        ).then((a) => callers.map((c, i) => ({ id: c, p: (a[`c${i}`] as Extract<JudgeAnswer, { type: "noul" }>).noul })).sort((x, y) => y.p - x.p))
      : [];
    return [
      { id, note: `start here · ${callers.length} caller${callers.length === 1 ? "" : "s"}`, step: 1, importance: "core" as const },
      ...ranked.slice(0, budget - 1).map((c) => ({ id: c.id, note: `calls ${name} · relevance ${pct(c.p)}`, score: c.p, step: 0, importance: c.p >= 0.6 ? ("core" as const) : ("supporting" as const) })),
    ];
  }

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

// Symbols the question names: an identifier that looks like code
// (contextFor, with_sums, toggleDictation, save!) or a qualified method
// (Pusher#process, User.find, Admin::UsersController#index).
export function namedSymbols(question: string, queries: Queries): string[] {
  const g = queries.graph();
  const nodes = [...g.allNodes()].filter((n) => !n.external && n.loc && n.id !== n.loc.file);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found: string[] = [];
  for (const [, cls, method] of question.matchAll(/\b([A-Z][\w]*(?:::[A-Z]\w*)*)(?:#|\.|::)([a-z_]\w*[?!]?)/g)) {
    const re = new RegExp(`(^|[#:.])${escape(cls)}\\.(self\\.)?${escape(method)}$`);
    found.push(...nodes.filter((n) => re.test(n.id)).map((n) => n.id));
  }
  for (const w of question.match(/[A-Za-z_$][\w$]*[?!]?/g) ?? []) {
    if (!/[a-z][A-Z]|[_$\d]|[?!]$/.test(w) || w.length < 3) continue;
    found.push(...nodes.filter((n) => n.name === w).map((n) => n.id));
  }
  return [...new Set(found)].slice(0, 3);
}

// The project as a tree to crawl: folders → files → classes → members, and
// a function → what it calls (or what calls it). A folder with one entry
// is that entry; a file declaring one class is that class. Each item is
// described for the judge by what's in it: a folder by the classes and
// modules declared under it, a class by its first lines and members, a
// function by its comment and first lines.
function projectTree(queries: Queries) {
  const g = queries.graph();
  const files = queries.files().filter((f) => f.indexed).map((f) => f.file);
  const dirs = new Map<string, Set<string>>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      const child = i === parts.length - 1 ? f : `dir:${parts.slice(0, i + 1).join("/")}`;
      (dirs.get(parent) ?? dirs.set(parent, new Set()).get(parent)!).add(child);
    }
  }
  const members = (id: string) => g.childrenOf(id).filter((c) => !c.external && (c.kind === "callable" || c.kind === "container" || c.kind === "type"));
  const collapse = (id: string): string => {
    if (id.startsWith("dir:")) {
      const kids = [...(dirs.get(id.slice(4)) ?? [])];
      return kids.length === 1 ? collapse(kids[0]) : id;
    }
    const n = g.node(id);
    if (n && n.id === n.loc?.file) {
      const top = members(id);
      return top.length === 1 && top[0].kind === "container" ? top[0].id : id;
    }
    return id;
  };
  const isContainer = (id: string) => id === "" || id.startsWith("dir:") || g.node(id)?.kind === "container" || g.node(id)?.kind === "type";
  const children = (id: string, direction: "down" | "up"): string[] => {
    if (id === "" || id.startsWith("dir:")) return [...(dirs.get(id.replace(/^dir:/, "")) ?? [])].map(collapse);
    const n = g.node(id);
    if (!n) return [];
    if (n.kind !== "callable") return members(id).map((c) => c.id);
    const ids = g.neighbors(id, direction, ["calls"]).map((e) => (direction === "down" ? e.to : e.from));
    return [...new Set(ids)].filter((x) => {
      const t = g.node(x);
      return t && !t.external && t.id !== t.loc?.file;
    });
  };
  const describe = (id: string): string => {
    if (id.startsWith("dir:")) {
      const prefix = `${id.slice(4)}/`;
      const inside = files.filter((f) => f.startsWith(prefix));
      const names = [...new Set(inside.flatMap((f) => members(f).map((m) => m.name)))];
      const kids = [...(dirs.get(id.slice(4)) ?? [])].map((k) => `${k.replace(/^dir:/, "").split("/").pop()}${k.startsWith("dir:") ? "/" : ""}`);
      return `folder ${prefix} — ${inside.length} files; entries: ${kids.slice(0, 15).join(", ")}${kids.length > 15 ? ", …" : ""}; declares: ${names.slice(0, 40).join(", ")}${names.length > 40 ? ", …" : ""}`;
    }
    const n = g.node(id);
    if (!n?.loc) return id;
    if (n.id === n.loc.file) return `file ${n.id} — defines: ${members(id).slice(0, 20).map((m) => m.name).join(", ")}`;
    const head = symbolText(queries, n, n.kind === "callable" ? 7 : 2).split("\n").slice(1).map((l) => l.trim()).filter(Boolean).join(" ⏎ ").slice(0, 350);
    if (n.kind === "callable") return `function ${n.id} — ${head}`;
    return `${n.kind === "type" ? "type" : "class"} ${n.id} — ${head} ⏎ members: ${members(id).slice(0, 25).map((m) => m.name).join(", ")}`;
  };
  return { children, describe, isContainer };
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
