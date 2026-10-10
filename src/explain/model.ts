// What explaining needs from a model: chat with tools, streaming text as
// it's written. The Anthropic API is the default; a host can bring any
// model that does this (another API, a local model, Claude Code).

export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ChatBlock[];
}

export interface ChatTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ChatTurn {
  content: ChatBlock[]; // what the model said this turn: text and tool calls
  stop: "end" | "tool_use" | "max_tokens";
}

export interface ChatModel {
  // One turn: `system` (instructions, then context: the part to cache),
  // the conversation, and tools. Text streams through onText as it's
  // written.
  // `model` is the caller's choice for this question (e.g. "claude-haiku-5-5"),
  // a hint the implementation may map or ignore.
  chat(args: { system: string[]; messages: ChatMessage[]; tools: ChatTool[]; model?: string; maxTokens?: number; onText?: (delta: string) => void; signal?: AbortSignal }): Promise<ChatTurn>;
}

export interface AnthropicOptions {
  apiKey: string;
  model?: string; // default claude-sonnet-5-5
  baseURL?: string; // default https://api.anthropic.com
  retries?: number; // on 429, 529 and 5xx before streaming starts (default 3)
}

// Claude over the Messages API, streaming (server-sent events). The last
// system block (the context) is marked for prompt caching, so follow-ups
// about the same cards are cheaper and faster.
export function anthropicModel(options: AnthropicOptions): ChatModel {
  const url = `${(options.baseURL ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
  return {
    async chat({ system, messages, tools, model, maxTokens, onText, signal }) {
      const body = JSON.stringify({
        model: model ?? options.model ?? "claude-sonnet-5-5",
        max_tokens: maxTokens ?? 2048,
        stream: true,
        system: system.map((text, i) => ({ type: "text", text, ...(i === system.length - 1 && { cache_control: { type: "ephemeral" } }) })),
        messages,
        ...(tools.length && { tools }),
      });
      let response: Response | undefined;
      for (let attempt = 0; ; attempt++) {
        response = await fetch(url, {
          method: "POST",
          headers: { "x-api-key": options.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body,
          signal,
        });
        if (response.ok) break;
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < (options.retries ?? 3)) {
          const after = Number(response.headers.get("retry-after"));
          await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt));
          continue;
        }
        const detail = await response.text().catch(() => "");
        throw new Error(response.status === 401 ? "Anthropic: the API key was refused (ANTHROPIC_API_KEY)" : `Anthropic: ${response.status} ${detail.slice(0, 300)}`);
      }

      // Read the event stream: text deltas, and tool calls whose input
      // arrives as JSON in pieces.
      const content: ChatBlock[] = [];
      const partial = new Map<number, string>();
      let stop: ChatTurn["stop"] = "end";
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response!.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let i; (i = buffer.indexOf("\n\n")) >= 0; ) {
          const raw = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const data = raw.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
          if (!data) continue;
          const event = JSON.parse(data);
          if (event.type === "content_block_start") {
            const b = event.content_block;
            content[event.index] = b.type === "tool_use" ? { type: "tool_use", id: b.id, name: b.name, input: {} } : { type: "text", text: "" };
          } else if (event.type === "content_block_delta") {
            const block = content[event.index];
            if (event.delta.type === "text_delta" && block?.type === "text") {
              block.text += event.delta.text;
              onText?.(event.delta.text);
            } else if (event.delta.type === "input_json_delta") partial.set(event.index, (partial.get(event.index) ?? "") + event.delta.partial_json);
          } else if (event.type === "content_block_stop") {
            const block = content[event.index];
            if (block?.type === "tool_use") block.input = JSON.parse(partial.get(event.index) || "{}");
          } else if (event.type === "message_delta" && event.delta.stop_reason) {
            stop = event.delta.stop_reason === "tool_use" ? "tool_use" : event.delta.stop_reason === "max_tokens" ? "max_tokens" : "end";
          } else if (event.type === "error") {
            throw new Error(`Anthropic: ${event.error?.message ?? "stream error"}`);
          }
        }
      }
      return { content: content.filter(Boolean), stop };
    },
  };
}
