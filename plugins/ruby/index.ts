import type { LanguagePlugin } from "../../src/schema/index.js";
import { treeSitterPlugin } from "../treesitter/index.js";
import { erbToRuby } from "./erb.js";
import { extractRuby, type RubyFacts } from "./extract.js";
import { linkRuby, type RubyPack } from "./link.js";

export type { RubyPack, RubyProject, ClassInfo, Registration } from "./link.js";
export type { RubyFacts, RubyCall, RubyDecl, RubyArg } from "./extract.js";

// Ruby, parsed with tree-sitter. Packs add what a framework does by
// convention (railsPack: routes, callbacks, finders, mailers, jobs); each
// one only runs where it detects its framework.
//   const ruby = await rubyPlugin({ packs: [railsPack] });
//   GraphStore.open(ruby, "path/to/app");

const FILE = /\.(rb|rake|gemspec|ru|thor|erb|jbuilder)$|(^|\/)(Gemfile|Rakefile|Guardfile|Capfile)$/;
const SKIP = /(^|\/)(vendor|node_modules|tmp|log|coverage|\.bundle)\//;

export const isRubyFile = (file: string) => FILE.test(file) && !SKIP.test(file);

export async function rubyPlugin(options: { packs?: RubyPack[] } = {}): Promise<LanguagePlugin> {
  const packs = options.packs ?? [];
  return treeSitterPlugin<RubyFacts>({
    name: packs.length ? `ruby+${packs.map((p) => p.name).join("+")}` : "ruby",
    version: 5,
    grammar: "ruby",
    owns: isRubyFile,
    source: (file, text) => (file.endsWith(".erb") ? erbToRuby(text) : text), // an ERB template: its Ruby
    extract: extractRuby,
    link: (facts, root) => linkRuby(facts, root, packs),
  });
}
