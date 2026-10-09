import type { LanguagePlugin } from "../../schema/index.js";
import { ingestTsProject } from "./ingest.js";
import { openTsSession } from "./session.js";
import { toGraph } from "./toGraph.js";

// TypeScript and JavaScript, via the TS compiler. projectPath: a
// tsconfig.json, a jsconfig.json, or a directory.
export const tsPlugin: LanguagePlugin = {
  name: "typescript",
  version: 7,
  index: (projectPath) => toGraph(ingestTsProject(projectPath)),
  open: openTsSession,
};
