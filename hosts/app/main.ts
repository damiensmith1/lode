// The standalone host: the code on the left, lode views on the right, kept
// in step by clicks only. Clicking a line focuses the linked view there;
// clicking in the graph opens and jumps the code. Nothing moves on its own. It's one host among many;
// everything lode-specific comes from ../../views through LodeHost.
import type { FileEntry, FileView, NodeRef, ProjectInfo } from "../../src/query/types.js";
import { highlightLines } from "./highlight.js";
import { createView, LodeClient, TITLE_EVENT, type LodeHost, type SourceHighlight, type ViewRequest } from "../../views/index.js";

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
      if (symbol) gutter.append(el("button", { title: `focus ${symbol.name}`, ariaLabel: `Focus ${symbol.name}`, onclick: () => focusLinked(symbol.id) }, "◇"));
      const notes = el("span", { className: "notes" });
      for (const a of (notesByLine.get(n) ?? []).slice(0, 3)) {
        notes.append(el("button", { className: `note k-${a.kind}`, onclick: () => focusLinked(a.target) }, `◇ ${a.text}`));
      }
      const src = el("span", { className: "src hljs" });
      src.innerHTML = highlighted[i] || " "; // highlight.js output: source text is escaped
      const row = el("div", { className: "ln", id: `L${n}` }, el("span", { className: "no" }, String(n)), gutter, src, notes);
      row.dataset.line = String(n);
      return row;
    }),
  );
  applied = null; // the old file's highlight is gone with its lines
  const selectedTab = tabs.find((t) => t.button.getAttribute("aria-selected") === "true");
  if (selectedTab?.highlight?.file === view.file) applyHighlight(selectedTab.highlight);
}

// Click a line: the linked view focuses on whatever's declared around it.
// Selecting text isn't a click on a line.
$("code").addEventListener("click", (e) => {
  if ((e.target as Element).closest("button") || String(window.getSelection() ?? "")) return;
  const row = (e.target as Element).closest<HTMLElement>(".ln");
  if (row && currentFile) void followCode(currentFile, Number(row.dataset.line));
});

// --- Highlights from the selected view ----------------------------------

let applied: SourceHighlight | null = null;
let codeDriven: string | null = null; // a focus the code asked for: don't scroll for it

function applyHighlight(h: SourceHighlight | null) {
  if (h && h.file !== currentFile) {
    void showSource(h.file).then(() => applyHighlight(h));
    return;
  }
  const code = $("code");
  const newFocus = h?.node !== applied?.node;
  if (newFocus || !h) {
    code.querySelectorAll(".in-focus, .mark, .focus-start").forEach((r) => r.classList.remove("in-focus", "mark", "focus-start"));
    if (h?.range) {
      for (let l = h.range[0]; l <= h.range[1]; l++) document.getElementById(`L${l}`)?.classList.add("in-focus");
      document.getElementById(`L${h.range[0]}`)?.classList.add("focus-start");
    }
    for (const l of h?.marks ?? []) document.getElementById(`L${l}`)?.classList.add("mark");
  }
  code.querySelector(".hover")?.classList.remove("hover");
  if (h?.hover) document.getElementById(`L${h.hover}`)?.classList.add("hover"); // marked, never scrolled to
  if (h?.range && newFocus && codeDriven !== h.node) scrollToLine(Math.max(1, h.range[0] - 2), "start");
  if (h && newFocus) codeDriven = null;
  applied = h;
}

// --- Tabs of lode views ---------------------------------------------------

interface Tab {
  key: string;
  button: HTMLButtonElement;
  view: HTMLElement;
  highlight?: SourceHighlight | null;
}
const tabs: Tab[] = [];
let linked: Tab | null = null; // the focus tab that follows the code

function select(tab: Tab) {
  for (const t of tabs) t.button.setAttribute("aria-selected", String(t === tab));
  $("view").replaceChildren(tab.view);
  applyHighlight(tab.highlight ?? null);
}

function openView(request: ViewRequest, options: { linked?: boolean } = {}): Tab {
  const key = options.linked ? "linked" : JSON.stringify(request);
  const existing = tabs.find((t) => t.key === key);
  if (existing) {
    select(existing);
    return existing;
  }

  const label = el("span", {}, request.kind === "focus" ? request.id.split("#").pop()! : request.kind);
  const close = el("span", { className: "close", title: "Close", role: "button" }, "×");
  const icon = el("span", { className: "diamond", ariaHidden: "true", title: options.linked ? "follows the code" : "" }, options.linked ? "⇄" : "◇");
  const button = el("button", { className: "tab", role: "tab" }, icon, label, close);
  const tab = { key, button } as Tab;

  // Each tab gets its own host, so highlights come from the tab that sent them.
  const host: LodeHost = {
    openSource: (file, line) => void showSource(file, line),
    openView: (r) => void openView(r),
    highlight: (h) => {
      tab.highlight = h;
      if (button.getAttribute("aria-selected") === "true") applyHighlight(h);
    },
  };
  tab.view = createView(request, client, host);
  tab.view.addEventListener(TITLE_EVENT, (e) => (label.textContent = String((e as CustomEvent).detail)));
  button.addEventListener("click", (e) => {
    if (e.target !== close) return select(tab);
    const i = tabs.indexOf(tab);
    tabs.splice(i, 1);
    button.remove();
    if (tab === linked) linked = null;
    if (button.getAttribute("aria-selected") === "true") {
      if (tabs.length) select(tabs[Math.max(0, i - 1)]);
      else $("view").replaceChildren(), applyHighlight(null);
    }
  });
  tabs.push(tab);
  if (options.linked) {
    linked = tab;
    $("tabs").prepend(button);
  } else $("tabs").append(button);
  select(tab);
  return tab;
}

// Point the linked view at a node, creating it if needed.
function focusLinked(id: string, selectIt = true) {
  if (!linked) return void openView({ kind: "focus", id }, { linked: true });
  if (linked.view.getAttribute("node") !== id) linked.view.setAttribute("node", id);
  if (selectIt) select(linked);
}

async function followCode(file: string, line: number) {
  const at = await client.call<NodeRef | null>("symbolAt", { file, line });
  if (!at) return;
  codeDriven = at.id;
  // The graph view, when it's showing, reveals the node in place.
  const view = $("view").firstElementChild as (HTMLElement & { reveal?: (id: string) => void }) | null;
  if (view?.tagName === "LODE-GRAPH" && view.reveal) view.reveal(at.id);
  else focusLinked(at.id);
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
async function openFile(file: string) {
  await showSource(file);
  $("code").scrollTop = 0;
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
              { role: "option", onclick: () => (focusLinked(n.id), (results.hidden = true), (input.value = "")) },
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
    status.textContent = `◇ lode · ${info.files} files · ${info.nodes} nodes · ${info.edges} edges · click a line to focus it${extra}`;
  };
  setStatus();
  renderTree(await client.call<FileEntry[]>("files"));
  setupSearch();
  $("toggle-tree").addEventListener("click", () => document.body.classList.toggle("no-tree"));

  // Deep links: #token=…&focus=<node id>&file=<path>&line=<n>
  if (link.get("focus")) focusLinked(link.get("focus")!);
  else if (link.get("file")) void openFile(link.get("file")!);
  openView({ kind: "map", lens: "runtime" });
  openView({ kind: "graph", lens: "runtime" });
  if (linked) select(linked);

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

start().catch((error) => {
  document.body.textContent = `lode: ${error.message}`;
});
