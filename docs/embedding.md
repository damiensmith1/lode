# Embedding lode

lode is three layers, and a host picks how to join them:

```
 any folder ─▶ core (Node)                 views (browser)              host
               GraphStore + plugins   ◀──▶ <lode-flow>, <lode-entries>  ◀──▶ your editor / app
               Queries · createService     connection · LodeHost          tabs, storage, theme,
                                                                           editor, syntax colours
```

- **Core** (`lode`): reads a folder into a graph with a language plugin
  (`tsPlugin`: TypeScript and JavaScript; a directory, `tsconfig.json` or
  `jsconfig.json`), caches it, and answers queries. Runs in Node.
- **Views** (`lode/views`): framework-free web components that render the
  graph as cards, arrows, folds and callers, and do the reading mechanics
  (drag, zoom, fold, page, select, undo). They touch nothing outside their
  shadow root; everything else comes from the host.
- **Host**: your editor or app. It decides how views reach the core, where
  their state is kept, how they look, and what "open this file" means.

## 1. Run the core

```ts
import { GraphStore, tsPlugin, createService } from "lode";

const store = GraphStore.open(tsPlugin, folder);   // cache: ~/.cache/lode/<hash>, or { cacheDir }
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
view.addEventListener("lode-title", (e) => (tab.label = e.detail));
// later, read something else in the same flow:
(view as LodeFlow).show("src/other.ts#thing");
```

- `kind: "flow"` is the reading canvas; `kind: "entries"` is where to start
  (it asks the host to `openView` a flow when an entry is picked).
- `state` names where that flow keeps its canvas (cards, arrows, camera,
  selection). Give each tab its own key; create a view with the same key
  again to bring the tab back as it was. Default `"flow"`.

Without a bundler (a webview, a plain page), import the self-contained
bundles: `lode/dist/views/lode-views.js` and `lode-highlight.js`. See
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

Also `info()`, `entries()`, `block(id)`, `source(file)`.

## 5. Driving a flow and listening to it

Methods on a `<lode-flow>`: `show(id)` (add a node or file, or go to its
card), `run(command)`, `cards()`, `selection()`, `setSelection(keys)`.
Commands: `close` (the selection), `undo`, `fit`, `focus`, `deselect`,
`zoomReset`, `clear`.

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
| `lode-title` | the view's title changed | the title |

`preventDefault()` on `lode-action` takes an action over, e.g. open chips
in the editor instead of on the canvas:

```ts
flow.addEventListener("lode-action", (e) => {
  if (e.detail.action === "open") { e.preventDefault(); editor.reveal(e.detail.target); }
});
```

**Keys.** Defaults: `close` Delete / Backspace, `undo` Mod+z (⌘ or Ctrl);
the rest have none. `host.keys` remaps (`{ undo: ["Mod+Shift+u"], fit:
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

**Syntax colours**: bring your editor's tokenizer, or use the bundled one:
`import { highlightJs } from "lode/views/highlight"` then `{ ...highlightJs }`.

**Storage** (`LodeStorage`: `load(key)`, `save(key, value)`, null removes;
sync or async):

- `serviceStorage(connection)`: in lode's cache, with the project (default).
- `localStorageStorage(prefix)`: this browser.
- `memoryStorage()`: this page only.
- your own: VS Code `context.workspaceState`, a webview's `getState`, a
  database, Clance's store. A host can also keep its own tab list in the
  same storage, as the standalone app does (`app-tabs`).

## 7. Editing

Cards' code is always editable: what a card shows is what you can change.
Folded and paged-off lines can't be touched from the card (an edit never
crosses them). Typing, Enter (keeps the indent), Backspace/Delete (joining
lines only where both are visible together), Tab, paste, cut and copy (the
code only) and ⌘Z / ⌘⇧Z (per card) work inside a card's code. ⌘S saves the
card; a card with unsaved edits shows "● unsaved · save · discard", and the
toolbar counts them. Undo goes back past a save: the card becomes unsaved
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

## 8. Look

- **Tokens.** Every colour and font is a `--lode-*` custom property, set on
  any ancestor of a view (or on the view). Ready-made: `LIGHT_THEME` (the
  default) and `DARK_THEME`; `themeCss(theme, selector)` turns one into CSS.
  Map them to your editor's theme variables, e.g.
  `lode-flow { --lode-bg: var(--vscode-editor-background); … }`.
  Tokens: bg, surface, sunken, fg, muted, faint, line-number, border,
  outline, shadow, calls, local, channel, channel-text, state, font, mono,
  and syntax-{keyword, string, number, title, type, comment, attr, variable}.
- **Parts.** Pieces carry `part` names for `::part()` from the host page:
  flow: `toolbar`, `toolbar-hint`, `canvas`, `board`, `empty`, `card`,
  `card-selected`, `card-header`, `card-title`, `card-meta`, `card-close`,
  `callers`, `caller`, `code`, `line`, `line-number`, `source`, `chips`,
  `chip`, `chip-calls`, `chip-channel`, `chip-state`, `chip-local`, `fold`,
  `paging`, `paging-button`, `arrows`, and `host-header`, `host-footer`,
  `host-line` around render hooks' markup; entries: `page`, `lede`, `summary`,
  `filter`, `list`, `runtime`, `category`, `entry`, `more`.
- **`host.css`** goes last inside every view's shadow root, for anything
  tokens and parts don't reach.

## Other languages

A language is a `LanguagePlugin` (`src/schema`): it reads a project's
files into nodes, edges, channel endpoints and fold regions, and the core
does the rest. `GraphStore.open(yourPlugin, folder)` uses it in place of
`tsPlugin`.
