import ts from "typescript";
import type { ChannelEndpoint } from "../../schema/index.js";
import type { CallFact, Location } from "./facts.js";

// Framework knowledge: which library calls send or receive on a string-keyed
// channel. Families keep directions apart, so ipcMain.on("x") never matches
// webContents.send("x"). The core only matches endpoints; it never sees this.
interface ChannelCall {
  role: "send" | "receive";
  family: string;
  awaitsReply?: true; // send: the sender gets the receiver's return value back
}

const TO_MAIN = "electron-ipc:to-main";
const INVOKE = "electron-ipc:invoke";
const TO_RENDERER = "electron-ipc:to-renderer";

const CHANNEL_CALLS: Record<string, ChannelCall> = {
  "ext:electron#IpcRenderer.send": { role: "send", family: TO_MAIN },
  "ext:electron#IpcRenderer.sendSync": { role: "send", family: TO_MAIN, awaitsReply: true },
  "ext:electron#IpcRenderer.postMessage": { role: "send", family: TO_MAIN },
  "ext:electron#IpcMain.on": { role: "receive", family: TO_MAIN },
  "ext:electron#IpcMain.once": { role: "receive", family: TO_MAIN },
  "ext:electron#IpcMain.addListener": { role: "receive", family: TO_MAIN },

  "ext:electron#IpcRenderer.invoke": { role: "send", family: INVOKE, awaitsReply: true },
  "ext:electron#IpcMain.handle": { role: "receive", family: INVOKE },
  "ext:electron#IpcMain.handleOnce": { role: "receive", family: INVOKE },

  "ext:electron#WebContents.send": { role: "send", family: TO_RENDERER },
  "ext:electron#WebContents.postMessage": { role: "send", family: TO_RENDERER },
  "ext:electron#IpcRenderer.on": { role: "receive", family: TO_RENDERER },
  "ext:electron#IpcRenderer.once": { role: "receive", family: TO_RENDERER },
  "ext:electron#IpcRenderer.addListener": { role: "receive", family: TO_RENDERER },
};

// A channel call before its key is resolved. When the key is a parameter of
// the enclosing function (a wrapper like `send(channel, payload)`), keyParam
// says which one, and the key is taken from the wrapper's callers instead.
export interface ChannelFact {
  role: "send" | "receive";
  family: string;
  nodeId: string;
  keyType: string | null; // checker's type string for the key, e.g. '"a" | "b"'
  keyParam: { wrapperId: string; index: number } | null;
  payload: string[];
  awaitsReply?: true;
  returns?: string; // receive: what the handler returns
  loc: Location;
}

interface Context {
  checker: ts.TypeChecker;
  nodeIdOf: (node: ts.Node) => string | null; // id if the node is a graph node
  enclosingId: (node: ts.Node) => string;
  locOf: (node: ts.Node) => Location;
}

export function channelFactOf(call: ts.CallExpression, calleeId: string | null, ctx: Context): ChannelFact | null {
  const spec = calleeId ? CHANNEL_CALLS[calleeId] : undefined;
  if (!spec || call.arguments.length === 0) return null;
  const { checker } = ctx;
  const [keyArg, ...rest] = call.arguments;

  let nodeId = ctx.enclosingId(call);
  let payload = rest.map((a) => checker.typeToString(checker.getTypeAtLocation(a)));
  let returns: string | undefined;

  if (spec.role === "receive" && rest[0]) {
    nodeId = handlerId(rest[0], ctx) ?? nodeId;
    payload = [];
    const signature = checker.getTypeAtLocation(rest[0]).getCallSignatures()[0];
    if (signature) returns = checker.typeToString(checker.getReturnTypeOfSignature(signature));
  }

  return {
    role: spec.role,
    family: spec.family,
    nodeId,
    keyType: checker.typeToString(checker.getTypeAtLocation(keyArg)),
    keyParam: keyParamOf(keyArg, ctx),
    payload,
    ...(spec.awaitsReply && { awaitsReply: true as const }),
    ...(returns && { returns }),
    loc: ctx.locOf(call),
  };
}

function handlerId(arg: ts.Expression, ctx: Context): string | null {
  const own = ctx.nodeIdOf(arg); // a registered callback literal
  if (own) return own;
  if (!ts.isIdentifier(arg)) return null;
  const decl = ctx.checker.getSymbolAtLocation(arg)?.valueDeclaration;
  return decl ? ctx.nodeIdOf(decl) : null; // a named function passed in
}

export function keyParamOf(arg: ts.Expression, ctx: Context): ChannelFact["keyParam"] {
  if (!ts.isIdentifier(arg)) return null;
  const decl = ctx.checker.getSymbolAtLocation(arg)?.valueDeclaration;
  if (!decl || !ts.isParameter(decl) || !ts.isFunctionLike(decl.parent)) return null;
  const wrapperId = ctx.nodeIdOf(decl.parent);
  return wrapperId ? { wrapperId, index: decl.parent.parameters.indexOf(decl) } : null;
}

// Turns facts into endpoints. Wrapper endpoints are replaced by one endpoint
// per call to the wrapper, keyed by the argument it was given; repeated so
// wrappers of wrappers resolve too.
export function resolveEndpoints(facts: ChannelFact[], calls: CallFact[], maxDepth = 3): ChannelEndpoint[] {
  let pending = facts;
  const endpoints: ChannelEndpoint[] = [];

  for (let depth = 0; depth <= maxDepth && pending.length; depth++) {
    const next: ChannelFact[] = [];
    for (const fact of pending) {
      if (!fact.keyParam) {
        endpoints.push(...toEndpoints(fact));
        continue;
      }
      const { wrapperId, index } = fact.keyParam;
      for (const call of calls) {
        if (call.calleeId !== wrapperId || call.argTypes[index] === undefined) continue;
        next.push({
          ...fact,
          nodeId: call.callerId,
          keyType: call.argTypes[index],
          keyParam: call.argParams?.[index] ?? null,
          payload: fact.role === "send" ? call.argTypes.filter((_, i) => i !== index) : [],
          loc: call.loc,
        });
      }
    }
    pending = next;
  }
  return endpoints;
}

function toEndpoints(fact: ChannelFact): ChannelEndpoint[] {
  return keysOf(fact.keyType).map((key) => ({
    node: fact.nodeId,
    role: fact.role,
    family: fact.family,
    key: key.value,
    pattern: key.pattern,
    payload: fact.payload.join(", ") || undefined,
    ...(fact.awaitsReply && { awaitsReply: true }),
    ...(fact.returns && { returns: fact.returns }),
    loc: fact.loc,
  }));
}

// '"a"' -> a; '"a" | "b"' -> a, b; '`topic:${string}`' -> topic:* (pattern).
// Anything else (plain `string`) has no usable key.
export function keysOf(type: string | null): { value: string; pattern: boolean }[] {
  if (!type) return [];
  return type.split(" | ").flatMap((part): { value: string; pattern: boolean }[] => {
    const literal = part.match(/^"(.*)"$/);
    if (literal) return [{ value: literal[1], pattern: false }];
    const template = part.match(/^`(.*)`$/);
    if (template) return [{ value: template[1].replace(/\$\{[^}]*\}/g, "*"), pattern: true }];
    return [];
  });
}
