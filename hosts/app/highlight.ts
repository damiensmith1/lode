// The app's syntax colours (highlight.js: TS/JS, Ruby, Python and common
// project files: JSON, Markdown, CSS, HTML, YAML, shell, TOML), given to
// the flow as LodeHost.syntax. Colouring is the host's: an IDE passes its
// own tokenizer, another host Shiki; lode only takes HTML per line.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import scss from "highlight.js/lib/languages/scss";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, language] of Object.entries({ bash, css, ini, javascript, json, markdown, python, ruby, scss, typescript, xml, yaml })) hljs.registerLanguage(name, language);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", md: "markdown", markdown: "markdown", mdx: "markdown",
  css: "css", scss: "scss", html: "xml", htm: "xml", xml: "xml", svg: "xml",
  yml: "yaml", yaml: "yaml", sh: "bash", zsh: "bash", bash: "bash",
  toml: "ini", ini: "ini", py: "python",
  rb: "ruby", rake: "ruby", gemspec: "ruby", ru: "ruby", thor: "ruby", erb: "xml", Gemfile: "ruby", Rakefile: "ruby",
};

// One HTML string per source line. highlight.js escapes the source text; its
// spans can cross line breaks (block comments, template strings), so each
// line closes the spans still open and the next line reopens them.
export function highlightLines(text: string, file: string): string[] {
  const language = LANGUAGE_BY_EXTENSION[file.split("/").pop()!.split(".").pop() ?? ""]; // an extension, or a name (Gemfile)
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
.hljs-section, .hljs-strong { color: var(--lode-syntax-title); font-weight: 600; }
.hljs-emphasis { font-style: italic; }
.hljs-bullet, .hljs-link, .hljs-selector-class, .hljs-selector-id, .hljs-tag, .hljs-name { color: var(--lode-syntax-type); }
.hljs-code, .hljs-symbol { color: var(--lode-syntax-string); }
`;

// Ready to spread into a LodeHost: { ...highlightJs, openView, … }.
export const highlightJs = { syntax: highlightLines, syntaxCss: SYNTAX_CSS };

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}
