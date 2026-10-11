import type { RubyPack } from "../ruby/index.js";
import { camelize } from "../ruby/link.js";
import { singularize } from "../rails/index.js";

// Ruby's everyday tools, by convention:
//   RSpec      let(:user) { … } / let! / subject(:x) are methods (typed by
//              what the block gives); described_class is the class described
//   Minitest   fixtures (users(:one), via the Rails pack)
//   FactoryBot create(:user) / build(:user) / build_stubbed is a User;
//              create_list / build_list, Users
//   Thor       a command per method after `desc "name"` in a Thor class (entries)

const TEST_FILE = /(^|\/)(spec|test)\/|_(spec|test)\.rb$/;

export const rubyToolsPack: RubyPack = {
  name: "ruby-tools",

  detect: () => true,

  prepare(project) {
    for (const f of project.facts) {
      const testFile = TEST_FILE.test(f.file);
      for (const call of f.calls) {
        if (call.recv.kind !== "none" || !call.block) continue;
        const first = call.args?.[0];
        if (testFile && /^(let!?|subject!?)$/.test(call.name)) {
          // let(:user) { … }; subject { … } is `subject`.
          const name = first && (first.t === "sym" || first.t === "str") ? first.v : call.name.startsWith("subject") ? "subject" : null;
          if (!name) continue;
          const id = project.promote(call, f.file, name);
          const d = id && project.decls.get(id);
          if (d && call.block.last) d.ret = call.block.last;
        }
        // (Examples, it "…" / test "…" blocks, aren't made callables: thousands of
        // sentence-named nodes crowd the word search out of a question's answer.)
      }
    }

    // FactoryBot: create(:user) is a User; create_list(:user, 3), Users.
    project.typeHooks.push((e) => {
      if (e.recv && !(e.recv.k === "const" && e.recv.text === "FactoryBot")) return null;
      const m = /^(create|build|build_stubbed|create_list|build_list|build_stubbed_list)$/.exec(e.name);
      const sym = e.args?.[0];
      if (!m || sym?.t !== "sym") return null;
      const path = project.resolveConst(camelize(sym.v), []) ?? project.resolveConst(camelize(singularize(sym.v)), []);
      return path && project.classes.get(path)?.kind === "class" ? { path, singleton: false, many: m[1].endsWith("_list"), confidence: "inferred" } : null;
    });
    // described_class: the class the file's RSpec.describe names.
    project.typeHooks.push((e, _base, ctx) => {
      if (e.recv || e.name !== "described_class") return null;
      const describe = project.facts.find((f) => f.file === ctx.file)?.calls.find((c) => c.name === "describe" && c.args?.[0]?.t === "const");
      const arg = describe?.args?.[0];
      const path = arg?.t === "const" ? project.resolveConst(arg.v, describe!.nesting) : null;
      return path ? { path, singleton: true, confidence: "inferred" } : null;
    });
  },

  link(project) {
    // Thor: desc "sync", "…" then def sync → a command.
    for (const f of project.facts) {
      for (const c of f.calls) {
        if (c.name !== "desc" || c.recv.kind !== "none" || c.args?.[0]?.t !== "str") continue;
        const cls = project.classes.get(c.owner);
        if (!cls || !project.inherits(cls.path, /(^|::)Thor$/)) continue;
        const next = [...(cls.methods.values())].flat().map((id) => project.decls.get(id)!).filter((d) => d.file === f.file && d.line > c.line).sort((a, b) => a.line - b.line)[0];
        if (next) project.register(next.id, { call: "command", key: c.args[0].v.split(/\s/)[0], category: "tasks" });
      }
    }
  },
};
