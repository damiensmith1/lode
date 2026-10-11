import type { ChannelEndpoint, Confidence, Edge } from "../schema/index.js";

// Matches senders to receivers on the same family and key, and emits a flow
// edge for each pair (plus the reply, when the sender awaits one). Exact keys
// match with "exact" confidence; anything involving a pattern is "pattern".
export function deriveChannelFlows(endpoints: ChannelEndpoint[]): Edge[] {
  const receivers = new Map<string, ChannelEndpoint[]>();
  for (const e of endpoints) if (e.role === "receive") push(receivers, e.family, e);

  const edges: Edge[] = [];
  for (const send of endpoints) {
    if (send.role !== "send") continue;
    let matched = (receivers.get(send.family) ?? []).map((receive) => ({ receive, confidence: matchKeys(send, receive) })).filter((m) => m.confidence);
    // Routes: a link goes to the most specific route that matches, as a router
    // picks it (a /article/* page, not the ** catch-all).
    if (ROUTE_FAMILIES.has(send.family.split("@")[0]) && matched.length > 1) {
      const best = Math.max(...matched.map((m) => specificity(m.receive.key)));
      matched = matched.filter((m) => specificity(m.receive.key) === best);
    }
    for (const { receive, confidence } of matched) {
      if (!confidence) continue;
      const via = { family: send.family, key: send.pattern ? receive.key : send.key };
      edges.push({ kind: "flows", from: send.node, to: receive.node, confidence, loc: send.loc, type: send.payload, via });
      if (send.awaitsReply) {
        edges.push({ kind: "flows", from: receive.node, to: send.node, confidence, loc: receive.loc, type: receive.returns, via, reply: true });
      }
    }
  }
  return edges;
}

function matchKeys(a: ChannelEndpoint, b: ChannelEndpoint): Confidence | null {
  if (!a.pattern && !b.pattern) return a.key === b.key ? "exact" : null;
  // Instantiate each side's wildcards and test it against the other side.
  const fits = (x: ChannelEndpoint, y: ChannelEndpoint) => toRegex(y).test(x.key.replaceAll("*", "\u0000"));
  return fits(a, b) || fits(b, a) ? "pattern" : null;
}

function toRegex(e: ChannelEndpoint): RegExp {
  if (!e.pattern) return new RegExp(`^${escape(e.key)}$`);
  // A route's * is one path segment; ** (a catch-all) is any number.
  if (ROUTE_FAMILIES.has(e.family.split("@")[0])) return new RegExp(`^${e.key.split("**").map((part) => part.split("*").map(escape).join("[^/]*")).join("[^]*")}$`);
  return new RegExp(`^${e.key.split("*").map(escape).join("[^]*")}$`);
}

// Route-like families, scoped to an app: route@apps/web.
const ROUTE_FAMILIES = new Set(["route", "screen", "route-name"]);

// How specific a route is: its literal characters, less for each wildcard.
const specificity = (key: string) => key.replace(/\*+/g, "").length * 4 - (key.match(/\*\*/g)?.length ?? 0) * 100 - (key.match(/(?<!\*)\*(?!\*)/g)?.length ?? 0);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
