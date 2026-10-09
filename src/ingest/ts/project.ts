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
  compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
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
  const files = parsed.fileNames.map((f) => path.resolve(f)).filter((f) => !isBundled(f));
  return { root, options: parsed.options, files };
}

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
