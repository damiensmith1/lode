// Base styles for every view, inside its shadow root. Hosts theme lode by
// setting these custom properties on any ancestor (they inherit through the
// shadow boundary); the defaults are a quiet light theme.
export const BASE_CSS = `
:host {
  --lode-bg: #fafaf7;
  --lode-surface: #ffffff;
  --lode-sunken: #f4f3ee;
  --lode-fg: #171614;
  --lode-muted: #5f5d57;
  --lode-faint: #75726b;
  --lode-border: #e9e8e3;
  --lode-outline: #b8b5ad;
  --lode-calls: #75726b;
  --lode-local: #2f5fa8;
  --lode-channel: #e2632f;
  --lode-channel-text: #a8461b;
  --lode-state: #8a3b6b;
  --lode-font: "Geist", -apple-system, BlinkMacSystemFont, sans-serif;
  --lode-mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
  display: block;
  height: 100%;
  overflow: auto;
  background: var(--lode-bg);
  color: var(--lode-fg);
  font: 13px/1.45 var(--lode-font);
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }
button:focus-visible, select:focus-visible { outline: 2px solid var(--lode-local); outline-offset: 2px; }
.mono { font-family: var(--lode-mono); }
.muted { color: var(--lode-muted); }
.faint { color: var(--lode-faint); }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 14px; border-bottom: 1px solid var(--lode-border); font-size: 12px; position: sticky; top: 0; background: var(--lode-bg); z-index: 2; }
.toolbar .sep { color: var(--lode-outline); }
.crumb { padding: 2px 4px; border-radius: 4px; color: var(--lode-muted); }
.crumb:hover { background: var(--lode-sunken); color: var(--lode-fg); }
.crumb.current { color: var(--lode-fg); font-weight: 550; }
.spacer { margin-left: auto; }
select { font: inherit; font-size: 12px; padding: 2px 6px; border: 1px solid var(--lode-border); border-radius: 6px; background: var(--lode-surface); color: var(--lode-fg); }
.empty { padding: 32px; color: var(--lode-muted); }
.wires { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.k-calls { --k: var(--lode-calls); }
.k-local { --k: var(--lode-local); }
.k-channel { --k: var(--lode-channel); }
.k-state { --k: var(--lode-state); }
.tag { font-size: 11px; font-family: var(--lode-mono); }
.tag.k-channel { color: var(--lode-channel-text); }
.tag.k-state { color: var(--lode-state); }
.tag.k-local { color: var(--lode-local); }
.tag.k-calls { color: var(--lode-faint); }
`;

export const escape = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// One SVG path per wire, styled by kind: calls solid, local flow solid blue,
// channels dashed, shared state dotted.
export function wire(d: string, kind: string, title = ""): string {
  const dash = kind === "channel" ? "6 5" : kind === "state" ? "1.5 4" : "";
  return `<path d="${d}" class="k-${kind}" fill="none" stroke="var(--k)" stroke-width="1.5" stroke-linecap="round"${
    dash ? ` stroke-dasharray="${dash}"` : ""
  } marker-end="url(#head-${kind})"><title>${escape(title)}</title></path>`;
}

export const ARROW_DEFS = `<defs>${["calls", "local", "channel", "state"]
  .map(
    (k) =>
      `<marker id="head-${k}" class="k-${k}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="var(--k)"/></marker>`,
  )
  .join("")}</defs>`;
