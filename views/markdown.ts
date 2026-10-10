import { escape } from "./theme.js";

// An answer's Markdown, safely: escaped first, then code blocks, lists,
// paragraphs, **bold** and `code`. A code name that `link` knows (a real
// symbol: name → id) becomes a link to its card; anything else is just code.
export function renderMarkdown(text: string, link: (name: string) => string | undefined = () => undefined): string {
  const inline = (t: string) =>
    escape(t)
      .replace(/`([^`]+)`/g, (_, code: string) => {
        const id = link(unescapeHtml(code));
        return id ? `<code class="sym" data-action="explain-open" data-id="${escape(id)}" data-name="${code}">${code}</code>` : `<code>${code}</code>`;
      })
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
      out.push(`<pre>${escape(body.join("\n"))}</pre>`);
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) items.push(`<li>${inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`);
      i--;
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
    } else if (/^#{1,6}\s/.test(line)) out.push(`<p><b>${inline(line.replace(/^#+\s*/, ""))}</b></p>`);
    else if (line.trim()) {
      const para = [line];
      for (; i + 1 < lines.length && lines[i + 1].trim() && !/^(```|#{1,6}\s|\s*([-*]|\d+\.)\s)/.test(lines[i + 1]); i++) para.push(lines[i + 1]);
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
  }
  return out.join("");
}

function unescapeHtml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// The code names in an answer (what's in backticks and looks like a name),
// to resolve.
export function codeNames(text: string): string[] {
  return [...new Set([...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((c) => /^(this\.)?[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*(\(\))?$/.test(c)))];
}
