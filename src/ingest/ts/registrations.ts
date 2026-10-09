import ts from "typescript";

// Calls that register a callback to run later (events, IPC, routes, timers,
// hooks). A function literal passed directly to one of these becomes its own
// node, so the work it does isn't credited to the code that registered it.
//
// Matched by the called method or function name only. A false match is cheap
// (one extra node), because only function-literal arguments are affected:
// `map.get(key)` never matches, `app.get("/x", (req) => …)` does.
const REGISTRATION_CALLS: (string | RegExp)[] = [
  // Event emitters (Node, DOM, Electron, socket.io, ws, chokidar, …)
  "on", "once", "off", "addListener", "prependListener", "prependOnceListener",
  "addEventListener", "listen", "subscribe",

  // Electron
  "handle", "handleOnce", // ipcMain
  "register", "registerAll", // globalShortcut
  "registerFileProtocol", "registerStringProtocol", "registerBufferProtocol",
  "registerHttpProtocol", "registerStreamProtocol",
  "setWindowOpenHandler", "setPermissionRequestHandler", "setPermissionCheckHandler",
  "setDevicePermissionHandler", "setDisplayMediaRequestHandler", "setCertificateVerifyProc",

  // Callback-style hooks: onBeforeRequest, onDidChange, onMessage, onClick, …
  /^on[A-Z]/,
  // Registries: registerCommand, registerTool, registerHoverProvider, …
  /^register[A-Z]/,
  // Handler setters: setRequestHandler, setNotificationHandler, setErrorHandler, …
  /^set\w*Handler$/,

  // HTTP routing (Express, Koa, Fastify, Hono, Elysia, …)
  "get", "post", "put", "patch", "delete", "head", "options", "all",
  "use", "route", "addHook", "hook", "decorate", "onRequest",

  // RPC / API frameworks
  "tool", "resource", "prompt", // MCP SDK (older API)
  "query", "mutation", "subscription", "procedure", // tRPC
  "action", "command", // CLI builders (commander, yargs)

  // Timers and scheduling
  "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "nextTick",
  "requestAnimationFrame", "requestIdleCallback", "schedule",

  // React effects (run later, not inline)
  "useEffect", "useLayoutEffect", "useInsertionEffect",

  // Test frameworks (vitest, jest, mocha, node:test)
  "describe", "it", "test", "suite", "bench",
  "beforeAll", "beforeEach", "afterAll", "afterEach", "before", "after",

  // Workers and messaging
  "addMessageListener",
];

// Constructors that take a callback to run later.
const REGISTRATION_CONSTRUCTORS = new Set([
  "MutationObserver", "ResizeObserver", "IntersectionObserver", "PerformanceObserver",
  "ReportingObserver", "Worker", "EventSource", "BroadcastChannel",
]);

// Assigned handlers: `worker.onmessage = (e) => …`, `ws.onclose = …`.
const ASSIGNED_HANDLER = /^on[a-z]+$/;

export interface Registration {
  call: string; // the registering method, function or property name
  key: string | null; // the channel/event/route, when it's a string literal
}

// If `node` is a function literal handed to a registration, describe it.
export function registrationOf(node: ts.Node, checker: ts.TypeChecker): Registration | null {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return null;
  const parent = node.parent;

  if (ts.isBinaryExpression(parent) && parent.right === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const name = ts.isPropertyAccessExpression(parent.left) ? parent.left.name.text : null;
    return name && ASSIGNED_HANDLER.test(name) ? { call: name, key: null } : null;
  }

  if (!(ts.isCallExpression(parent) || ts.isNewExpression(parent))) return null;
  const args = parent.arguments ?? ts.factory.createNodeArray();
  if (!args.includes(node as ts.Expression)) return null;

  const call = calleeName(parent.expression);
  if (!call) return null;
  const matches = ts.isNewExpression(parent)
    ? REGISTRATION_CONSTRUCTORS.has(call)
    : REGISTRATION_CALLS.some((p) => (typeof p === "string" ? p === call : p.test(call)));
  if (!matches) return null;

  return { call, key: literalKey(args[0], node, checker) };
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

// The first argument, when it's a string the checker knows exactly
// (a literal, or a const holding one).
function literalKey(first: ts.Expression | undefined, handler: ts.Node, checker: ts.TypeChecker): string | null {
  if (!first || first === handler) return null;
  if (ts.isStringLiteralLike(first)) return first.text;
  const type = checker.getTypeAtLocation(first);
  return type.isStringLiteral() ? type.value : null;
}
