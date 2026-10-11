import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pluginFor, pythonPlugin, pythonToolsPack, pythonWebPack } from "../plugins/index.js";
import { GraphStore } from "../src/graph/store.js";
import { Queries } from "../src/query/index.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "lode-python-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const fixture = "test/fixtures/python";
const store = GraphStore.open(await pythonPlugin({ packs: [pythonWebPack, pythonToolsPack] }), fixture, { cacheDir: path.join(tmp, "cache") });
const queries = new Queries(() => store.graph, store.root);

// Every arrow as "from → to" (ids without their file), with its confidence.
const arrows = (s = store) =>
  [...s.graph.allNodes()].flatMap((n) => s.graph.neighbors(n.id, "down", ["calls"])).map((e) => `${e.from.replace(/^.*?#/, "")} → ${e.to.replace(/^.*?#/, "")} (${e.confidence})`);

describe("python", () => {
  it("declares modules, classes, functions and methods by their dotted names, decorators included", () => {
    expect(store.graph.node("app/services.py#UserService.find")).toMatchObject({ kind: "callable", name: "find", parent: "app/services.py#UserService" });
    expect(store.graph.node("app/api/users.py#read_user")?.loc).toEqual({ file: "app/api/users.py", line: 8, endLine: 10 }); // from its @router.get line
    expect(store.graph.node("app/main.py#app")).toMatchObject({ kind: "value" });
  });

  it("resolves names through imports: relative, absolute, and re-exported by a package", () => {
    const all = arrows();
    expect(all).toContain("UserRepo.get → User.__init__ (exact)"); // from .models import User
    expect(all).toContain("UserService.register → slugify (exact)"); // app.utils re-exports text.slugify
    expect(all).toContain("get_service → UserService.build (exact)"); // a class's static method
  });

  it("knows what variables hold: annotations, assignments, self attributes, return types", () => {
    const all = arrows();
    expect(all).toContain("read_user → UserService.find (inferred)"); // service: UserService
    expect(all).toContain("UserService.find → UserRepo.get (inferred)"); // self.repo = repo (repo: UserRepo)
    expect(all).toContain("UserService.find → User.touch (inferred)"); // user = self.repo.get(…) -> User
    expect(all).toContain("create_user → UserService.register (inferred)"); // service = UserService.build() -> "UserService"
    expect(all).toContain("User.touch → Base.save (exact)"); // super()
    expect(all).toContain("UserService.register → Base.save (inferred)"); // inherited
  });

  it("leaves library calls alone", () => {
    expect(arrows().filter((a) => /^slugify →/.test(a))).toEqual([]); // re.sub, .lower()
  });
});

describe("python, beyond annotations", () => {
  const refs = () => [...store.graph.allNodes()].flatMap((n) => store.graph.neighbors(n.id, "down", ["references"])).map((e) => `${e.from.replace(/^.*?#/, "")} → ${e.to.replace(/^.*?#/, "")}`);

  it("what an unannotated function returns, and tuples unpacked from a call", () => {
    const all = arrows();
    expect(all).toContain("use → UserRepo.get (inferred)"); // repo, user = make() (return UserRepo(), User("x"))
    expect(all).toContain("use → User.touch (inferred)");
    expect(all.filter((a) => a === "use → UserRepo.get (inferred)")).toHaveLength(2); // and again = make_repo() (return UserRepo()), on another line
  });

  it("a @property read runs it", () => {
    expect(arrows()).toContain("use → User.display (inferred)"); // return user.display
  });

  it("a call to an abstract method also reaches its implementations", () => {
    const all = arrows();
    for (const impl of ["Judge.ask", "JevJudge.ask", "FakeJudge.ask"]) expect(all).toContain(`judge_all → ${impl} (inferred)`);
  });

  it("functions passed along are shown as passed: thread targets, callbacks", () => {
    expect(refs()).toEqual(expect.arrayContaining(["start → work", "main → cmd_sync"]));
  });

  it("pytest: a parameter is the fixture of that name, from conftest.py, with its value's type", () => {
    const all = arrows();
    expect(all).toContain("test_get → repo (pattern)");
    expect(all).toContain("test_get → UserRepo.get (inferred)");
  });

  it("CLI commands and console scripts are entries", () => {
    const tasks = queries.entries().groups.flatMap((g) => g.categories).filter((c) => c.name === "tasks").flatMap((c) => c.entries.map((e) => e.label));
    expect(tasks).toEqual(expect.arrayContaining(["command sync", "script fixture-cli", "manage.py cleanup"]));
  });
});

describe("python web frameworks", () => {
  it("routes, with router prefixes and Django's include(), are entries by verb and path", () => {
    const web = queries.entries().groups.find((g) => g.runtime === "web")!;
    expect(web.categories.find((c) => c.name === "routes")!.entries.map((e) => e.label).sort()).toEqual(["GET /blog/articles/<int:pk>", "GET /health", "GET /users/{user_id}", "POST /users", "path /blog/articles", "path /shop/items/<int:pk>"]);
    const all = arrows();
    expect(all).toContain("blog/urls.py → article_list (pattern)");
    expect(all).toContain("blog/urls.py → ArticleDetail (pattern)"); // ArticleDetail.as_view()
    expect(all).toContain("read_user → get_service (pattern)"); // Depends(get_service)
  });

  it("the ORM, tasks and management commands", () => {
    const all = arrows();
    expect(all).toContain("ArticleDetail.get → Article.publish (inferred)"); // Article.objects.get(…)
    expect(all).toContain("article_list → ArticleQuerySet.published (inferred)"); // objects = ArticleQuerySet.as_manager()
    const events = queries.entries().groups.flatMap((g) => g.categories).filter((c) => c.name === "events").flatMap((c) => c.entries.map((e) => e.label));
    expect(events).toContain("django ArticleDetail.get_context_data"); // a view hook Django calls
    expect(all).toContain("Command.handle → Article.publish (inferred)"); // for article in Article.objects.filter(…)
    expect(all).toContain("UserService.register → send_welcome (exact)"); // send_welcome.delay(…)
    const groups = queries.entries().groups;
    expect(groups.find((g) => g.runtime === "jobs")?.categories[0]).toMatchObject({ name: "jobs", entries: [{ label: "task send_welcome" }] });
    expect(groups.find((g) => g.runtime === "tasks")?.categories[0]).toMatchObject({ name: "tasks", entries: [{ label: "manage.py cleanup" }] });
  });

  it("Django templates: a view renders one; a template extends, includes and links to views by URL name", () => {
    const all = arrows();
    expect(all).toContain("article_list → blog/templates/blog/article_list.html (pattern)"); // render(request, "blog/article_list.html")
    expect(all).toContain("ArticleDetail → blog/templates/blog/_card.html (pattern)"); // template_name = …
    expect(all).toContain("blog/templates/blog/article_list.html → blog/templates/blog/base.html (pattern)"); // {% extends %}
    expect(all).toContain("blog/templates/blog/article_list.html → blog/templates/blog/_card.html (pattern)"); // {% include %}
    expect(all).toContain("blog/templates/blog/article_list.html → ArticleDetail (pattern)"); // {% url 'blog:article-detail' %}
    expect(all).not.toContain("blog/templates/blog/article_list.html → item_detail (pattern)"); // shop's article-detail: another namespace
  });

  it("is chosen for a Python project, and re-indexes only what changed", async () => {
    expect((await pluginFor(fixture)).name).toBe("python+python-web+python-tools");
    const copy = path.join(tmp, "app");
    cpSync(fixture, copy, { recursive: true });
    const s = GraphStore.open(await pluginFor(copy), copy, { cacheDir: path.join(tmp, "cache-copy") });
    appendFileSync(path.join(copy, "app/repo.py"), "\n    def all(self):\n        return [self.get(1)]\n");
    expect(s.refresh()).toEqual(["app/repo.py"]);
    expect(arrows(s)).toContain("UserRepo.all → UserRepo.get (inferred)");
  });

  it("imports: a module links to the modules it imports (absolute and relative), and lists who imports it", () => {
    const services = queries.block("app/services.py")!;
    expect(services.links.filter((l) => l.kind === "imports").map((l) => `${l.line} ${l.target.id}`)).toEqual(
      expect.arrayContaining(["1 app/repo.py", "2 app/models.py", "3 app/utils/__init__.py", "4 app/tasks.py"]),
    );
    const models = queries.block("app/models.py")!;
    const importers = models.callers.filter((c) => c.kind === "imports").map((c) => c.node.id);
    expect(importers).toEqual(expect.arrayContaining(["app/services.py", "app/repo.py", "app/factory.py"])); // from .models import User
  });
});
