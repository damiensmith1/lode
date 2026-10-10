// The standalone host: entry points to pick where to start, flows to read
// from there (as many tabs as you like, each with its own canvas), and a
// file tree (a file opens in the flow too). Nothing moves on its own, only
// on clicks. It's one host among many; everything lode-specific comes from
// ../../views through LodeHost.
import { highlightJs } from "../../views/highlight.js";
import type { ChangesResult } from "../../src/query/types.js";
import { buildFileTree, createView, lodeApi, LodeClient, serviceStorage, TITLE_EVENT, type FileTreeNode, type LodeFlow, type LodeHost, type ViewRequest } from "../../views/index.js";

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

interface Tab {
  request: ViewRequest;
  button: HTMLButtonElement;
  view: HTMLElement;
}
const tabs: Tab[] = [];
let current: Tab | undefined;
let lastFlow: Tab | undefined; // where entries, search and the tree read

const isFlow = (t: Tab) => t.request.kind === "flow";

const host: LodeHost = {
  // No openSource: there's no separate editor, so the flow opens the file
  // as a card next to the one it came from.
  openView: (r) => void openView(r),
  storage,
  ...highlightJs,
};

function select(tab: Tab) {
  current = tab;
  if (isFlow(tab)) lastFlow = tab;
  for (const t of tabs) t.button.setAttribute("aria-selected", String(t === tab));
  $("view").replaceChildren(tab.view);
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
function openView(request: ViewRequest, newTab = false): Tab {
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

function addTab(request: ViewRequest, at = tabs.length): Tab {
  if (request.kind === "flow" && !request.state) {
    // The first flow keeps the key flows always used, so its canvas survives.
    const used = new Set(tabs.map((t) => (t.request.kind === "flow" ? t.request.state : "")));
    request = { ...request, state: used.has("flow") ? `flow-${Math.random().toString(36).slice(2, 10)}` : "flow" };
  }
  const label = el("span", {}, request.kind);
  const close = el("span", { className: "close", title: "Close", role: "button" }, "×");
  const icon = el("span", { className: "diamond", ariaHidden: "true" }, "◇");
  const button = el("button", { className: "tab", role: "tab" }, icon, label, close);
  const tab: Tab = { request, button, view: createView(request, client, host) };
  tab.view.addEventListener(TITLE_EVENT, (e) => (label.textContent = String((e as CustomEvent).detail)));
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
        rows.push(indent(el("button", { ariaExpanded: String(isOpen), onclick: toggle }, `${isOpen ? "▾" : "▸"} ${n.name}`), depth));
        if (isOpen) walk(n.children ?? [], depth + 1);
      } else {
        const dot = n.indexed === false ? "dot text" : `dot rt-${n.runtime ?? "none"}`;
        const button = indent(el("button", { title: n.runtime ? `runtime: ${n.runtime}` : n.indexed === false ? "text file" : "", onclick: () => readInFlow(n.path) }, el("span", { className: dot }), n.name), depth);
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
  node.style.paddingLeft = `${8 + depth * 14}px`;
  return node;
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
  const counts = (a: number, r: number) => el("span", { className: "n" }, ...(a ? [el("span", { className: "add" }, `+${a} `)] : []), ...(r ? [el("span", { className: "del" }, `−${r}`)] : []));
  const read = (id: string) => openView({ kind: "flow", id, diff: changes!.base });
  const rows: HTMLElement[] = [];
  for (const f of changes.files) {
    const open = openFiles.has(f.file);
    const status = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U" }[f.status];
    // Symbols under the file: the hierarchy, top-level ones first.
    const symbols = f.status === "added" || f.status === "untracked" ? [] : f.symbols.filter((s) => s.node.id !== f.file || s.added || s.removed);
    const chev = el("span", { className: "chev" }, symbols.length ? (open ? "▾" : "▸") : "");
    const gone = f.status === "deleted";
    const row = el(
      "button",
      { className: `row file${gone ? " gone" : ""}`, title: f.from ? `${f.from} → ${f.file}` : f.file },
      chev,
      el("span", { className: `st ${status}` }, status),
      el("span", { className: "name" }, f.file),
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
        const sChev = el("span", { className: "chev" }, kids ? (folded ? "▸" : "▾") : "");
        const label = s.node.id === f.file ? "(top level)" : s.node.name;
        const sRow = el("button", { className: "row", title: s.node.id }, sChev, el("span", { className: "name" }, label, " ", el("span", { className: "kind" }, s.node.kind)), counts(s.added, s.removed));
        sRow.style.paddingLeft = `${10 + depth * 14}px`;
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
  input.addEventListener("input", () => {
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
    if (e.key === "Enter") results.querySelector<HTMLButtonElement>("button")?.click();
  });
  document.addEventListener("click", (e) => {
    if (!(e.target as Element).closest(".search")) results.hidden = true;
  });
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
  renderTree(buildFileTree(await api.files()));
  setupSearch();
  $("toggle-tree").addEventListener("click", () => document.body.classList.toggle("no-tree"));
  setupChanges();
  const side = (await storage.load(SIDE_KEY)) as { mode?: "files" | "changes"; base?: string } | null;
  if (side?.base) $<HTMLInputElement>("changes-base").value = side.base;
  setSideMode(side?.mode === "changes" ? "changes" : "files");
  void loadChanges(); // the count on the toggle

  // The tabs open last time, or entry points and a flow.
  const newFlow = el("button", { id: "new-flow", className: "tab new", title: "New flow tab", ariaLabel: "New flow tab" }, "+");
  newFlow.addEventListener("click", () => openView({ kind: "flow" }, true));
  $("tabs").append(newFlow);
  const saved = (await storage.load(TABS_KEY)) as { tabs: ViewRequest[]; selected: number } | null;
  const restored: ViewRequest[] = saved?.tabs?.length ? saved.tabs : [{ kind: "entries" }, { kind: "flow", state: "flow" }];
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
    Object.assign(info, await api.info());
    renderTree(buildFileTree(await api.files()));
    void loadChanges();
    setStatus(` · re-indexed ${files.length} file${files.length === 1 ? "" : "s"}`);
  });
}

start().catch((error) => {
  document.body.textContent = `lode: ${error.message}`;
});
