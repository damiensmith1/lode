import ts from "typescript";

// Local def-use for tier 1 flows: which calls produced the value of an
// expression. Follows what a reader would: nested calls, `await`, local
// `const`/`let` initializers (including destructuring), property access,
// object/array literals and simple branches (`a ?? b`, `c ? a : b`).
// Reassignments after the initializer are not followed.
export function sourceCalls(expr: ts.Expression, checker: ts.TypeChecker, depth = 0): ts.CallLikeExpression[] {
  if (depth > 8) return [];
  const next = (e: ts.Expression) => sourceCalls(e, checker, depth + 1);
  expr = unwrap(expr);

  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "require") return []; // an import
  if (ts.isCallExpression(expr) || ts.isNewExpression(expr)) return [expr];
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) return next(expr.expression);
  if (ts.isConditionalExpression(expr)) return [...next(expr.whenTrue), ...next(expr.whenFalse)];
  if (ts.isBinaryExpression(expr) && isFallback(expr.operatorToken.kind)) return [...next(expr.left), ...next(expr.right)];
  if (ts.isArrayLiteralExpression(expr)) return expr.elements.flatMap((e) => next(ts.isSpreadElement(e) ? e.expression : e));
  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.flatMap((p) => {
      if (ts.isPropertyAssignment(p)) return next(p.initializer);
      if (ts.isShorthandPropertyAssignment(p)) {
        const init = localInitializer(checker.getShorthandAssignmentValueSymbol(p));
        return init ? sourceCalls(init, checker, depth + 1) : [];
      }
      if (ts.isSpreadAssignment(p)) return next(p.expression);
      return [];
    });
  }
  if (ts.isIdentifier(expr)) {
    const init = localInitializer(checker.getSymbolAtLocation(expr));
    return init ? next(init) : [];
  }
  return [];
}

function unwrap(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAwaitExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isTypeAssertionExpression(expr)
  ) {
    expr = expr.expression;
  }
  return expr;
}

function isFallback(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.AmpersandAmpersandToken;
}

// The initializer of a variable declared inside a function body, walking
// out of destructuring patterns (`const { a } = load()` -> `load()`).
function localInitializer(symbol: ts.Symbol | undefined): ts.Expression | undefined {
  let decl: ts.Node | undefined = symbol?.valueDeclaration;
  while (decl && ts.isBindingElement(decl)) decl = decl.parent.parent; // pattern -> its declaration
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
  const statement = decl.parent.parent;
  const isLocal = !(ts.isVariableStatement(statement) && (ts.isSourceFile(statement.parent) || ts.isModuleBlock(statement.parent)));
  return isLocal ? decl.initializer : undefined;
}

// The function whose output a `return` (or an arrow's expression body)
// produces, or undefined when that's an anonymous inner function.
export function returningFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
  for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return n;
  return undefined;
}
