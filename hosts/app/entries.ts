// The app's "entry points" tab: where to start reading. What the outside
// world calls into (other processes, the UI, the runtime), by runtime and
// kind, with a line on how the runtimes talk; clicking one starts a flow
// there. Built on lode's API (api.entries), like any host's would be.
import type { EntryPoint, LodeApi } from "../../views/index.js";

const SHOW_FIRST = 12; // entries shown per category before "show all"

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function entriesView(api: LodeApi, read: (id: string) => void): { el: HTMLElement; reload: () => Promise<void> } {
  const el = document.createElement("div");
  el.className = "entries";
  el.innerHTML = `
    <p class="lede">Where to start reading: what calls into this code from outside.</p>
    <div class="summary"></div>
    <div class="filter"><label class="faint" for="entries-filter">filter</label><input id="entries-filter" type="search" placeholder="channel, event, file…" autocomplete="off"></div>
    <div class="list"></div>`;
  let data: Awaited<ReturnType<LodeApi["entries"]>> | null = null;
  let filter = "";
  const opened = new Set<string>(); // "runtime|category" shown in full

  const renderList = () => {
    if (!data) return;
    const q = filter;
    const matches = (e: EntryPoint) => !q || `${e.label} ${e.node.name} ${e.node.file ?? ""}`.toLowerCase().includes(q);
    const html: string[] = [];
    for (const group of data.groups) {
      const cats = group.categories.map((c) => ({ ...c, entries: c.entries.filter(matches) })).filter((c) => c.entries.length);
      if (!cats.length) continue;
      html.push(`<h2>${escape(group.runtime ?? "other")}</h2>`);
      for (const c of cats) {
        const key = `${group.runtime}|${c.name}`;
        const full = q || opened.has(key);
        const shown = full ? c.entries : c.collapsed ? [] : c.entries.slice(0, SHOW_FIRST);
        html.push(`<h3>${escape(c.name)} <span class="n">${c.entries.length}</span></h3>`);
        for (const e of shown) html.push(`<button class="entry" data-id="${escape(e.node.id)}" title="${escape(e.node.id)}"><span class="label">${escape(e.label)}</span><span class="where">${escape(e.detail)}</span></button>`);
        if (shown.length < c.entries.length) html.push(`<button class="more" data-key="${escape(key)}">show ${shown.length ? "all " : ""}${c.entries.length}</button>`);
      }
    }
    el.querySelector(".list")!.innerHTML = html.join("") || `<div class="empty">Nothing matches “${escape(filter)}”.</div>`;
  };

  const reload = async () => {
    data = await api.entries();
    // How the runtimes talk, both directions on one line.
    const pairs = new Map<string, { text: string; count: number }[]>();
    for (const e of data.summary) {
      const key = [e.from, e.to].sort().join(" ⇄ ");
      pairs.set(key, [...(pairs.get(key) ?? []), { text: `${e.from} → ${e.to}: ${e.count}`, count: e.count }]);
    }
    el.querySelector(".summary")!.innerHTML = [...pairs]
      .map(([pair, parts]) => `<span title="${escape(parts.map((p) => p.text).join("\n"))}">${escape(pair)} · ${parts.reduce((s, p) => s + p.count, 0)} calls</span>`)
      .join("");
    renderList();
  };

  el.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("button");
    if (b?.dataset.id) read(b.dataset.id);
    else if (b?.dataset.key) {
      opened.add(b.dataset.key);
      renderList();
    }
  });
  el.querySelector("input")!.addEventListener("input", (e) => {
    filter = (e.target as HTMLInputElement).value.trim().toLowerCase();
    renderList();
  });
  void reload();
  return { el, reload };
}
