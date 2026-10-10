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
// After files change (from your own watcher): service.refresh()
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

## 4. The host

```ts
const host: LodeHost = {
  openView: (request) => …,                    // required: open a flow/entries tab, or show() in one
  openSource: (file, line) => editor.open(…),  // optional: without it, a card's title opens the file as a card
  highlight: (h) => editor.decorate(h),        // optional: lines the selected card covers (null clears)
  syntax: (text, file) => htmlLines,           // optional: one HTML string per line, source escaped
  syntaxCss: "…",                              // CSS for what `syntax` emits
  storage: myStorage,                          // optional: where views keep state (default: the project's cache)
  css: "…",                                    // optional: CSS added last inside every view
};
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

## 5. Look

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
  `paging`, `paging-button`, `arrows`; entries: `page`, `lede`, `summary`,
  `filter`, `list`, `runtime`, `category`, `entry`, `more`.
- **`host.css`** goes last inside every view's shadow root, for anything
  tokens and parts don't reach.

## Other languages

A language is a `LanguagePlugin` (`src/schema`): it reads a project's
files into nodes, edges, channel endpoints and fold regions, and the core
does the rest. `GraphStore.open(yourPlugin, folder)` uses it in place of
`tsPlugin`.
