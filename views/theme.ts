import type { LodeHost } from "./host.js";

// Themes. Every colour and font in the views is a `--lode-*` custom
// property; a host themes lode by setting them on any ancestor of a view (or
// the view itself), e.g. with themeCss(DARK_THEME). Unset ones fall back to
// LIGHT_THEME. For more than colours, LodeHost.css is added last inside
// every view, and the main pieces carry `part` names for ::part() styling.
export type LodeTheme = Record<string, string>;

export const LIGHT_THEME: LodeTheme = {
  "--lode-bg": "#fafaf7",
  "--lode-surface": "#ffffff",
  "--lode-sunken": "#f4f3ee",
  "--lode-fg": "#171614",
  "--lode-muted": "#5f5d57",
  "--lode-faint": "#75726b",
  "--lode-line-number": "#a3a09a",
  "--lode-border": "#e9e8e3",
  "--lode-outline": "#b8b5ad",
  "--lode-shadow": "#171614",
  "--lode-calls": "#75726b",
  "--lode-local": "#2f5fa8",
  "--lode-channel": "#e2632f",
  "--lode-channel-text": "#a8461b",
  "--lode-state": "#8a3b6b",
  "--lode-added": "#2e7d4f", // git changes: added or changed lines
  "--lode-removed": "#b3402a", // and removed ones
  "--lode-font": '"Geist", -apple-system, BlinkMacSystemFont, sans-serif',
  "--lode-mono": '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
  // Syntax colours, for highlighters that use them (see ./highlight.ts).
  "--lode-syntax-keyword": "#8a3b6b",
  "--lode-syntax-string": "#7a5320",
  "--lode-syntax-number": "#2f5fa8",
  "--lode-syntax-title": "#3a5a7a",
  "--lode-syntax-type": "#2f6b5e",
  "--lode-syntax-comment": "#75726b",
  "--lode-syntax-attr": "#5f5d57",
  "--lode-syntax-variable": "#34322e",
};

export const DARK_THEME: LodeTheme = {
  ...LIGHT_THEME,
  "--lode-bg": "#1b1a18",
  "--lode-surface": "#232220",
  "--lode-sunken": "#2b2a27",
  "--lode-fg": "#ecebe5",
  "--lode-muted": "#b3b0a8",
  "--lode-faint": "#8f8c85",
  "--lode-line-number": "#6f6c66",
  "--lode-border": "#34322f",
  "--lode-outline": "#56534e",
  "--lode-shadow": "#000000",
  "--lode-calls": "#8f8c85",
  "--lode-local": "#7aa5e6",
  "--lode-channel": "#f08a5d",
  "--lode-channel-text": "#f3a07c",
  "--lode-state": "#d68bb8",
  "--lode-added": "#6cc28f",
  "--lode-removed": "#e07a66",
  "--lode-syntax-keyword": "#d68bb8",
  "--lode-syntax-string": "#d9b27c",
  "--lode-syntax-number": "#7aa5e6",
  "--lode-syntax-title": "#9cc0e0",
  "--lode-syntax-type": "#7cc4b0",
  "--lode-syntax-comment": "#8f8c85",
  "--lode-syntax-attr": "#b3b0a8",
  "--lode-syntax-variable": "#dcdad3",
};

// A theme as CSS, for a host's page: `<style>${themeCss(DARK_THEME)}</style>`.
export function themeCss(theme: LodeTheme, selector = ":root"): string {
  return `${selector} {\n${Object.entries(theme).map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}`;
}

// Give every var(--lode-x) its default, so a token set anywhere above the
// view wins (declaring them on :host would shadow what's inherited).
export function withDefaults(css: string): string {
  return css.replace(/var\((--lode-[a-z-]+)\)/g, (all, name: string) => (name in LIGHT_THEME ? `var(${name}, ${LIGHT_THEME[name]})` : all));
}

// A view's styles: the base, the view's own, then the host's syntax CSS and
// its own CSS last, so a host can restyle anything.
export function viewCss(css: string, host?: LodeHost): string {
  return withDefaults(BASE_CSS + css + (host?.syntaxCss ?? "") + (host?.css ?? ""));
}

export const BASE_CSS = `
:host {
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
