import type { EntriesResult, EntryPoint } from "../src/query/types.js";
import type { LodeClient } from "./client.js";
import { TITLE_EVENT, type LodeHost } from "./host.js";
import { BASE_CSS, escape } from "./theme.js";

const SHOW_FIRST = 12; // entries shown per category before "show all"

const CSS = `
.page { max-width: 880px; padding: 24px 32px 64px; }
.lede { margin: 0 0 6px; font-size: 14px; }
.summary { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0 0 20px; font: 12px var(--lode-mono); color: var(--lode-channel-text); }
.filter { display: flex; align-items: center; gap: 8px; margin: 0 0 24px; }
.filter input { flex: 1; max-width: 360px; font: inherit; padding: 6px 10px; border: 1px solid var(--lode-border); border-radius: 6px; background: var(--lode-surface); color: var(--lode-fg); }
h2 { margin: 28px 0 8px; font-size: 15px; font-weight: 600; }
h3 { margin: 14px 0 4px; font-size: 12px; font-weight: 550; color: var(--lode-faint); letter-spacing: .3px; }
h3 .n { font-weight: 400; }
.entry { display: flex; align-items: baseline; gap: 12px; width: 100%; padding: 4px 8px; border-radius: 5px; }
.entry:hover { background: var(--lode-sunken); }
.entry .label { font: 12.5px var(--lode-mono); color: var(--lode-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.entry .where { margin-left: auto; font-size: 11.5px; color: var(--lode-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 50%; }
.more { margin: 2px 0 0 8px; font-size: 12px; color: var(--lode-muted); }
.more:hover { color: var(--lode-fg); text-decoration: underline; }
`;

// <lode-entries>: where to start reading. What the outside world calls into
// (other processes, the UI, the runtime), by runtime and kind, with a line
// on how the runtimes talk. Clicking an entry starts the flow there.
export class LodeEntries extends HTMLElement {
  client?: LodeClient;
  host?: LodeHost;

  private readonly root = this.attachShadow({ mode: "open" });
  private data: EntriesResult | null = null;
  private filter = "";
  private opened = new Set<string>(); // "runtime|category" shown in full
  private unsubscribe?: () => void;

  connectedCallback() {
    this.root.innerHTML = `<style>${BASE_CSS}${CSS}</style>
      <div class="page">
        <p class="lede">Where to start reading: what calls into this code from outside.</p>
        <div class="summary"></div>
        <div class="filter"><label class="faint" for="filter">filter</label><input id="filter" type="search" placeholder="channel, event, file…" autocomplete="off"></div>
        <div class="list"></div>
      </div>`;
    this.root.addEventListener("click", (e) => this.onClick(e));
    this.root.querySelector("input")!.addEventListener("input", (e) => {
      this.filter = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderList();
    });
    this.unsubscribe = this.client?.onChanged(() => this.load());
    this.dispatchEvent(new CustomEvent(TITLE_EVENT, { detail: "entry points", bubbles: true, composed: true }));
    void this.load();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
  }

  private async load() {
    if (!this.client) return;
    this.data = await this.client.call<EntriesResult>("entries");
    // How the runtimes talk, both directions on one line.
    const pairs = new Map<string, { text: string; count: number }[]>();
    for (const e of this.data.summary) {
      const key = [e.from, e.to].sort().join(" ⇄ ");
      pairs.set(key, [...(pairs.get(key) ?? []), { text: `${e.from} → ${e.to}: ${e.count}`, count: e.count }]);
    }
    this.root.querySelector(".summary")!.innerHTML = [...pairs]
      .map(([pair, parts]) => `<span title="${escape(parts.map((p) => p.text).join("\n"))}">${escape(pair)} · ${parts.reduce((s, p) => s + p.count, 0)} calls</span>`)
      .join("");
    this.renderList();
  }

  private onClick(event: Event) {
    const el = (event.target as Element).closest<HTMLElement>("[data-action]");
    if (!el) return;
    if (el.dataset.action === "read" && el.dataset.id) this.host?.openView({ kind: "flow", id: el.dataset.id });
    if (el.dataset.action === "more" && el.dataset.key) {
      this.opened.add(el.dataset.key);
      this.renderList();
    }
  }

  private renderList() {
    if (!this.data) return;
    const q = this.filter;
    const matches = (e: EntryPoint) => !q || `${e.label} ${e.node.name} ${e.node.file ?? ""}`.toLowerCase().includes(q);
    const html: string[] = [];
    for (const group of this.data.groups) {
      const cats = group.categories.map((c) => ({ ...c, entries: c.entries.filter(matches) })).filter((c) => c.entries.length);
      if (!cats.length) continue;
      html.push(`<h2>${escape(group.runtime ?? "other")}</h2>`);
      for (const c of cats) {
        const key = `${group.runtime}|${c.name}`;
        const full = q || this.opened.has(key);
        const shown = full ? c.entries : c.collapsed ? [] : c.entries.slice(0, SHOW_FIRST);
        html.push(`<h3>${escape(c.name)} <span class="n">${c.entries.length}</span></h3>`);
        for (const e of shown) html.push(row(e));
        if (shown.length < c.entries.length) {
          html.push(`<button class="more" data-action="more" data-key="${escape(key)}">show ${shown.length ? "all " : ""}${c.entries.length}</button>`);
        }
      }
    }
    this.root.querySelector(".list")!.innerHTML = html.join("") || `<div class="empty">Nothing matches “${escape(this.filter)}”.</div>`;
  }
}

function row(e: EntryPoint): string {
  return `<button class="entry" data-action="read" data-id="${escape(e.node.id)}" title="${escape(e.node.id)}"><span class="label">${escape(e.label)}</span><span class="where">${escape(e.detail)}</span></button>`;
}
