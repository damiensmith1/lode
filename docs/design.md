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

### TypeScript and JavaScript

One plugin covers both, through the TS compiler (`src/ingest/ts`):

- **Projects** (`project.ts`): a `tsconfig.json`, a `jsconfig.json`, or a
  directory (its config if it has one, else plain-JS defaults). `allowJs` is
  always on, so a TS project's `.js` files are indexed too.
- **Vendored code is skipped**: files under `vendor/`, `third_party/` etc.,
  `*.min.js`, and anything with minified lines. It still loads as a library
  when imported, named by its path (`ext:src/shared/vendor/…#html`).
- **CommonJS**: `exports.x = …`, `module.exports.x = …` and
  `module.exports = {…}` at the top level are declarations (callable, value
  or container); `require("…")` is an import, not a call. Destructured
  imports (`const { f } = require("./m")`) resolve to the property's node.
- **JSDoc**: the checker reads JSDoc types for free (`@param`, `@returns`);
  `@typedef`/`@callback` become type nodes, and types referenced in JSDoc
  become `type` references.
- **Untyped code resolves less**: on glance's renderer JS, ~80% of calls
  resolve; the rest are methods on untyped values (`e.preventDefault()`),
  a natural place for a model to fill gaps later.

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
- **The bridge is a channel too** (family `electron-bridge`): each exposed
  member receives on key `api.member`, and renderer calls
  `window.api.member(…)` (or `api.member(…)` on an undeclared global, or via
  `const api = window.api`) send on it, awaiting the member's return value.
  That links renderer → preload → main end to end.

On glance: 286 IPC flow edges, every IPC send matched a receiver; plus 230
bridge calls from renderer JS, all matched to a bridge member (4 members
are never called).
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

Bridge calls (`window.api.x()`) also seed `renderer`, and imports include
`require()` and dynamic `import()`.

On glance: 40 files in `main`, 41 in `renderer`, 3 in `preload`, none
untagged.

## Views and hosts

Mockups of the target UX, using real data from the glance index:
[lode UX mockups](https://claude.ai/artifact/HtcZBCmXu8LkFT9yNSQ9tq).

### What's built

```
GraphStore ─▶ Queries (src/query) ─▶ server (src/server) ══ JSON-RPC / WebSocket ══▶ views (views/) ─▶ host
                                       lode serve | lode open                          <lode-flow>       standalone app
                                                                                       <lode-entries>    (hosts/app)
```

- **Queries** (`src/query`): deterministic, from the graph alone:
  `info`, `files`, `search`, `entries`, `block(id)`, `symbolAt(file,
  line)`, `source(file)` (text + inline annotations + symbols), plus
  `map(lens, parent?)` and `graph(lens)` (lens overviews; no view uses them
  now, but they stay for the query layer and MCP). Results are plain
  JSON (`src/query/types.ts`), the only thing views depend on.
- **Server** (`src/server`): JSON-RPC over a WebSocket at `/rpc`, localhost
  only; watches the project and pushes `changed` after re-indexing.
  Optionally serves a host's static files. Since it serves source code, a
  WebSocket must carry the session's random token (`/rpc?token=…`), come
  from an allowed Origin (none for non-browser hosts; hosts can add theirs),
  and name a localhost Host (blocks DNS rebinding). The standalone app gets
  the token in the URL fragment, which never goes over HTTP. `source` checks
  real paths, so symlinks can't escape the project.
- **Views** (`views/`): framework-free web components with shadow DOM,
  themed by `--lode-*` CSS custom properties from the host:
  `<lode-entries>` (where to start) and `<lode-flow>` (reading).
  Wires are measured from the laid-out DOM, so layout stays plain CSS.
  Hosts may detach and reattach a view (switching tabs does), so a view
  builds its DOM and listeners once; reattaching only resubscribes.
- **Map, graph and focus were removed.** Map (one lens level at a time,
  merged edge counts) and graph (a zoomable tree of the whole project)
  answered "what are the parts and how do they talk", but boxes with counts
  didn't say what anything does or where to start, and took clicks to reach
  readable code. Their one useful fact, how the runtimes talk, is the
  entries view's summary line.
- **Focus** It showed one symbol's steps and links as names;
  flow shows the same links on the real code (callers in each block header,
  calls / IPC / state as chips on lines), so focus added nothing.
- **Host contract** (`views/host.ts`; how-to in `embedding.md`): lode
  provides the mechanics (cards, arrows, folds, paging, drag, zoom, select,
  undo) and the host everything around them. A host passes a connection
  (`LodeConnection`: `call`, `onChanged`) and a `LodeHost` (`openView`,
  optional `openSource`, `highlight`, `syntax`/`syntaxCss`, `storage`,
  `css`) and listens for `lode-title` to name tabs. That's all an adapter
  (VS Code, Clance) has to implement. Without `openSource` (the standalone
  app has no editor), a card's title opens its file as a card to its left,
  with an arrow from the line where the card's code starts. `highlight`
  reports the lines a view is about; the host decides how to show them,
  which in an IDE maps to editor decorations.
- **Transport is the host's.** The core's methods live in a service with no
  transport (`src/service`). The WebSocket server is one way to reach it;
  `serveMessages` + `MessageConnection` are another, over any message
  channel (a webview's postMessage, Electron IPC), with no server or port.
- **State is the host's.** Each flow saves its canvas (cards, arrows,
  camera, selection) under its own key (`ViewRequest.state`) in
  `host.storage`: lode's cache through the connection by default, or
  localStorage, memory, or the host's own store. The standalone app keeps
  any number of flow tabs this way, plus its tab list (`app-tabs`); the
  first flow keeps the key `flow`, so canvases saved before tabs still load.
- **Interaction is the host's too.** Every click and key action is
  announced first as a cancelable `lode-action` (a host can take any over,
  e.g. open chips in its editor), and the flow reports `lode-select`,
  `lode-open`, `lode-close`, `lode-change`. Hosts drive it with `show`,
  `run(command)`, `cards()`, `selection()`, `setSelection()`. Keys map to
  commands through `host.keys` (remap, `[]` for one off, `false` for all
  off); defaults are Delete/Backspace and Mod+Z. Cards take host markup
  through `host.render` (header, footer, per line, chip labels), with
  `data-action="host:…"` for the host's own buttons.
- **Around the views.** `lodeApi(connection)` types the calls a host needs
  for its own file tree, search, status or "symbol at cursor", and
  `buildFileTree` turns the file list into folders. `service.watch()`
  re-indexes on file changes (the server's `watch` uses it), and views and
  the app's tree update from `onChanged`.
- **Editing in place.** A card's code is always editable (no edit mode):
  what's visible is what's editable. Visible lines form runs (contiguous in
  the file; folds and the paging cut end one), and no edit crosses runs,
  so hidden lines are never touched. The card's own rows are the editor
  (views/editing.ts), not CodeMirror, so folds, chips, arrows and callers
  stay as they are: typing within a line is the browser's; Enter, joins,
  pastes and multi-line deletes rebuild a run's rows. ⌘S saves through
  `editFile` (or `host.saveEdits`) with each changed run's original lines,
  refused if the file no longer matches; it re-indexes, so the graph
  follows. After a save the card isn't redrawn while the caret is in it:
  it keeps its rows, renumbered to the file and taken as the new base, so
  undo can go back past the save (as unsaved edits). Leaving the code
  refreshes it from the file; its undo history stays only if the fresh
  card shows the same lines in the same runs (a saved line that now folds
  away ends it). Unsaved cards show it, keep their rows through re-renders, and
  can't be closed, folded or paged until saved or discarded. Selection
  gestures (⌘-click, header) take the caret out of code so keys act on
  cards again.
- **Git changes.** `changes(base)` runs `git diff -U0 -M <base>` (with
  `--end-of-options`, the ref validated) plus untracked files, under the
  project root, and maps each changed line to the symbol it's in: the
  deepest declaration that isn't nested in a function, a type's member or
  a class field (so methods, not their callbacks; interfaces, not their
  properties), else the file. Removed lines count toward what follows
  them. A changes view lists files → symbols with +/− and opens them in a
  flow with the diff shown; "open all" puts every changed symbol in a new
  flow, laid out as one: they link up where they call each other, each
  connected group in columns of call steps (callers left of what they
  call, next to their callers), groups packed in rows (biggest first) to
  about the view's shape. While a diff is shown, chips and callers that
  lead to a changed symbol carry a green dot, so changes can be followed
  card to card. Linking skips calls made inside a nested declaration
  (they're that declaration's) and cards inside one another, so a class
  card doesn't unroll to reach its own methods. Every card has "expand":
  all its lines, plus everything it leads to one level down (its own
  lines' chips and its outermost nested declarations; calls inside those
  are theirs), opened beside it in one go, undoable as one step. A card whose folds hide
  changes offers "open N changes →" to open them all beside it at once.
  Cards arriving while changes are shown open at them (down to the last
  changed line, small folds holding changes opened), not at their top. Cards show added/changed lines, removed lines as struck-through
  read-only rows where they were (outside editing's runs), and mark folds
  and paging that hide changes. Both refresh on re-index, so an agent's
  work shows up live. A flow's diff setting is part of its saved state.
- **Not just code.** The file list is every project file (git's tracked
  and untracked, not ignored), not just the graph's; files outside the
  graph read as text cards (Markdown headings as folds) that can be edited
  and diffed, and their changes reach views through the watcher even
  though nothing re-indexes. The standalone app's sidebar toggles between
  files and changes: changed files that drop down into the changed
  declarations as a hierarchy (a class over its methods), with the
  "since" ref and "open all" at the top and a count on the toggle.
- **Look is the host's.** Every colour and font is a `--lode-*` token with
  its default as a `var()` fallback, so a host sets tokens on any ancestor
  (declaring defaults on `:host` would shadow inherited ones). Syntax
  colours are tokens too. `LIGHT_THEME` / `DARK_THEME` / `themeCss` are
  exported; pieces carry `part` names for `::part()`; `host.css` goes last
  inside every view for the rest.
- **Packaging.** `npm run build`: `dist/lib` (ESM + .d.ts for core, server,
  views, the app), `dist/app` (the app prebuilt, which an installed
  `lode open` serves), `dist/views` (self-contained bundles for pages
  without a bundler). Exports: `lode`, `lode/server`, `lode/views`,
  `lode/views/highlight`, `lode/views/bundle`. Checked by installing the
  packed tarball into an empty project and running a host from it.
- **No separate code pane.** It was dropped: the flow reads code better, and
  the one thing the pane did that the flow didn't, reading a file's
  top-level code, is now how a file block works. A file opens in the flow as
  the whole file: top-level code in full (imports folded when long), each
  function or class folded to its first line with a chip to open it, any
  fold expandable, top-level calls / IPC / state writes as chips. The
  `source` query and annotations stay in the core for IDE adapters, where
  the host's own editor is the code pane. Nothing moves on its own; only
  clicks navigate.
- Declarations record their **end line** (`loc.endLine`) for ranges.
- **Flow view: code as nodes** (`<lode-flow>`, the app's first tab). The
  graph views showed structure but didn't make code readable: a box saying
  `startRecording()` says nothing the name doesn't, so reading still
  happened in the code pane. Here the nodes *are* the code. Blocks of real
  code sit in columns, left to right; a line that leads somewhere (a call,
  IPC, a shared-state write) carries a chip, and clicking it opens that code
  in the next column, lined up with the line, with an arrow from it
  (Finder-style: opening from column i replaces what's right of it). The
  first block lists its callers; clicking one re-roots the flow upstream.
  Long bodies fold down to the lines that lead somewhere (±1 line), comment
  runs fold, and any fold opens on click. With the flow tab showing, the
  code pane steps aside. Backed by the `block(id)` query: a node's lines,
  its outgoing links by line (including from callbacks inside it), and its
  callers with the calling line; files come back as an outline of members.
  Prior art: Code Bubbles and the Haystack editor; lode's difference is that
  the graph picks which blocks and lines matter. Next idea: a model-written
  one-line summary above each block.
- **Cards one level deep.** A card is a node, or a range inside one (a
  fragment, titled `startRecording › sendToHud(…)`). It shows its code one
  level deep: every nested region (if/loop/try bodies, callbacks, multi-line
  literals and argument lists, comment runs, imports) folds to its header
  line, with the fold as a `⋯ n lines` button on that line, so folds cost
  no height. Regions hiding 3 lines or fewer never fold (they're just shown);
  comment runs and imports open in place; bigger regions open the next card: a nested declaration's own card when the
  region is exactly its body, otherwise a fragment. An anonymous fold
  carries up to 3 chips from inside it (then "+N inside"). Regions come from
  the TS plugin (`src/ingest/ts/regions.ts`) as plain line ranges on the
  graph (`Region`), so the core stays language-agnostic. On glance,
  `startRecording` goes from 35 lines to 17, `handleAudio` from 97 to 17.
  A card shows 25 lines, then "show 25 more", "show all" and, once past
  25, "⌃ collapse" (back 25, or to the first 25 when fully shown;
  expanding a fold in place grows the card by the lines it reveals, and its
  header line keeps a "⌃ collapse" button), and
  always at least down to the line the next card was opened from, so its
  arrow has an anchor. Long flat files (index.ts: runs of one-line
  `ipcMain.handle(…)`) lean on that; grouping runs of similar statements is
  a next step.
- **What leads here, on every block.** Tried a focus panel beside the flow
  that followed the selected block; it duplicated the flow and was dropped.
  Who reaches this code now sits in every block's header: callers, IPC senders, code passing it as a callback ("passes
  it"), writers of a value, users of a type. Clicking one puts it to the
  left of that block with an arrow from the calling line; the one already
  open to the left is marked. Passing a function (`rows.map(toTranscript)`)
  is also a chip on the passing line. Long caller lists show 4 and a
  "+N more" chip that expands into a short scrolling list.
- **Replies aren't links.** A request that awaits a reply (IPC `invoke` →
  `handle`, renderer → bridge member) also has an edge carrying the return
  value back; those are marked `reply` and left out of chips, "used by",
  annotations and summaries. Otherwise following a call led straight back
  to the caller. A registered callback with no callers says what runs it
  ("runs on addEventListener drop").
- **The flow is a canvas.** Cards sit at positions, not in one chain.
  Opening a chip, fold or caller adds a card beside its source (to the
  right; callers to the left), level with the line, nudged down until it
  overlaps nothing, with an arrow from that line. Opening from several
  places branches; opening something already on the canvas adds an arrow to
  the existing card and goes to it (no duplicates). A card that arrives
  (opened fresh or again, from anywhere) gets arrows to the cards already
  on the canvas that it calls and from those that call it, from the first
  line that does; whole-file cards don't, or they'd point at everything. Entry points, search and
  the file tree add new trees below what's open. Cards drag by their header
  and arrows follow. × closes just that card (the cards it opened
  stay; to close a branch, ⌘-click its cards and press Delete). ← is undo: it reverses the last open, close, move, fold or "show
  more".
- **Camera.** The canvas is a viewport over a transformed board: scrolling
  (two fingers, or the wheel; shift for sideways) pans, a pinch or
  ⌘-scroll zooms around the pointer (20–200%), dragging empty space pans, dragging a card's header moves the card (scaled, so it tracks the
  pointer at any zoom). Going to a card pans only if it's off screen. The
  toolbar shows the zoom (click for 100%), "fit" (every card in view, at
  most 100%) and "focus" (brings the selected
  card to the left of the view at up to 100%; off when nothing is selected).
  ⌘-click adds a card to the selection (or takes it out); a plain click
  selects just that card. Focus, fit (with two or more selected), Delete
  and dragging a header act on the whole selection. Ctrl-click is kept free
  for right-click. The camera is saved
  with the layout, in canvas coordinates; a startup link to a card that's
  already on the restored canvas selects it without moving the view.
  Panning and moving cards never select text. Keys (while the flow is
  showing, not while typing in a field): Delete/Backspace closes the
  selected cards (like ×, the cards they opened stay), ⌘Z / Ctrl+Z undoes.
- **Layouts are saved with the project.** The server keeps a view's layout
  (`loadLayout` / `saveLayout`, `layout-<name>.json` in the project's cache
  dir, name-checked and size-capped), so it survives restarts in any host;
  the browser's storage wouldn't (each `lode open` gets a new port, so a new
  origin). The flow saves after every change: cards (node, range, folds,
  position) and arrows. On load, blocks are refetched and cards whose node
  is gone are dropped. Undo history isn't saved.
- **Host syntax hook**: hosts may pass `syntax(text, file)` (escaped HTML per
  line) and `syntaxCss`; views put the CSS inside their shadow root. Views
  never bundle a highlighter.
- **Entry points view** (`<lode-entries>`, the app's first tab): where to
  start reading. The `entries` query lists what the outside world calls
  into, by runtime and kind: files that run code on load, IPC handlers,
  messages from main, the preload bridge API, other registered callbacks
  (app events, hotkeys, UI listeners; timers and tests left out), and,
  folded, functions nothing in the project reaches (a framework, HTML or
  the outside calls them). All from data lode already had: channel
  endpoints (now kept on `Graph`), registrations, call edges. A summary line
  says how the runtimes talk (`preload ⇄ renderer · 460 calls`). Filter by
  text; clicking an entry starts the flow there. Next idea: a model-written
  one-line summary per entry.
- **Standalone host** (`hosts/app`): entry points and flow tabs, a file tree
  (a file opens in the flow), syntax colours
  (highlight.js, Clance's palette; a host concern, so not in views) and ◇
  annotations,
  lode views in tabs on the right, file tree, symbol search, deep links
  (`#flow=<id>` or `#file=<path>`). `lode open <project>` builds it
  with esbuild and opens it.

Not built yet: trace (needs the query layer), impact, inline annotations
and SCM hooks in a real IDE (need a host adapter).

### Target UX

lode runs as a plugin inside an IDE-like host. The host owns its chrome
(activity bar, explorer, source control, editor tabs, status bar); lode
contributes views through four integration points:

- **Tabs**: each view opens as its own editor tab with its own toolbar
  (view switch, lens, ask box), so it is self-contained and portable.
- **Inline annotations** in the host's editor, CodeLens-style:
  `⟶ sendToHud`, `9 readers`, `ipc ⇢ onStart`.
- **A sidebar panel**: ask box, recent questions, open views.
- **Source control action**: "show impact" on a changed file.

The four views:

1. **Focus**: one symbol expanded (its steps and local flows), what feeds it
   above, what it feeds below (IPC, shared state, helpers), collapsed by
   default. Opened beside the source file.
2. **Trace**: a question's answer as a path across runtime lanes
   (renderer → preload → main), requests down, replies back up with their
   types; off-path nodes collapsed but one click away.
3. **Impact**: a change fanned out to its callers grouped by file, plus hops
   across process boundaries the typechecker can't see.
4. **Map**: zoomed out to a lens (runtimes), edges merged between groups and
   labelled with counts.

Visual encoding, one per edge kind: calls solid grey, local flow blue, IPC /
bridge orange dashed, shared state purple dotted. Collapsed nodes are dashed
outlines; library code is hidden behind a toggle.

### Package layout (idea)

```
lode-core      graph, plugins, derive, cache (this repo today)
lode-query     query layers: deterministic cut + model-scored (Jev / LLM)
lode-views     framework-free view components (entries, flow; impact later)
lode-<host>    thin adapters: VS Code first, Clance later
```

Views depend on core and query only through their public APIs; an adapter
only maps host concepts (open tab, editor decorations, sidebar, SCM action)
onto view mounts.

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
