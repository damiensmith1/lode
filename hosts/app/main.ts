// The standalone host: entry points to pick where to start, the flow to read
// from there, and a file tree (a file opens in the flow too). Nothing moves on
// its own, only on clicks. It's one host among many; everything lode-specific
// comes from ../../views through LodeHost.
import type { FileEntry, NodeRef, ProjectInfo } from "../../src/query/types.js";
import { highlightLines, SYNTAX_CSS } from "./highlight.js";
import { createView, LodeClient, TITLE_EVENT, type LodeHost, type ViewRequest } from "../../views/index.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

// The server puts its session token in the fragment (never sent over HTTP).
const link = new URLSearchParams(location.hash.slice(1));
const client = new LodeClient(`ws://${location.host}/rpc?token=${encodeURIComponent(link.get("token") ?? "")}`);

// --- Tabs of lode views ---------------------------------------------------

interface Tab {
  key: string;
  button: HTMLButtonElement;
  view: HTMLElement;
}
const tabs: Tab[] = [];

function select(tab: Tab) {
  for (const t of tabs) t.button.setAttribute("aria-selected", String(t === tab));
  $("view").replaceChildren(tab.view);
}

function openView(request: ViewRequest): Tab {
  // There's one flow: asking for another reads in it instead.
  const flow = tabs.find((t) => t.view.tagName === "LODE-FLOW");
  if (request.kind === "flow" && flow) {
    // Adds the node as a new tree, or goes to its card if it's already open.
    if (request.id) void (flow.view as HTMLElement & { show(id: string): Promise<void> }).show(request.id);
    select(flow);
    return flow;
  }
  const key = JSON.stringify(request);
  const existing = tabs.find((t) => t.key === key);
  if (existing) {
    select(existing);
    return existing;
  }

  const label = el("span", {}, request.kind);
  const close = el("span", { className: "close", title: "Close", role: "button" }, "×");
  const icon = el("span", { className: "diamond", ariaHidden: "true" }, "◇");
  const button = el("button", { className: "tab", role: "tab" }, icon, label, close);
  const tab = { key, button } as Tab;

  const host: LodeHost = {
    // No openSource: there's no separate editor, so the flow opens the file
    // as a card next to the one it came from.
    openView: (r) => void openView(r),
    syntax: highlightLines,
    syntaxCss: SYNTAX_CSS,
  };
  tab.view = createView(request, client, host);
  tab.view.addEventListener(TITLE_EVENT, (e) => (label.textContent = String((e as CustomEvent).detail)));
  button.addEventListener("click", (e) => {
    if (e.target !== close) return select(tab);
    const i = tabs.indexOf(tab);
    tabs.splice(i, 1);
    button.remove();
    if (button.getAttribute("aria-selected") === "true") {
      if (tabs.length) select(tabs[Math.max(0, i - 1)]);
      else $("view").replaceChildren();
    }
  });
  tabs.push(tab);
  $("tabs").append(button);
  select(tab);
  return tab;
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

  // Deep links: #token=…&flow=<node id or file>
  const entries = openView({ kind: "entries" });
  const start = link.get("flow") ?? link.get("focus") ?? link.get("file"); // older links still work
  openView({ kind: "flow", ...(start && { id: start }) });
  if (!start) select(entries);

  client.onChanged(async (files) => {
    Object.assign(info, await client.call<ProjectInfo>("info"));
    setStatus(` · re-indexed ${files.length} file${files.length === 1 ? "" : "s"}`);
  });
}

start().catch((error) => {
  document.body.textContent = `lode: ${error.message}`;
});
