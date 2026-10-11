import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { tsPlugin } from "../src/ingest/ts/index.js";
import { listFiles } from "../src/query/git.js";
import type { GraphData, LanguagePlugin, PluginSession } from "../src/schema/index.js";
import { railsPack } from "./rails/index.js";
import { isRubyFile, rubyPlugin } from "./ruby/index.js";
import { rubyToolsPack } from "./ruby-tools/index.js";
import { sinatraPack } from "./sinatra/index.js";
import { isPythonFile, pythonPlugin } from "./python/index.js";
import { pythonWebPack } from "./python-web/index.js";
import { pythonToolsPack } from "./python-tools/index.js";

export { railsPack } from "./rails/index.js";
export { rubyPlugin, isRubyFile } from "./ruby/index.js";
export { rubyToolsPack } from "./ruby-tools/index.js";
export { sinatraPack } from "./sinatra/index.js";
export { pythonPlugin, isPythonFile } from "./python/index.js";
export { pythonWebPack } from "./python-web/index.js";
export { pythonToolsPack } from "./python-tools/index.js";
export type { PyPack, PythonProject } from "./python/index.js";
export type { RubyPack, RubyProject } from "./ruby/index.js";
export { treeSitterPlugin, loadParser, type TreeSitterLanguage } from "./treesitter/index.js";

// The plugin for a project, from what's in it: TypeScript/JavaScript (a
// tsconfig/jsconfig, or .ts/.js files), Ruby (with Rails where Rails is),
// Python (with its web frameworks where they are), or several at once. A TS-only project gets tsPlugin exactly as before.
export async function pluginFor(projectPath: string): Promise<LanguagePlugin> {
  const absolute = path.resolve(projectPath);
  const root = statSync(absolute).isDirectory() ? absolute : path.dirname(absolute);
  if (!statSync(absolute).isDirectory()) return tsPlugin; // a tsconfig.json given directly
  const files = listFiles(root);
  const hasTs = existsSync(path.join(root, "tsconfig.json")) || existsSync(path.join(root, "jsconfig.json")) || files.some((f) => /\.(m|c)?(t|j)sx?$/.test(f) && !/(^|\/)(vendor|public|node_modules)\//.test(f));
  // Ruby: a Gemfile, gemspec, Rakefile or config.ru, or a few .rb files (not
  // one stray Homebrew formula, not test fixtures).
  const ruby = files.filter((f) => isRubyFile(f) && !/(^|\/)fixtures\//.test(f));
  const hasRuby = ruby.length >= 3 || ruby.some((f) => /(^|\/)(Gemfile|Rakefile|config\.ru)$|\.gemspec$/.test(f));
  // Python: a pyproject.toml, setup.py, requirements.txt or Pipfile, or a few .py files.
  const python = files.filter((f) => isPythonFile(f) && !/(^|\/)fixtures\//.test(f));
  const hasPython = python.length >= 3 || files.some((f) => /^(pyproject\.toml|setup\.py|setup\.cfg|requirements\.txt|Pipfile)$/.test(f));
  const plugins: LanguagePlugin[] = [];
  if (hasTs || (!hasRuby && !hasPython)) plugins.push(tsPlugin);
  if (hasRuby) plugins.push(await rubyPlugin({ packs: [railsPack, sinatraPack, rubyToolsPack] }));
  if (hasPython) plugins.push(await pythonPlugin({ packs: [pythonWebPack, pythonToolsPack] }));
  return plugins.length === 1 ? plugins[0] : combinePlugins(plugins);
}

// Several languages in one project: each plugin indexes its own files, and
// their graphs are put together. A change re-indexes only the plugins whose
// files changed.
export function combinePlugins(plugins: LanguagePlugin[]): LanguagePlugin {
  return {
    name: plugins.map((p) => p.name).join("+"),
    version: plugins.reduce((v, p) => v * 100 + p.version, 1),
    index: (projectPath) => merge(plugins.map((p) => p.index(projectPath))),
    open(projectPath, state) {
      const saved = (typeof state === "object" && state !== null && "parts" in state ? (state as { parts: unknown[] }).parts : []) ?? [];
      const sessions: PluginSession[] = plugins.map((p, i) => p.open(projectPath, saved[i]));
      let parts: (GraphData | null)[] = sessions.map(() => null);
      let owners: Record<string, string>[] = sessions.map(() => ({}));
      const files = () => {
        owners = sessions.map((s) => s.files());
        return Object.assign({}, ...owners) as Record<string, string>;
      };
      return {
        root: () => sessions[0].root(),
        files,
        update(changed) {
          if (!changed) parts = sessions.map((s) => s.update());
          else {
            const before = owners;
            files();
            parts = sessions.map((s, i) => {
              const mine = changed.filter((f) => f in owners[i] || f in before[i]);
              return mine.length || !parts[i] ? s.update(mine) : parts[i];
            });
          }
          return merge(parts.filter((p): p is GraphData => !!p));
        },
        state: () => ({ parts: sessions.map((s) => s.state()) }),
      };
    },
  };
}

function merge(parts: GraphData[]): GraphData {
  return {
    nodes: parts.flatMap((p) => p.nodes),
    edges: parts.flatMap((p) => p.edges),
    channels: parts.flatMap((p) => p.channels ?? []),
    regions: parts.flatMap((p) => p.regions ?? []),
  };
}
