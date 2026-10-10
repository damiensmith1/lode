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
    for (const receive of receivers.get(send.family) ?? []) {
      const confidence = matchKeys(send, receive);
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
  return new RegExp(`^${e.key.split("*").map(escape).join("[^]*")}$`);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
