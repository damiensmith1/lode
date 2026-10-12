// The standalone host: entry points to pick where to start, flows to read
// from there (as many tabs as you like, each with its own canvas), and a
// file tree (a file opens in the flow too). Nothing moves on its own, only
// on clicks. It's one host among many, built only on lode's API: lodeApi
// for data, the flow (createView) and its methods and events. The tabs,
// tree, changes list, entry points, the flow's toolbar and question line,
// the keys help and the explain panel are all the app's own.
import { highlightJs } from "./highlight.js";
import type { ChangesResult } from "../../src/query/types.js";
import { ExplainPanel } from "./explain.js";
import { entriesView } from "./entries.js";
import { renderMarkdown } from "./markdown.js";
import { ACTION_EVENT, ASK_EVENT, CHANGE_EVENT, COMMAND_HELP, DEFAULT_KEYS, DIRTY_EVENT, SELECT_EVENT, buildFileTree, createView, lodeApi, LodeClient, serviceStorage, CLOSE_EVENT, OPEN_EVENT, type FileTreeNode, type FlowCommand, type LodeFlow, type LodeHost, type ViewRequest } from "../../views/index.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

// The server puts its session token in the fragment (never sent over HTTP).
const link = new URLSearchParams(location.hash.slice(1));
const client = new LodeClient(`ws://${location.host}/rpc?token=${encodeURIComponent(link.get("token") ?? "")}`);
// Tabs and each flow's canvas are kept with the project (lode's cache).
const storage = serviceStorage(client);
const api = lodeApi(client);
const TABS_KEY = "app-tabs";
const SIDE_KEY = "app-sidebar"; // files or changes, and the changes' base

// --- Tabs of lode views ---------------------------------------------------

// A tab: a flow (lode's), or the app's entry points.
type AppRequest = ViewRequest | { kind: "entries" };

interface Tab {
  request: AppRequest;
  button: HTMLButtonElement;
  view: HTMLElement;
  reload?: () => Promise<void>; // entry points: after re-indexing
}
const tabs: Tab[] = [];
let current: Tab | undefined;
let lastFlow: Tab | undefined; // where entries, search and the tree read

const isFlow = (t: Tab) => t.request.kind === "flow";
const flowOf = (t: Tab | undefined) => (t && isFlow(t) ? (t.view as LodeFlow) : null);

const host: LodeHost = {
  // No openSource: there's no separate editor, so the flow opens the file
  // as a card next to the one it came from.
  openView: (r) => void openView(r),
  storage,
  empty: "Pick an entry point, a file or a symbol to start reading from it.",
  // Note cards' text is Markdown (escaped first: renderMarkdown is safe).
  renderNote: (text) => renderMarkdown(text),
  ...highlightJs,
};

// The explain panel talks about the flow tab last shown (see explain.ts:
// a host feature, built on the flow's scope/apply/highlight).
const explain = new ExplainPanel($("explain"), client, storage);

function select(tab: Tab) {
  current = tab;
  if (isFlow(tab)) {
    lastFlow = tab;
    void explain.attach(tab.view as LodeFlow, tab.request.kind === "flow" ? (tab.request.state ?? "flow") : "flow");
  }
  for (const t of tabs) t.button.setAttribute("aria-selected", String(t === tab));
  $("view").replaceChildren(tab.view);
  $("flowbar").hidden = !isFlow(tab);
  renderFlowbar();
  saveTabs();
}

function saveTabs() {
  void storage.save(TABS_KEY, {
    // A flow's own state (cards, diff) is in its storage; just its key here.
    tabs: tabs.map((t) => (t.request.kind === "flow" ? { kind: "flow", state: t.request.state } : t.request)),
    selected: current ? tabs.indexOf(current) : 0,
  });
}

// A flow request reads in the last flow tab (or the first one, if none is
// open), turning on its git changes if asked; `newTab` adds a flow tab
// instead. Entries and changes have one tab each.
function openView(request: AppRequest, newTab = false): Tab {
  if (request.kind === "flow" && !newTab && !request.newTab) {
    const flow = lastFlow && tabs.includes(lastFlow) ? lastFlow : tabs.find(isFlow);
    if (flow) {
      const view = flow.view as LodeFlow;
      void (async () => {
        if (request.diff) await view.setDiff(request.diff);
        await view.showAll([...(request.id ? [request.id] : []), ...(request.ids ?? [])]);
      })();
      select(flow);
      return flow;
    }
  }
  if (request.kind !== "flow") {
    const existing = tabs.find((t) => t.request.kind === request.kind);
    if (existing) return (select(existing), existing);
  }
  return addTab(request.kind === "flow" ? { ...request, newTab: undefined } : request);
}

function addTab(request: AppRequest, at = tabs.length): Tab {
  if (request.kind === "flow" && !request.state) {
    // The first flow keeps the key flows always used, so its canvas survives.
    const used = new Set(tabs.map((t) => (t.request.kind === "flow" ? t.request.state : "")));
    request = { ...request, state: used.has("flow") ? `flow-${Math.random().toString(36).slice(2, 10)}` : "flow" };
  }
  const label = el("span", {}, request.kind);
  const close = el("span", { className: "close", title: "Close", role: "button" }, "×");
  const icon = el("span", { className: "diamond", ariaHidden: "true" }, "◇");
  const button = el("button", { className: "tab", role: "tab" }, icon, label, close);
  let tab: Tab;
  if (request.kind === "flow") {
    tab = { request, button, view: createView(request, client, host) };
    // The tab's label: the question it answers, else its first card.
    const flow = tab.view as LodeFlow;
    const name = () => (label.textContent = flow.asked ? `/ ${flow.asked.question}` : flow.cards().length ? `flow · ${flow.cards()[0].node.name}` : "flow");
    for (const event of [ASK_EVENT, OPEN_EVENT, CLOSE_EVENT, CHANGE_EVENT]) flow.addEventListener(event, name);
  } else {
    const entries = entriesView(api, readInFlow);
    tab = { request, button, view: entries.el, reload: entries.reload };
    label.textContent = "entry points";
  }
  button.addEventListener("click", (e) => (e.target === close ? closeTab(tab) : select(tab)));
  tabs.splice(at, 0, tab);
  $("tabs").insertBefore(button, $("new-flow"));
  select(tab);
  return tab;
}

function closeTab(tab: Tab) {
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  tab.button.remove();
  // A closed flow's canvas goes with it.
  if (tab.request.kind === "flow" && tab.request.state) void storage.save(tab.request.state, null);
  if (lastFlow === tab) lastFlow = undefined;
  if (current === tab) {
    current = undefined;
    if (tabs.length) return select(tabs[Math.max(0, i - 1)]);
    $("view").replaceChildren();
  }
  saveTabs();
}

// Read a node (or a whole file) in the flow.
function readInFlow(id: string) {
  openView({ kind: "flow", id });
  currentFile = id;
  document.querySelectorAll<HTMLElement>("#tree [data-file]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.file === id)));
}

// --- File tree ------------------------------------------------------------

// Folders start open at the top level; what's opened stays open across
// redraws (after re-indexing, say).
const openDirs = new Set<string>();
let treeShown = false;
let currentFile = "";

function renderTree(tree: FileTreeNode[]) {
  if (!treeShown) for (const n of tree) if (n.kind === "dir") openDirs.add(n.path);
  treeShown = true;
  const rows: HTMLElement[] = [];
  const walk = (nodes: FileTreeNode[], depth: number) => {
    for (const n of nodes) {
      if (n.kind === "dir") {
        const isOpen = openDirs.has(n.path);
        const toggle = () => (isOpen ? openDirs.delete(n.path) : openDirs.add(n.path), renderTree(tree));
        rows.push(indent(el("button", { className: "row", ariaExpanded: String(isOpen), onclick: toggle, title: n.path }, twist(true), icon(folderIcon(n.name, isOpen)), el("span", { className: "name" }, n.name)), depth));
        if (isOpen) walk(n.children ?? [], depth + 1);
      } else {
        const title = `${n.path}${n.runtime ? ` · runtime: ${n.runtime}` : n.indexed === false ? " · text (not in the code graph)" : ""}`;
        const button = indent(el("button", { className: `row${n.indexed === false ? " text" : ""}`, title, onclick: () => readInFlow(n.path) }, twist(false), icon(fileIcon(n.name)), el("span", { className: "name" }, n.name)), depth);
        button.dataset.file = n.path;
        button.setAttribute("aria-current", String(n.path === currentFile));
        rows.push(button);
      }
    }
  };
  walk(tree, 0);
  $("tree").replaceChildren(...rows);
}

function indent<T extends HTMLElement>(node: T, depth: number): T {
  node.style.paddingLeft = `${6 + depth * 11}px`;
  return node;
}

// A folder's chevron (a file keeps the space, so names line up).
function twist(dir: boolean): HTMLElement {
  const span = el("span", { className: "twist" });
  if (dir) span.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>';
  return span;
}

// File and folder icons by name: Material Icon Theme's mapping (file-icons/,
// the subset Clance ships). Without the map, the plain file and folder.
type IconMap = { file: string; folder: string; folderExpanded: string; fileExtensions: Record<string, string>; fileNames: Record<string, string>; folderNames: Record<string, string>; folderNamesExpanded: Record<string, string> };
let icons: IconMap = { file: "file", folder: "folder", folderExpanded: "folder-open", fileExtensions: {}, fileNames: {}, folderNames: {}, folderNamesExpanded: {} };

function fileIcon(name: string): string {
  const lower = name.toLowerCase();
  if (icons.fileNames[lower]) return icons.fileNames[lower];
  // "a.test.ts" tries "test.ts" before "ts".
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    if (icons.fileExtensions[ext]) return icons.fileExtensions[ext];
  }
  return icons.file;
}

function folderIcon(name: string, open: boolean): string {
  const lower = name.toLowerCase();
  return open ? (icons.folderNamesExpanded[lower] ?? icons.folderExpanded) : (icons.folderNames[lower] ?? icons.folder);
}

function icon(name: string): HTMLElement {
  return el("span", { className: "icon" }, el("img", { src: `file-icons/${name}.svg`, alt: "" }));
}

// The sidebar's width: dragged on its edge, kept between runs.
const WIDTH_KEY = "lode-sidebar-width";
function setupResize() {
  const apply = (w: number) => document.body.style.setProperty("--side-width", `${Math.round(Math.min(Math.max(w, 180), window.innerWidth * 0.6))}px`);
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (saved) apply(saved);
  } catch {
    // No storage: the default width.
  }
  const handle = $("side-resize");
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const left = $("side").getBoundingClientRect().left;
    const move = (m: PointerEvent) => apply(m.clientX - left);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      try {
        localStorage.setItem(WIDTH_KEY, String($("side").getBoundingClientRect().width));
      } catch {
        // Not kept; fine.
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  handle.addEventListener("dblclick", () => (apply(260), localStorage.removeItem(WIDTH_KEY)));
}

// --- Changes (the sidebar's other mode) -------------------------------------
//
// What changed in git since a ref: files, each dropping down into the
// declarations that changed, as a hierarchy (a class over its methods).
// Picking one reads it in the flow with the diff shown.

const openFiles = new Set<string>(); // files dropped down
const closedSymbols = new Set<string>(); // symbols with children folded up
let changes: ChangesResult | null = null;
let sideMode: "files" | "changes" = "files";

function changesBase(): string {
  return $<HTMLInputElement>("changes-base").value.trim() || "HEAD";
}

async function loadChanges() {
  changes = await api.changes(changesBase()).catch((error) => ({ base: changesBase(), error: String(error), files: [] }));
  const total = changes.files.length;
  $("changes-count").textContent = total ? String(total) : "";
  if (sideMode === "changes") renderChanges();
}

function setSideMode(mode: "files" | "changes") {
  sideMode = mode;
  $("side-files").setAttribute("aria-selected", String(mode === "files"));
  $("side-changes").setAttribute("aria-selected", String(mode === "changes"));
  $("tree").hidden = mode !== "files";
  $("changes").hidden = mode !== "changes";
  void storage.save(SIDE_KEY, { mode, base: changesBase() });
  if (mode === "changes") void loadChanges();
}

function renderChanges() {
  const list = $("changes-list");
  const totals = $("changes-totals");
  if (!changes || changes.error) {
    totals.textContent = "";
    return void list.replaceChildren(el("div", { className: "faint" }, changes?.error ?? "loading…"));
  }
  const added = changes.files.reduce((n, f) => n + f.added, 0);
  const removed = changes.files.reduce((n, f) => n + f.removed, 0);
  totals.textContent = changes.files.length ? `${changes.files.length} file${changes.files.length === 1 ? "" : "s"} · +${added} −${removed}` : `no changes since ${changes.base}`;
  const counts = (a: number, r: number) => el("span", { className: "n" }, ...(a ? [el("span", { className: "add" }, `+${a}`)] : []), ...(r ? [el("span", { className: "del" }, `−${r}`)] : []));
  const read = (id: string) => openView({ kind: "flow", id, diff: changes!.base });
  const rows: HTMLElement[] = [];
  for (const f of changes.files) {
    const open = openFiles.has(f.file);
    const status = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U" }[f.status];
    // Symbols under the file: the hierarchy, top-level ones first.
    const symbols = f.status === "added" || f.status === "untracked" ? [] : f.symbols.filter((s) => s.node.id !== f.file || s.added || s.removed);
    const chev = chevron(symbols.length > 0, open);
    const gone = f.status === "deleted";
    const row = el(
      "button",
      { className: `row file${gone ? " gone" : ""}`, title: f.from ? `${f.from} → ${f.file}` : f.file },
      chev,
      el("span", { className: `st ${status}` }, status),
      // The name carries the row; the folder recedes (and truncates first).
      el("span", { className: "path" }, el("span", { className: "dir" }, f.file.includes("/") ? f.file.slice(0, f.file.lastIndexOf("/") + 1) : ""), el("span", { className: "base" }, f.file.slice(f.file.lastIndexOf("/") + 1))),
      counts(f.added, f.removed),
    );
    // The arrow drops down; the name reads the whole file.
    row.addEventListener("click", (e) => {
      if (e.target === chev && symbols.length) {
        open ? openFiles.delete(f.file) : openFiles.add(f.file);
        return renderChanges();
      }
      if (!gone) read(f.file);
    });
    rows.push(row);
    if (!open) continue;
    const children = new Map<string | undefined, typeof symbols>();
    for (const s of symbols) children.set(s.parent, [...(children.get(s.parent) ?? []), s]);
    const walk = (parent: string | undefined, depth: number) => {
      for (const s of children.get(parent) ?? []) {
        const kids = children.get(s.node.id)?.length ?? 0;
        const folded = closedSymbols.has(s.node.id);
        const sChev = chevron(kids > 0, !folded);
        const label = s.node.id === f.file ? "(top level)" : s.node.name;
        const sRow = el("button", { className: "row", title: s.node.id }, sChev, el("span", { className: "name" }, label, " ", el("span", { className: "kind" }, s.node.kind)), counts(s.added, s.removed));
        sRow.style.paddingLeft = `${8 + depth * 14}px`;
        sRow.addEventListener("click", (e) => {
          if (e.target === sChev && kids) {
            folded ? closedSymbols.delete(s.node.id) : closedSymbols.add(s.node.id);
            return renderChanges();
          }
          read(s.node.id);
        });
        rows.push(sRow);
        if (!folded) walk(s.node.id, depth + 1);
      }
    };
    walk(undefined, 1);
  }
  list.replaceChildren(...rows);
}

// A drop-down's chevron (rotated when open); empty, but keeping its space,
// when there's nothing under the row.
function chevron(has: boolean, open: boolean): HTMLElement {
  const span = twist(has);
  span.classList.add("chev");
  if (open) span.classList.add("open");
  return span;
}

function setupChanges() {
  $("side-files").addEventListener("click", () => setSideMode("files"));
  $("side-changes").addEventListener("click", () => setSideMode("changes"));
  $("changes-base").addEventListener("change", () => {
    void storage.save(SIDE_KEY, { mode: sideMode, base: changesBase() });
    void loadChanges();
  });
  $("changes-all").addEventListener("click", () => {
    const ids = (changes?.files ?? []).flatMap((f) => (f.status === "deleted" ? [] : f.status === "added" || f.status === "untracked" || !f.symbols.length ? [f.file] : f.symbols.filter((s) => s.added || s.removed).map((s) => s.node.id)));
    if (ids.length) openView({ kind: "flow", ids, diff: changesBase(), newTab: true });
  });
}

// --- Search ---------------------------------------------------------------

function setupSearch() {
  const input = $<HTMLInputElement>("search");
  const results = $<HTMLUListElement>("results");
  let timer: number | undefined;
  // "/" first: a question, not a symbol name. Enter asks it in a new flow.
  const asking = () => input.value.startsWith("/");
  input.addEventListener("input", () => {
    input.classList.toggle("asking", asking());
    if (asking()) {
      clearTimeout(timer);
      results.hidden = true;
      return;
    }
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const found = await api.search(input.value);
      results.hidden = found.length === 0;
      results.replaceChildren(
        ...found.map((n) =>
          el(
            "li",
            {},
            el(
              "button",
              { role: "option", onclick: () => (readInFlow(n.id), (results.hidden = true), (input.value = "")) },
              el("span", { className: "mono" }, n.name),
              el("span", { className: "where" }, `${n.kind} · ${n.file ?? ""}${n.line ? `:${n.line}` : ""}`),
            ),
          ),
        ),
      );
    }, 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") results.hidden = true;
    if (e.key === "Enter" && asking()) {
      const question = input.value.slice(1).trim();
      if (!question) return;
      openView({ kind: "flow", ask: question, newTab: true });
      input.value = "";
      input.classList.remove("asking");
      input.blur();
      return;
    }
    if (e.key === "Enter") results.querySelector<HTMLButtonElement>("button")?.click();
  });
  document.addEventListener("click", (e) => {
    if (!(e.target as Element).closest(".search")) results.hidden = true;
  });
}

// --- The flow's toolbar and question line ------------------------------------
//
// lode's flow is only the canvas; these are the app's, drawn from its
// methods (run, canRun, zoom, diff, unsaved, asked, context) and redrawn on
// its events.

function setupFlowbar() {
  const bar = $("flowbar");
  const flow = () => flowOf(current);
  bar.addEventListener("click", async (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-do]");
    const f = flow();
    if (!b || !f) return;
    const what = b.dataset.do!;
    if (what === "explain") return explain.toggle();
    if (what === "diff") return void f.setDiff(f.diff === null ? "HEAD" : null).then(renderFlowbar);
    if (what === "context") return void copyContext(f);
    f.run(what as FlowCommand);
    renderFlowbar();
  });
  for (const name of [CHANGE_EVENT, SELECT_EVENT, DIRTY_EVENT, ASK_EVENT]) $("view").addEventListener(name, () => renderFlowbar());
}

let flowbarNote = ""; // a moment's message in place of the count ("copied …")

function renderFlowbar() {
  const f = flowOf(current);
  if (!f) return;
  const can = (c: FlowCommand) => f.canRun(c);
  const set = (what: string, enabled: boolean) => ($("flowbar").querySelector<HTMLButtonElement>(`[data-do="${what}"]`)!.disabled = !enabled);
  set("undo", can("undo"));
  set("fit", can("fit"));
  set("focus", can("focus"));
  set("clear", can("clear"));
  $("flowbar").querySelector('[data-do="zoomReset"]')!.textContent = `${Math.round(f.zoom * 100)}%`;
  $("flowbar").querySelector('[data-do="diff"]')!.classList.toggle("on", f.diff !== null);
  const n = f.cards().length;
  const unsaved = f.unsaved().length;
  $("flowbar-count").textContent = flowbarNote || [n ? `${n} card${n === 1 ? "" : "s"}` : "", unsaved ? `${unsaved} unsaved` : ""].filter(Boolean).join(" · ");
  // The question this flow answers, and how asking went.
  const asked = f.asked;
  const line = $("asked");
  line.hidden = !asked;
  if (asked) line.textContent = `/ ${asked.question} · ${asked.status === "asking" ? "asking…" : (asked.detail ?? asked.status)}`;
}

// The cards (or the selection) as context for an LLM, to the clipboard.
async function copyContext(f: LodeFlow) {
  const say = (text: string) => {
    flowbarNote = text;
    renderFlowbar();
    setTimeout(() => ((flowbarNote = ""), renderFlowbar()), 2500);
  };
  try {
    const result = await f.context();
    if (!result) return;
    await navigator.clipboard.writeText(result.markdown);
    say(`copied ${result.items.length} pieces · ${result.tokens.toLocaleString()} tokens`);
  } catch (error) {
    say(`couldn't copy: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// "?": the flow's keys (lode's defaults; a host that remaps them lists its own).
function toggleHelp() {
  const open = document.querySelector(".keys-help");
  if (open) return open.remove();
  const label = (k: string) => k.replace("Mod+", "⌘").replace("Shift+", "⇧").replace("Arrow", "").replace("Up", "↑").replace("Down", "↓").replace("Left", "←").replace("Right", "→");
  const help = el("div", { className: "keys-help" }, el("div", { className: "title" }, "Keys ", el("span", { className: "faint" }, "(Esc or ? closes)")));
  for (const c of Object.keys(COMMAND_HELP) as FlowCommand[]) {
    const keys = DEFAULT_KEYS[c];
    if (!keys?.length) continue;
    help.append(el("div", { className: "row" }, el("span", { className: "keys" }, ...keys.map((k) => el("kbd", {}, label(k)))), el("span", {}, COMMAND_HELP[c])));
  }
  help.append(el("div", { className: "faint note" }, "In code, keys type; Esc comes back here. i opens explain."));
  help.addEventListener("click", () => help.remove());
  document.addEventListener("keydown", function close(e) {
    if (e.key !== "Escape") return;
    help.remove();
    document.removeEventListener("keydown", close);
  });
  $("view").parentElement!.append(help);
}

// --- Start ------------------------------------------------------------------

async function start() {
  const info = await api.info();
  $("project").textContent = info.root;
  const status = $("status");
  const setStatus = (extra = "") => {
    status.textContent = `◇ lode · ${info.files} files · ${info.nodes} nodes · ${info.edges} edges${extra}`;
  };
  setStatus();
  $("side-name").textContent = info.root.split(/[\\/]/).filter(Boolean).pop() ?? info.root;
  icons = await fetch("file-icons/map.json").then((r) => (r.ok ? r.json() : icons)).catch(() => icons);
  setupResize();
  renderTree(buildFileTree(await api.files()));
  setupSearch();
  $("toggle-tree").addEventListener("click", () => document.body.classList.toggle("no-tree"));
  $("open-entries").addEventListener("click", () => openView({ kind: "entries" }));
  // Explain: the header button, or "i" over a flow (not while typing).
  setupFlowbar();
  document.addEventListener("keydown", (e) => {
    const typing = e.composedPath().some((t) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)));
    if (e.key === "i" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && current && isFlow(current)) {
      e.preventDefault();
      explain.toggle();
    }
  });
  for (const name of [SELECT_EVENT, CHANGE_EVENT]) $("view").addEventListener(name, () => explain.refresh());
  // A flow's "?" (help) is ours: the keys, listed.
  document.addEventListener(ACTION_EVENT, (e) => {
    if ((e as CustomEvent).detail?.action !== "help") return;
    e.preventDefault();
    toggleHelp();
  });
  // A flow's "/" (search) is ours: the search box.
  document.addEventListener(ACTION_EVENT, (e) => {
    if ((e as CustomEvent).detail?.action !== "search") return;
    e.preventDefault();
    // From a flow, "/" starts a question.
    const box = $<HTMLInputElement>("search");
    box.value = "/";
    box.classList.add("asking");
    box.focus();
  });
  setupChanges();
  const side = (await storage.load(SIDE_KEY)) as { mode?: "files" | "changes"; base?: string } | null;
  if (side?.base) $<HTMLInputElement>("changes-base").value = side.base;
  setSideMode(side?.mode === "changes" ? "changes" : "files");
  void loadChanges(); // the count on the toggle

  // The tabs open last time, or entry points and a flow.
  const newFlow = el("button", { id: "new-flow", className: "tab new", title: "New flow tab", ariaLabel: "New flow tab" }, "+");
  newFlow.addEventListener("click", () => openView({ kind: "flow" }, true));
  $("tabs").append(newFlow);
  const saved = (await storage.load(TABS_KEY)) as { tabs: AppRequest[]; selected: number } | null;
  // (Older saves may hold a "changes" tab: the sidebar has those now.)
  const kept = (saved?.tabs ?? []).filter((t) => t.kind === "flow" || t.kind === "entries");
  const restored: AppRequest[] = kept.length ? kept : [{ kind: "entries" }, { kind: "flow", state: "flow" }];
  // A startup link reads in the selected flow tab (or the first): it goes in
  // that view's request, so a card already on its canvas is just selected
  // and the saved view stays where it was.
  const start = link.get("flow") ?? link.get("focus") ?? link.get("file"); // older links still work
  const selected = Math.min(saved?.selected ?? 0, restored.length - 1);
  const reader = restored[selected]?.kind === "flow" ? selected : restored.findIndex((r) => r.kind === "flow");
  restored.forEach((request, i) => addTab(start && i === reader && request.kind === "flow" ? { ...request, id: start } : request));
  if (start && reader === -1) openView({ kind: "flow", id: start });
  else select(tabs[start ? reader : selected]);

  client.onChanged(async (files) => {
    for (const t of tabs) void t.reload?.();
    Object.assign(info, await api.info());
    renderTree(buildFileTree(await api.files()));
    void loadChanges();
    setStatus(` · re-indexed ${files.length} file${files.length === 1 ? "" : "s"}`);
  });
}

start().catch((error) => {
  document.body.textContent = `lode: ${error.message}`;
});
