import ts from "typescript";
import type { Region } from "../../schema/index.js";

// Foldable regions of a file, from its syntax tree: blocks (function bodies,
// if/loop/try bodies, classes), multi-line object/array literals, argument
// lists and template strings, runs of comments, and the import block. Views
// show code one level deep and fold the rest.
export function regionsOf(sf: ts.SourceFile, file: string): Region[] {
  const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const seen = new Set<string>();
  const out: Region[] = [];
  const add = (startPos: number, endPos: number, kind: Region["kind"]) => {
    const start = line(startPos);
    const end = line(endPos);
    const key = `${start}:${end}`;
    if (end <= start || seen.has(key)) return;
    seen.add(key);
    out.push({ file, start, end, kind });
  };

  const walk = (node: ts.Node) => {
    if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node)) add(node.getStart(sf), node.getEnd(), "block");
    else if (ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) add(node.getStart(sf), node.getEnd(), "block");
    else if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isTypeLiteralNode(node)) add(node.getStart(sf), node.getEnd(), "literal");
    else if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node.getStart(sf), node.getEnd(), "literal");
    else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments?.length) {
      // From the line the arguments open on to the closing paren.
      add(node.arguments.pos - 1, node.getEnd(), "args");
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);

  // Runs of 2+ comment lines: keep the first, fold the rest.
  const lines = sf.text.split("\n");
  let runStart = 0;
  const isComment = (t: string) => t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
  for (let i = 0; i <= lines.length; i++) {
    const comment = i < lines.length && isComment(lines[i].trim());
    if (comment && !runStart) runStart = i + 1;
    if (!comment && runStart) {
      if (i - runStart >= 1) {
        const key = `${runStart}:${i}`;
        if (!seen.has(key)) (seen.add(key), out.push({ file, start: runStart, end: i, kind: "comment" }));
      }
      runStart = 0;
    }
  }

  // The import block: the first import line heads it.
  const imports = sf.statements.filter((s) => ts.isImportDeclaration(s));
  if (imports.length >= 2) add(imports[0].getStart(sf), imports[imports.length - 1].getEnd(), "imports");

  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}
