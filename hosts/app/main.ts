// The standalone host: entry points to pick where to start, flows to read
// from there (as many tabs as you like, each with its own canvas), and a
// file tree (a file opens in the flow too). Nothing moves on its own, only
// on clicks. It's one host among many; everything lode-specific comes from
// ../../views through LodeHost.
import type { FileEntry, NodeRef, ProjectInfo } from "../../src/query/types.js";
import { highlightJs } from "../../views/highlight.js";
import { createView, LodeClient, serviceStorage, TITLE_EVENT, type LodeHost, type ViewRequest } from "../../views/index.js";

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
const TABS_KEY = "app-tabs";

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
    tabs: tabs.map((t) => (t.request.kind === "flow" ? { kind: "flow", state: t.request.state } : { kind: t.request.kind })),
    selected: current ? tabs.indexOf(current) : 0,
  });
}

// A flow request reads in the last flow tab (or the first one, if none is
// open); entries has one tab. `newTab` adds a flow tab instead.
function openView(request: ViewRequest, newTab = false): Tab {
  if (request.kind === "flow" && !newTab) {
    const flow = lastFlow && tabs.includes(lastFlow) ? lastFlow : tabs.find(isFlow);
    if (flow) {
      if (request.id) void (flow.view as HTMLElement & { show(id: string): Promise<void> }).show(request.id);
      select(flow);
      return flow;
    }
  }
  if (request.kind === "entries") {
    const existing = tabs.find((t) => t.request.kind === "entries");
    if (existing) return (select(existing), existing);
  }
  return addTab(request);
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
  document.querySelectorAll<HTMLElement>("#tree [data-file]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.file === id)));
}

// --- File tree ------------------------------------------------------------

function renderTree(files: FileEntry[]) {
  const tree = $("tree");
  const open = new Set<string>();
  const draw = () => {
    const rows: HTMLElement[] = [];
    const seenDirs = new Set<string>();
    for (const f of files) {
      const parts = f.file.split("/");
      // Show each ancestor directory once; skip files under closed ones.
      let hidden = false;
      for (let d = 1; d < parts.length; d++) {
        const dir = parts.slice(0, d).join("/");
        if (hidden) break;
        if (!seenDirs.has(dir)) {
          seenDirs.add(dir);
          const isOpen = open.has(dir);
          rows.push(indent(el("button", { ariaExpanded: String(isOpen), onclick: () => (isOpen ? open.delete(dir) : open.add(dir), draw()) }, `${isOpen ? "▾" : "▸"} ${parts[d - 1]}`), d - 1));
        }
        if (!open.has(dir)) hidden = true;
      }
      if (hidden) continue;
      const button = indent(
        el("button", { title: f.runtime ? `runtime: ${f.runtime}` : "", onclick: () => readInFlow(f.file) }, el("span", { className: `dot rt-${f.runtime ?? "none"}` }), parts[parts.length - 1]),
        parts.length - 1,
      );
      button.dataset.file = f.file;
      rows.push(button);
    }
    tree.replaceChildren(...rows);
  };
  for (const f of files) {
    const parts = f.file.split("/");
    if (parts.length > 1) open.add(parts[0]);
  }
  draw();
}

function indent<T extends HTMLElement>(node: T, depth: number): T {
  node.style.paddingLeft = `${8 + depth * 14}px`;
  return node;
}

// --- Search ---------------------------------------------------------------

function setupSearch() {
  const input = $<HTMLInputElement>("search");
  const results = $<HTMLUListElement>("results");
  let timer: number | undefined;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const found = await client.call<NodeRef[]>("search", { query: input.value });
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
  const info = await client.call<ProjectInfo>("info");
  $("project").textContent = info.root;
  const status = $("status");
  const setStatus = (extra = "") => {
    status.textContent = `◇ lode · ${info.files} files · ${info.nodes} nodes · ${info.edges} edges${extra}`;
  };
  setStatus();
  renderTree(await client.call<FileEntry[]>("files"));
  setupSearch();
  $("toggle-tree").addEventListener("click", () => document.body.classList.toggle("no-tree"));

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
    Object.assign(info, await client.call<ProjectInfo>("info"));
    setStatus(` · re-indexed ${files.length} file${files.length === 1 ? "" : "s"}`);
  });
}

start().catch((error) => {
  document.body.textContent = `lode: ${error.message}`;
});
