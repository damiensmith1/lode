import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GraphStore } from "../src/graph/store.js";
import { tsPlugin } from "../src/ingest/ts/index.js";
import { Queries } from "../src/query/index.js";

// TS/JS web and mobile frameworks: React (JSX), Next.js, React Navigation,
// Express, Nest. Each folder of the fixture has its own package.json (the
// frameworks it uses) and, for Next, its own tsconfig with a path alias.
const tmp = mkdtempSync(path.join(os.tmpdir(), "lode-ts-web-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const store = GraphStore.open(tsPlugin, "test/fixtures/ts-web", { cacheDir: tmp });
const queries = new Queries(() => store.graph, store.root);
const g = store.graph;
const links = (kind: "calls" | "flows") =>
  [...g.allNodes()].flatMap((n) => g.neighbors(n.id, "down", [kind])).map((e) => `${e.from.replace(/^.*?#/, "")} → ${e.to.replace(/^.*?#/, "")}${e.via ? ` (${e.via.family.split("@")[0]} ${e.via.key})` : ""}`);
const entries = () => queries.entries().groups.flatMap((gr) => gr.categories).filter((c) => c.name !== "not called in the project").flatMap((c) => c.entries.map((e) => `${c.name}: ${e.label}`));

describe("typescript web frameworks", () => {
  it("JSX renders a component: a link, through a tsconfig path alias", () => {
    expect(links("calls")).toContain("HomePage → ProductCard"); // import from "@/components/card"
  });

  it("Next.js: pages, API routes and server actions are entries", () => {
    expect(entries()).toEqual(expect.arrayContaining(["routes: page /", "routes: page /products/[id]", "routes: GET /api/hello", "actions: server action save"]));
  });

  it("navigation: a link to a page, and a screen by name, are channels", () => {
    const flows = links("flows");
    expect(flows).toContain("ProductCard → ProductPage (route /products/*)"); // <Link href={`/products/${id}`}>
    expect(flows).toContain("HomePage → ProductPage (route /products/*)"); // href={paths.product.getHref("2")}: a helper returning a template
    expect(flows).toContain("HomeScreen → ProfileScreen (screen Profile)"); // navigation.navigate("Profile")
    expect(entries()).toEqual(expect.arrayContaining(["routes: screen Profile", "routes: screen Home"]));
  });

  it("Angular: a template's bindings, child components and router links; lifecycle hooks are entries", () => {
    const calls = links("calls");
    expect(calls).toContain("FavoriteComponent → FavoriteComponent.toggle"); // (click)="toggle()"
    expect(calls).toContain("ArticleComponent → ArticleComponent.title"); // {{ title() }}
    expect(calls).toContain("ArticleComponent → FavoriteComponent"); // <app-favorite>, by its selector
    expect(links("flows")).toContain("ArticleComponent → EditorComponent (route /editor/*)"); // [routerLink]="['/editor', slug]", a child route
    expect(entries()).toContain("events: ngOnInit ArticleComponent");
  });

  it("Vue: single-file components' scripts are code; templates use their functions, child components and named routes", () => {
    const calls = links("calls");
    expect(calls).toContain("cart → useCart"); // const cart = useCart(), in the script
    expect(calls).toContain("vue/Home.vue → save"); // @click="save"
    expect(calls).toContain("vue/Home.vue → vue/ArticleCard.vue"); // <ArticleCard>
    expect(links("flows")).toContain("vue/Home.vue → vue/Article.vue (route-name article)"); // :to="{ name: 'article' }"
  });

  it("SvelteKit, Nuxt and Remix: file routes, components and their templates", () => {
    const calls = links("calls");
    expect(calls).toContain("svelte/src/routes/+page.svelte → svelte/src/lib/Card.svelte"); // <Card />, through $lib
    expect(calls).toContain("svelte/src/routes/+page.svelte → save"); // on:click={save}
    expect(calls).toContain("save → format");
    const flows = links("flows");
    expect(flows).toContain("nuxt/pages/index.vue → nuxt/pages/posts/[id].vue (route /posts/1)"); // <NuxtLink to>
    expect(flows).toContain("Index → Post (route /posts/x)"); // <a href>, to a Remix flat route
    // Routes are per app: Nuxt's link to /posts/1 doesn't reach Remix's /posts/$slug.
    expect(flows).not.toContain("nuxt/pages/index.vue → Post (route /posts/1)");
    expect(entries()).toEqual(expect.arrayContaining(["routes: page /posts/[id]", "routes: GET /api/hello", "routes: load /blog/[slug]", "routes: GET /api", "routes: loader /posts/[slug]", "routes: route /posts/[slug]"]));
  });

  it("Express routes (named and inline handlers) and Nest endpoints", () => {
    expect(entries()).toEqual(expect.arrayContaining(["routes: GET /users", "routes: POST /users", "routes: GET /accounts/:id"]));
    // A router mounted in a router mounted at /api, across files: the full path.
    expect(entries()).toContain("routes: GET /api/articles/:slug");
  });
});
