import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface Project {
  root: string; // ids and locations are relative to this
  options: ts.CompilerOptions;
  files: string[]; // absolute paths of the project's own source files
}

// Defaults for a folder with no tsconfig.json or jsconfig.json.
const PLAIN_JS_CONFIG = {
  compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "preserve" },
  include: ["**/*"],
  exclude: ["node_modules", "dist", "build", "out", "coverage"],
};

// `projectPath` is a tsconfig.json, a jsconfig.json, or a directory (which
// uses the tsconfig.json or jsconfig.json inside it, or plain JS defaults).
// JavaScript is always included: a TS project's .js files are part of it.
export function loadProject(projectPath: string): Project {
  const absolute = path.resolve(projectPath);
  const configPath = statSync(absolute).isDirectory() ? findConfig(absolute) : absolute;
  const root = configPath ? path.dirname(configPath) : absolute;

  let raw: { compilerOptions?: Record<string, unknown> } = PLAIN_JS_CONFIG;
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    raw = config.config;
  }
  raw = { ...raw, compilerOptions: { ...raw.compilerOptions, allowJs: true, checkJs: false, noEmit: true } };

  const parsed = ts.parseJsonConfigFileContent(raw, ts.sys, root, undefined, configPath ?? undefined);
  // A solution config (`"files": []` with `references`, as Nx and project
  // references set up): the files are its referenced projects'.
  const fileNames = new Set(parsed.fileNames);
  const visit = (refs: readonly ts.ProjectReference[] | undefined, depth: number) => {
    for (const ref of refs ?? []) {
      const refPath = ts.sys.directoryExists(ref.path) ? path.join(ref.path, "tsconfig.json") : ref.path;
      const config = ts.readConfigFile(refPath, ts.sys.readFile);
      if (config.error) continue;
      const sub = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(refPath), undefined, refPath);
      for (const f of sub.fileNames) fileNames.add(f);
      if (depth < 3) visit(sub.projectReferences, depth + 1);
    }
  };
  visit(parsed.projectReferences, 0);
  // Vue single-file components, as virtual .vue.ts files (their scripts).
  for (const f of ts.sys.readDirectory(root, [".vue", ".svelte"], ["**/node_modules/**", "**/dist/**", "**/.nuxt/**", "**/.output/**", "**/.svelte-kit/**"])) fileNames.add(`${f}.ts`);
  const files = [...fileNames].map((f) => path.resolve(f)).filter((f) => !isBundled(f));
  return { root, options: parsed.options, files };
}

// --- Vue single-file components ------------------------------------------------------

// A .vue file's script(s), in place: the content of <script> and
// <script setup>, everything else blanked (newlines kept), so lines match.
export function vueScript(text: string): string {
  let out = "";
  let at = 0;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const script = /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/g;
  for (let m = script.exec(text); m; m = script.exec(text)) {
    out += blank(text.slice(at, m.index)) + blank(m[1]) + m[2] + blank(m[3]);
    at = m.index + m[0].length;
  }
  // Always a module (a template-only component, a script with no imports),
  // so imports of it resolve; on the last line, so no line moves.
  return `${out}${blank(text.slice(at))} export {};`;
}

// Vue and Svelte components: a .vue.ts / .svelte.ts stands for its file's script.
export const isVueVirtual = (file: string) => file.endsWith(".vue.ts") || file.endsWith(".svelte.ts");
// The real file a program file stands for (a .vue.ts is its .vue).
export const realFile = (file: string) => (isVueVirtual(file) ? file.slice(0, -3) : file);

function findConfig(dir: string): string | null {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const VENDOR_DIRS = new Set(["vendor", "vendors", "third_party", "third-party", "thirdparty"]);

// Minified or bundled third-party code checked into the repo (vendor/*.js):
// not the project's own code. It still loads as a library when imported.
function isBundled(file: string): boolean {
  if (file.split(/[\\/]/).some((part) => VENDOR_DIRS.has(part))) return true;
  if (!/\.[cm]?js$/.test(file)) return false;
  if (/\.min\.[cm]?js$/.test(file)) return true;
  const head = Buffer.alloc(64 * 1024);
  const fd = openSync(file, "r");
  const bytes = readSync(fd, head, 0, head.length, 0);
  closeSync(fd);
  return head.toString("utf8", 0, bytes).split("\n").some((line) => line.length > 1000);
}

// Module resolution for repos with more than one tsconfig (monorepos, an
// app per folder): a file's imports resolve with its nearest tsconfig's
// settings (its `paths` aliases, `baseUrl`), and a workspace package
// (`@acme/ui`, by its package.json name) resolves to its folder even when
// dependencies aren't installed.
export function withProjectResolution(host: ts.CompilerHost, root: string, options: ts.CompilerOptions): ts.CompilerHost {
  const configs = new Map<string, ts.CompilerOptions | null>(); // folder → its tsconfig's options
  const optionsFor = (file: string): ts.CompilerOptions => {
    const chain: string[] = [];
    for (let dir = path.dirname(file); dir.startsWith(root); dir = path.dirname(dir)) {
      if (configs.has(dir)) {
        const hit = configs.get(dir);
        for (const d of chain) configs.set(d, hit ?? null);
        return hit ?? options;
      }
      chain.push(dir);
      const found = findConfig(dir);
      if (found) {
        const config = ts.readConfigFile(found, ts.sys.readFile);
        const parsed = config.error ? null : ts.parseJsonConfigFileContent(config.config, ts.sys, dir, undefined, found).options;
        const merged = parsed ? { ...options, ...parsed, allowJs: true, noEmit: true } : null;
        for (const d of chain) configs.set(d, merged);
        return merged ?? options;
      }
      if (dir === root || dir === path.dirname(dir)) break;
    }
    for (const d of chain) configs.set(d, null);
    return options;
  };
  let workspaces: Map<string, string> | null = null; // package name → folder
  const workspaceOf = (name: string): { dir: string; sub: string } | null => {
    if (!workspaces) {
      workspaces = new Map();
      const walk = (dir: string, depth: number) => {
        if (depth > 4) return;
        let entries: string[] = [];
        try {
          entries = ts.sys.readDirectory(dir, [".json"], ["**/node_modules/**"], ["package.json"], 1);
        } catch {
          return;
        }
        for (const f of entries) {
          try {
            const pkg = JSON.parse(ts.sys.readFile(f) ?? "{}") as { name?: string };
            if (pkg.name && path.dirname(f) !== root) workspaces!.set(pkg.name, path.dirname(f));
          } catch {
            // not a package
          }
        }
        for (const sub of ts.sys.getDirectories(dir)) if (!/^(node_modules|\.git|dist|build|out|\.next)$/.test(sub)) walk(path.join(dir, sub), depth + 1);
      };
      walk(root, 0);
    }
    const parts = name.split("/");
    const pkgName = name.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    const dir = workspaces.get(pkgName);
    return dir ? { dir, sub: name.slice(pkgName.length).replace(/^\//, "") } : null;
  };
  // Vue: a .vue.ts is its .vue's script.
  const { getSourceFile, fileExists, readFile } = host;
  host.readFile = (f) => (isVueVirtual(f) ? (ts.sys.fileExists(realFile(f)) ? vueScript(ts.sys.readFile(realFile(f)) ?? "") : undefined) : readFile.call(host, f));
  host.fileExists = (f) => (isVueVirtual(f) ? ts.sys.fileExists(realFile(f)) : fileExists.call(host, f));
  host.getSourceFile = (f, version, onError, create) => {
    if (!isVueVirtual(f)) return getSourceFile.call(host, f, version, onError, create);
    const text = host.readFile(f);
    return text === undefined ? undefined : ts.createSourceFile(f, text, version, true, ts.ScriptKind.TS);
  };
  // import X from "./X.vue" / "@/components/X.vue": its .vue.ts, through
  // the importing file's tsconfig paths.
  const vueImport = (name: string, containingFile: string, opts: ts.CompilerOptions): ts.ResolvedModuleFull | undefined => {
    const candidates: string[] = [];
    if (name.startsWith(".")) candidates.push(path.resolve(path.dirname(containingFile), name));
    const base = (opts as { pathsBasePath?: string }).pathsBasePath ?? opts.baseUrl ?? root;
    for (const [pattern, targets] of Object.entries(opts.paths ?? {})) {
      const [pre, post = ""] = pattern.split("*");
      if (!name.startsWith(pre) || !name.endsWith(post)) continue;
      const star = name.slice(pre.length, name.length - post.length);
      for (const t of targets) candidates.push(path.resolve(base, t.replace("*", star)));
    }
    const found = candidates.find((c) => ts.sys.fileExists(c));
    return found ? { resolvedFileName: `${found}.ts`, extension: ts.Extension.Ts, isExternalLibraryImport: false } : undefined;
  };
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) => {
      const opts = optionsFor(containingFile);
      if (name.endsWith(".vue") || name.endsWith(".svelte")) return vueImport(name, containingFile, opts);
      const resolved = ts.resolveModuleName(name, containingFile, opts, host).resolvedModule;
      if (resolved && !resolved.isExternalLibraryImport) return resolved;
      const ws = workspaceOf(name);
      if (ws) {
        for (const candidate of ws.sub ? [path.join(ws.dir, "src", ws.sub), path.join(ws.dir, ws.sub)] : [path.join(ws.dir, "src", "index"), path.join(ws.dir, "index"), ws.dir]) {
          const hit = ts.resolveModuleName(candidate, containingFile, opts, host).resolvedModule;
          if (hit) return { ...hit, isExternalLibraryImport: false };
        }
      }
      return resolved;
    });
  return host;
}
