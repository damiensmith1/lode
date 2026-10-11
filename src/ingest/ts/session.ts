import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { GraphData, PluginSession } from "../../schema/index.js";
import type { FileFacts } from "./facts.js";
import { createExtractor, mergeFacts } from "./ingest.js";
import { loadProject, realFile, withProjectResolution } from "./project.js";
import { toGraph } from "./toGraph.js";

interface CachedFile {
  hash: string;
  facts: FileFacts;
}

interface State {
  files: Record<string, CachedFile>;
}

// Keeps the TS program between updates so unchanged files aren't re-parsed,
// and keeps each file's facts so only changed files (and the files that
// import them) are re-extracted. The program is only built when something
// actually needs re-extracting.
export function openTsSession(projectPath: string, state?: unknown): PluginSession {
  let cache: Record<string, CachedFile> = isState(state) ? state.files : {};
  let program: ts.Program | undefined;
  let host: ts.CompilerHost | undefined;

  const root = loadProject(projectPath).root; // fixed for the session
  const rel = (abs: string) => path.relative(root, realFile(abs)).split(path.sep).join("/");

  const files = () => {
    const hashes: Record<string, string> = {};
    for (const abs of loadProject(projectPath).files) hashes[rel(abs)] = hashOf(readFileSync(realFile(abs)));
    return hashes;
  };

  const update = (changed?: string[]): GraphData => {
    const project = loadProject(projectPath);
    const current = files();
    host ??= withProjectResolution(cachingHost(project.options), project.root, project.options);
    program = ts.createProgram(project.files, project.options, host, program);

    const affected = changed ? withImporters(new Set(changed), cache) : new Set(Object.keys(current));
    for (const file of Object.keys(current)) if (!cache[file]) affected.add(file); // new or never indexed

    const extract = createExtractor(program, project);
    const next: Record<string, CachedFile> = {};
    for (const file of Object.keys(current)) {
      if (!affected.has(file) && cache[file]) {
        next[file] = cache[file];
        continue;
      }
      const sf = program.getSourceFile(path.join(root, /\.(vue|svelte)$/.test(file) ? `${file}.ts` : file));
      if (sf) next[file] = { hash: current[file], facts: extract(sf) };
    }
    cache = next; // files that disappeared drop out here
    return graphData();
  };

  const graphData = () => toGraph(mergeFacts(Object.values(cache).map((c) => c.facts)));

  return { root: () => root, files, update, state: (): State => ({ files: cache }) };
}

// A compiler host that only re-parses a file when its text changed. Most of a
// program is library .d.ts files that never change, so this is most of the
// cost of an update.
function cachingHost(options: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  const parsed = new Map<string, { text: string; sf: ts.SourceFile }>();
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = host.readFile(fileName);
    if (text === undefined) return getSourceFile.call(host, fileName, languageVersion, onError, shouldCreate);
    const hit = parsed.get(fileName);
    if (hit && hit.text === text) return hit.sf;
    const sf = ts.createSourceFile(fileName, text, languageVersion, true);
    parsed.set(fileName, { text, sf });
    return sf;
  };
  return host;
}

// Adds every project file that directly imports one of `files`, per the
// cached facts (an importer whose own text changed is in `files` already).
// Their facts can change too (callee ids, argument types). Transitive effects
// of inferred types are not followed; a full update catches those.
function withImporters(files: Set<string>, cache: Record<string, CachedFile>): Set<string> {
  const result = new Set(files);
  for (const [file, cached] of Object.entries(cache)) {
    if (cached.facts.imports.some((imported) => files.has(imported))) result.add(file);
  }
  return result;
}

function hashOf(content: Buffer): string {
  return createHash("sha1").update(content).digest("hex");
}

function isState(value: unknown): value is State {
  return typeof value === "object" && value !== null && "files" in value;
}
