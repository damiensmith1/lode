// lode's core, for a host running Node (an editor extension, an Electron
// main process, a CLI): read a folder into a graph, query it, and answer
// views. The views live in "lode-graph/views"; the WebSocket server in
// "lode-graph/server".
//
//   import { GraphStore, pluginFor, createService, serveMessages } from "lode-graph";
//   const store = GraphStore.open(await pluginFor(folder), folder);   // any folder
//   const service = createService(store);
//   serveMessages(service, { send, listen });           // e.g. a webview
export { GraphStore, type StoreOptions } from "./graph/store.js";
export { Graph, type Direction } from "./graph/graph.js";
export { tsPlugin } from "./ingest/ts/index.js";
export { pluginFor, combinePlugins, rubyPlugin, railsPack, treeSitterPlugin, loadParser, type RubyPack, type RubyProject, type TreeSitterLanguage } from "../plugins/index.js";
export { Queries } from "./query/index.js";
export { createService, serveMessages, type LodeService, type ServiceOptions } from "./service/index.js";
export { askFlow, lexicalCandidates, type AskOptions } from "./ask/index.js";
export { contextFor, type ContextItem, type ContextRequest, type ContextResult } from "./context/index.js";
export { explain, type ExplainEvent, type ExplainRequest, type ExplainResult } from "./explain/index.js";
export { openaiModel, type OpenAIOptions } from "./explain/openai.js";
export { chooseModel, parseModelList, providersFromEnv, type ExplainProvider, type ExplainProviders, type ModelChoice } from "./explain/providers.js";
export { anthropicModel, type AnthropicOptions, type ChatBlock, type ChatMessage, type ChatModel, type ChatTool, type ChatTurn } from "./explain/model.js";
export { jevJudge, type Judge, type JudgeAnswer, type JudgeQuestion, type JevOptions } from "./ask/judge.js";
export { ENV_KEYS, loadEnv } from "./ask/env.js";
export type * from "./schema/index.js";
export type * from "./query/types.js";
export type { NodeKind } from "./schema/index.js"; // the same in both
