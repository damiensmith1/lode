# ◇ lode

**Read a codebase as a flow of real code.** lode builds a live graph of how
your TypeScript and JavaScript fits together and lets you read it as cards
of actual code on a canvas, connected by arrows: what calls what, what
flows where, what reads and writes which state, across processes. Ask it a
question and it lays out the answer. Point it at your git changes and it
shows what changed and what might break. Edit right in the cards.

It's a library first: a code graph and query core, embeddable views, and a
small host contract, so any editor or app can show it. It also ships a
standalone app that runs on any folder.

![Asking "/how do we create the tabs": a flow of the code that does it, built in 0.6s](docs/images/ask.png)

## Features

### The flow canvas
- **Cards of real code**, one per function, class, type or file, with
  syntax colouring. Long bodies fold into `⋯ N lines`, which open as their
  own card or in place (comments and imports). Cards page in 25 lines at
  a time ("show 25 more", "show all", "collapse").
- **Chips** on each line show what it leads to (calls, IPC channels, state
  it writes); click one to open it beside the card with an arrow from that
  line. Every card shows **who calls it** too.
- **Expand** opens everything a card leads to, one level, in one click.
- **Trees, tabs, layout:** open as many trees as you like, drag cards,
  scroll to pan, pinch to zoom, fit or focus, ⌘-click to select several
  and move, fit, focus or close them together. Undo everything. Each flow
  tab keeps its canvas across reloads.
- **Any file:** README, docs, JSON, CSS and other project files open as
  text cards too (Markdown headings fold into sections).

### Ask for a flow
Type **/** and a question: `/how do we create the tabs`,
`/what calls showAll`, `/where are the theme colours defined`,
`/what most likely breaks from these changes`. lode builds the answer as a
flow in a new tab, in well under a second: where to start, then each step
it leads to, each card with a note on why it's there.

It isn't an LLM writing an answer. The graph supplies every candidate;
[TypeSafe's Jev](https://docs.typesafe.ai) makes fast, typed judgments
about them (what kind of question it is, where to start, whether each next
step belongs, how risky each dependent of a change is), and code builds
the flow. Every card is a real piece of your code, and it takes 2-3 model
calls and a fraction of a cent.

### Explain, and build it out, in conversation
Every flow has an **explain** panel (**i**): explain the whole flow, the
selected cards, or ask follow-ups ("why does closeTab call select?"). The
answer streams in, grounded in the exact code on the canvas, and every
name in it is a link to its card. Ask for more ("also show where the tabs
get saved") and the model searches and reads lode's graph, then **adds the
cards** to your canvas, linked like any other. Flows built with **/** get
an "explain this flow" button. Conversations are saved with the tab.

Claude does the explaining (`ANTHROPIC_API_KEY` in `.env`), and you pick
the model per question in the panel (Sonnet by default, Haiku for speed,
Opus for depth; `LODE_EXPLAIN_MODEL` sets the server's default). It sits
behind a small `ChatModel` interface any model can implement, and a host
can offer its own list of models or limit which are allowed.

### Git changes

![The changes sidebar and a flow with the diff shown on its cards](docs/images/changes.png)

- **Changes sidebar:** every changed file, dropping down into the
  declarations that changed as a hierarchy (a class over its methods),
  with +/− counts, against `HEAD` or any ref. It updates live as files
  change, so an agent's edits show up as they land.
- **Diffs on cards:** added lines in green, removed lines struck through
  where they were, folds that hide changes marked. Cards open at their
  changes.
- **Open all** lays every changed symbol out as a flow (callers left of
  what they call); **open N changes** opens a card's changed folds at
  once; chips that lead to a change are marked, so you can follow them.

### Edit in place
Press **Enter** on a card to edit its code; **⌘S** saves. You edit exactly
what the card shows; hidden lines are never touched. Saves are checked
against the file (a conflicting change is refused, not overwritten), the
graph re-indexes, and undo goes back past a save.

### Context for LLMs
lode knows which code matters, so it can hand a model exactly that instead
of whole files: full code at the centre (unrelated folds collapsed),
signatures and the connecting line one hop out, names further out, and
the connections spelled out, sized to a token budget.

- **`lode mcp`** serves it to any agent over MCP (Claude Code, Cursor,
  Clance…): `lode_read` (a symbol and its surroundings), `lode_context` (a
  question or symbols), `lode_impact` (what your changes touch),
  `lode_search`, `lode_changes`, `lode_entries`. `skills/lode/SKILL.md`
  teaches agents when to use which.
- **Copy context** on any flow copies its cards (or the selected ones) as
  Markdown for a chat, with the diff if changes are shown.
- Deterministic by default (same commit and request, same context);
  `rank: "judge"` lets Jev choose what's relevant.

```sh
npm run build
claude mcp add lode -- node /path/to/lode/dist/lib/src/cli.js mcp /path/to/project
```

### Keyboard
A line cursor in the selected card: **↑↓** lines, **→** follow a chip or
fold (**Tab** picks which), **←** back along the arrow, **[ ]** cards in
reading order, **n / ⇧N** next and previous change, **e** expand, **o / c**
open and fold, **Space** focus, **f** fit, **/** ask, **?** every key.

### Entry points
Where to start reading an unfamiliar codebase: what the outside world calls
into (IPC handlers, messages between processes, events, exports nothing in
the project calls), grouped by runtime, with a line on how the runtimes
talk (`renderer → preload: 230 · preload → main: 139`).

## Quick start

```sh
git clone https://github.com/damiensmith1/lode.git && cd lode
npm install
npm run lode -- open path/to/any/project     # the app, in your browser
```

A project is any folder, or a `tsconfig.json` / `jsconfig.json`. JavaScript
is always included (ESM, CommonJS, JSDoc types). The graph is cached in
`~/.cache/lode/` (`--cache <dir>` to change it); nothing is written into
the project unless you save an edit.

For **/** questions and the explain panel, add keys to a `.env` in lode's
folder (it's git-ignored, and lode reads only these keys from it):

```sh
TYPESAFE_API_KEY=your-key        # / questions (Jev)
ANTHROPIC_API_KEY=your-key       # explain (Claude)
# LODE_EXPLAIN_MODEL=claude-haiku-5-5   # optional: faster, streams after tool calls
```

Other commands:

```sh
npm run lode -- serve <project> [--port n] [--origin url]   # just the server, for another host
npm run lode -- index <project> [--json out.json]            # build the graph, print a summary
npm run lode -- node <project> 'src/main.ts#run'             # one node, its edges each way
node dist/lib/src/cli.js mcp <project>                       # MCP server on stdio, for agents (after npm run build)
```

## How it fits together

```
 any folder ──▶ language plugin ──▶ graph (core) ──▶ queries ──▶ service ──┬─▶ WebSocket server ─▶ views in any web page
                (TS/JS today)       nodes, edges,    block,      the       └─▶ any message channel ─▶ views in a webview, Electron, …
                                    channels,        entries,    methods,
                                    regions          search,     no transport        views: <lode-flow>, <lode-entries>, <lode-changes>
                                                     changes,                        host: your editor or app (opens files,
                                                     ask (Jev)                         stores state, themes, keys, markup)
```

- **Core** (`src/schema`, `src/ingest`, `src/derive`, `src/graph`): a
  deterministic, incremental graph of a project: containment, calls,
  references, and data flows in three tiers (within a function, through
  shared state, across process boundaries such as Electron IPC). Language
  support is a plugin.
- **Queries** (`src/query`): what the views need, all deterministic: code
  blocks with their links and callers, entry points, search, file lists,
  git changes mapped to symbols.
- **Ask** (`src/ask`): a flow for a question, built from graph candidates
  that a `Judge` (Jev by default) scores.
- **Context** (`src/context`, `src/mcp`): slices of the graph formatted
  for language models, and an MCP server that serves them.
- **Explain** (`src/explain`): a conversation about the canvas with a
  `ChatModel` (Claude by default) that can search, read and add cards.
- **Service and server** (`src/service`, `src/server`): the queries as
  methods with no transport, a file watcher, and an optional localhost
  WebSocket server.
- **Views** (`views/`): framework-free web components with shadow DOM,
  that know nothing about the page around them.
- **Hosts** (`hosts/`): the standalone app, and a whole host in one HTML
  file.

## Embed it anywhere

lode is built to be plugged into an editor (VS Code, JetBrains), an
Electron app, or any web page. A host decides how views reach the core,
where their state lives, how they look, which keys do what, and what
"open this file" means. Everything below is in
[`docs/embedding.md`](docs/embedding.md).

**Packages:** `lode` (core, queries, service, ask, context), `lode/server`, `lode/mcp`,
`lode/views`, `lode/views/highlight`, self-contained bundles in
`dist/views` for pages without a bundler, and the `lode` command
(`npm run build` makes them).

**Run the core** in Node, on any folder, and keep it current:

```ts
import { GraphStore, tsPlugin, createService } from "lode";

const service = createService(GraphStore.open(tsPlugin, folder));
service.watch(); // re-index as files change; views update
```

**Connect the views** over whatever the host has: a localhost WebSocket
(`startServer`, `LodeClient`), or any message channel with no server or
port, like a VS Code webview's `postMessage`:

```ts
// extension / main process
serveMessages(service, { send: (m) => panel.webview.postMessage(m), listen: (h) => panel.webview.onDidReceiveMessage(h).dispose });
// webview
const connection = new MessageConnection({ send: (m) => vscode.postMessage(m), listen: (h) => /* window "message" events */ });
```

**Mount views** with a host:

```ts
const flow = createView({ kind: "flow", id: "src/main.ts#run", state: "tab-1" }, connection, {
  openView: (request) => { /* open or reuse a tab */ },
  openSource: (file, line) => editor.open(file, line), // optional: else files open as cards
  highlight: (lines) => editor.decorate(lines),         // optional: mark what the card covers
  ...highlightJs,                                       // or your editor's own syntax colours
  storage: workspaceStorage,                            // where each tab keeps its canvas
});
```

What a host can plug in or take over:

| | |
| --- | --- |
| **Transport** | `LodeConnection`: WebSocket client, `MessageConnection`, or your own `{ call, onChanged }` |
| **State** | `LodeStorage` per view key: the project's cache (default), `localStorage`, memory, or yours (VS Code `workspaceState`, a database) |
| **Look** | every colour and font is a `--lode-*` token (light and dark themes included, syntax colours too); `::part()` on every piece; `host.css` inside every view |
| **Markup** | `host.render` hooks add your own HTML to card headers, footers, line ends and chip labels, with `data-action="host:…"` buttons |
| **Interaction** | events for every action (cancelable, so you can take any over: open chips in your editor), selection, open, close, edits, saves |
| **Keys** | every key is a command; remap, disable, or drive `flow.run(command)` from your own keybindings |
| **Editing** | read-only, per card, or yours: `host.saveEdits` lets the editor apply saves with its own undo |
| **Your own UI** | `lodeApi(connection)`: files, `buildFileTree`, search, entries, changes, symbol at cursor, ask |
| **Asking** | `flow.ask(question)`, `flow.loadPlan(plan)`, or your own model behind the `Judge` interface |
| **Explaining** | the flow's explain panel, `flow.sendExplain(text)`, `explain()` in Node, or your own model behind `ChatModel`; answers stream as `explain` events on the connection |
| **LLM context** | `contextFor(request)` in Node, `lode/mcp` (`serveMcp`) for agents, `flow.context()` and the cancelable `lode-context` event to send a canvas to your own agent |
| **Languages** | a `LanguagePlugin` reads a project into nodes, edges, channels and fold regions; the core does the rest |

`hosts/minimal/index.html` is a complete host in one page, from the
prebuilt bundles.

## Security

The server listens on localhost only and every connection needs the
session's random token, an allowed Origin and a localhost Host header, so
other web pages can't read your code. Reads and writes are limited to the
project's own files (resolved for real, inside the root). Model keys stay
on the server. `.env` files are read for lode's own key only.

## Development

```sh
npm test            # unit and integration tests, on fixtures
npm run typecheck
npm run build       # dist/lib, dist/app, dist/views
npm run build:web   # just the app
```

`docs/` holds the background, requirements and design notes, kept current
with the code.

## License

[MIT](LICENSE) © Damien Smith
