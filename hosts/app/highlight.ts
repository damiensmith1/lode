// Syntax colours for the standalone app's code pane. A host concern: IDEs and
// Clance bring their own, so this lives with the app, not the views.
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

// Colours for the classes highlight.js emits, from Clance's theme tokens.
// Used by the app's code pane and handed to views (inside their shadow root).
export const SYNTAX_CSS = `
.hljs-keyword, .hljs-literal, .hljs-meta .hljs-keyword { color: #8a3b6b; }
.hljs-string, .hljs-regexp, .hljs-template-tag, .hljs-subst { color: #7a5320; }
.hljs-number { color: #2f5fa8; }
.hljs-title.function_, .hljs-title.class_, .hljs-title { color: #3a5a7a; }
.hljs-built_in, .hljs-type { color: #2f6b5e; }
.hljs-comment, .hljs-doctag { color: #75726b; font-style: italic; }
.hljs-attr, .hljs-property { color: #5f5d57; }
.hljs-variable.language_, .hljs-params { color: #34322e; }
.hljs-meta { color: #75726b; }
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}
