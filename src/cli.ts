// A project is a directory, a tsconfig.json or a jsconfig.json.
//
// lode index <project> [--json <out>] [--cache <dir>]
//   Build (or refresh) the graph and print a summary.
// lode node <project> <node-id> [--cache <dir>]
//   Print one node, its place in each lens, and its edges one hop up and down.
// lode serve <project> [--port <n>] [--cache <dir>]
//   Run the lode server for a host to connect to (ws://…/rpc).
// lode open <project> [--port <n>] [--cache <dir>]
//   Run the server with the standalone app, and open it in the browser.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore } from "./graph/store.js";
import { tsPlugin } from "./ingest/ts/index.js";
import type { Edge } from "./schema/index.js";

// Exit quietly when piped into something that stops reading (`| head`).
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const json = option("json");
const cacheDir = option("cache");
const port = Number(option("port") ?? 0);
const [command, project, nodeId] = args;

const COMMANDS = ["index", "node", "serve", "open"];
if (!project || !COMMANDS.includes(command) || (command === "node" && !nodeId)) {
  console.error(
    [
      "usage: lode index <project> [--json out] [--cache dir]",
      "       lode node <project> <node-id> [--cache dir]",
      "       lode serve <project> [--port n] [--cache dir]",
      "       lode open <project> [--port n] [--cache dir]",
    ].join("\n"),
  );
  process.exit(1);
}

const start = performance.now();
const store = GraphStore.open(tsPlugin, project, { cacheDir });
const ms = Math.round(performance.now() - start);
const { graph } = store;

if (command === "serve" || command === "open") {
  const { startServer } = await import("./server/index.js");
  let staticDir: string | undefined;
  if (command === "open") {
    const { buildApp } = await import("../hosts/app/build.js");
    staticDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "app");
    await buildApp(staticDir);
  }
  const server = await startServer({ store, port, staticDir, watch: true });
  console.log(`lode · ${graph.size.nodes} nodes, ${graph.size.edges} edges (${ms}ms) · ${store.root}`);
  console.log(command === "open" ? `open ${server.url}` : `serving ${server.rpcUrl}`);
  if (command === "open") spawn(process.platform === "darwin" ? "open" : "xdg-open", [server.url], { stdio: "ignore", detached: true }).unref();
} else if (command === "index") {
  const data = graph.toData();
  const count = <T>(items: T[], key: (t: T) => string) =>
    Object.entries(items.reduce<Record<string, number>>((m, t) => ((m[key(t)] = (m[key(t)] ?? 0) + 1), m), {}))
      .map(([k, n]) => `${k} ${n}`)
      .join(" · ");
  console.log(`${graph.size.nodes} nodes, ${graph.size.edges} edges (${ms}ms)`);
  console.log(`  nodes: ${count(data.nodes, (n) => (n.external ? "external" : n.kind))}`);
  console.log(`  edges: ${count(data.edges, (e) => (e.kind === "flows" ? `flows(${tierOf(e)})` : e.kind))}`);
  const runtime = graph.lens("runtime");
  console.log(`  runtimes: ${runtime.roots().filter((r) => r.startsWith("runtime:")).map((r) => `${r.slice(8)} ${runtime.children(r).length}`).join(" · ") || "none"}`);
  if (json) writeFileSync(json, JSON.stringify(data, null, 2));
} else {
  const node = graph.node(nodeId);
  if (!node) {
    console.error(`no node ${nodeId}`);
    process.exit(1);
  }
  console.log(`${node.id}  [${node.kind}]${node.loc ? `  ${node.loc.file}:${node.loc.line}` : ""}`);
  for (const lens of ["folder", "runtime"]) console.log(`  ${lens}: ${graph.lens(lens).path(node.id).join(" › ")}`);
  const show = (label: string, edges: Edge[], end: "from" | "to") => {
    if (!edges.length) return;
    console.log(`\n${label}`);
    for (const e of edges) console.log(`  ${describe(e)}  ${e[end]}`);
  };
  show("up (what feeds it)", graph.neighbors(node.id, "up"), "from");
  show("down (what it feeds)", graph.neighbors(node.id, "down"), "to");
}

function tierOf(e: Edge): string {
  return e.within ? "local" : e.through ? "state" : e.via ? "channel" : "other";
}

function describe(e: Edge): string {
  if (e.kind === "calls") return `calls(${(e.args ?? []).join(", ")}) → ${e.returns}`;
  if (e.kind === "references") return `references:${e.access}`;
  const detail = e.via ? ` ${e.via.key}` : e.through ? ` via ${e.through}` : e.within ? ` in ${e.within}` : "";
  return `flows[${tierOf(e)}${detail}] ${e.type ?? ""}`.trimEnd();
}
