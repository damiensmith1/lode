import type { ChatBlock, ChatMessage, ChatModel, ChatTool, ChatTurn } from "./model.js";

// A ChatModel over the OpenAI Chat Completions API, streaming, with tool
// (function) calls: OpenAI itself, and anything that speaks the same API at
// another base URL (OpenRouter, Groq, Together, Ollama, LM Studio, vLLM…).
// lode's conversation is kept Anthropic-shaped (text, tool_use and
// tool_result blocks); this maps it to OpenAI messages and back.

export interface OpenAIOptions {
  apiKey?: string; // some local servers (Ollama) need none
  model: string; // the default model: "gpt-…", "anthropic/claude-…" on OpenRouter, "llama3.1" on Ollama
  baseURL?: string; // default https://api.openai.com/v1
  headers?: Record<string, string>; // e.g. OpenRouter's HTTP-Referer / X-Title
  retries?: number; // on 429 and 5xx before streaming starts (default 3)
}

export function openaiModel(options: OpenAIOptions): ChatModel {
  const url = `${(options.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;
  return {
    async chat({ system, messages, tools, model, maxTokens, onText, signal }) {
      const body = JSON.stringify({
        model: model ?? options.model,
        stream: true,
        messages: [{ role: "system", content: system.join("\n\n") }, ...messages.flatMap(toOpenAI)],
        ...(tools.length && { tools: tools.map(toFunction), tool_choice: "auto" }),
        ...(maxTokens && { max_tokens: maxTokens }),
      });
      let response: Response | undefined;
      for (let attempt = 0; ; attempt++) {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(options.apiKey && { authorization: `Bearer ${options.apiKey}` }), ...options.headers },
          body,
          signal,
        });
        if (response.ok) break;
        if ((response.status === 429 || response.status >= 500) && attempt < (options.retries ?? 3)) {
          const after = Number(response.headers.get("retry-after"));
          await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt));
          continue;
        }
        const detail = await response.text().catch(() => "");
        throw new Error(response.status === 401 ? "OpenAI-compatible API: the key was refused" : `OpenAI-compatible API: ${response.status} ${detail.slice(0, 300)}`);
      }

      // The event stream: content deltas, and tool calls whose name and
      // arguments arrive in pieces, by index.
      let text = "";
      const calls = new Map<number, { id: string; name: string; args: string }>();
      let finish = "stop";
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response!.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let i; (i = buffer.indexOf("\n")) >= 0; ) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          const event = JSON.parse(data);
          if (event.error) throw new Error(`OpenAI-compatible API: ${event.error.message ?? JSON.stringify(event.error)}`);
          const choice = event.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          if (typeof delta.content === "string" && delta.content) {
            text += delta.content;
            onText?.(delta.content);
          }
          for (const t of delta.tool_calls ?? []) {
            const at = calls.get(t.index) ?? { id: "", name: "", args: "" };
            if (t.id) at.id = t.id;
            if (t.function?.name) at.name += t.function.name;
            if (t.function?.arguments) at.args += t.function.arguments;
            calls.set(t.index, at);
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      }
      const content: ChatBlock[] = [];
      if (text) content.push({ type: "text", text });
      for (const [index, c] of [...calls].sort((a, b) => a[0] - b[0])) {
        let input: Record<string, unknown> = {};
        try {
          input = c.args ? JSON.parse(c.args) : {};
        } catch {
          // Malformed arguments: the tool will say what's missing.
        }
        content.push({ type: "tool_use", id: c.id || `call_${index}`, name: c.name, input });
      }
      const stop: ChatTurn["stop"] = calls.size || finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end";
      return { content, stop };
    },
  };
}

function toFunction(t: ChatTool) {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } };
}

// One lode message as OpenAI messages (tool results become "tool" messages).
function toOpenAI(m: ChatMessage): Record<string, unknown>[] {
  if (typeof m.content === "string") return [{ role: m.role, content: m.content }];
  if (m.role === "assistant") {
    const text = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    const calls = m.content.filter((b): b is Extract<ChatBlock, { type: "tool_use" }> => b.type === "tool_use");
    return [{ role: "assistant", content: text || null, ...(calls.length && { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) }) }];
  }
  const out: Record<string, unknown>[] = [];
  const text: string[] = [];
  for (const b of m.content) {
    if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
    else if (b.type === "text") text.push(b.text);
  }
  if (text.length) out.push({ role: "user", content: text.join("\n") });
  return out;
}
