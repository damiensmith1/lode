import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { GraphData, LanguagePlugin, PluginSession } from "../../src/schema/index.js";
import { listFiles } from "../../src/query/git.js";

// The base for languages parsed with tree-sitter (Ruby, then Python, Go,
// Java). A language gives which files are its own, a syntax-only extractor
// (one file's text → that file's facts, independent of every other file)
// and a linker (every file's facts → the graph). So an update re-parses
// only the files that changed, and re-links the whole project, which is
// cheap. Grammars come from @vscode/tree-sitter-wasm: WASM, nothing to
// compile, no language toolchain needed.

const require = createRequire(import.meta.url);
type TreeSitter = typeof import("@vscode/tree-sitter-wasm");
export type SyntaxNode = import("@vscode/tree-sitter-wasm").Node;
export type Tree = import("@vscode/tree-sitter-wasm").Tree;

let runtime: Promise<TreeSitter> | null = null;
const languages = new Map<string, Promise<import("@vscode/tree-sitter-wasm").Language>>();

// A parser for one of the bundled grammars ("ruby", "python", "go", "java").
// Loading is async (WASM); parsing after that is synchronous.
export async function loadParser(grammar: string): Promise<(text: string) => Tree> {
  runtime ??= (async () => {
    const ts = require("@vscode/tree-sitter-wasm") as TreeSitter;
    await ts.Parser.init();
    return ts;
  })();
  const ts = await runtime;
  if (!languages.has(grammar)) languages.set(grammar, ts.Language.load(require.resolve(`@vscode/tree-sitter-wasm/wasm/tree-sitter-${grammar}.wasm`)));
  const language = await languages.get(grammar)!;
  const parser = new ts.Parser();
  parser.setLanguage(language);
  return (text) => {
    const tree = parser.parse(text);
    if (!tree) throw new Error(`tree-sitter couldn't parse (${grammar})`);
    return tree;
  };
}

export interface TreeSitterLanguage<Facts> {
  name: string; // the plugin's name ("ruby")
  version: number; // bump when facts or the graph change shape (invalidates caches)
  grammar: string;
  // Is this one of the language's files? (relative path)
  owns(file: string): boolean;
  // One file's facts, from its syntax alone. JSON-serializable: they're
  // kept between runs.
  extract(tree: Tree, file: string, text: string): Facts;
  // The project's graph from every file's facts. `root` for anything a
  // pack wants to know about the project (a Gemfile, config files).
  link(facts: Facts[], root: string): GraphData;
}

const MAX_BYTES = 1_000_000; // bigger files (generated, vendored) aren't indexed

// A LanguagePlugin for a tree-sitter language. Async: the grammar loads first.
export async function treeSitterPlugin<Facts>(language: TreeSitterLanguage<Facts>): Promise<LanguagePlugin> {
  const parse = await loadParser(language.grammar);
  const open = (projectPath: string, state?: unknown): PluginSession => {
    const root = rootOf(projectPath);
    let cache: Record<string, { hash: string; facts: Facts }> = isState<Facts>(state) ? state.files : {};
    const sources = () => listFiles(root).filter((f) => language.owns(f) && small(path.join(root, f)));
    const files = () => {
      const hashes: Record<string, string> = {};
      for (const f of sources()) {
        try {
          hashes[f] = hashOf(readFileSync(path.join(root, f)));
        } catch {
          // Gone between listing and reading: next time.
        }
      }
      return hashes;
    };
    const update = (changed?: string[]): GraphData => {
      const current = files();
      const redo = new Set(changed ?? Object.keys(current));
      const next: typeof cache = {};
      for (const [file, hash] of Object.entries(current)) {
        const cached = cache[file];
        if (cached && cached.hash === hash && !redo.has(file)) {
          next[file] = cached;
          continue;
        }
        const text = readFileSync(path.join(root, file), "utf8");
        try {
          next[file] = { hash, facts: language.extract(parse(text), file, text) };
        } catch {
          // A file the grammar chokes on is left out, not the project.
        }
      }
      cache = next;
      return language.link(Object.keys(cache).sort().map((f) => cache[f].facts), root);
    };
    return { root: () => root, files, update, state: () => ({ files: cache }) };
  };
  return {
    name: language.name,
    version: language.version,
    index: (projectPath) => open(projectPath).update(),
    open,
  };
}

// --- helpers for extractors -------------------------------------------------

// 1-based line of a node's start / end.
export const lineOf = (n: SyntaxNode) => n.startPosition.row + 1;
export const endLineOf = (n: SyntaxNode) => n.endPosition.row + 1;

// Every descendant (and the node), depth-first, in source order.
export function* walk(node: SyntaxNode): Generator<SyntaxNode> {
  yield node;
  for (const child of node.namedChildren) if (child) yield* walk(child);
}

function rootOf(projectPath: string): string {
  const absolute = path.resolve(projectPath);
  return statSync(absolute).isDirectory() ? absolute : path.dirname(absolute);
}

function small(file: string): boolean {
  try {
    return statSync(file).size <= MAX_BYTES;
  } catch {
    return false;
  }
}

function hashOf(content: Buffer): string {
  return createHash("sha1").update(content).digest("hex");
}

function isState<Facts>(value: unknown): value is { files: Record<string, { hash: string; facts: Facts }> } {
  return typeof value === "object" && value !== null && "files" in value;
}
