// The "/" ask eval: questions with known answers, run through askFlow
// with the real judge (Jev), scored, so a change to asking is measured
// against many repos, languages and kinds of question, not the one in
// front of us.
//
//   npx tsx eval/run.ts eval/example.json [more suites…] [--repeat 3] [--only id] [--json out.json] [--mode crawl]
//   npx tsx eval/run.ts eval/example.json --check   (every start and include pattern names a real symbol; no judge)
//
// Needs TYPESAFE_API_KEY (lode's .env). Suites in eval/local/ are yours and
// never pushed (private repos, local paths). A suite:
//
//   { "repos": { "<name>": "<path>" | { "git": "<url>", "commit": "<sha>" } },
//     "questions": [{
//       "id": "keepr-ledger",
//       "repo": "<name>",
//       "type": "overview" | "process" | "where" | "callers" | "vocab" | "none",
//       "question": "explain the ledger",
//       "start": ["Keepr::Journal$", …],        // the start card should match one (regexes over card ids)
//       "include": ["Keepr::Account$", …],     // each should match some card
//       "exclude": ["(^|/)spec/", …],          // no card should match
//     }] }
//
// A path is relative to the suite file. A git repo is fetched once at that
// commit into lode's cache (~/.cache/lode/eval). "vocab" questions are
// worded unlike the code (a synonym, a typo). "none" questions should
// come back with no flow. Scores: start (the start card is right),
// coverage (share of `include` found), noise (cards matching `exclude`).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginFor } from "../plugins/index.js";
import { askFlow } from "../src/ask/index.js";
import { loadEnv } from "../src/ask/env.js";
import { jevJudge, type Judge } from "../src/ask/judge.js";
import { GraphStore } from "../src/graph/store.js";
import { Queries } from "../src/query/index.js";
import type { FlowPlan } from "../src/query/types.js";

type Repo = string | { git: string; commit: string };
interface Question {
  id: string;
  repo: string;
  type: "overview" | "process" | "where" | "callers" | "vocab" | "none";
  question: string;
  start?: string[];
  include?: string[];
  exclude?: string[];
}
interface Suite {
  repos: Record<string, Repo>;
  questions: Question[];
}
interface Result {
  id: string;
  type: Question["type"];
  repo: string;
  start: boolean;
  coverage: number;
  noise: number;
  cards: number;
  ms: number;
  requests: number;
  startCard?: string;
  missing: string[];
  noisy: string[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv([path.join(here, "..", ".env")]);

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const repeat = Number(flag("repeat") ?? 1);
const only = flag("only");
const jsonOut = flag("json");
const mode = flag("mode") === "crawl" ? "crawl" : "pass"; // how "/" finds the flow (src/ask)
const check = args.includes("--check") && args.splice(args.indexOf("--check"), 1).length > 0;
if (!args.length) {
  console.error("usage: npx tsx eval/run.ts <suite.json…> [--repeat n] [--only id] [--json out.json] [--mode pass|crawl]");
  process.exit(1);
}
if (!check && !process.env.TYPESAFE_API_KEY) {
  console.error("eval: needs TYPESAFE_API_KEY (in lode's .env)");
  process.exit(1);
}
const judge: Judge = jevJudge({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });

// A repo's folder: a path, or a pinned git commit fetched once.
const cacheRoot = path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "lode", "eval");
function folderOf(repo: Repo, suiteDir: string): string {
  if (typeof repo === "string") return path.resolve(suiteDir, repo.replace(/^~(?=\/)/, os.homedir()));
  const dir = path.join(cacheRoot, `${repo.git.replace(/^.*\/([^/]+?)(\.git)?$/, "$1")}@${repo.commit.slice(0, 12)}`);
  if (!existsSync(path.join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "ignore", "inherit"] });
    console.error(`eval: fetching ${repo.git} @ ${repo.commit.slice(0, 12)}`);
    git("init", "-q");
    git("fetch", "-q", "--depth", "1", repo.git, repo.commit);
    git("checkout", "-q", "FETCH_HEAD");
  }
  return dir;
}

// Graphs are indexed fresh each run, never from lode's cache: a cache built
// by other code (same plugin version, different rules) would be measured instead.
const graphs = mkdtempSync(path.join(os.tmpdir(), "lode-eval-"));
process.on("exit", () => rmSync(graphs, { recursive: true, force: true }));
const stores = new Map<string, Queries>();
async function queriesFor(folder: string): Promise<Queries> {
  if (!stores.has(folder)) {
    const store = GraphStore.open(await pluginFor(folder), folder, { cacheDir: path.join(graphs, String(stores.size)) });
    stores.set(folder, new Queries(() => store.graph, store.root));
  }
  return stores.get(folder)!;
}

function score(q: Question, plan: FlowPlan): Omit<Result, "id" | "type" | "repo" | "ms" | "requests"> {
  const ids = plan.cards.map((c) => c.id);
  const re = (patterns: string[] = []) => patterns.map((p) => new RegExp(p));
  if (q.type === "none") return { start: !plan.answered, coverage: plan.answered ? 0 : 1, noise: 0, cards: ids.length, missing: [], noisy: [] };
  const startCard = plan.cards.find((c) => c.note.startsWith("start here"))?.id ?? ids[0];
  const include = re(q.include);
  const missing = (q.include ?? []).filter((_, i) => !ids.some((id) => include[i].test(id)));
  const noisy = ids.filter((id) => re(q.exclude).some((r) => r.test(id)));
  return {
    start: !!startCard && (q.start?.length ? re(q.start).some((r) => r.test(startCard)) : true),
    coverage: include.length ? 1 - missing.length / include.length : 1,
    noise: noisy.length,
    cards: ids.length,
    ...(startCard && { startCard }),
    missing,
    noisy,
  };
}

const results: Result[] = [];
for (const file of args) {
  const suite = JSON.parse(readFileSync(file, "utf8")) as Suite;
  for (const q of suite.questions) {
    if (only && q.id !== only) continue;
    const queries = await queriesFor(folderOf(suite.repos[q.repo], path.dirname(path.resolve(file))));
    if (check) {
      const ids = [...queries.graph().allNodes()].filter((n) => !n.external).map((n) => n.id);
      const dead = [...(q.start ?? []), ...(q.include ?? [])].filter((p) => !ids.some((id) => new RegExp(p).test(id)));
      console.log(`${dead.length ? "✗" : "✓"} ${q.id}${dead.length ? `  matches nothing: ${dead.join("  ")}` : ""}`);
      continue;
    }
    for (let r = 0; r < repeat; r++) {
      const plan = await askFlow(q.question, queries, judge, { mode });
      const result: Result = { id: q.id, type: q.type, repo: q.repo, ms: plan.ms, requests: plan.requests, ...score(q, plan) };
      results.push(result);
      const short = (id?: string) => id?.replace(/^.*\//, "") ?? "–";
      console.log(
        `${result.start ? "✓" : "✗"} ${q.id.padEnd(28)} cov ${pct(result.coverage).padStart(4)}  noise ${result.noise}  ${String(result.ms).padStart(5)}ms ${String(result.requests).padStart(2)}req  start ${short(result.startCard)}` +
          `${result.missing.length ? `  missing: ${result.missing.join(", ")}` : ""}${result.noisy.length ? `  noise: ${result.noisy.map(short).join(", ")}` : ""}`,
      );
    }
  }
}

if (check) process.exit(0);

// By type and overall: start rate, mean coverage, noise per question, time.
const groups = new Map<string, Result[]>([["all", results]]);
for (const r of results) groups.set(r.type, [...(groups.get(r.type) ?? []), r]);
console.log("");
for (const [name, rs] of groups) {
  if (!rs.length) continue;
  const mean = (f: (r: Result) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
  console.log(`${name.padEnd(9)} n=${String(rs.length).padStart(3)}  start ${pct(mean((r) => (r.start ? 1 : 0))).padStart(4)}  coverage ${pct(mean((r) => r.coverage)).padStart(4)}  noise ${mean((r) => r.noise).toFixed(1)}  ${Math.round(mean((r) => r.ms))}ms  ${mean((r) => r.requests).toFixed(1)}req`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
