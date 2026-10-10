import { describe, expect, it } from "vitest";
import { highlightLines } from "../views/highlight.js";

describe("highlightLines", () => {
  it("returns one balanced HTML line per source line, even across block comments", () => {
    const src = "/* one\n   two */\nconst x = `a\nb`;";
    const lines = highlightLines(src, "f.ts");
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect((line.match(/<span/g) ?? []).length).toBe((line.match(/<\/span>/g) ?? []).length);
    }
    expect(lines[1]).toContain("hljs-comment");
    expect(lines[3]).toContain("hljs-string");
  });

  it("escapes source text, highlighted or not", () => {
    expect(highlightLines("const a = '<b>';", "f.js")[0]).not.toContain("<b>");
    expect(highlightLines("<script>", "notes.txt")[0]).toBe("&lt;script&gt;");
  });
});
