# Embedding lode

lode is three layers, and a host picks how to join them:

```
 any folder ─▶ core (Node)                 views (browser)              host
               GraphStore + plugins   ◀──▶ <lode-flow>                  ◀──▶ your editor / app
               Queries · createService     lodeApi · connection           tabs, tree, toolbars,
                                           LodeHost                       explain UI, storage,
                                                                           theme, editor
```

- **Core** (`lode`): reads a folder into a graph with a language plugin
  (`pluginFor(folder)` picks them: `tsPlugin` for TypeScript and
  JavaScript, `rubyPlugin` with `railsPack` for Ruby, both combined in a
  mixed repo), caches it, and answers queries. Runs in Node.
- **Views** (`lode/views`): the flow, a framework-free web component that
  renders the graph as cards, arrows, folds and callers, and does the
  reading mechanics (drag, zoom, fold, page, select, undo, keys). It's
  only the canvas: no toolbar, tabs, lists or explain UI. Everything it
  can do is a method or a command, and it reports what changed as events,
  so a host builds its own controls around it. `lodeApi` is the typed API
  for everything else a host shows.
- **Host**: your editor or app. It decides how views reach the core, where
  their state is kept, how they look, and what "open this file" means.

## 1. Run the core

```ts
import { GraphStore, pluginFor, createService } from "lode";

const store = GraphStore.open(await pluginFor(folder), folder);   // cache: ~/.cache/lode/<hash>, or { cacheDir }
const service = createService(store);              // the methods views call
const stop = service.watch();                      // re-index as files change; views update
// or, with your own watcher (an editor's file events): service.refresh()
```

## 2. Connect views to it

Pick a connection; views only need `{ call, onChanged }` (`LodeConnection`).

**Messages** (VS Code webview, Electron, iframe, worker): no server, no port.

```ts
// Node side (extension host / Electron main)
import { serveMessages } from "lode";
serveMessages(service, {
  send: (m) => panel.webview.postMessage(m),
  listen: (h) => panel.webview.onDidReceiveMessage(h).dispose,
});

// Page side (webview)
import { MessageConnection } from "lode/views";
const vscode = acquireVsCodeApi();
const connection = new MessageConnection({
  send: (m) => vscode.postMessage(m),
  listen: (h) => {
    const f = (e: MessageEvent) => h(e.data);
    addEventListener("message", f);
    return () => removeEventListener("message", f);
  },
});
```

Messages are tagged `{ lode: 1, … }`, so they share a channel with the
host's own.

**WebSocket** (any browser page): run the server, connect with the token.

```ts
import { startServer } from "lode/server";
const server = await startServer({ store, service, allowedOrigins: ["vscode-webview://…"] });
// page: new LodeClient(server.rpcUrl)
```

or from a shell: `lode serve <folder> [--port n] [--origin url]`. The server
only listens on localhost and needs the session token, an allowed Origin
and a localhost Host header.

## 3. Mount views

```ts
import { createView } from "lode/views";

const view = createView({ kind: "flow", id: "src/main.ts#run", state: "tab-3" }, connection, host);
container.append(view);
// name the tab from the flow: its question, or its first card
view.addEventListener("lode-change", () => (tab.label = view.asked?.question ?? view.cards()[0]?.node.name ?? "flow"));
// later, read something else in the same flow:
(view as LodeFlow).show("src/other.ts#thing");
```

- `createView` makes a flow (`kind: "flow"`), the only view lode has.
  Entry points, a changes list, a file tree and the rest are the host's,
  from `lodeApi` (the standalone app's are examples: `hosts/app`).
- A flow request can also carry `ids` (open several), `diff` (show git
  changes against that ref, e.g. `"HEAD"`) and `newTab` (ask the host for
  a fresh flow).
- `state` names where that flow keeps its canvas (cards, arrows, camera,
  selection). Give each tab its own key; create a view with the same key
  again to bring the tab back as it was. Default `"flow"`.

Without a bundler (a webview, a plain page), import the self-contained
bundle: `lode/dist/views/lode-views.js`. See
`hosts/minimal/index.html` for a whole host in one page.

## 4. Your own UI around the views

`lodeApi(connection)` is the typed API for building a file tree, a search
box, a status line or "show the symbol under the cursor":

```ts
import { lodeApi, buildFileTree } from "lode/views";
const api = lodeApi(connection);
renderTree(buildFileTree(await api.files()));       // folders → files, with runtimes
renderResults(await api.search(query));             // symbols; open with flow.show(node.id)
const here = await api.symbolAt(file, cursorLine);  // then flow.show(here.id)
connection.onChanged(async () => renderTree(buildFileTree(await api.files())));
```

Also `info()`, `entries()` (where to start reading), `block(id)`,
`source(file)`, `changes(base)`, `ask(question)`, `context(request)`,
`explain(request, stream)`, `explainCancel(stream)`, `explainModels()`,
`resolve(names, prefer)` and `editFile(file, edits)`: every service method
a host needs, typed.

`files()` lists every project file: the code graph's (TS/JS, with their
runtime) and the rest (README, JSON, CSS, …; whatever git doesn't ignore,
or everything outside node_modules/.git/dist when it isn't a repository),
marked `indexed: false`. Those open in a flow as text cards (Markdown
headings fold into sections), take edits and show diffs like code; they
just have no chips or callers. (The app's highlighter colours JSON,
Markdown, CSS/SCSS, HTML/XML, YAML, shell, TOML, Ruby and Python too.)

## 5. Driving a flow and listening to it

Every card has **expand** in its header (while there's something to do):
it shows all the card's lines (comment/import folds opened in place) and
opens everything it leads to, one
level: its chips' targets (calls, IPC, state) on its own lines, and its
nested declarations (a file's functions, a class's methods), as cards
beside it with arrows. The new cards aren't expanded. (`action: "expand"`;
part `expand`.)


Methods on a `<lode-flow>`: everything a key, click or toolbar could do,
so a host draws its own toolbar, menus and keybindings:

- reading: `show(id)` (add a node or file, or go to its card),
  `showAll(ids)`, `ask(question)`, `loadPlan(plan)`, `goTo(key)` (select
  and pan to it)
- commands: `run(command)` and `canRun(command)` (whether there's
  anything to do: grey a button by it). Commands: `close` (the
  selection), `undo`, `fit`, `focus`, `deselect`, `zoomReset`, `clear`,
  `expand`, `lineDown`, `lineUp`, `follow`, `back`, `nextChip`,
  `nextCard`, `prevCard`, `nextChange`, `prevChange`, `openFold`,
  `collapseFold`, `edit`; `search` and `help` only send `lode-action`
  (the host's search box, the host's key list).
- the canvas: `apply(CanvasAction)` (add, expand, fold, close, select,
  focus, fit, changes: what a model asks for, and a host can too),
  `cards()`, `selection()`, `setSelection(keys)`, `readingOrder()`,
  `highlight(key)`
- the view: `zoom` and `setZoom(k)`, `cursorAt` and `moveCursor(key,
  line)`, `diff` and `setDiff(base | null)`, `unsaved()`, `asked` (the
  question it answers), `context(budget)`, `scope(selection)`

Events (bubbling, composed; types in `FlowEventMap`):

| event | when | detail |
| --- | --- | --- |
| `lode-action` | before lode acts on a click or key; **cancelable** | `action`, `card`, `target`, `line`, `via`, `data` |
| `lode-select` | the selection changed | `selected`, `cards` |
| `lode-open` | a card was opened or gone to | `card`, `from`, `line`, `existing` |
| `lode-close` | cards were closed | `cards` (keys) |
| `lode-change` | anything on the canvas changed | |
| `lode-dirty` | a card got, or lost, unsaved edits | `card`, `dirty` |
| `lode-save` | a card's edits were saved, or refused | `card`, `file`, `ok`, `message` |
| `lode-cursor` | the line cursor moved | `{ key, line }` or null |
| `lode-ask` | the question it answers, or how asking went, changed | `AskState`: `question`, `status`, `detail` |

`preventDefault()` on `lode-action` takes an action over, e.g. open chips
in the editor instead of on the canvas:

```ts
flow.addEventListener("lode-action", (e) => {
  if (e.detail.action === "open") { e.preventDefault(); editor.reveal(e.detail.target); }
});
```

**Keys.** Outside code, a flow is driven from the keyboard: the selected
card has a line cursor (outlined; clicks move it). Defaults (`DEFAULT_KEYS`,
described in `COMMAND_HELP` for a host's help screen):
↓/j ↑/k lines (past the end shows 25 more) · →/l follow the line's chip
or fold (Tab cycles chips, then the fold) · ←/h back along the arrow to the line it came
from (a root card opens its first caller) · ] [ next/previous card in
reading order (trees top to bottom, depth first along arrows) · n ⇧N
next/previous change, hunk by hunk, opening folds to reach it · e expand ·
o / c open the line's fold (never its chips) / fold back · Enter edit the card
at the cursor (code is read-only until then; Esc, or the caret leaving,
stops, keeping unsaved edits, with the cursor on that line) · Space focus · f fit ·
Delete/Backspace/x close · Mod+z undo · / search (sent as `lode-action`
for the host to handle: the app focuses its search box) · ? help (also
the host's: the app lists the keys). `host.keys` remaps (`{ undo: ["Mod+Shift+u"], fit:
["Shift+F"] }`; `[]` turns one off) or `false` turns them all off, for a
host that routes its own keybindings to `flow.run()`. Keys never fire
while typing in a field, or when the flow isn't showing.

## 6. The host

```ts
const host: LodeHost = {
  openView: (request) => …,                    // required: open a flow/entries tab, or show() in one
  openSource: (file, line) => editor.open(…),  // optional: without it, a card's title opens the file as a card
  highlight: (h) => editor.decorate(h),        // optional: lines the selected card covers (null clears)
  syntax: (text, file) => htmlLines,           // optional: one HTML string per line, source escaped
  syntaxCss: "…",                              // CSS for what `syntax` emits
  storage: myStorage,                          // optional: where views keep state (default: the project's cache)
  css: "…",                                    // optional: CSS added last inside every view
  keys: { … } | false,                         // optional: see above
  render: { header, footer, line, chip },      // optional: your markup in cards (below)
};
```

**Card markup** (`host.render`): each hook gets the card (`CardInfo`) and
returns HTML, or nothing. You escape what you put in.

```ts
render: {
  header: (card) => `<span class="owner">${owners.get(card.node.file)}</span>
                     <button data-action="host:pin" data-id="${card.key}">pin</button>`,
  footer: (card) => …,                         // below the code
  line: (card, line) => coverage.has(line) ? "<i>●</i>" : undefined,  // before a line's chips
  chip: (link, card) => …,                     // a chip's label
}
```

Elements with `data-action="host:<name>"` are your buttons: clicking one
fires `lode-action` with that action, the card, and the element's `data-*`
values. They're not drag handles, even in the header.
```

**Syntax colours** are the host's: pass `syntax(text, file)` (HTML per
line, source escaped) and `syntaxCss`, from your editor's tokenizer,
Shiki, or highlight.js (`hosts/app/highlight.ts` is the app's; copy it).
Without them, code is plain.

**Empty canvas**: `empty` is the text a flow shows with no cards ("Pick
a file to start reading"); default nothing.

**Storage** (`LodeStorage`: `load(key)`, `save(key, value)`, null removes;
sync or async):

- `serviceStorage(connection)`: in lode's cache, with the project (default).
- `localStorageStorage(prefix)`: this browser.
- `memoryStorage()`: this page only.
- your own: VS Code `context.workspaceState`, a webview's `getState`, a
  database, Clance's store. A host can also keep its own tab list in the
  same storage, as the standalone app does (`app-tabs`).

## 7. Editing

A card's code is editable once you press Enter on it (it shows "editing";
Esc or clicking elsewhere stops; clicks alone only move the line cursor).
What a card shows is what you can change.
Folded and paged-off lines can't be touched from the card (an edit never
crosses them). Typing, Enter (keeps the indent), Backspace/Delete (joining
lines only where both are visible together), Tab, paste, cut and copy (the
code only) and ⌘Z / ⌘⇧Z (per card) work inside a card's code. ⌘S saves the
card; a card with unsaved edits shows "● unsaved · save · discard"
(`flow.unsaved()` lists them, for a host's count). Undo goes back past a save: the card becomes unsaved
again, and saving writes the undo. Unsaved cards can't be closed, folded or paged until
saved or discarded; other re-renders keep their edits and the caret.

Saving sends the card's edits: one per run of visible lines that changed,
as the lines the card showed (`expected`) and what they are now (`lines`).
By default the service writes them (`editFile`), only if the file still
reads as `expected` there, inside the project only, and re-indexes, so
callers, chips and arrows follow. Otherwise the card says why and keeps
the edits.

- `host.editable`: `false` for read-only, or `(card) => boolean`.
- `host.saveEdits(request)`: save it yourself, e.g. as an editor edit so
  the editor's undo and dirty state include it; return `{ ok: true }` or
  `{ ok: false, message }`.
- `lode-action` is sent with `action: "save"` / `"discard"` first
  (cancelable), then `lode-dirty` and `lode-save`.

## 8. Git changes

`lodeApi(connection).changes(base)` lists what changed since a ref
(default `HEAD`: uncommitted work, untracked files included), by file and
by the symbol each change is in: a top-level function, class, method, type
or variable, or "(top level)". Symbols carry `parent` (a method's class),
so a host can show them as a hierarchy; a class whose methods changed is
listed even if its own lines didn't. Refetch on `onChanged` and an agent's
edits appear as they land. A host opens them in a flow with the diff
shown (`{ kind: "flow", ids, diff: base }`, or `flow.setDiff(base)` then
`flow.showAll(ids)`); several ids are laid out as a flow: linked where
they call each other, callers left of what they call, unconnected groups
in rows. (The standalone app's sidebar is one such list.)

A flow showing changes (`diff` in its request, or `flow.setDiff(base |
null)`; kept with its state) marks added or
changed lines, shows removed lines struck through where they were
(read-only, never part of an edit), and marks folds and "show more" that
hide changes, and chips or callers leading to a changed symbol get a dot.
A card whose folds hide changes gets "open N changes →" in its header:
it opens each of them as a card beside it (as clicking each fold would),
counting only those not open yet. A card that arrives while changes are
shown (or is on the canvas when they're turned on) opens far enough to
show its changes: comment/import folds holding them open in place, and it
shows down to its last changed line. (`action: "open-changes"` in
`lode-action`; part `open-changes`.)

## 9. Asking for a flow

`flow.ask("how do we create the tabs?")` (or `{ kind: "flow", ask }`)
builds the flow that answers a question on the server and lays it out:
cards in steps from where to start, linked where they call each other,
each with a note on why it's there. `flow.asked` (and `lode-ask`) gives
the question and how asking went, for the host to show. The server needs a judge: Jev by default (`TYPESAFE_API_KEY` in
the environment or lode's `.env`), or pass `createService(store, { judge
})` with anything implementing `Judge` (Choice, Noul and Score answers),
e.g. an LLM. `lodeApi(connection).ask(question)` returns the `FlowPlan`
for a host's own UI, and `flow.loadPlan(plan)` lays one out.

## 10. Context for LLMs

`contextFor(request, queries, judge?)` (service method `context`) returns
a slice of the code formatted for a language model: `{ title, markdown,
items, edges, tokens, dropped }`. Where it starts: `seeds` (symbol ids),
`question`, `changes` (a git ref: changed symbols and what depends on
them) or `canvas` (cards and arrows, as a flow has them). It grows `hops`
along the graph (`direction`: down, up, both), then fits `budget` tokens:
full code at distance 0 (folds collapsed unless they hold changes),
signature plus the connecting line at 1, names beyond; detail drops
before items do. `rank: "graph"` (default) is deterministic; `"judge"`
uses the judge to pick a question's seeds and steps, or what a change
puts at risk.

`serveMcp(service, { input, output })` (or `lode mcp <project>`) serves
it to agents over MCP: `lode_search`, `lode_read`, `lode_context`,
`lode_impact`, `lode_changes`, `lode_entries`. `flow.context(budget)`
builds it from the canvas (or the selection) for a host to copy or send
to its own agent.

## 11. Explaining

Explaining is lode's; how it's shown is the host's: a side panel, an
overlay, notes inside cards. The flow view has no explain UI of its own,
just the pieces to build one:

- `flow.scope(selection?)` → `{ label, focus, request }`: what a question
  is about (the selection, or every card) and the explain request's
  fields for it (`canvas`, `cards`, `changes`, `focus`, `question`); add
  `messages` (and `model`) and call the service's `explain`.
- `flow.apply(actions, { undoGroup })`: do the model's `CanvasAction`s in
  order (from `action` events as they stream, or the result's `actions`).
  Actions sharing an `undoGroup` undo as one step; added cards glow.
- `flow.highlight(id | null)`: light up a card (a name hovered in an answer).
- `renderMarkdown(text, link)` and `codeNames(text)` (in `lode/views`): an
  answer's Markdown, safely, with code names that `link` knows (resolve
  them with the service's `resolve`) as `<code class="sym" data-id>`.

The standalone app's panel (`hosts/app/explain.ts`) is one such UI, built
only on these: suggestions, streaming, a stop button (`explainCancel`), a
model picker (`explainModels`), the conversation kept per flow in the
host's storage. Copy it or build your own.

The service's `explain` method (`explain(request, queries, model,
onEvent)` in Node) builds the context from the cards (or the selection)
with `contextFor`, sends it with the conversation to a `ChatModel`, and
gives the model tools to read the graph (`search`, `read`) and to work the
canvas: `add_cards`, `build_flow` (a whole flow for a question, with Jev:
pass `explain(…, { judge })`; the service uses `TYPESAFE_API_KEY`),
`expand`, `open_fold` / `close_fold`, `close_cards`, `select`, `focus`,
`fit`, `show_changes` and `open_tab`. Canvas tools change nothing on the
server: each becomes a `CanvasAction` (`add`, `plan`, `expand`, `fold`,
`close`, `select`, `focus`, `fit`, `changes`, `tab`), checked against the
graph and the cards it was sent (`ExplainRequest.cards`: every card's
key), which the host hands to `flow.apply` as they arrive (one undo
group per message). New tabs only when the user's message asks for one
(enforced, not just prompted); a tab action calls the host's
`openView({ kind: "flow", newTab: true, ask })`. No editing. `open_fold`
and `expand` return the code they reveal to the model. The answer
streams as `explain` events (`{ stream, event: text | tool | action }`)
through `LodeConnection.onEvent` (WebSocket and message channels both
forward them); without `onEvent`, it arrives whole, with `actions`.

The default model is Claude over the Anthropic API (`anthropicModel`:
`ANTHROPIC_API_KEY`, `LODE_EXPLAIN_MODEL`, default `claude-sonnet-5-5`;
the context is marked for prompt caching). Pass `createService(store, {
model })` with anything implementing `ChatModel.chat({ system, messages,
tools, model, onText })` to use another.

**Providers:** explaining runs on named providers, each a `ChatModel` and
the models it offers; a question picks one as `"provider:model"`.
`createService(store, { providers: { anthropic: { label, model:
anthropicModel({ apiKey }), models: [{ id, label }] }, openrouter: { label,
model: openaiModel({ apiKey, baseURL, model }), models } } })` uses exactly
those, whatever keys the environment has, so a host decides alone what's
used. Without `providers`, the environment's: `ANTHROPIC_API_KEY`
(`LODE_ANTHROPIC_MODELS`, default Sonnet, Haiku, Opus), `OPENAI_API_KEY` and/or
`OPENAI_BASE_URL` (`LODE_OPENAI_MODELS`), `OPENROUTER_API_KEY`
(`LODE_OPENROUTER_MODELS`); OpenAI-compatible providers are offered once
their models are listed (`id=Label,…`). `defaultModel` (or
`LODE_EXPLAIN_MODEL`) is what a question gets before one is picked;
`models` limits which may be. `openaiModel` speaks Chat Completions
(streaming, function calls) for OpenAI, OpenRouter, Groq, Together,
Ollama, LM Studio, vLLM. The service's `explainModels` gives views `{
providers: [{ id, label, models: [{ id: "provider:model", label }] }],
default, notes }` (no secrets), for a host's model picker.

**Per question:** `ExplainRequest.model` (`"provider:model"`, or a bare id
any provider offers) picks the provider and model for one question; the
provider's `ChatModel.chat` gets the model id as `model`.

## 12. Look

- **Tokens.** Every colour and font is a `--lode-*` custom property, set on
  any ancestor of a view (or on the view). Ready-made: `LIGHT_THEME` (the
  default) and `DARK_THEME`; `themeCss(theme, selector)` turns one into CSS.
  Map them to your editor's theme variables, e.g.
  `lode-flow { --lode-bg: var(--vscode-editor-background); … }`.
  Tokens: bg, surface, sunken, fg, muted, faint, line-number, border,
  outline, shadow, calls, local, channel, channel-text, state, added,
  removed, font, mono,
  and syntax-{keyword, string, number, title, type, comment, attr, variable}.
- **Parts.** Pieces carry `part` names for `::part()` from the host page:
  flow: `canvas`, `board`, `empty`, `card`,
  `card-selected`, `card-header`, `card-title`, `card-meta`, `card-close`,
  `callers`, `caller`, `code`, `line`, `line-number`, `source`, `chips`,
  `chip`, `chip-calls`, `chip-channel`, `chip-state`, `chip-local`, `fold`,
  `paging`, `paging-button`, `arrows`, `line-removed`, and `host-header`, `host-footer`,
  `host-line` around render hooks' markup.
- **`host.css`** goes last inside every view's shadow root, for anything
  tokens and parts don't reach.

## Other languages

A language is a `LanguagePlugin` (`src/schema`): it reads a project's
files into nodes, edges, channel endpoints and fold regions, and the core
does the rest. `GraphStore.open(yourPlugin, folder)` uses it in place of
`tsPlugin`; `combinePlugins([a, b])` runs several on one repo (each
re-indexes only when its own files change).

**Ruby:** `await rubyPlugin({ packs: [railsPack, sinatraPack, rubyToolsPack] })` (async: the grammar
is WASM). A pack adds what a framework does by convention, and runs only
where it detects its framework: `{ name, detect(project), prepare?(project),
link?(project) }`. `prepare` runs before calls are resolved (turn a DSL
block into a method with `project.promote`, add what calls return to
`instanceReturns`, answer `Const.name` another way with
`singletonFallbacks`); `link` after (`project.addEdge`, `project.register`
an entry point with a `category`, `project.tag` a file's runtime). It has
the project's classes, `resolveConst`, `findMethod`, `inherits` and every
file's facts (declarations, calls with their receivers and DSL arguments,
assignments). `railsPack` is one: routes, callbacks, associations, scopes,
concerns, finders, mailers, jobs and rake tasks.

**Python:** `await pythonPlugin({ packs: [pythonWebPack, pythonToolsPack] })`, the same
shape: a `PyPack` is `{ name, detect, prepare?, link? }` over a
`PythonProject` (`resolveModule`, `resolveName`, `evalPath`, `evalRef`,
`classMember`, `inherits`, `addEdge`, `register`, `tag`; `callTypes` and
`memberHooks` to say what a framework's calls return and what its
attributes are).

**Another tree-sitter language:** `treeSitterPlugin({ name, version,
grammar, owns(file), extract(tree, file, text), link(facts, root) })`.
`extract` sees one file's syntax and returns its facts (kept per file
between runs); `link` turns every file's facts into the graph. Grammars
come from `@vscode/tree-sitter-wasm` (Ruby, Python, Go, Java, Rust, C#,
C++, PHP, Bash).

Entry points: a node's `detail.registration` (`{ call, key, category }`)
lists it under `category` ("routes", "jobs", "tasks"; default "events"),
grouped by its file's `runtime` tag.
