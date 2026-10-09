# Requirements

Scope for v1 is **the core only**: building the lode graph. Consumers come
later.

## Functional

- **Index TypeScript and JavaScript codebases** into the lode graph
  (ESM, CommonJS, JSDoc). Clance is the first target.
- **Resolve names across files**, so every use of a symbol links to its one
  declaration.
- **Normalize to a common schema** of node kinds (container, callable, type,
  value, block), containment, and edge kinds (calls, references, flows).
- **Source location on every node and edge.**
- **Flow edges labelled with the data type they carry**, where it's known.
  - tier 1: direct calls and returns
  - tier 2: shared state (writes and reads of the same symbol)
  - tier 3: string-keyed channels (IPC, events), literal and pattern matched
- **Confidence on every derived edge.**
- **Hierarchies** of variable depth over the nodes, at least a folder lens
  and a runtime lens.
- **Traversal**: from any focus, walk up (what feeds it) and down (what it
  feeds) one hop at a time, with no built-in stopping point.

## Non-functional

- **Deterministic.** Same code in, same graph out. No models in the core.
- **Language-agnostic core.** Language specifics live only in plugins;
  adding a language must not change the core.
- **Buy, don't build, compiler work.** Parsing, resolution and type
  inference come from existing tools.
- **Incremental.** A file change patches the graph rather than re-indexing.
- **Persistent.** The graph survives restarts without a full re-index.
- **Verifiable.** Graph correctness is checked by tests against known facts
  about Clance (e.g. "edge `enrich → dispatch` exists and carries
  `Envelope`").

## Out of scope for v1

- Query layer (Jev / LLM relevance scoring)
- UI and views
- MCP tooling
- Diffs
- Exports (e.g. Mermaid)
- Languages other than TypeScript and JavaScript
- Inferred concept hierarchy

## Status (core MVP)

Done, tested on fixtures and on glance (84 files, TS + JS: ~2900 nodes,
~9700 edges, ~2.3s full index, ~50ms cached reopen):

- TypeScript and JavaScript ingest (ESM, CommonJS, JSDoc; vendored bundles
  skipped) with cross-file name resolution and source locations
- Schema with node kinds, containment, calls / references / flows edges
- Flow edges: tier 1 (local), tier 2 (shared state), tier 3 (channels, with
  wrapper following); confidence on derived edges
- Electron preload bridge: renderer `window.api.x()` → bridge member → main
- Lenses: containment, folder, runtime (main / preload / renderer / shared)
- One-hop traversal up and down
- Persistent cache with incremental per-file updates
- CLI: `index`, `node`

Known gaps:

- Untyped JS resolves ~80% of calls; methods on untyped values don't resolve.
- Channel keys passed through *local* wrappers inside functions.
- Node `EventEmitter` `emit`/`on` channels.
- Reassignment-based local flows (`let x; x = load()`).
- Importer-based invalidation is one level deep; `rebuild()` catches the rest.
