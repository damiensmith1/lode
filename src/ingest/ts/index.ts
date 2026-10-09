import type { LanguagePlugin } from "../../schema/index.js";
import { ingestTsProject } from "./ingest.js";
import { openTsSession } from "./session.js";
import { toGraph } from "./toGraph.js";

// projectPath: the project's tsconfig.json.
export const tsPlugin: LanguagePlugin = {
  name: "typescript",
  version: 2,
  index: (projectPath) => toGraph(ingestTsProject(projectPath)),
  open: openTsSession,
};
