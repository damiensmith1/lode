import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GraphStore } from "../src/graph/store.js";
import { Queries } from "../src/query/index.js";
import { combinePlugins, pluginFor, railsPack, rubyPlugin, webPlugin } from "../plugins/index.js";

// Web files (HTML, CSS, SCSS) as file nodes and what each one imports; TS
// importing a stylesheet; and a Rails layout's stylesheet_link_tag.
const tmp = mkdtempSync(path.join(os.tmpdir(), "lode-web-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const open = async (fixture: string, plugin?: Awaited<ReturnType<typeof pluginFor>>) => {
  const store = GraphStore.open(plugin ?? (await pluginFor(fixture)), fixture, { cacheDir: path.join(tmp, fixture.replace(/\W/g, "-")) });
  return new Queries(() => store.graph, store.root);
};
const imports = (q: Queries, file: string) => q.block(file)!.links.filter((l) => l.kind === "imports").map((l) => `${l.line} ${l.target.id}`);
const importers = (q: Queries, file: string) => q.block(file)!.callers.filter((c) => c.kind === "imports").map((c) => c.node.id).sort();

describe("web files", () => {
  it("HTML: scripts, stylesheets and other pages; not URLs, anchors or files nothing reads", async () => {
    const q = await open("test/fixtures/web");
    expect(imports(q, "index.html")).toEqual(["4 styles/main.scss", "6 public/app.js", "9 about.html"]); // /app.js: under public/
    expect(imports(q, "about.html")).toEqual(["2 styles/theme.css", "3 index.html"]);
  });

  it("CSS / SCSS: @use partials, @import url(), not sass: modules; who imports a stylesheet", async () => {
    const q = await open("test/fixtures/web");
    expect(imports(q, "styles/main.scss")).toEqual(["2 styles/_base.scss", "3 styles/theme.css"]);
    expect(importers(q, "styles/theme.css")).toEqual(["about.html", "styles/main.scss"]);
  });

  it("JS importing a stylesheet links to it", async () => {
    const q = await open("test/fixtures/web");
    expect(imports(q, "public/app.js")).toEqual(["1 styles/extra.css"]);
    expect(importers(q, "styles/extra.css")).toEqual(["public/app.js"]);
  });

  it("Rails: a layout's stylesheet_link_tag, and the stylesheet's own imports", async () => {
    const q = await open("test/fixtures/rails", combinePlugins([await rubyPlugin({ packs: [railsPack] }), webPlugin()]));
    expect(imports(q, "app/views/layouts/application.html.erb")).toEqual(["4 app/assets/stylesheets/application.css"]);
    expect(imports(q, "app/assets/stylesheets/application.css")).toEqual(["1 app/assets/stylesheets/posts.css"]);
  });
});
