// The standalone host: entry points to pick where to start, the flow to read
// from there. The code pane is for browsing a file; clicking in it opens that
// code in the flow. Nothing moves on its own, only on clicks. It's one host among many;
// everything lode-specific comes from ../../views through LodeHost.
import type { FileEntry, FileView, NodeRef, ProjectInfo } from "../../src/query/types.js";
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

// --- Source pane --------------------------------------------------------

let currentFile: string | null = null;
function scrollToLine(line: number, block: ScrollLogicalPosition = "center") {
  document.getElementById(`L${line}`)?.scrollIntoView({ block });
}

async function showSource(file: string, line?: number) {
  if (file !== currentFile) {
    const view = await client.call<FileView | null>("source", { file });
    if (!view) return;
    currentFile = file;
    document.body.classList.add("has-file");
    renderSource(view);
  }
  if (line) scrollToLine(line);
}

function renderSource(view: FileView) {
  $("code-path").textContent = view.file;
  document.querySelectorAll<HTMLElement>("#tree [data-file]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.file === view.file)));

  const symbolsByLine = new Map<number, NodeRef[]>();
  for (const s of view.symbols) if (s.line && s.kind !== "container") symbolsByLine.set(s.line, [...(symbolsByLine.get(s.line) ?? []), s]);
  const notesByLine = new Map<number, typeof view.annotations>();
  for (const a of view.annotations) notesByLine.set(a.line, [...(notesByLine.get(a.line) ?? []), a]);

  const highlighted = highlightLines(view.text, view.file);
  $("code").replaceChildren(
    ...view.text.split("\n").map((_text, i) => {
      const n = i + 1;
      const symbol = symbolsByLine.get(n)?.find((s) => s.kind === "callable") ?? symbolsByLine.get(n)?.[0];
      const gutter = el("span", { className: "gut" });
      if (symbol) gutter.append(el("button", { title: `read ${symbol.name}`, ariaLabel: `Read ${symbol.name} in the flow`, onclick: () => readInFlow(symbol.id) }, "◇"));
      const notes = el("span", { className: "notes" });
      for (const a of (notesByLine.get(n) ?? []).slice(0, 3)) {
        notes.append(el("button", { className: `note k-${a.kind}`, onclick: () => readInFlow(a.target) }, `◇ ${a.text}`));
      }
      const src = el("span", { className: "src hljs" });
      src.innerHTML = highlighted[i] || " "; // highlight.js output: source text is escaped
      const row = el("div", { className: "ln", id: `L${n}` }, el("span", { className: "no" }, String(n)), gutter, src, notes);
      row.dataset.line = String(n);
      return row;
    }),
  );
}

// Click a line: read whatever's declared around it in the flow.
// Selecting text isn't a click on a line.
$("code").addEventListener("click", (e) => {
  if ((e.target as Element).closest("button") || String(window.getSelection() ?? "")) return;
  const row = (e.target as Element).closest<HTMLElement>(".ln");
  if (row && currentFile) void followCode(currentFile, Number(row.dataset.line));
});

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
  // The flow view is the code, so the code pane steps aside for it.
  document.body.classList.toggle("flow-mode", tab.view.tagName === "LODE-FLOW");
}

function openView(request: ViewRequest): Tab {
  // There's one flow: asking for another reads in it instead.
  const flow = tabs.find((t) => t.view.tagName === "LODE-FLOW");
  if (request.kind === "flow" && flow) {
    if (request.id) flow.view.setAttribute("node", request.id);
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
    openSource: (file, line) => void showSource(file, line),
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

// Read a node in the flow.
const readInFlow = (id: string) => void openView({ kind: "flow", id });

async function followCode(file: string, line: number) {
  const at = await client.call<NodeRef | null>("symbolAt", { file, line });
  if (!at) return;
  readInFlow(at.id);
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
        el("button", { title: f.runtime ? `runtime: ${f.runtime}` : "", onclick: () => void openFile(f.file) }, el("span", { className: `dot rt-${f.runtime ?? "none"}` }), parts[parts.length - 1]),
        parts.length - 1,
      );
      button.dataset.file = f.file;
      button.setAttribute("aria-current", String(f.file === currentFile));
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

// Opening a file just shows it; click a line (or ◇) to bring the graph along.
// In flow mode it starts the flow from the file's outline instead.
async function openFile(file: string) {
  if (startFlow(file)) return;
  await showSource(file);
  $("code").scrollTop = 0;
}

// Point the flow view at a node, if the flow tab is the one showing.
function startFlow(id: string): boolean {
  const view = $("view").firstElementChild;
  if (view?.tagName !== "LODE-FLOW") return false;
  view.setAttribute("node", id);
  return true;
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
    status.textContent = `◇ lode · ${info.files} files · ${info.nodes} nodes · ${info.edges} edges · click a line to read it in the flow${extra}`;
  };
  setStatus();
  renderTree(await client.call<FileEntry[]>("files"));
  setupSearch();
  $("toggle-tree").addEventListener("click", () => {
    const flowMode = document.body.classList.contains("flow-mode");
    document.body.classList.toggle(flowMode ? "show-tree" : "no-tree");
  });

  // Deep links: #token=…&flow=<node id> | file=<path>
  const entries = openView({ kind: "entries" });
  const start = link.get("flow") ?? link.get("focus"); // "focus" links predate the flow
  openView({ kind: "flow", ...(start && { id: start }) });
  if (!start) select(entries);
  if (link.get("file") && !start) void openFile(link.get("file")!);

  client.onChanged(async (files) => {
    Object.assign(info, await client.call<ProjectInfo>("info"));
    setStatus(` · re-indexed ${files.length} file${files.length === 1 ? "" : "s"}`);
    if (currentFile && files.includes(currentFile)) {
      const file = currentFile;
      currentFile = null; // force a re-read
      await showSource(file);
    }
  });
}

document.head.append(el("style", {}, SYNTAX_CSS));

start().catch((error) => {
  document.body.textContent = `lode: ${error.message}`;
});
