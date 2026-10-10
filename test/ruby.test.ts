import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pluginFor, railsPack, rubyPlugin } from "../plugins/index.js";
import { tsPlugin } from "../src/ingest/ts/index.js";
import { GraphStore } from "../src/graph/store.js";
import { Queries } from "../src/query/index.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "lode-ruby-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const fixture = "test/fixtures/rails";
const store = GraphStore.open(await rubyPlugin({ packs: [railsPack] }), fixture, { cacheDir: path.join(tmp, "cache") });
const queries = new Queries(() => store.graph, store.root);

// Every arrow as "from → to" (ids without their file), with its confidence.
const arrows = (s = store) =>
  [...s.graph.allNodes()]
    .flatMap((n) => s.graph.neighbors(n.id, "down", ["calls"]))
    .map((e) => `${e.from.replace(/^.*?#/, "")} → ${e.to.replace(/^.*?#/, "")} (${e.confidence})`);

describe("ruby", () => {
  it("declares classes, modules, methods and class methods, by their constant paths", () => {
    const user = store.graph.node("app/controllers/admin/users_controller.rb#Admin::UsersController")!;
    expect(user).toMatchObject({ kind: "container", name: "UsersController", parent: "app/controllers/admin/users_controller.rb#Admin" });
    expect(store.graph.node("lib/greeter.rb#Greeter.self.build")).toMatchObject({ kind: "callable", name: "build", detail: { singleton: true } });
    expect(store.graph.node("lib/greeter.rb#Greeter.greet")?.loc).toEqual({ file: "lib/greeter.rb", line: 6, endLine: 8 });
  });

  it("resolves calls the way Ruby looks them up: self, constants, new, and what a variable holds", () => {
    const all = arrows();
    expect(all).toContain("Greeter.greet → Greeter.format_name (exact)"); // self, private
    expect(all).toContain("lib/runner.rb → Greeter.initialize (exact)"); // Greeter.new
    expect(all).toContain("lib/runner.rb → Greeter.self.build (exact)");
    expect(all).toContain("lib/runner.rb → Greeter.greet (inferred)"); // greeter = Greeter.new
    expect(all).toContain("ApplicationController.authenticate → ApplicationController.current_user (exact)");
    expect(all).toContain("CommentsController.create → ApplicationController.current_user (exact)"); // inherited
    expect(all).toContain("User.activate! → User.welcome (exact)"); // a bare name
  });

  it("leaves framework calls without arrows rather than guessing", () => {
    // post.author (an association), update!, where, order: none of ours.
    expect(arrows().filter((a) => /PostMailer\.published →|User\.activate! → (?!User\.welcome)/.test(a))).toEqual([]);
  });

  it("folds class, method and block bodies, and the requires", () => {
    const block = queries.block("lib/greeter.rb#Greeter")!;
    expect(block.regions.map((r) => `${r.start}-${r.end}${r.node ? ` ${r.node.name}` : ""}`)).toEqual(expect.arrayContaining(["2-4 initialize", "6-8 greet", "10-12 build"]));
  });
});

describe("rails", () => {
  it("routes go to their controller actions, and are entries by verb and path", () => {
    const all = arrows();
    for (const action of ["PagesController.home", "PagesController.about", "PostsController.index", "PostsController.show", "PostsController.publish", "CommentsController.create", "Admin::UsersController.index", "Admin::UsersController.show"]) {
      expect(all).toContain(`config/routes.rb → ${action} (pattern)`);
    }
    const web = queries.entries().groups.find((g) => g.runtime === "web")!;
    expect(web.categories.find((c) => c.name === "routes")!.entries.map((e) => e.label).sort()).toEqual(
      ["GET /", "GET /about", "GET /admin/users", "GET /admin/users/:id", "GET /posts", "GET /posts/:id", "POST /posts/:id/publish", "POST /posts/:post_id/comments"].sort(),
    );
  });

  it("callbacks, associations, scopes, concerns, finders, jobs, mailers and rake tasks", () => {
    const all = arrows();
    expect(all).toContain("ApplicationController → ApplicationController.authenticate (pattern)"); // before_action
    expect(all).toContain("Post → Post.normalize_title (pattern)"); // before_save
    expect(all).toContain("Post → User (pattern)"); // belongs_to :author, class_name: "User"
    expect(all).toContain("Post → Comment (pattern)"); // has_many :comments
    expect(all).toContain("PostsController.index → Post.self.published (exact)"); // scope
    expect(all).toContain("NotifyJob.perform → Publishable.recent (exact)"); // class_methods in a concern
    expect(all).toContain("PostsController.show → Post.view! (inferred)"); // @post = Post.find(…)
    expect(all).toContain("PostsController.publish → Publishable.publish! (inferred)"); // included
    expect(all).toContain("PostsController.publish → NotifyJob.perform (exact)"); // perform_later
    expect(all).toContain("PostsController.publish → PostMailer.published (exact)"); // a mailer's class method
    expect(all).toContain("task posts:cleanup → Post.self.published (exact)");
    const groups = queries.entries().groups;
    expect(groups.find((g) => g.runtime === "jobs")?.categories[0]).toMatchObject({ name: "jobs", entries: [{ label: "job NotifyJob" }] });
    expect(groups.find((g) => g.runtime === "tasks")?.categories[0]).toMatchObject({ name: "tasks", entries: [{ label: "rake posts:cleanup" }] });
  });
});

describe("choosing plugins", () => {
  it("a TS project gets the TS plugin as before; a Ruby one, Ruby with Rails", async () => {
    expect(await pluginFor("test/fixtures/ipc")).toBe(tsPlugin);
    expect((await pluginFor(fixture)).name).toBe("ruby+rails");
  });

  it("re-indexes only what changed", async () => {
    const copy = path.join(tmp, "app");
    cpSync(fixture, copy, { recursive: true });
    const s = GraphStore.open(await pluginFor(copy), copy, { cacheDir: path.join(tmp, "cache-copy") });
    expect(arrows(s)).not.toContain("User.welcome → User.activate! (exact)");
    appendFileSync(path.join(copy, "app/models/user.rb"), "\nclass User\n  def welcome\n    activate!\n  end\nend\n");
    expect(s.refresh()).toEqual(["app/models/user.rb"]);
    expect(arrows(s).some((a) => /User\.welcome(~\d+)? → User\.activate! \(exact\)/.test(a))).toBe(true);
  });
});
