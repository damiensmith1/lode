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
                         containment: node.parent (a tree)
                         edges {calls, references, flows}
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

lode uses the `typescript` 5.x package for analysis. TypeScript 7 (the Go
port) doesn't expose the classic JS compiler API, but 5.x reads TS 7
projects fine (glance is one).

**Status:** the TS plugin (`src/ingest/ts`) emits raw facts: declarations
with stable ids (`<file>#<Outer.Inner>`, `ext:<package>#<name>` for
libraries) and call sites with resolved callee, argument types and return
type. On glance (43 files): 1224 declarations, 2823 calls, ~1.2s, under 1%
unresolved (IIFEs, dynamic `import()`, calls on `any`).

Findings that shape the next steps:

- **Literal channel keys come free.** The checker types `"terminal:data"` as
  a string literal, so tier 3 matching can read channel names from argument
  types. glance has ~300 IPC call sites.
- **Registered callbacks are nodes.** A function literal passed to a
  registration call (`on`, `handle`, routes, timers, effects, `onX`,
  `registerX`, …) becomes its own node, named after what it handles
  (`on:popup:hide`, or `setTimeout@L42` with no literal key). Calls inside it
  are credited to it, not to the code that registered it. Other callbacks
  (`.map(x => …)`) stay inside their parent. The list of registration calls
  lives in the TS plugin (`src/ingest/ts/registrations.ts`), not the core.
  On glance: 189 handlers, 118 of them IPC `handle` with channel keys.

### 2. Normalize

**Each plugin maps its own facts into the schema** (`src/schema`); the core
validates and indexes what it receives (`src/graph`). Mapping (e.g. TS
`MethodSignature` → `callable`) is language knowledge, so it lives in the
plugin. A plugin keeps its raw facts too, so mapping can be fixed without
re-parsing.

- **Containment is `node.parent`,** not an edge. It's a strict tree, so an
  edge kind would only duplicate it and risk the two disagreeing. Other
  hierarchies (lenses) are separate trees built in derive.
- **Library code is external nodes** (`ext:<package>#<name>`, no location),
  grouped under one container per package, so calls into libraries keep
  both ends.
- **Calls to locals and parameters** (a helper `const` inside a function, a
  callback passed in) aren't edges yet: the callee isn't a node. They're
  flagged in the facts (`localCallee`); they matter later for data flow.
- **`Graph.from` rejects** duplicate ids, unknown parents and dangling edges.
- **Traversal** is `neighbors(id, "up" | "down", kinds?)`: one hop, callers
  decide whether to keep going.

On glance: 1622 nodes (287 external), 2720 call edges, ~1s end to end.

### 3. Graph cache

Indexing is slow; opening a file must be instant. The current graph is held
in memory, saved to disk so a restart doesn't trigger a full re-index, and
patched when a file changes. No database in v1.

**Core** (`src/graph/store.ts`, `GraphStore`): knows nothing about languages.

- Saves one JSON file: plugin output (not derived edges, which are
  recomputed on load), a content hash per source file, and an opaque
  `pluginState` blob. Written atomically (temp file + rename).
- Lives in `~/.cache/lode/<project hash>/` by default, **never inside the
  indexed project**.
- `open()` loads the cache, re-hashes the project's files, and re-indexes
  only what changed, was added or was removed. No changes means the plugin
  never runs. `refresh()` does the same at any time; `rebuild()` is a full
  re-index.
- Invalidated by a change in cache format, plugin name or plugin `version`.
- Watching files is left to the consumer: it calls `refresh()`.

**Plugin side** (`LanguagePlugin.open` → `PluginSession`): `files()` returns
hashes, `update(changed)` re-indexes, `state()` returns what to persist. The
TS session (`src/ingest/ts/session.ts`) keeps per-file facts and the
program between updates:

- Re-extracts the changed files **plus the files that directly import
  them**, since their callee ids and argument types can change. Transitive
  effects of inferred types aren't followed; `rebuild()` catches those.
- A caching compiler host re-parses a file only when its text changed, so
  library `.d.ts` files (most of a program) are parsed once per session.
- Cross-file steps (channel wrapper resolution, external nodes) re-run over
  all cached facts on every update; they're cheap.

On glance: full index 1.2s; reopen with no changes **24ms**; one changed
file ~300ms warm (~0.9s for the first update after a cold start, which
builds the program). The remaining cost is TS's type checker, which is
rebuilt per program.

### 4. Derive

Deterministic analysis over the whole graph:

- **Flow edges**, by how a value moves from producer to consumer:
  1. *direct*: passed through a call or return (`enrich → dispatch`)
  2. *shared state*: written to and read from the same symbol
  3. *channels*: linked by a string key (IPC, events). Literal keys match
     exactly; computed keys are resolved to patterns (`topic:*:update`).

### Direct flows (tier 1)

A call's result flowing into another call, or out of the function:

```ts
function send(msg, bus) {
  const env = enrich(msg);   // enrich ──Envelope──▶ Bus.dispatch   (within send)
  bus.dispatch(env);
  return format(env);        // format ──string──▶ send             (within send)
}
```

- **Emitted by the plugin**, not derived in the core: it needs local def-use,
  which is syntax-level and language-specific (`src/ingest/ts/flows.ts`).
  The core only stores the edges.
- **Every tier 1 edge has `within`**: the node where the flow happens. Without
  it, `enrich → dispatch` would read as global when it only happens in `send`.
- **Followed:** nested calls, `await`, local `const`/`let` initializers
  (including destructuring and shorthand properties), property access,
  object/array literals, `??`/`||`/`&&`, ternaries, and method receivers
  (`env.save()` takes `env` as input). Returns include arrow expression
  bodies; a `return` inside an anonymous inner callback isn't credited to
  the enclosing function.
- **Not followed yet:** reassignment after the initializer
  (`let x; x = load()`), and values passing through parameters (that's what
  call edges' `args` already describe).
- One edge per producer per argument, so a value used in three properties of
  one argument is one edge.

On glance: 1691 tier 1 flow edges, 424 of them between project nodes (the
rest touch library code: `Map.set`, `Promise.then`, …).

### References and shared-state flows (tier 2)

- **The plugin emits `references` edges** (`src/ingest/ts/refs.ts`): a node
  using a value or a type without calling it. Each carries an `access`:
  - `write`: assignment, `++`/`--`, `delete`, assigning into it
    (`x.a = 1`, `x[k] = 1`), or a mutating method (`set`, `push`, `delete`, …)
  - `read`: any other use, including a function passed by reference
    (`register(setCurrent)`)
  - `type`: used in a type position (`(m: Message) => …`, `extends Base`)

  Targets are project code only; library use shows up as calls.
- **Module-level initializers flow into their variable**:
  `const cfg = readConfig()` is a tier 1 edge `readConfig → cfg`.
- **The core derives tier 2** (`src/derive/state.ts`): for every `value`
  node, each writer flows to each other reader, as a `flows` edge with
  `through: <value>`. This is generic: it only reads `references` edges.

On glance: 575 references (303 read, 103 write, 169 type) and 178 tier 2
flows. The busiest value is dictation's `state` (26 flows), so the
writers × readers product hasn't been a problem.

### Channel flows (tier 3)

Split between plugin and core:

- **The plugin knows frameworks.** It says which calls send and which
  receive, and emits `ChannelEndpoint`s: node, role, family, key, payload
  type. Families keep directions apart (Electron: `to-main`, `invoke`,
  `to-renderer`), so `ipcMain.on("x")` never matches `webContents.send("x")`.
  The table lives in `src/ingest/ts/channels.ts`.
- **The core only matches** (`src/derive/channels.ts`): same family and key
  gives a `flows` edge, `exact` for literals and `pattern` when either side
  is a pattern. When the sender awaits a reply (`invoke`), a second edge
  carries the handler's return type back.
- **Keys** are read from the checker's type for the key argument: literals,
  unions of literals (one endpoint each), template literals (patterns).
- **Wrappers are followed.** When the key is a parameter of the enclosing
  function (`sendToHud(channel, payload)`), the endpoint moves to each caller
  of the wrapper, keyed by the argument it passed, up to 3 levels deep.
- **Preload bridges are nodes.** Objects passed to
  `contextBridge.exposeInMainWorld` become containers, and their function
  members become callables, so `clance.onTerminalData` is a real endpoint.

On glance: 321 endpoints, 286 flow edges, every send matched a receiver.
The 5 receivers with no sender: 3 truly have none in TS, and 2 are sent
through a *local* wrapper (`const send = …` inside a function), which isn't a
node, so its key can't be followed. Known gap. Node `EventEmitter`
`emit`/`on` isn't modelled yet: it needs the emitter instance, not just a key.
- **Confidence** on every derived edge: literal match, pattern match, or
  model guess (model guesses come later and are tagged as such).
- **Hierarchies (lenses)**: variable-depth containment trees over the same
  nodes, e.g. folder and runtime (main vs renderer). An inferred concept
  lens comes later.

### Hierarchies (lenses)

A lens is a tree over the same nodes (`graph.lens(name)`: `parent`,
`children`, `roots`, `path`). Lenses only add group nodes above the
containment tree; they never change edges. Group ids are namespaced
(`dir:src/main`, `runtime:main`).

- **`containment`**: `node.parent` as is (file › class › method).
- **`folder`**: directories above top-level nodes, from their file path.
  Built in the core.
- **Tag lenses**: any `node.tags` key a plugin sets becomes a lens. The TS
  plugin tags file nodes with `runtime` (`src/ingest/ts/runtimes.ts`): a
  file is seeded `main`, `preload` or `renderer` by the Electron/DOM APIs it
  calls, and files without a seed inherit the runtime of the files that
  import them (`shared` when imported from more than one).

Imports are part of each file's facts, which also lets the session find a
changed file's importers from cached facts.

On glance: 40 files in `main` (including pure utilities, via importers), 3
in `preload`, none untagged. Glance's renderer code is plain JS outside the
TS project, so `renderer` doesn't appear.

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

- **Edge type labels for untyped code.** When callers pass different types
  into an unannotated parameter, what does the edge carry?
