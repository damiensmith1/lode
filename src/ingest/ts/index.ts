import type { LanguagePlugin } from "../../schema/index.js";
import { ingestTsProject } from "./ingest.js";
import { toGraph } from "./toGraph.js";

// projectPath: the project's tsconfig.json.
export const tsPlugin: LanguagePlugin = {
  name: "typescript",
  index: (projectPath) => toGraph(ingestTsProject(projectPath)),
};
