import { anthropicModel, type ChatModel } from "./model.js";
import { openaiModel } from "./openai.js";

// Providers for explaining: each a ChatModel plus the models it offers. A
// question names its model as "provider:model" ("anthropic:claude-haiku-5-5",
// "openrouter:meta-llama/llama-3.1-70b-instruct"), so the same model id can
// come from two providers (Claude direct, or Claude through OpenRouter).

export interface ExplainProvider {
  label: string; // shown in the picker: "Anthropic", "OpenRouter"
  model: ChatModel;
  models: { id: string; label: string }[]; // the provider's own ids (no prefix)
}

export type ExplainProviders = Record<string, ExplainProvider>;

export interface ModelChoice {
  provider: string;
  model: string; // the provider's id for it
}

// "id=Label, id=Label" (ids may hold "/" and ":").
export function parseModelList(text: string | undefined): { id: string; label: string }[] {
  return (text ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const at = s.indexOf("=");
      const id = (at < 0 ? s : s.slice(0, at)).trim();
      return { id, label: (at < 0 ? "" : s.slice(at + 1)).trim() || id };
    });
}

// Every provider the environment has a key (or address) for:
//   anthropic   ANTHROPIC_API_KEY; LODE_ANTHROPIC_MODELS (default Sonnet, Haiku, Opus)
//   openai      OPENAI_API_KEY and/or OPENAI_BASE_URL (any compatible server); LODE_OPENAI_MODELS
//   openrouter  OPENROUTER_API_KEY; LODE_OPENROUTER_MODELS
// OpenAI-compatible providers need their models listed (lode can't guess
// ids); one without a list is left out, with a note saying what to set.
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): { providers: ExplainProviders; notes: string[] } {
  const providers: ExplainProviders = {};
  const notes: string[] = [];
  if (env.ANTHROPIC_API_KEY) {
    const models = parseModelList(env.LODE_ANTHROPIC_MODELS);
    providers.anthropic = {
      label: "Anthropic",
      model: anthropicModel({ apiKey: env.ANTHROPIC_API_KEY }),
      models: models.length ? models : [{ id: "claude-sonnet-5-5", label: "Sonnet" }, { id: "claude-haiku-5-5", label: "Haiku" }, { id: "claude-opus-5-5", label: "Opus" }],
    };
  }
  if (env.OPENAI_API_KEY || env.OPENAI_BASE_URL) {
    const models = parseModelList(env.LODE_OPENAI_MODELS);
    if (models.length)
      providers.openai = {
        label: env.OPENAI_BASE_URL ? "OpenAI-compatible" : "OpenAI",
        model: openaiModel({ apiKey: env.OPENAI_API_KEY, model: models[0].id, ...(env.OPENAI_BASE_URL && { baseURL: env.OPENAI_BASE_URL }) }),
        models,
      };
    else notes.push("OpenAI: set LODE_OPENAI_MODELS (id=Label, …) to offer its models");
  }
  if (env.OPENROUTER_API_KEY) {
    const models = parseModelList(env.LODE_OPENROUTER_MODELS);
    if (models.length)
      providers.openrouter = {
        label: "OpenRouter",
        model: openaiModel({ apiKey: env.OPENROUTER_API_KEY, model: models[0].id, baseURL: "https://openrouter.ai/api/v1", headers: { "X-Title": "lode" } }),
        models,
      };
    else notes.push("OpenRouter: set LODE_OPENROUTER_MODELS (id=Label, …) to offer its models");
  }
  return { providers, notes };
}

// Which provider and model a request means. `ref` is "provider:model", or
// a bare model id (the first provider offering it); none: `fallback`, else
// the first provider's first model.
export function chooseModel(providers: ExplainProviders, ref: string | undefined, fallback?: string): ModelChoice | null {
  const names = Object.keys(providers);
  if (!names.length) return null;
  const parse = (r: string): ModelChoice | null => {
    const at = r.indexOf(":");
    const prefix = at > 0 ? r.slice(0, at) : "";
    if (prefix && providers[prefix]) return { provider: prefix, model: r.slice(at + 1) };
    const offering = names.find((n) => providers[n].models.some((m) => m.id === r));
    return offering ? { provider: offering, model: r } : null;
  };
  if (ref) return parse(ref);
  const first = providers[names[0]];
  return (fallback && parse(fallback)) || { provider: names[0], model: first.models[0]?.id ?? "" };
}
