// An optional syntax highlighter for views (highlight.js, TS/JS), for hosts
// without their own. Kept out of the views index so hosts that bring their
// own (an IDE's tokenizer, Shiki) don't pull highlight.js in.
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
};

// One HTML string per source line. highlight.js escapes the source text; its
// spans can cross line breaks (block comments, template strings), so each
// line closes the spans still open and the next line reopens them.
export function highlightLines(text: string, file: string): string[] {
  const language = LANGUAGE_BY_EXTENSION[file.split(".").pop() ?? ""];
  const html = language ? hljs.highlight(text, { language, ignoreIllegals: true }).value : escapeHtml(text);

  const lines: string[] = [];
  const open: string[] = []; // opening tags in effect
  let line = "";
  for (const part of html.match(/<span[^>]*>|<\/span>|[^<]+/g) ?? []) {
    if (part.startsWith("<span")) {
      open.push(part);
      line += part;
    } else if (part === "</span>") {
      open.pop();
      line += part;
    } else {
      const pieces = part.split("\n");
      line += pieces[0];
      for (const piece of pieces.slice(1)) {
        lines.push(line + "</span>".repeat(open.length));
        line = open.join("") + piece;
      }
    }
  }
  lines.push(line + "</span>".repeat(open.length));
  return lines;
}

// Colours for the classes highlight.js emits, from the --lode-syntax-*
// tokens (see theme.ts), so themes colour code too.
export const SYNTAX_CSS = `
.hljs-keyword, .hljs-literal, .hljs-meta .hljs-keyword { color: var(--lode-syntax-keyword); }
.hljs-string, .hljs-regexp, .hljs-template-tag, .hljs-subst { color: var(--lode-syntax-string); }
.hljs-number { color: var(--lode-syntax-number); }
.hljs-title.function_, .hljs-title.class_, .hljs-title { color: var(--lode-syntax-title); }
.hljs-built_in, .hljs-type { color: var(--lode-syntax-type); }
.hljs-comment, .hljs-doctag { color: var(--lode-syntax-comment); font-style: italic; }
.hljs-attr, .hljs-property { color: var(--lode-syntax-attr); }
.hljs-variable.language_, .hljs-params { color: var(--lode-syntax-variable); }
.hljs-meta { color: var(--lode-syntax-comment); }
`;

// Ready to spread into a LodeHost: { ...highlightJs, openView, … }.
export const highlightJs = { syntax: highlightLines, syntaxCss: SYNTAX_CSS };

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}
