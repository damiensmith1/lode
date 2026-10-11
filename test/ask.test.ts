import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { askFlow, lexicalCandidates } from "../src/ask/index.js";
import type { Judge, JudgeAnswer, JudgeQuestion } from "../src/ask/judge.js";
import { loadEnv } from "../src/ask/env.js";
import { GraphStore } from "../src/graph/store.js";
import { tsPlugin } from "../src/ingest/ts/index.js";
import { Queries } from "../src/query/index.js";
import { createService } from "../src/service/index.js";
import { writeFileSync } from "node:fs";

const cacheDir = mkdtempSync(path.join(os.tmpdir(), "lode-ask-"));
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));
const store = GraphStore.open(tsPlugin, "test/fixtures/ipc", { cacheDir });
const queries = new Queries(() => store.graph, store.root);

// A stand-in for Jev: answers from the text it's shown, so tests are fast,
// free and repeatable. It routes as told and calls anything mentioning
// `topic` relevant.
function fakeJudge(route: string, topic: RegExp): Judge & { calls: number } {
  const judge = {
    calls: 0,
    async ask(state: unknown, questions: Record<string, JudgeQuestion>) {
      judge.calls++;
      const s = state as { candidates?: string[]; items?: string[]; callers?: string[]; dependents?: string[] };
      const items = s.candidates ?? s.items ?? s.callers ?? s.dependents ?? [];
      const answers: Record<string, JudgeAnswer> = {};
      for (const [key, q] of Object.entries(questions)) {
        const index = Number(/\[(\d+)\]/.exec(JSON.stringify(q.instructions))?.[1] ?? -1);
        const text = items[index] ?? "";
        if (key === "route") answers[key] = { type: "choice", choice: route, probabilities: { [route]: 1 }, confidence: 1 };
        else if (key === "start") {
          const id = items.find((c) => topic.test(c))?.split("|")[0] ?? "S1";
          answers[key] = { type: "choice", choice: id, probabilities: { [id]: 1 }, confidence: 1 };
        } else if (q.type === "noul") answers[key] = { type: "noul", noul: key === "answerable" ? (items.some((c) => topic.test(c)) ? 0.9 : 0.1) : topic.test(text) ? 0.9 : 0.1 };
        else answers[key] = { type: "score", score: topic.test(text) ? 2 : 0, probabilities: {}, confidence: 1 };
      }
      return answers;
    },
  };
  return judge;
}

describe("finding candidates", () => {
  const ids = (question: string) => lexicalCandidates(question, queries, 5).map((n) => n.id);

  it("searches everything about a symbol, not just its name", () => {
    // "cleared" is only in the handlers' code (notes:cleared, onCleared).
    expect(ids("what happens when the notes are cleared").slice(0, 3)).toEqual(expect.arrayContaining(["src/preload.ts#exposeInMainWorld:notes.onCleared", "src/renderer.js#onCleared@L13"]));
  });

  it("puts a symbol the question names first, and matches word forms", () => {
    expect(ids("where is saveNote")[0]).toBe("src/main.ts#saveNote");
    expect(ids("how do we save notes")).toEqual(ids("how are notes saved")); // save / saved, notes
  });

  it("forgives typos: a word the code never uses matches the code's words it's a slip of", () => {
    expect(ids("how are notes svaed")).toContain("src/main.ts#saveNote");
    expect(ids("where is saveNote")).toEqual(ids("where is saveNote")); // real words are left alone
  });
});

describe("asking for a flow", () => {
  it("starts where the judge says and follows what belongs, step by step", async () => {
    const judge = fakeJudge("how", /saveNote|writeNote|Note/);
    const plan = await askFlow("how is a note saved", queries, judge);
    expect(plan.route).toBe("how");
    expect(plan.answered).toBe(true);
    // What triggers it first (the IPC handler that calls it), then the start.
    expect(plan.cards[0]).toMatchObject({ step: 0 });
    expect(plan.cards[0].note).toMatch(/^triggers it: calls saveNote/);
    expect(plan.cards[1]).toMatchObject({ id: "src/main.ts#saveNote", step: 1 });
    expect(plan.cards[1].note).toMatch(/^start here/);
    expect(plan.cards.every((c) => c.importance === "core" || c.importance === "supporting")).toBe(true);
    expect(plan.cards.every((c, i) => i === 0 || (c.step ?? 0) >= (plan.cards[i - 1].step ?? 0))).toBe(true);
    expect(plan.requests).toBe(judge.calls);
  });

  it("says so when nothing is about the question", async () => {
    const plan = await askFlow("how does the payment refund queue retry", queries, fakeJudge("how", /zzz/));
    expect(plan.answered).toBe(false);
    expect(plan.message).toBeTruthy();
  });

  it("declines questions that aren't about the code", async () => {
    const plan = await askFlow("what's the weather", queries, fakeJudge("other", /zzz/));
    expect(plan).toMatchObject({ route: "other", answered: false, cards: [] });
  });

  it("asks through the service, and explains a missing key", async () => {
    const service = createService(store, { judge: fakeJudge("how", /saveNote|Note/) });
    expect(await service.call("ask", { question: "how is a note saved" })).toMatchObject({ answered: true });
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    await expect(createService(store).call("ask", { question: "x" })).rejects.toThrow(/TYPESAFE_API_KEY/);
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  });

  it("loads only the allowed keys from .env, without overriding what's set", () => {
    const file = path.join(cacheDir, ".env");
    writeFileSync(file, '# comment\nLODE_TEST_A="from file"\nexport LODE_TEST_B=b\nLODE_TEST_C=c\nLODE_TEST_D=d\n');
    process.env.LODE_TEST_C = "already";
    loadEnv([file], ["LODE_TEST_A", "LODE_TEST_B", "LODE_TEST_C"]);
    expect([process.env.LODE_TEST_A, process.env.LODE_TEST_B, process.env.LODE_TEST_C, process.env.LODE_TEST_D]).toEqual(["from file", "b", "already", undefined]);
  });
});
