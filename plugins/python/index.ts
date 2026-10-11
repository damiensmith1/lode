import type { LanguagePlugin } from "../../src/schema/index.js";
import { treeSitterPlugin } from "../treesitter/index.js";
import { extractPython, type PyFacts } from "./extract.js";
import { linkPython, type PyPack } from "./link.js";

export type { PyPack, PythonProject, Registration, Sym, Ctx } from "./link.js";
export type { PyFacts, PyDecl, PyCall, PyArg, TypeRef } from "./extract.js";

// Python, parsed with tree-sitter. Packs add frameworks' conventions
// (pythonWebPack: FastAPI/Flask/Django routes, the ORM, Celery tasks); each
// runs only where it detects its framework.
//   const python = await pythonPlugin({ packs: [pythonWebPack] });

const SKIP = /(^|\/)(\.venv|venv|env|\.tox|\.nox|site-packages|node_modules|build|dist|__pycache__|\.eggs|[^/]+\.egg-info)\//;

export const isPythonFile = (file: string) => file.endsWith(".py") && !SKIP.test(file);

export async function pythonPlugin(options: { packs?: PyPack[] } = {}): Promise<LanguagePlugin> {
  const packs = options.packs ?? [];
  return treeSitterPlugin<PyFacts>({
    name: packs.length ? `python+${packs.map((p) => p.name).join("+")}` : "python",
    version: 2,
    grammar: "python",
    owns: isPythonFile,
    extract: extractPython,
    link: (facts, root) => linkPython(facts, root, packs),
  });
}
