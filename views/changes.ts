import type { ChangesResult, FileChange } from "../src/query/types.js";
import type { LodeConnection } from "./connection.js";
import { ACTION_EVENT, TITLE_EVENT, type LodeHost } from "./host.js";
import { escape, viewCss } from "./theme.js";

const CSS = `
.page { max-width: 920px; padding: 20px 32px 64px; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 18px; font-size: 12.5px; }
.bar input { width: 140px; font: 12px var(--lode-mono); padding: 4px 8px; border: 1px solid var(--lode-border); border-radius: 6px; background: var(--lode-surface); color: var(--lode-fg); }
.bar .all { padding: 4px 10px; border-radius: 6px; background: var(--lode-sunken); }
.bar .all:hover { background: color-mix(in srgb, var(--lode-added) 14%, transparent); }
.bar .all:disabled { opacity: .5; cursor: default; }
.totals { color: var(--lode-muted); font: 12px var(--lode-mono); }
.add { color: var(--lode-added); }
.del { color: var(--lode-removed); }
.file { margin: 14px 0 2px; }
.file > button, .file > .row { display: flex; align-items: baseline; gap: 10px; width: 100%; padding: 4px 8px; border-radius: 5px; font: 12.5px var(--lode-mono); }
.file > button:hover, .symbol:hover { background: var(--lode-sunken); }
.status { flex: none; width: 74px; font: 11px var(--lode-font); color: var(--lode-faint); }
.status.added, .status.untracked { color: var(--lode-added); }
.status.deleted { color: var(--lode-removed); }
.counts { margin-left: auto; font: 11.5px var(--lode-mono); white-space: nowrap; }
.dim { color: var(--lode-faint); }
.symbol { display: flex; align-items: baseline; gap: 10px; width: 100%; padding: 3px 8px 3px 92px; border-radius: 5px; font: 12.5px var(--lode-mono); }
.symbol .kind { font: 11px var(--lode-font); color: var(--lode-faint); }
.note { color: var(--lode-muted); padding: 24px 8px; }
`;

// <lode-changes>: what changed in git since a ref (default HEAD: the
// uncommitted changes), by file and by the symbol each change is in.
// Picking one reads it in a flow with the changes shown; "open all" puts
// every changed symbol in a new flow. Refreshes as files change, so an
// agent's edits show up as they land.
export class LodeChanges extends HTMLElement {
  client?: LodeConnection;
  host?: LodeHost;
  base = "HEAD";

  private readonly root = this.attachShadow({ mode: "open" });
  private data: ChangesResult | null = null;
  private built = false;
  private unsubscribe?: () => void;

  connectedCallback() {
    this.unsubscribe = this.client?.onChanged(() => void this.load());
    if (this.built) return void this.load();
    this.built = true;
    this.root.innerHTML = `<style>${viewCss(CSS, this.host)}</style>
      <div class="page" part="page">
        <div class="bar" part="bar">
          <label class="dim" for="base">changes since</label>
          <input id="base" spellcheck="false" autocomplete="off" title="A git ref: HEAD (uncommitted), main, HEAD~3, a commit">
          <button class="all" data-action="open-all" title="Open every changed symbol in a new flow">open all in a flow</button>
          <span class="totals"></span>
        </div>
        <div class="list" part="list"></div>
      </div>`;
    const input = this.root.querySelector<HTMLInputElement>("#base")!;
    input.value = this.base;
    input.addEventListener("change", () => {
      this.base = input.value.trim() || "HEAD";
      void this.load();
    });
    this.root.addEventListener("click", (e) => this.onClick(e));
    this.dispatchEvent(new CustomEvent(TITLE_EVENT, { detail: "changes", bubbles: true, composed: true }));
    void this.load();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
  }

  private async load() {
    if (!this.client) return;
    this.data = await this.client.call<ChangesResult>("changes", { base: this.base }).catch((error) => ({ base: this.base, error: String(error), files: [] }));
    this.render();
  }

  private onClick(event: Event) {
    const el = (event.target as Element).closest<HTMLElement>("[data-action]");
    if (!el) return;
    const action = el.dataset.action!;
    const go = this.dispatchEvent(new CustomEvent(ACTION_EVENT, { detail: { action, target: el.dataset.id, via: "click", data: { ...el.dataset } }, bubbles: true, composed: true, cancelable: true }));
    if (!go) return;
    if (action === "read" && el.dataset.id) this.host?.openView({ kind: "flow", id: el.dataset.id, diff: this.base });
    if (action === "open-all") {
      const ids = this.symbolIds();
      if (ids.length) this.host?.openView({ kind: "flow", ids, diff: this.base, newTab: true });
    }
  }

  // Every changed symbol, in file order (a file's own symbol for new files).
  private symbolIds(): string[] {
    return (this.data?.files ?? []).flatMap((f) => f.symbols.map((s) => s.node.id));
  }

  private render() {
    const d = this.data;
    const list = this.root.querySelector(".list")!;
    const all = this.root.querySelector<HTMLButtonElement>(".all")!;
    const totals = this.root.querySelector(".totals")!;
    all.disabled = !this.symbolIds().length;
    if (!d || d.error) {
      totals.textContent = "";
      list.innerHTML = `<div class="note">${escape(d?.error ?? "loading…")}</div>`;
      return;
    }
    const added = d.files.reduce((n, f) => n + f.added, 0);
    const removed = d.files.reduce((n, f) => n + f.removed, 0);
    totals.innerHTML = d.files.length ? `${d.files.length} file${d.files.length === 1 ? "" : "s"} · <span class="add">+${added}</span> <span class="del">−${removed}</span>` : "";
    list.innerHTML = d.files.length ? d.files.map((f) => fileHtml(f)).join("") : `<div class="note">No changes since ${escape(d.base)}.</div>`;
  }
}

function counts(added: number, removed: number): string {
  return `<span class="counts">${added ? `<span class="add">+${added}</span> ` : ""}${removed ? `<span class="del">−${removed}</span>` : ""}</span>`;
}

function fileHtml(f: FileChange): string {
  const name = f.from ? `${escape(f.from)} → ${escape(f.file)}` : escape(f.file);
  const status = `<span class="status ${f.status}">${f.status}</span>`;
  const head = f.indexed && f.status !== "deleted"
    ? `<button data-action="read" data-id="${escape(f.file)}" part="file" title="Read the file">${status}<span>${name}</span>${counts(f.added, f.removed)}</button>`
    : `<div class="row" part="file">${status}<span class="dim">${name}</span>${counts(f.added, f.removed)}</div>`;
  // A new file's only symbol is itself: the file row opens it.
  const symbols = f.status === "added" || f.status === "untracked" ? [] : f.symbols;
  return `<div class="file">${head}${symbols
    .map(
      (s) =>
        `<button class="symbol" part="symbol" data-action="read" data-id="${escape(s.node.id)}" title="${escape(s.node.id)}"><span>${escape(s.node.id === f.file ? "(top level)" : s.node.name)}</span><span class="kind">${escape(s.node.kind)}${s.node.line ? ` · line ${s.node.line}` : ""}</span>${counts(s.added, s.removed)}</button>`,
    )
    .join("")}</div>`;
}
