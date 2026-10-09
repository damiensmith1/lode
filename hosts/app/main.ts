// The standalone host: a file tree, a source pane with lode's annotations,
// and lode views in tabs. It's one host among many; everything lode-specific
// comes from ../../views through the LodeHost interface.
import type { FileEntry, FileView, NodeRef, ProjectInfo } from "../../src/query/types.js";
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

async function showSource(file: string, line?: number) {
  const view = await client.call<FileView | null>("source", { file });
  if (!view) return;
  currentFile = file;
  $("code-path").textContent = file;
  document.querySelectorAll<HTMLElement>("#tree [data-file]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.file === file)));

  const symbolsByLine = new Map<number, NodeRef[]>();
  for (const s of view.symbols) if (s.line && s.kind !== "container") symbolsByLine.set(s.line, [...(symbolsByLine.get(s.line) ?? []), s]);
  const notesByLine = new Map<number, typeof view.annotations>();
  for (const a of view.annotations) notesByLine.set(a.line, [...(notesByLine.get(a.line) ?? []), a]);

  const code = $("code");
  code.replaceChildren(
    ...view.text.split("\n").map((text, i) => {
      const n = i + 1;
      const symbol = symbolsByLine.get(n)?.find((s) => s.kind === "callable") ?? symbolsByLine.get(n)?.[0];
      const gutter = el("span", { className: "gut" });
      if (symbol) {
        gutter.append(el("button", { title: `focus ${symbol.name}`, ariaLabel: `Focus ${symbol.name}`, onclick: () => openView({ kind: "focus", id: symbol.id }) }, "◇"));
      }
      const notes = el("span", { className: "notes" });
      for (const a of (notesByLine.get(n) ?? []).slice(0, 3)) {
        notes.append(el("button", { className: `note k-${a.kind}`, onclick: () => openView({ kind: "focus", id: a.target }) }, `◇ ${a.text}`));
      }
      return el("div", { className: n === line ? "ln hit" : "ln", id: `L${n}` }, el("span", { className: "no" }, String(n)), gutter, el("span", { className: "src" }, text || " "), notes);
    }),
  );
  if (line) document.getElementById(`L${line}`)?.scrollIntoView({ block: "center" });
}

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

function openView(request: ViewRequest) {
  const key = JSON.stringify(request);
  const existing = tabs.find((t) => t.key === key);
  if (existing) return select(existing);

  const view = createView(request, client, host);
  const label = el("span", {}, request.kind === "focus" ? request.id.split("#").pop()! : "map");
  const close = el("span", { className: "close", title: "Close", role: "button" }, "×");
  const button = el("button", { className: "tab", role: "tab" }, el("span", { className: "diamond", ariaHidden: "true" }, "◇"), label, close);
  const tab: Tab = { key, button, view };
  view.addEventListener(TITLE_EVENT, (e) => (label.textContent = String((e as CustomEvent).detail)));
  button.addEventListener("click", (e) => {
    if (e.target === close) {
      const i = tabs.indexOf(tab);
      tabs.splice(i, 1);
      button.remove();
      if (button.getAttribute("aria-selected") === "true" && tabs.length) select(tabs[Math.max(0, i - 1)]);
      else if (!tabs.length) $("view").replaceChildren();
    } else select(tab);
  });
  tabs.push(tab);
  $("tabs").append(button);
  select(tab);
}

const host: LodeHost = { openSource: (file, line) => void showSource(file, line), openView };

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
      const button = indent(el("button", { title: f.runtime ? `runtime: ${f.runtime}` : "", onclick: () => void showSource(f.file) }, el("span", { className: `dot rt-${f.runtime ?? "none"}` }), parts[parts.length - 1]), parts.length - 1);
      button.dataset.file = f.file;
      button.setAttribute("aria-current", String(f.file === currentFile));
      rows.push(button);
    }
    tree.replaceChildren(...rows);
  };
  // Open the top two levels so there's something to click.
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
              { role: "option", onclick: () => (openView({ kind: "focus", id: n.id }), (results.hidden = true), (input.value = "")) },
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
  openView({ kind: "map", lens: "runtime" });

  // Deep links: #token=…&focus=<node id>&file=<path>&line=<n>
  if (link.get("file")) void showSource(link.get("file")!, Number(link.get("line")) || undefined);
  if (link.get("focus")) openView({ kind: "focus", id: link.get("focus")! });

  client.onChanged(async (files) => {
    Object.assign(info, await client.call<ProjectInfo>("info"));
    setStatus(` · re-indexed ${files.length} file${files.length === 1 ? "" : "s"}`);
    if (currentFile && files.includes(currentFile)) void showSource(currentFile);
  });
}

start().catch((error) => {
  document.body.textContent = `lode: ${error.message}`;
});
