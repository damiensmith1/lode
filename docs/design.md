# Design

## Core architecture

The core is **the lode graph**, built by **the lode indexer**. Everything
else (query layer, views, MCP, exports) is a consumer of the graph.

```
            ┌───────────── consumers (not core) ─────────────┐
            │  query layer (Jev/LLM) · views · MCP · export   │
            └───────────────────────┬────────────────────────┘
                                    │ traverse(focus, up|down, hop by hop)
════════════════════════════════════╪═══════════════ CORE ══════
4. DERIVE        flow edges: tier 1 calls · tier 2 shared state · tier 3 channels
                 hierarchies: folder lens · runtime lens
                                    ▲
3. GRAPH CACHE   current graph in memory · saved to disk · patched per file
                                    ▲
2. NORMALIZE     schema: nodes {container, callable, type, value, block}
                         edges {contains, calls, references, flows}
                         every edge: data type?, confidence, location
                                    ▲  raw facts
1. INGEST        per-language plugin (bought + thin adapter)
                 TS: compiler API (symbols, types) · tree-sitter (channel patterns)
```

### Rules

- **The core is deterministic.** Models (Jev, LLMs) only live above the line.
- **The schema is the contract.** Nothing above layer 2 knows which language
  it's looking at.
- **Raw and derived facts are stored separately,** so analysis can be fixed
  and re-run without re-indexing.
- **The core exposes traversal, not views.** Where a trace stops is decided
  by the query layer.

## Layers

### 1. Ingest

One plugin per language. Compiler work (parsing, name resolution, type
inference) is bought, not built:

- **TS compiler API**: symbols, resolved references, types at call sites.
- **tree-sitter**: syntax patterns the compiler doesn't model, e.g. string-keyed
  channels like `ipc.send('topic:update', …)`.
- **SCIP / LSP**: the route to other languages later.

### 2. Normalize

Maps plugin output into lode's language-agnostic schema. Every node and edge
keeps its source location so it can be traced back to the code.

### 3. Graph cache

Indexing is slow; opening a file must be instant. The current graph is held
in memory, saved to disk so a restart doesn't trigger a full re-index, and
patched when a file changes. No database in v1.

### 4. Derive

Deterministic analysis over the whole graph:

- **Flow edges**, by how a value moves from producer to consumer:
  1. *direct*: passed through a call or return (`enrich → dispatch`)
  2. *shared state*: written to and read from the same symbol
  3. *channels*: linked by a string key (IPC, events). Literal keys match
     exactly; computed keys are resolved to patterns (`topic:*:update`).
- **Confidence** on every derived edge: literal match, pattern match, or
  model guess (model guesses come later and are tagged as such).
- **Hierarchies (lenses)**: variable-depth containment trees over the same
  nodes, e.g. folder and runtime (main vs renderer). An inferred concept
  lens comes later.

## Build vs buy: existing code graphs

Joern (code property graph) and CodeQL were considered as the core and
rejected:

- **Batch, not incremental.** Builds take minutes; lode must update per file.
- **Licensing.** CodeQL is not free for closed-source commercial use.
- **Wrong level.** Statement-level graphs with no hierarchy or rolled-up
  flows; Joern's TS support is weak.

They remain useful as **reference oracles** to check lode's flow edges
against.

## Open decisions

- **Ingest/normalize boundary.** Do plugins emit lode's schema directly, or
  raw facts (symbols, occurrences, types) that the core maps?
- **Where channel matching lives.** IPC conventions are framework-specific,
  not language-specific: core derive, or plugins?
- **Edge type labels for untyped code.** When callers pass different types
  into an unannotated parameter, what does the edge carry?
