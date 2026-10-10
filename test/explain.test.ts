import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { explain, type ExplainEvent } from "../src/explain/index.js";
import type { ChatModel, ChatTurn } from "../src/explain/model.js";
import { GraphStore } from "../src/graph/store.js";
import { tsPlugin } from "../src/ingest/ts/index.js";
import { Queries } from "../src/query/index.js";
import { createService } from "../src/service/index.js";
import { codeNames, renderMarkdown } from "../views/markdown.js";

const cacheDir = mkdtempSync(path.join(os.tmpdir(), "lode-explain-"));
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));
const store = GraphStore.open(tsPlugin, "test/fixtures/ipc", { cacheDir });
const queries = new Queries(() => store.graph, store.root);

// A scripted model: plays back turns, and records what it was sent.
function scripted(turns: ChatTurn[]): ChatModel & { seen: { system: string[]; messages: unknown[] }[] } {
  const seen: { system: string[]; messages: unknown[] }[] = [];
  return {
    seen,
    async chat({ system, messages, onText }) {
      seen.push({ system, messages: structuredClone(messages) });
      const turn = turns.shift() ?? { content: [{ type: "text", text: "done" }], stop: "end" };
      for (const b of turn.content) if (b.type === "text") onText?.(b.text);
      return turn;
    },
  };
}

describe("explaining", () => {
  const canvas = { cards: [{ id: "src/main.ts#saveNote", note: "start here" }] };

  it("streams the answer, with the canvas as context", async () => {
    const model = scripted([{ content: [{ type: "text", text: "`saveNote` writes a note." }], stop: "end" }]);
    const events: ExplainEvent[] = [];
    const r = await explain({ messages: [{ role: "user", text: "Explain this." }], canvas }, queries, model, (e) => events.push(e));
    expect(r.text).toBe("`saveNote` writes a note.");
    expect(events).toEqual([{ type: "text", text: "`saveNote` writes a note." }]);
    expect(model.seen[0].system[1]).toContain("### saveNote");
    expect(model.seen[0].system[1]).toContain("> start here");
  });

  it("runs tools, adds real symbols to the canvas, and never sends empty text back", async () => {
    const model = scripted([
      {
        content: [
          { type: "text", text: "" },
          { type: "tool_use", id: "t1", name: "read", input: { symbol: "registerIpc" } },
        ],
        stop: "tool_use",
      },
      { content: [{ type: "tool_use", id: "t2", name: "add_to_flow", input: { symbols: ["registerIpc", "noSuchSymbolAnywhere"] } }], stop: "tool_use" },
      { content: [{ type: "text", text: "Added `registerIpc`." }], stop: "end" },
    ]);
    const events: ExplainEvent[] = [];
    const r = await explain({ messages: [{ role: "user", text: "Show what registers it." }], canvas }, queries, model, (e) => events.push(e));
    expect(r.added).toEqual(["src/main.ts#registerIpc"]);
    expect(events.filter((e) => e.type === "add")).toEqual([{ type: "add", ids: ["src/main.ts#registerIpc"] }]);
    expect(events.some((e) => e.type === "tool" && e.summary.includes("registerIpc"))).toBe(true);
    // The second request carries the first turn (without its empty text) and the tool result.
    const sent = model.seen[1].messages as { role: string; content: { type: string; text?: string; content?: string }[] }[];
    expect(sent[1].content.every((b) => b.type !== "text" || b.text)).toBe(true);
    expect(sent[2].content[0].content).toContain("### registerIpc");
  });

  it("routes each question to the provider it names, within what the host allows", async () => {
    const asked: string[] = [];
    const fake = (name: string): ChatModel => ({ async chat({ model: m }) { asked.push(`${name}:${m}`); return { content: [{ type: "text", text: "ok" }], stop: "end" }; } });
    const service = createService(store, {
      providers: {
        anthropic: { label: "Anthropic", model: fake("anthropic"), models: [{ id: "claude-haiku-5-5", label: "Haiku" }] },
        openrouter: { label: "OpenRouter", model: fake("openrouter"), models: [{ id: "meta-llama/llama-3:free", label: "Llama" }] },
      },
      models: ["anthropic:claude-haiku-5-5", "openrouter:meta-llama/llama-3:free"],
    });
    const ask = (model?: string) => service.call("explain", { request: { messages: [{ role: "user", text: "x" }], ...(model && { model }) } }) as Promise<{ model: string }>;
    expect((await ask("openrouter:meta-llama/llama-3:free")).model).toBe("openrouter:meta-llama/llama-3:free");
    expect((await ask("claude-haiku-5-5")).model).toBe("anthropic:claude-haiku-5-5"); // a bare id: whoever offers it
    expect((await ask()).model).toBe("anthropic:claude-haiku-5-5"); // the default
    expect(asked).toEqual(["openrouter:meta-llama/llama-3:free", "anthropic:claude-haiku-5-5", "anthropic:claude-haiku-5-5"]);
    await expect(ask("anthropic:claude-opus-5-5")).rejects.toThrow(/isn't allowed/);
    await expect(ask("nobody:x")).rejects.toThrow(/no provider offers/);
    await expect(ask("bad name!")).rejects.toThrow(/bad model/);
    expect(await service.call("explainModels")).toEqual({
      providers: [
        { id: "anthropic", label: "Anthropic", models: [{ id: "anthropic:claude-haiku-5-5", label: "Haiku" }] },
        { id: "openrouter", label: "OpenRouter", models: [{ id: "openrouter:meta-llama/llama-3:free", label: "Llama" }] },
      ],
      default: "anthropic:claude-haiku-5-5",
      notes: [],
    });
  });

  it("a host's providers are the only ones used, whatever keys are in the environment", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-from-env";
    const mine: ChatModel = { async chat() { return { content: [{ type: "text", text: "mine" }], stop: "end" }; } };
    const service = createService(store, { providers: { mine: { label: "Mine", model: mine, models: [{ id: "m1", label: "M1" }] } } });
    expect(((await service.call("explainModels")) as { providers: { id: string }[] }).providers.map((p) => p.id)).toEqual(["mine"]);
    expect(await service.call("explain", { request: { messages: [{ role: "user", text: "x" }] } })).toMatchObject({ text: "mine", model: "mine:m1" });
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  it("needs a model: says how to add one", async () => {
    const saved = { ...process.env };
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENROUTER_API_KEY"]) delete process.env[k];
    await expect(createService(store).call("explain", { request: { messages: [{ role: "user", text: "x" }] } })).rejects.toThrow(/ANTHROPIC_API_KEY/);
    process.env = saved;
  });

  it("streams through the service as events tagged with the caller's stream", async () => {
    const service = createService(store, { model: scripted([{ content: [{ type: "text", text: "hi" }], stop: "end" }]) });
    const got: unknown[] = [];
    service.onEvent((name, payload) => got.push({ name, payload }));
    await service.call("explain", { request: { messages: [{ role: "user", text: "x" }], canvas }, stream: "s1" });
    expect(got).toEqual([{ name: "explain", payload: { stream: "s1", event: { type: "text", text: "hi" } } }]);
  });
});

describe("linking names in answers", () => {
  it("resolves real symbols only: qualified, preferred, unique; never prose words or unknowns", async () => {
    const service = createService(store);
    const out = (await service.call("resolve", { names: ["saveNote", "saveNote()", "registerIpc", "text", "nothingHere", "a.b.c"], prefer: ["src/main.ts"] })) as Record<string, string>;
    expect(out).toMatchObject({ saveNote: "src/main.ts#saveNote", "saveNote()": "src/main.ts#saveNote", registerIpc: "src/main.ts#registerIpc" });
    expect(out.nothingHere).toBeUndefined();
    expect(out["a.b.c"]).toBeUndefined();
  });

  it("finds the code names in an answer", () => {
    expect(codeNames("`addTab` then `this.save()` and `x < y` and `Queries.changes`")).toEqual(["addTab", "this.save()", "Queries.changes"]);
  });
});

describe("answer rendering", () => {
  it("escapes, and links only names it's told are symbols", () => {
    const html = renderMarkdown("Calls `addTab` and `base` and `x < y`.\n\n- one **two**\n\n```\n<b>raw</b>\n```", (name) => (name === "addTab" ? "src/a.ts#addTab" : undefined));
    expect(html).toContain('<code class="sym" data-action="explain-open" data-id="src/a.ts#addTab" data-name="addTab">addTab</code>');
    expect(html).toContain("<code>base</code>");
    expect(html).toContain("<code>x &lt; y</code>");
    expect(html).toContain("<ul><li>one <b>two</b></li></ul>");
    expect(html).toContain("<pre>&lt;b&gt;raw&lt;/b&gt;</pre>");
    expect(renderMarkdown("<img src=x onerror=alert(1)>")).not.toContain("<img");
  });
});
