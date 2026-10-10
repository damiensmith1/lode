// What asking needs from a model: typed judgments over a state, many at a
// time. Jev (TypeSafe's System One model) is the default; anything that can
// answer these three question types (an LLM, a heuristic) can stand in.

export type JudgeQuestion =
  | { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "score"; instructions: unknown; criteria: unknown[] };

export type JudgeAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

export interface Judge {
  // Every question is answered against the same state, independently.
  ask(state: unknown, questions: Record<string, JudgeQuestion>): Promise<Record<string, JudgeAnswer>>;
}

export interface JevOptions {
  apiKey: string;
  model?: string; // default "jev-latest"
  baseURL?: string; // default https://api.typesafe.ai
  timeoutMs?: number; // per attempt, default 30s
  retries?: number; // on 429, 529 and 5xx, default 3
}

// Jev over its HTTP API (POST /v1/systemone). Retries rate limits and
// overloads with backoff, honouring retry-after.
export function jevJudge(options: JevOptions): Judge {
  const url = `${(options.baseURL ?? "https://api.typesafe.ai").replace(/\/+$/, "")}/v1/systemone`;
  const retries = options.retries ?? 3;
  return {
    async ask(state, questions) {
      for (let attempt = 0; ; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
        let response: Response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ model: options.model ?? "jev-latest", state, questions }),
            signal: controller.signal,
          });
        } catch (error) {
          clearTimeout(timer);
          if (attempt < retries) {
            await sleep(backoff(attempt));
            continue;
          }
          throw new Error(`Jev unreachable: ${error instanceof Error ? error.message : String(error)}`);
        }
        clearTimeout(timer);
        if (response.ok) return ((await response.json()) as { answers: Record<string, JudgeAnswer> }).answers;
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < retries) {
          const after = Number(response.headers.get("retry-after"));
          await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : backoff(attempt));
          continue;
        }
        const detail = await response.text().catch(() => "");
        throw new Error(response.status === 401 ? "Jev: the API key was refused (TYPESAFE_API_KEY)" : `Jev: ${response.status} ${detail.slice(0, 300)}`);
      }
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number) => 400 * 2 ** attempt + Math.random() * 200;
