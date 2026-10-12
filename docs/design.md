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
                         edges {calls, references, flows, imports}
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
                                                                                       lodeApi           (hosts/app)
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
- **Lode core vs host.** lode gives the pieces; a host builds the
  features. The flow is only the canvas (cards, arrows, folds, editing,
  undo, keys), with every action a method or command and every change an
  event; everything around it is the host's, built on `lodeApi` and the
  flow's API: tabs, the file tree, entry points, the changes list, the
  flow's toolbar and question line, the keys help, copy context, the
  explain UI, creating and renaming files. The standalone app builds all
  of those as the example (`hosts/app`); a host can show the same things
  differently (an explain overlay, notes in cards) without touching lode.
  Features that were in the views by mistake (the explain panel, the
  toolbar, the banner, the help overlay, `<lode-entries>` and
  `<lode-changes>`) moved to the app.
- **Views** (`views/`): `<lode-flow>`, a framework-free web component with
  shadow DOM, themed by `--lode-*` CSS custom properties from the host.
  Wires are measured from the laid-out DOM, so layout stays plain CSS.
  Hosts may detach and reattach a view (switching tabs does), so a view
  builds its DOM and listeners once; reattaching only resubscribes.
- **Map, graph and focus were removed.** Map (one lens level at a time,
  merged edge counts) and graph (a zoomable tree of the whole project)
  answered "what are the parts and how do they talk", but boxes with counts
  didn't say what anything does or where to start, and took clicks to reach
  readable code. Their one useful fact, how the runtimes talk, is the
  entry points' summary line.
- **Focus** It showed one symbol's steps and links as names;
  flow shows the same links on the real code (callers in each block header,
  calls / IPC / state as chips on lines), so focus added nothing.
- **Host contract** (`views/host.ts`; how-to in `embedding.md`): lode
  provides the mechanics (cards, arrows, folds, paging, drag, zoom, select,
  undo) and the host everything around them. A host passes a connection
  (`LodeConnection`: `call`, `onChanged`) and a `LodeHost` (`openView`,
  optional `openSource`, `highlight`, `syntax`/`syntaxCss`, `storage`,
  `css`, `empty`) and names tabs itself (from `flow.asked` and
  `flow.cards()`). That's all an adapter
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
  `host.storage`, which is opt-in (without it nothing is saved): lode's
  cache through the connection (`serviceStorage`), localStorage, memory,
  or the host's own store. The standalone app keeps
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
- **Editing in place.** A card's code is editable after Enter (an edit
  mode per card; Esc or the caret leaving ends it, edits kept; clicks
  only move the line cursor, so reading never types by accident):
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
  them. The app's changes sidebar lists files → symbols with +/− and opens them in a
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
- **The standalone app's sidebar** looks like Clance's Files pane:
  chevrons, Material Icon Theme icons (`hosts/app/file-icons`, MIT, the
  subset Clance ships), a header that switches between files (the project's
  folder) and changes (a branch icon with the count), and a width you set by
  dragging its edge (kept per browser). Changes rows read like Clance's:
  status letter, the folder dimmed, the file name, and +/− counts. Creating,
  renaming and importing files is the host's job (Clance's Files tree);
  lode re-indexes what appears and opens a file as an editable card on
  request (`flow.show(path)`, then `flow.run("edit")`).
- **Keyboard.** Outside code the flow is navigable: a line cursor in the
  selected card (outlined; clicks and Esc-from-code set it) that moves by
  line, follows a line's chip (Tab chooses) or fold, goes back along the
  arrow it came by, steps cards in reading order (each tree top to bottom,
  depth first along arrows in line order), and steps git changes hunk by
  hunk, opening folds and paging to reach them. Every key is a command in
  `host.keys`, so hosts remap or drop them; `?` lists the current ones.
  Search is the host's (sent as an action). Enter edits at the cursor; in
  code, keys type.
- **Look is the host's.** Every colour and font is a `--lode-*` token with
  its default as a `var()` fallback, so a host sets tokens on any ancestor
  (declaring defaults on `:host` would shadow inherited ones). Syntax
  colours are tokens too. `LIGHT_THEME` / `DARK_THEME` / `themeCss` are
  exported; pieces carry `part` names for `::part()`; `host.css` goes last
  inside every view for the rest.
- **Packaging.** The package is lode for building on, with no host in it.
  `npm run build`: `dist/lib` (ESM + .d.ts for core, queries, service,
  server, MCP, CLI, plugins, views) and `dist/views` (a self-contained
  bundle for pages without a bundler). The standalone app and the minimal
  host stay in the repo; `lode open` builds and serves the app from a
  clone, and says so when installed. Published as `lode-graph`. Exports: `lode-graph`,
  `lode-graph/server`, `lode-graph/mcp`, `lode-graph/views`,
  `lode-graph/views/bundle`. Checked by installing the
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
  app's toolbar shows the zoom (`flow.zoom`; click for 100%), "fit" (every
  card in view, at most 100%) and "focus" (brings the selected card to
  the left of the view at up to 100%; off when nothing is selected), from
  `run` and `canRun`.
  ⌘-click adds a card to the selection (or takes it out); a plain click
  selects just that card. Focus, fit (with two or more selected), Delete
  and dragging a header act on the whole selection. Ctrl-click is kept free
  for right-click. The camera is saved
  with the layout, in canvas coordinates; a startup link to a card that's
  already on the restored canvas selects it without moving the view.
  Panning and moving cards never select text. Keys (while the flow is
  showing, not while typing in a field): Delete/Backspace closes the
  selected cards (like ×, the cards they opened stay), ⌘Z / Ctrl+Z undoes.
- **Layouts can be saved with the project** (`serviceStorage`, which the app
  uses). The server keeps a view's layout
  (`loadLayout` / `saveLayout`, `layout-<name>.json` in the project's cache
  dir, name-checked and size-capped), so it survives restarts in any host;
  the browser's storage wouldn't (each `lode open` gets a new port, so a new
  origin). The flow saves after every change: cards (node, range, folds,
  position) and arrows. On load, blocks are refetched and cards whose node
  is gone are dropped. Undo history isn't saved.
- **Host syntax hook**: hosts may pass `syntax(text, file)` (escaped HTML per
  line) and `syntaxCss`; views put the CSS inside their shadow root. Views
  never bundle a highlighter.
- **Entry points** (the app's first tab, `hosts/app/entries.ts`, from
  `api.entries()`): where to start reading. The `entries` query lists what the outside world calls
  into, by runtime and kind: files that run code on load, IPC handlers,
  messages from main, the preload bridge API, other registered callbacks
  (app events, hotkeys, UI listeners; timers and tests left out), and,
  folded, functions nothing in the project reaches (a framework, HTML or
  the outside calls them). All from data lode already had: channel
  endpoints (now kept on `Graph`), registrations, call edges. A summary line
  says how the runtimes talk (`preload ⇄ renderer · 460 calls`): only
  between real runtimes, and only with two or more (a project without them,
  like lode, shows none rather than every pair of files). Filter by
  text; clicking an entry starts the flow there. Next idea: a model-written
  one-line summary per entry.
- **Standalone host** (`hosts/app`): entry points and flow tabs (the top
  bar's "entry points" brings that tab back once closed; "+" adds a flow), a file tree
  (a file opens in the flow), syntax colours
  (highlight.js, Clance's palette, `hosts/app/highlight.ts`; a host
  concern, so not in lode: the flow takes `host.syntax`), tab names from
  the flow's question or first card, the empty canvas's hint, and ◇
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

## Asking for a flow

Typing "/" in the top bar's box turns symbol search into a question: "show
me how we create the tabs", "what most likely breaks from these changes".
The answer is a flow, laid out in a new tab: real cards, arrows, a reading
path, and a one-line note per card.

**Jev is the core, not an LLM.** Building a flow is selection and ranking
over the graph, which is what TypeSafe's Jev (a System One model: typed
judgments and probabilities, no generated text) is for. Code owns the
workflow; the graph supplies candidates; Jev judges them:

1. **Route.** A Choice judgment picks the kind of question (how X works,
   what breaks, where X is handled, what calls X, …).
2. **Start.** Lode finds candidate symbols (a text search over all the
   code, or the changed symbols); Jev scores each one's relevance to the
   question.
3. **Follow.** From the best starts, lode walks the graph in the routed
   direction (callees, callers, or downstream of changes); Jev judges
   whether each next symbol belongs, within a step budget (about 5-15
   cards).
4. **Breakage.** Lode collects everything downstream of the changed
   symbols; Jev scores how likely each is to break given the diff.
5. **Render.** A flow plan (cards, arrows, path, notes built from facts
   and scores: "reads the changed `ViewRequest` · risk high") opens in a
   new tab with the "open all" layout; cards stay live.

**Two modes** (`AskOptions.mode`; a host picks per question or sets the
service's `askMode`): **pass**, the pipeline below (the question's words
over every symbol, one Jev pass, the graph followed), and **crawl**: from
the top of the project and the best word matches, rounds that open the
most promising few (a folder, a class, what a function calls) with Jev
judging what's inside, then a pass that picks the start and marks each
card core or supporting (supporting cards open short), and one hop of
callers shows what triggers it. On the eval (51 questions, three suites):
pass 84% start / 88% coverage, noise 0.1, 0.6 s, 2.3 requests; crawl 80% /
87%, noise 0.3, 1.0 s, 5.5 requests. Crawl reads more and is slower, and
wins where the question's words aren't the code's (vocab: 82% coverage
against 68%), so it's an option, not the default.

**Note cards.** Not everything worth showing is code: a model drawing a
system design, a step in an explanation, a caveat. A note is a card with a
title and text (the host renders it: `host.renderNote`, Markdown in the
app and Clance; plain paragraphs by default), made by the canvas actions
`note`, `link` (a labelled arrow between any two cards, kind "note") and
`diagram` (notes and links at once, in columns along the links, below
what's there, then fitted). A note's block is an empty stand-in, so
everything that reads a card's code passes it by; it's saved with the
canvas (its `text`), skipped by re-indexing, left out of explain's canvas
and appended to `flow.context()` as text with its links. Cards in canvas
actions can be named, not just keyed (a symbol's name or id, a note's
title or id).

**Groups.** Cards can be framed: a group is a title and an ordered list of
cards, laid out inside its frame as a row, a column or a grid
(`group`, `ungroup`, `arrange` canvas actions). A card is in one group at
most; the frame is derived from its cards (their box plus padding and the
title), so it follows them, and dragging the title moves them all. A new
group goes below everything; changing one keeps it where it was.
`arrange` takes rows of groups (by id) and loose cards (by name) and lays
them out left to right, rows top to bottom, starting where the first of
them was; whatever else would overlap moves below, keeping its own
layout. Relative, not coordinates, because models are bad at pixels and
coordinates go stale as cards grow. Groups are saved with the canvas,
undone like anything else, and pruned as their cards go
(`flow.groups()`, `CardInfo.group`).

**More than one folder.** A canvas reads one project (its connection), and
can hold code from others too: a worktree of it, another repo. Each extra
folder has its own connection (`LodeHost.folder(path)`, or
`flow.addFolder(path, connection)`), a label (its folder name, made
unique), and its cards' ids are its node ids under the label,
`label//id` (`views/folders.ts`). Results from a folder's lode are
rewritten that way as they arrive (node refs and changed files), so the
rest of the view, arrows, diffs, groups, treats them like any other id,
and calls go back to the right lode with the label taken off: `block`,
`editFile`, `changes` (each folder's, merged), `context` (each folder's
cards from its own lode, the budget shared, concatenated). Hosts see
cards as their folder knows them, with `CardInfo.folder` (and `folder` on
`openSource`, `saveEdits`, `highlight`). Labels contain no `/` and real
ids never start `x//`, so a prefix is unambiguous (`::` would clash with
Ruby). A folder's lode is let go when its last card closes; the folders
are saved with the canvas (label and path) and reconnected through the
host first on restore. Asking and explaining stay on the canvas's own
project. Canvas actions `add` and `plan` take a `folder` (a path).

**Canvas tools** (`canvasTools(host)`, `lode-graph/mcp`): the tools an
agent needs to see and draw on a host's canvases, defined and checked in
lode, with the canvases reached through the host (`CanvasHost`: list,
read, apply, and a canvas's project's service, or another folder's).
Besides cards and notes, an agent can organise what it shows: `lode_group`,
`lode_ungroup`, `lode_arrange`; and the tools that find or add code take
a `folder`. Clance mounts them for its Claude sessions.

Every card is a real graph node that code chose, scores are data (so
thresholds, budgets and "show more" are settings), and judgments run in
parallel, so it's fast. **An LLM is optional** and only writes a short
summary over the finished flow (and could take questions that fit no
route). The judging step is an interface: Jev by default, an LLM or a
heuristic where TypeSafe isn't available. The Jev key lives in `.env`
(git-ignored), server-side only.

### How it maps onto Jev (from the TypeSafe docs, jev-1.13)

**The API.** One endpoint, `POST https://api.typesafe.ai/v1/systemone`
(Bearer key), body `{ model: "jev-latest", state, questions }`. `state` is
text or JSON (an object with named fields is best); `questions` is a map
of named questions, all answered in parallel against the same state, so
several judgments cost one round trip ("speculative fan-out": ask
everything a step might need, use what applies). Three question types:
**Choice** (one of up to 255 options, with a probability for each and a
confidence), **Noul** (probability of yes, independent of other
candidates) and **Score** (2-10 ordered levels, probability-weighted).
Limits: 64k tokens per request (32k for the state plus the longest
question), 80 requests/s; price $0.042 per million input tokens (output
free), so a flow costs a fraction of a cent. 429/529 mean retry with
backoff. Plain `fetch` behind a small `Judge` interface (an LLM or a
heuristic can implement it too); the key is `TYPESAFE_API_KEY`, from the
environment or `.env`, used only on the server.

**What Jev is bad at, and how the design avoids it.** It reads literally
(questions state exact conditions, with criteria for each answer); it
loses accuracy with indirection and with large states full of irrelevant
detail (code picks and trims what goes in: a name, kind, signature and
the line that connects it, not whole files); it can't count or do maths
(code does all ranking arithmetic and thresholds); Choice answers can
shift with option order (Nouls per candidate where scores must be
comparable); it doesn't generate (notes are built by code).

**The pipeline, in 2-4 requests:**

1. **Route + start** (one request). Code builds a shortlist of up to ~200
   candidate symbols cheaply: a text search (BM25) of the question's
   words over every symbol's name, path, comment and code; for change
   questions, the changed symbols. Each is tagged `S017|
   addTab (function) hosts/app/main.ts:96 — addTab(request, at)`. State:
   `{ question, candidates }`. Questions: a Choice routing the question
   (how X works / what breaks / where X is handled / what calls X / what
   changed / other); a Choice over the candidate ids for the best place
   to start; a Noul per candidate for "is this about the
   question?" (the re-ranking pattern), and a Noul for "does anything here
   answer it?" so an unanswerable question says so instead of guessing.
2. **Follow** (one request per hop, two or three hops). From the chosen
   symbols, the graph gives the next ones in the routed direction
   (callees for "how", callers for "what calls", dependents for
   breakage). State: the question, the flow so far by name, and each
   candidate with the line that leads to it. One Noul per candidate
   ("does following into `candidates[i]` help answer the question?");
   code keeps those over a threshold, within a card budget.
3. **Breakage** (one request). Changed symbols (from `changes`) and what
   depends on them up to two hops, each dependent with the line that uses
   the changed symbol and the diff of that symbol; one Score per
   dependent: unaffected / might be affected / likely breaks.
4. **Plan.** Code turns the kept symbols into cards, arrows (graph edges
   between them), a reading path (graph order from the start) and notes
   from facts and buckets ("calls `addTab`", "reads the changed
   `ViewRequest` · likely breaks"), and opens it in a new flow tab.

**As built** (`src/ask`): `askFlow(question, queries, judge)` returns a
`FlowPlan` (route, cards with a note and a step: 0 for where to start,
then each hop), typically in 2-3 requests and 0.3-0.6s. Candidates are
the top 40 top-level declarations and methods by a text search (BM25)
over everything about each symbol: its name (counted most), path, the
comment above it and its code, Porter-stemmed, English function words
ignored, and a symbol the question names exactly first. A question word
the code never uses is taken as a typo and matches the code's words
within an edit (two for long words; a swapped pair is one edit), counting
a little less. Jev judges all 40 in the first request, each shown with
its comment and first lines rather than a name and one line (`def
process` is too little to judge).

Measured with `eval/` (questions over glance, lode, keepr, sinatra and
rubygems.org, each run twice; scored on the start and on how much of the
expected answer is there): on 25 questions worded like the code,
name-only matching scored 18.2 and the text search 21.4 (starts right
70% → 84%); adding 9 questions with typos and synonyms (34 in all), the
text search scored 24.0 and with typo matching 27.7, all five typo
questions right ("acount balence", "tempaltes renderd"), at the same
0.4s and 2 requests. True synonyms are still missed ("explain the
ledger" in code that says journal, posting and account; "voice typing"
for dictation). A crawl of the project judged by Jev (branch
`ask-crawl`) reached some of those but scored 26.8 overall at three
times the cost, mostly by picking worse starts; it's kept there for the
next attempt at synonyms. Utilities (12+ callers, or
one- or two-letter names) need a 0.9 noul to get in, others 0.6; 12 cards
and 2 hops at most ("where" follows 1). The service's `ask` method uses
`options.judge`, or Jev when `TYPESAFE_API_KEY` is set (the CLI loads
lode's own settings from the `.env` in lode's folder only, never the
working directory, since `OPENAI_BASE_URL` decides where keys are sent;
nothing else a `.env` holds is read). In the views,
`flow.ask(question)` (or `ViewRequest.ask`) asks and lays the plan out by
step, left to right (`flow.asked` / `lode-ask` give the question and how
it went; the app shows them as a line above the canvas); notes show under each card's
header and are saved with the tab. In the app, "/" in the top box asks in
a new flow tab, and a flow's "/" key starts a question there.

## Context for LLMs

lode owns choosing and formatting the slice (a raw graph dump is useless
to a model); hosts choose how it's delivered. **Seeds** come from symbols,
a canvas, git changes, or a question (lexical, or judged by Jev with
`rank: "judge"`). The slice **grows** a few hops along calls, callers or
both (state writes only to module-level state, not class fields). It's
**ranked** seeds first, then by distance, utilities last, then by how
connected each is, and **fitted** to a token budget (about 4 characters a
token) by detail: full code at the centre, signature and connecting line
one hop out, names further; detail drops before items do, and what's left
out is counted. The **format** is Markdown: a title, the connections as
edges, then Code / Nearby / Also related, with line numbers, `⋯` folds
and `+`/`-` change lines. Deterministic by default, so the same commit
and request give the same context (cacheable, testable).

Delivered as: the `context` service method; **`lode mcp`**, a thin MCP
server (stdio JSON-RPC, written directly: initialize, ping, tools/list,
tools/call; stdout is the protocol, logs go to stderr) with six tools;
`flow.context()` for the canvas or selection (the app's "copy context"
puts it on the clipboard); and `skills/lode/SKILL.md` for
agents. Clance can run `lode mcp` for its agent or call `contextFor`
in-process.

## Explaining

Explaining is a conversation about the canvas, run on the server
(`src/explain`); showing it is the host's (lode core vs host: lode gives
the pieces, a host builds the feature, so a host can show answers in a
side panel, an overlay or inside cards). The flow view exposes
`scope(selection)` (what a question is about, as the request's fields),
`apply(actions, { undoGroup })` (do the model's canvas actions, one undo
step per group) and `highlight(id)`; `resolve` says which names in an
answer are real symbols, and the host draws the Markdown (the app's:
`hosts/app/markdown.ts`). The server side: the context is `contextFor` over the cards (or the
selection, which also becomes what "these" means), plus the question the
flow was built for and the diff when shown. The model (`ChatModel`;
Claude over the Anthropic API by default, streaming SSE, the context
block marked for prompt caching) gets tools to read the graph (`search`,
`read`: a `contextFor` around one symbol) and to work the canvas the way
the user does: `add_cards` (at most 12 a message), `build_flow` (Jev's
`askFlow` for a question, laid out like a / flow), `expand`, `open_fold` /
`close_fold` (by the card and the line the fold starts on), `close_cards`,
`select`, `focus`, `fit`, `show_changes`, and `open_tab`. The LLM drives
and Jev is one of its tools: Jev is fast and good at "where does this
start and what follows", the LLM at deciding what the user wants done.
Canvas tools don't touch anything on the server: each is checked (real
symbols; cards that are on the canvas, by name or id; folds that exist in
that card's lines) and becomes a `CanvasAction` event; the host passes
them to `flow.apply` in order as they arrive, with one undo group per
message, so ⌘Z takes back a whole message (moving the view and showing
changes aren't undone). At most 16 actions a
message. New tabs only when the user's last message asks for one: the
tools refuse otherwise, not just the prompt. No editing yet. Names
resolve to a symbol in a file already on the canvas first. Up to 8 model
turns per message. The system prompt asks
for grounded, concise answers with names in backticks (rendered as links
to their cards) and to read folded code before describing it. Answers
stream as service events, forwarded by both transports.

The standalone app's panel (`hosts/app/explain.ts`, a host feature built
only on the flow's public API; its conversations are kept per flow in the
host's storage): a header saying what the next question is about (all cards,
or the selection); each exchange as the question (with its scope), the
model's steps as compact chips (searched, read, "+ added …" and "↳
expanded …", which frame the cards they touched), then the answer, kept short (a lead sentence or two, then a
few bullets) with code names as quiet links that light up their card on
hover. Only real symbols are links: once an answer is written, its code
names go to the service's `resolve` (exact names, qualified ids like
`Queries.changes`, a shared name only in a file on the canvas, a plain
lowercase word only if one symbol in the project has it); while it
streams, only names of cards on the canvas link. The rest stays code; copy and "show the N added" under each answer. The composer grows
with the text, sends on Enter, turns into a stop button while answering
(`explainCancel` aborts the model request), and offers suggestions for
the moment (explain the selection, explain this flow, what could break,
go deeper, show more). Added cards glow briefly. The panel resizes from
its left edge (remembered per browser).

Observed: Sonnet and Opus 5.5 return the text after a tool result in one
burst (Haiku streams it), so the panel shows "thinking…" and the model's
reads while waiting, and writes text out as it arrives at a steady rate
(whatever is waiting shows in about 0.8s): real streaming passes straight
through, a burst types out instead of appearing at once.
Providers: several at once, by name (`src/explain/providers.ts`): Anthropic
(`anthropicModel`) and any OpenAI-compatible API (`openaiModel`: Chat
Completions with streaming and function calls; lode's conversation stays
Anthropic-shaped and is mapped to OpenAI messages, tool results becoming
"tool" messages, and back), each with the models it offers. A question
names `"provider:model"`, so Claude direct and Claude through OpenRouter
stay apart. A host's `providers` are the only ones used; otherwise every
provider the environment has a key for (OpenAI-compatible ones once their
models are listed: lode can't guess ids). The service's `explainModels`
gives the picker its groups. A model that doesn't stream still works: its
text comes with the turn.
`LODE_EXPLAIN_MODEL` sets the server's default model; a host picks one
per question (`ExplainRequest.model`, passed to `ChatModel.chat`; the
service's `models` option limits it, and its `explainModels` method lists
them for a picker).

## Languages

**File dependencies (`imports` edges).** A file depending on another, file
to file, at the line that does it: TS/JS imports, re-exports, `require` and
dynamic `import()` (resolved by the checker, so path aliases and each file's
nearest tsconfig count; a stylesheet by path), Python `import` / `from …
import` (a submodule when the name is one, else the package), Ruby
`require_relative` and `require` of the project's own lib/ (never a gem),
and the web plugin's files (below). Rails views' `stylesheet_link_tag` /
`javascript_include_tag` resolve to app/assets/stylesheets, app/javascript
or the builds. An import of a file no plugin read (an image) is dropped by
the graph rather than an error, so plugins can point at each other's files.
Kept apart from calls and flows on purpose: a file card shows them ("imported
by", a chip on each import line, LinkKind `imports`), and LLM context words
them as imports, but **/** answers, expand, impact and graph overviews
don't follow them; they say what a file needs, not what runs. (Django's
`{% extends %}` / `{% include %}` and Rails' `render` of partials stay
calls: a template rendering another.)

**Web files** (`webPlugin`, `plugins/web`): HTML, CSS, SCSS, Sass and Less
files become file nodes, with no parser: their tags and at-rules are all a
file's dependencies need. HTML: `<script src>`, `<link href>`, `<iframe
src>` and `<a href>` to another page; CSS: `@import` (and `url()` in it);
SCSS/Sass: `@use` and `@forward`, with Sass's partials (`_x.scss`,
`x/_index.scss`). Targets are project files, relative or from the root
(also tried under public/ and static/); URLs, `sass:` modules and template
placeholders are left out. `pluginFor` adds it when a project has such
files; Django's templates stay the Python plugin's.

A language is a plugin; everything above the graph (queries, views, ask,
context, explain, MCP) is language-agnostic. `pluginFor(folder)` picks
plugins from what's there: TypeScript/JavaScript (a tsconfig/jsconfig, or
.ts/.js files) gets `tsPlugin` exactly as before; Ruby (a Gemfile,
gemspec, Rakefile or config.ru, or 3+ .rb files, not counting test
fixtures) gets `rubyPlugin` with `railsPack`; both, `combinePlugins`,
which merges their graphs and re-indexes only the plugin whose files
changed.

**Why tree-sitter, and not each language's own tools.** TS's compiler is a
Node library, so lode runs it in-process and gets type-checked links.
Other languages' analysers are written in those languages (Go's in Go,
Ruby's in Ruby) and would need the toolchain installed and a process per
language. Tree-sitter parses every language in-process from WASM
(`@vscode/tree-sitter-wasm`, which bundles the runtime and grammars), with
nothing to install, so a language is a small extractor and linker. The
price is that links are resolved by rules, not types. The plan for TS-level
precision where it matters: language servers (gopls, jdtls, Pyright,
ruby-lsp) answering "where does this call go?" for each call site when
they're installed, falling back to the rules when they aren't. Ruby's
metaprogramming stays out of reach even for its own tools.

**The tree-sitter base** (`plugins/treesitter`): a language gives `owns`,
`extract` (one file's syntax → facts, independent of other files, cached
per file by content hash) and `link` (all facts → the graph). An update
re-parses only changed files and re-links the project, which is cheap.

**Ruby** (`plugins/ruby`). Ids follow TS's: `file#Admin::UsersController`,
`file#User.greet`, class methods `file#User.self.find`. A class reopened
in several files is one class with several declarations (the canonical one
is where Rails' autoloader would look: `admin/users_controller.rb`).
Calls resolve as a reader would:
- no receiver or `self`: the class, its prepended/included modules, its
  superclasses (exact); a bare name that isn't a local is a call;
- a constant: its class method; `.new`: `initialize` (exact);
- a variable: what it was assigned (`@user = User.find(…)`, per class for
  instance variables), else its name (`user`, `current_user` → `User`)
  (inferred);
- otherwise the one project method with that name, only if there's exactly
  one, it isn't a common or core-library name or a test helper, and the
  receiver isn't a known class (whose method would have been found), an
  unknown chain or a library constant (inferred).
Beyond single receivers, every expression is kept whole (self, a
constant, a variable, a method sent to another expression, an element of
a collection), so chains type step by step: `current_user` (its last
expression, `@current_user ||= User.find_by(…)`) → a User; `.posts` (an
association) → Posts, a collection: its scopes and finders apply;
`.published` (a scope) → Posts; `.each { |post| … }` → each a Post. Also
`attr_reader`s (typed by the ivar), `delegate :x, to: :y`, `self.class`,
`send(:x)` / `method(:x)` / `try(:x)`, `module_function` and `extend
self`, and a bare name read as what it says (`current_user` → User,
`posts` → Posts). Calls written directly in a class body (`set :x`,
`register Foo`) are on the class; calls in that body's blocks (`test do`,
`included do`, a scope's lambda) on instances. A global (`$stdout`) or a
literal never gets a name-only guess. A call that can't be resolved gets
no arrow: missing beats wrong. Folds:
class, module, method and block bodies, control flow, multi-line literals
and argument lists, comment runs, the requires.

**Packs** add framework conventions, only where detected
(`{ name, detect, prepare, link }`, see embedding.md). `railsPack`
(Rails, or ActiveRecord alone, as in a gem): routes (namespaces, scopes,
nested and singular resources, member/collection, `to:`, `root`) → actions,
registered as entries by verb and path; callbacks and their `if:`
conditions; associations (with `class_name:`); `scope` as a class method;
concerns' `class_methods`; finders returning instances; mailer class
methods → instance methods; `perform_later`/`perform_async` → `perform`
(jobs are entries); rake tasks in namespaces (entries). Files are tagged
web / jobs / tasks, the runtime lens for entries. Associations are typed
methods (has_many → a collection of the class, belongs_to/has_one → an
instance; `class_name:` respected, polymorphic skipped); relation methods
(`where`, `order`, `includes`…) keep a collection, finders (`find`,
`first`, `create`…) give an instance; fixtures (`users(:one)`) in tests
are instances.

**Views.** `.erb` and `.jbuilder` files are Ruby too: an ERB template
becomes its tags' code with the HTML blanked to spaces (lines kept, each
tag ended with `;`), parsed as Ruby (`plugins/ruby/erb.ts`, through the
tree-sitter base's `source` hook). A view runs as its controller's (or
mailer's) code, `app/views/admin/users/show.html.erb` →
`Admin::UsersController`, so `@post` is typed from the action and
`current_user` is the controller's; helpers (`app/helpers`) answer what
the class doesn't. An action links to its view by name; `render :edit`,
`render "posts/edit"`, `render partial:`, a view's `render "form"`
(→ `_form`) and `render @comments` (→ `comments/_comment`) link too.
Measured on rubygems.org: 216 views, 856 links out of them (helpers,
components, models through @variables), 248 into them (actions, mailers,
partials); sampled, all right.

**`sinatraPack`** (`plugins/sinatra`): `get "/x" do … end` (top level or
in a `Sinatra::Base` subclass) is a callable named by verb and path, an
entry; `before`/`after` filters too. **`rubyToolsPack`**
(`plugins/ruby-tools`): RSpec `let`/`let!`/`subject` as methods typed by
what their block gives, FactoryBot's `create(:user)` / `build` /
`create_list` typed, `described_class`; Thor commands (`desc` + method)
as entries. Examples (`it "…"`) aren't made callables: the eval showed
thousands of sentence-named nodes crowding the word search.

Measured again after this (eval, 34 questions): `/` answers unchanged
(79% of starts right), while rubygems.org links went from 5,707 to 6,373
of its non-test calls and what stays unlinked is overwhelmingly framework
DSL (Avo, Phlex, Pundit, I18n, config) and libraries.

Measured: keepr (an ActiveRecord gem, 35 files) 0.13s; sinatra (plain
Ruby, ~200 files) 0.4s; rubygems.org (Rails + JS, 1,400 .rb files) ~4s
with its TypeScript. Sampled name-only links there are mostly right; the
misses were library and core methods, now excluded.

**TS/JS frameworks** (`src/ingest/ts/frameworks.ts`, inside the TS
plugin: they need the checker). Detected per app, from the nearest
package.json's dependencies. JSX elements are calls (`<UserCard />` renders
`UserCard`, resolved by the checker). File-based routes register pages,
layouts and API handlers as entries by path: Next.js (app router `page`,
`layout`, `route` with `GET`/`POST`…, special files; pages router incl.
`pages/api`), Expo Router, Nuxt (`pages/`, `server/api`), SvelteKit
(`+page`, `+server`, `load`), Remix flat routes (`posts.$slug.tsx`,
`loader`/`action`); a page re-exported from elsewhere (`export { Feed as
default } from …`) or wrapped (`export default memo(Page)`) is the real
component. Server actions ("use server") are entries. Route tables (`{ path,
component | element | loadComponent | lazy }`, children under their
parents, `<Stack.Screen name component>`) say what's where. Navigation is a
channel, scoped to the app (`route@apps/web`): `<Link href|to>`, `<a href>`,
`router.push/replace/navigate`, `redirect()`, Angular's
`router.navigate([…])` and `routerLink`, Vue's `:to` and named routes
(`{ name: "article" }`, `routerPush("article")`, `<AppLink name>`), React
Navigation's `navigation.navigate("Profile")`. Route params are one path
segment, catch-alls any number, and a link goes to the most specific
matching route. Vue and Svelte components are read through virtual
`.vue.ts` / `.svelte.ts` files holding their scripts (lines kept); their
templates, like Angular's (inline or `templateUrl`), link their bindings
(`@click="save"`, `on:click={save}`, `(click)="save()"`, `{{ total() }}`)
to the script's functions and child components by name or selector.
Express routes (named handlers too) carry their full path: a router is the
variable holding it (or a file's anonymous default export), `.use("/api",
child)` mounts one in another (chained `Router().use(a).use(b)` too, across
files through imports), and a route's path is every prefix up the chain
(`/api/articles/:slug`). A path the code computes from something static
counts as written: a constant the checker knows (`ROUTES.HOME`), a helper
returning a template (`paths.discussion.getHref(id)` →
`/app/discussions/*`), a variable or property holding one. Nest's decorators (`@Get`,
`@MessagePattern`, `@Cron`…) are entries; Angular lifecycle hooks too.
Monorepos: imports resolve with each file's nearest tsconfig (paths,
baseUrl), workspace packages by package.json name, solution configs
through their references. Measured on bulletproof-react, vercel/commerce,
an Expo app, Express and Nest RealWorld, Angular and Vue 3 RealWorld:
navigation sampled correct, routes and actions complete.

**Python** (`plugins/python`), detected by a pyproject.toml, setup.py,
setup.cfg, requirements.txt or Pipfile, or 3+ .py files. Ids are dotted
names in the module: `app/services.py#UserService.find`. A declaration
spans its decorators, so a route's `@router.get("/x")` is on its card.
Python has what Ruby lacks, type annotations, so more resolves:
- names: the enclosing functions, the module, its imports: absolute
  (`app.repo`, found among the project's files, shallowest then nearest),
  relative (`..core`), through a package's `__init__.py` re-exports and
  `import *`; a library import leaves the call alone;
- attributes: through modules, classes and their bases (in order), and
  instances; `super()` goes to the bases;
- what a variable holds: its annotation (`repo: Repo`), what it was
  assigned (`repo = Repo()`), a call's return annotation (`user =
  repo.get(1)` with `-> User`, `"User"`, `Optional[User]`), or `self.repo`
  set in any method (traced back to `__init__`'s `repo: Repo`);
- what a function gives without an annotation: its first `return` (or a
  fixture's `yield`); a tuple (`return repo, user`, or `-> tuple[A, B]`)
  position by position, for `repo, user = make()`;
- loop and comprehension variables (an element of what they loop over;
  `dict[K, V]` reads as V), `with … as x`, and fields in a class body
  (dataclasses, models);
- calling a class is its `__init__` (or the class); calls in parameter
  defaults (`Depends(get_db)`) are the function's;
- a `@property` (or `cached_property`) read runs it: an arrow, though it
  isn't called; a function handed over as a value (`Thread(target=work)`,
  `set_defaults(run=cmd_sync)`, callbacks) is "passes it";
- a call to an abstract method (`@abstractmethod`, or a body of just `...`,
  `pass` or `raise NotImplementedError`) also reaches the classes that
  implement it, when there are four or fewer.
Through a variable's type it's inferred; directly, exact. An unknown
receiver links only to the one project method with that name (not a
common one, not a test helper). **`pythonWebPack`** (`plugins/python-web`):
FastAPI/Flask/Starlette routes by decorator (verb and path, with
`APIRouter(prefix=…)` / `Blueprint(url_prefix=…)`) and `Depends`; Django's
urls.py (`path`/`re_path` → function or class-based views, under
`include()` prefixes), `Model.objects.<finder>(…)` as an instance,
management commands (`manage.py <name>` → `Command.handle`) and
`@receiver` signals; Celery/Dramatiq tasks (entries) and `.delay(…)` /
`.apply_async(…)` → the task. Files with routes are tagged web, task
modules jobs, management commands tasks. On a real site
(djangoproject.com): custom managers and querysets (`objects =
EntryQuerySet.as_manager()`, class attributes on a model) resolve; the
hooks Django calls on the classes it drives (views' `get_queryset` /
`get_context_data`, models' `save`, forms' `clean`, apps' `ready`…) are
entries; templates (`templates/**`) are file nodes: a view renders one
(`render(request, "x.html")`, `template_name`), templates extend and
include others and link to views by URL name: `{% url 'blog:entry' %}` by the namespace
(`include(…, namespace=)` or the urls module's `app_name`), a bare
`{% url 'entry' %}` only when one urls file names it (two sites' `homepage`
links nowhere rather than to the wrong one). 133 templates there, 174
links into them, about 316 out. **`pythonToolsPack`**
(`plugins/python-tools`): pytest (a test's or fixture's parameter is the
fixture of that name, from its file or a conftest.py above it: an arrow
to it, and the parameter holds what it returns); CLI entries (click and
typer commands, argparse subcommands by `set_defaults(func=…)` and the
nearest `add_parser("name")`, pyproject's `[project.scripts]` and
`[tool.poetry.scripts]`).

Measured on two typed, real projects (jevfilter, 45 files, 0.2s;
jev-gmail-filter, 25 files plus its JS, 0.6s): sampled inferred links all
right; what stays unlinked is libraries (sqlite3, datetime, the Gmail
client, dataclasses' `field`), `Any`, and callables passed in as
parameters. Untyped and heavily dynamic Python (`getattr`, metaclasses,
monkeypatching) will link less, falling back to the one-method-by-name rule.

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
