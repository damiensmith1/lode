import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pluginFor, railsPack, rubyPlugin, rubyToolsPack, sinatraPack } from "../plugins/index.js";
import { tsPlugin } from "../src/ingest/ts/index.js";
import { GraphStore } from "../src/graph/store.js";
import { Queries } from "../src/query/index.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "lode-ruby-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const fixture = "test/fixtures/rails";
const store = GraphStore.open(await rubyPlugin({ packs: [railsPack, sinatraPack, rubyToolsPack] }), fixture, { cacheDir: path.join(tmp, "cache") });
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
    expect(store.graph.node("lib/greeter.rb#Greeter.greet")?.loc).toEqual({ file: "lib/greeter.rb", line: 9, endLine: 11 });
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
    expect(block.regions.map((r) => `${r.start}-${r.end}${r.node ? ` ${r.node.name}` : ""}`)).toEqual(expect.arrayContaining(["4-7 initialize", "9-11 greet", "22-24 build"]));
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
      ["GET /", "GET /about", "GET /admin/users", "GET /admin/users/:id", "GET /hi", "GET /posts", "GET /posts/:id", "POST /posts/:id/publish", "POST /posts/:post_id/comments"].sort(), // GET /hi: the Sinatra app
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

describe("ruby, typed through chains", () => {
  it("what methods return (their last expression), associations, scopes and block parameters", () => {
    const all = arrows();
    // current_user (→ @current_user ||= User.find_by(…)) .posts (has_many) .published (scope) .each { |post| post.view! }
    expect(all).toContain("PostsController.mine → Post.self.published (inferred)");
    expect(all).toContain("PostsController.mine → Post.view! (inferred)");
  });

  it("attr_reader, self.class, send(:name), module_function and delegate", () => {
    const all = arrows();
    expect(all).toContain("Greeter.pretty → Formatter.format (inferred)"); // formatter (attr_reader) holds Formatter.new
    expect(all).toContain("Greeter.again → Greeter.self.build (exact)"); // self.class.build
    expect(all).toContain("Greeter.again → Greeter.format_name (exact)"); // send(:format_name)
    expect(all).toContain("Formatter.format → Util.slug (exact)"); // module_function
    expect(all).toContain("PostsController.headline → Post.headline (exact)"); // delegate :headline, to: :post
  });

  it("calls in a class body are on the class; in its blocks, on instances", () => {
    expect(store.graph.node("app/models/post.rb#Post.self.published")).toBeTruthy(); // scope (a class method)
    expect(arrows()).toContain("Post → Post.normalize_title (pattern)"); // before_save :normalize_title
  });
});

describe("rails views (ERB, jbuilder)", () => {
  it("an action renders its view; a view, its partials", () => {
    const all = arrows();
    expect(all).toContain("PostsController.show → app/views/posts/show.html.erb (pattern)");
    expect(all).toContain("PostsController.index → app/views/posts/index.json.jbuilder (pattern)");
    expect(all).toContain("app/views/posts/show.html.erb → app/views/posts/_comment.html.erb (pattern)"); // render "comment"
  });

  it("a view's code runs as its controller's: @variables from its actions, helpers, partials' locals", () => {
    const all = arrows();
    expect(all).toContain("app/views/posts/show.html.erb → PostsHelper.headline_for (exact)");
    expect(all).toContain("app/views/posts/show.html.erb → Post.headline (inferred)"); // @post = Post.find(…)
    expect(all).toContain("app/views/posts/_comment.html.erb → Post.headline (inferred)"); // comment (a local), delegated to post
    expect(store.graph.node("app/views/posts/show.html.erb")?.loc).toEqual({ file: "app/views/posts/show.html.erb", line: 1, endLine: 7 });
  });
});

describe("ruby tools and sinatra", () => {
  it("RSpec: let and subject are typed methods, described_class is the class", () => {
    const all = arrows();
    expect(all).toContain("spec/models/post_spec.rb → post (exact)");
    expect(all).toContain("spec/models/post_spec.rb → Publishable.publish! (inferred)"); // let(:post) { create(:post) } (FactoryBot)
    expect(all).toContain("spec/models/post_spec.rb → User.activate! (inferred)"); // let(:author) { User.new }
    expect(all).toContain("spec/models/post_spec.rb → Post.self.published (inferred)"); // described_class.published
  });

  it("Minitest fixtures, Thor commands and Sinatra routes", () => {
    expect(arrows()).toContain("UserTest → User.activate! (inferred)"); // users(:one), in a test block
    const labels = queries.entries().groups.flatMap((g) => g.categories).flatMap((c) => c.entries.map((e) => e.label));
    expect(labels).toEqual(expect.arrayContaining(["command greet", "GET /hi"]));
    expect(arrows()).toContain("GET /hi → Greeter.self.build (exact)");
  });
});

describe("choosing plugins", () => {
  it("a TS project gets the TS plugin as before; a Ruby one, Ruby with Rails", async () => {
    expect(await pluginFor("test/fixtures/ipc")).toBe(tsPlugin);
    expect((await pluginFor(fixture)).name).toBe("ruby+rails+sinatra+ruby-tools+web"); // its stylesheets: the web plugin
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

  it("imports: require_relative links file to file; a gem's require doesn't", () => {
    const runner = queries.block("lib/runner.rb")!;
    expect(runner.links.filter((l) => l.kind === "imports").map((l) => `${l.line} ${l.target.id}`)).toEqual(["1 lib/greeter.rb"]);
    expect(queries.block("lib/greeter.rb")!.callers).toContainEqual(expect.objectContaining({ kind: "imports", node: expect.objectContaining({ id: "lib/runner.rb" }) }));
    expect(queries.block("app.rb")!.links.filter((l) => l.kind === "imports")).toEqual([]); // require "sinatra": a gem
  });
});
