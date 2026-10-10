import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openaiModel } from "../src/explain/openai.js";
import { GraphStore } from "../src/graph/store.js";
import { tsPlugin } from "../src/ingest/ts/index.js";
import { createService } from "../src/service/index.js";

// A stand-in OpenAI-compatible server: streams chat completions as SSE,
// first a tool call (its arguments split across chunks, as real servers
// send them), then, once the tool's result comes back, a text answer.
const requests: Record<string, unknown>[] = [];
let server: Server;
let baseURL = "";
const sse = (res: import("node:http").ServerResponse, chunks: unknown[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end("data: [DONE]\n\n");
};
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const json = JSON.parse(body);
    requests.push({ ...json, auth: req.headers.authorization, path: req.url });
    const hasToolResult = json.messages.some((m: { role: string }) => m.role === "tool");
    if (!hasToolResult)
      return sse(res, [
        { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"sym' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'bol":"registerIpc"}' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ]);
    return sse(res, [
      { choices: [{ index: 0, delta: { content: "`registerIpc` " } }] },
      { choices: [{ index: 0, delta: { content: "wires the IPC handlers." } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(() => server.close());

const cacheDir = mkdtempSync(path.join(os.tmpdir(), "lode-openai-"));
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));
const store = GraphStore.open(tsPlugin, "test/fixtures/ipc", { cacheDir });

describe("OpenAI-compatible models", () => {
  it("streams text and assembles tool calls from pieces", async () => {
    requests.length = 0;
    const model = openaiModel({ apiKey: "sk-test", model: "test-model", baseURL });
    const turn = await model.chat({ system: ["sys"], messages: [{ role: "user", content: "hi" }], tools: [{ name: "read", description: "Read", input_schema: { type: "object", properties: {} } }] });
    expect(turn).toEqual({ content: [{ type: "tool_use", id: "call_1", name: "read", input: { symbol: "registerIpc" } }], stop: "tool_use" });
    expect(requests[0]).toMatchObject({ path: "/v1/chat/completions", auth: "Bearer sk-test", model: "test-model", stream: true, tool_choice: "auto" });
    expect((requests[0].messages as unknown[])[0]).toEqual({ role: "system", content: "sys" });
  });

  it("explains end to end from the environment, beside other providers: tool round trip, then the answer", async () => {
    requests.length = 0;
    const saved = { ...process.env };
    Object.assign(process.env, { ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: baseURL, LODE_OPENAI_MODELS: "test-model=Test,org/other:free=Other", OPENROUTER_API_KEY: "or-test" });
    delete process.env.LODE_OPENROUTER_MODELS;
    delete process.env.LODE_EXPLAIN_MODEL;
    try {
      const service = createService(store);
      const info = (await service.call("explainModels")) as { providers: { id: string; label: string; models: { id: string }[] }[]; default: string; notes: string[] };
      expect(info.providers.map((p) => [p.id, p.label, p.models.map((m) => m.id)])).toEqual([
        ["anthropic", "Anthropic", ["anthropic:claude-sonnet-5-5", "anthropic:claude-haiku-5-5", "anthropic:claude-opus-5-5"]],
        ["openai", "OpenAI-compatible", ["openai:test-model", "openai:org/other:free"]],
      ]);
      expect(info.default).toBe("anthropic:claude-sonnet-5-5");
      expect(info.notes).toEqual([expect.stringMatching(/LODE_OPENROUTER_MODELS/)]);
      const texts: string[] = [];
      service.onEvent((_, p) => {
        const e = (p as { event: { type: string; text?: string } }).event;
        if (e.type === "text") texts.push(e.text!);
      });
      const result = (await service.call("explain", { request: { messages: [{ role: "user", text: "what wires IPC?" }], model: "openai:org/other:free" }, stream: "s" })) as { text: string; tools: number; model: string };
      expect(result).toMatchObject({ text: "`registerIpc` wires the IPC handlers.", tools: 1, model: "openai:org/other:free" });
      expect(texts.join("")).toBe(result.text);
      // The second request carries the tool call and its result, OpenAI-style.
      const second = requests[1] as { model: string; messages: { role: string; tool_calls?: unknown[]; tool_call_id?: string; content?: string }[] };
      expect(second.model).toBe("org/other:free");
      const assistant = second.messages.find((m) => m.role === "assistant")!;
      expect(assistant.tool_calls).toEqual([{ id: "call_1", type: "function", function: { name: "read", arguments: '{"symbol":"registerIpc"}' } }]);
      const tool = second.messages.find((m) => m.role === "tool")!;
      expect(tool.tool_call_id).toBe("call_1");
      expect(tool.content).toContain("### registerIpc");
    } finally {
      process.env = saved;
    }
  });

  it("OpenRouter: offered once its models are listed", async () => {
    const saved = { ...process.env };
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "LODE_EXPLAIN_MODEL", "LODE_OPENAI_MODELS"]) delete process.env[k];
    Object.assign(process.env, { OPENROUTER_API_KEY: "or-test", LODE_OPENROUTER_MODELS: "anthropic/claude-sonnet=Claude,openai/gpt=GPT" });
    try {
      expect(await createService(store).call("explainModels")).toEqual({
        providers: [{ id: "openrouter", label: "OpenRouter", models: [{ id: "openrouter:anthropic/claude-sonnet", label: "Claude" }, { id: "openrouter:openai/gpt", label: "GPT" }] }],
        default: "openrouter:anthropic/claude-sonnet",
        notes: [],
      });
    } finally {
      process.env = saved;
    }
  });
});
