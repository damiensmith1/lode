import type { CanvasAction } from "../src/explain/index.js";
import type { EditResult, LineEdit } from "./host.js";
import type { ChangesResult, CodeBlock, FlowPlan, EntriesResult, FileEntry, FileView, NodeRef, ProjectInfo } from "../src/query/types.js";
import type { LodeConnection } from "./connection.js";

// Typed calls for building a host's own UI around the views: a file tree,
// a search box, a status line, "go to symbol under the cursor".
//
//   const api = lodeApi(connection);
//   tree.render(buildFileTree(await api.files()));
//   results.render(await api.search(input.value));
//   connection.onChanged(async () => tree.render(buildFileTree(await api.files())));
export function lodeApi(connection: LodeConnection) {
  return {
    info: () => connection.call<ProjectInfo>("info"),
    // Every project file, with its runtime when known.
    files: () => connection.call<FileEntry[]>("files"),
    // Symbols by name (best first); open one with flow.show(node.id).
    search: (query: string) => connection.call<NodeRef[]>("search", { query }),
    entries: () => connection.call<EntriesResult>("entries"),
    // Context for an LLM: a slice of the code, formatted (see src/context).
    context: (request: Record<string, unknown>) => connection.call<{ title: string; markdown: string; tokens: number; dropped: number }>("context", request),
    // Explain cards and answer follow-ups (see src/explain); pass `stream`
    // and listen to connection.onEvent for the answer as it's written.
    explain: (request: Record<string, unknown>, stream?: string) => connection.call<{ text: string; added: string[]; actions: CanvasAction[]; tools: number; ms: number }>("explain", { request, ...(stream && { stream }) }),
    // Stop an explanation still being written (its stream id).
    explainCancel: (stream: string) => connection.call<boolean>("explainCancel", { stream }),
    // The models explaining can use, by provider, for a picker (no secrets).
    explainModels: () => connection.call<{ providers: { id: string; label: string; models: { id: string; label: string }[] }[]; default?: string; notes: string[] }>("explainModels"),
    // Which code names (from an answer) are real symbols: name → id. Symbols
    // in `prefer`'s files win a shared name.
    resolve: (names: string[], prefer: string[] = []) => connection.call<Record<string, string>>("resolve", { names, prefer }),
    // A flow built for a question ("how do we create tabs?"); needs a judge
    // (Jev) on the server.
    ask: (question: string) => connection.call<FlowPlan>("ask", { question }),
    // What changed since `base` (git; default HEAD), by file and symbol.
    changes: (base?: string) => connection.call<ChangesResult>("changes", base ? { base } : {}),
    block: (id: string) => connection.call<CodeBlock | null>("block", { id }),
    // The innermost symbol at a line, e.g. to open the editor's cursor in a flow.
    symbolAt: (file: string, line: number) => connection.call<NodeRef | null>("symbolAt", { file, line }),
    source: (file: string) => connection.call<FileView | null>("source", { file }),
    // Write a card's line edits to its file, if the lines still read as
    // `expected` (the flow saves this way unless the host saves itself).
    editFile: (file: string, edits: LineEdit[]) => connection.call<EditResult>("editFile", { file, edits }),
  };
}

export type LodeApi = ReturnType<typeof lodeApi>;

export interface FileTreeNode {
  name: string;
  path: string; // from the project root; a file's is what flow.show() takes
  kind: "dir" | "file";
  runtime?: string; // files only
  indexed?: boolean; // files only: in the code graph; false for text files (README, JSON)
  children?: FileTreeNode[]; // dirs only: dirs first, then files, by name
}

// The flat file list as a tree of folders.
export function buildFileTree(files: FileEntry[]): FileTreeNode[] {
  const root: FileTreeNode = { name: "", path: "", kind: "dir", children: [] };
  for (const f of files) {
    const parts = f.file.split("/");
    let dir = root;
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (i === parts.length - 1) return void dir.children!.push({ name, path, kind: "file", ...(f.runtime && { runtime: f.runtime }), ...(f.indexed === false && { indexed: false }) });
      let next = dir.children!.find((c) => c.kind === "dir" && c.name === name);
      if (!next) dir.children!.push((next = { name, path, kind: "dir", children: [] }));
      dir = next;
    });
  }
  const sort = (nodes: FileTreeNode[]): FileTreeNode[] =>
    nodes
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1))
      .map((n) => (n.children ? { ...n, children: sort(n.children) } : n));
  return sort(root.children!);
}
