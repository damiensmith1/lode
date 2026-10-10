#!/usr/bin/env node
// A project is a directory, a tsconfig.json or a jsconfig.json.
//
// lode index <project> [--json <out>] [--cache <dir>]
//   Build (or refresh) the graph and print a summary.
// lode node <project> <node-id> [--cache <dir>]
//   Print one node, its place in each lens, and its edges one hop up and down.
// lode serve <project> [--port <n>] [--cache <dir>] [--origin <url>]…
//   Run the lode server for a host to connect to (ws://…/rpc). --origin
//   allows a browser page from another origin (a host's webview) to connect.
// lode open <project> [--port <n>] [--cache <dir>]
//   Run the server with the standalone app, and open it in the browser.
// lode mcp <project> [--cache <dir>]
//   Serve lode's tools to an agent over MCP (stdio), e.g. in Claude Code:
//   claude mcp add lode -- npx lode mcp /path/to/project
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore } from "./graph/store.js";
import { pluginFor } from "../plugins/index.js";
import type { Edge } from "./schema/index.js";

// Exit quietly when piped into something that stops reading (`| head`).
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

// Settings and keys (TYPESAFE_API_KEY, ANTHROPIC_API_KEY, OPENAI_*, …) from
// the .env in lode's own folder only, never the working directory: a
// project's .env could otherwise point OPENAI_BASE_URL at its own server
// and receive a key from your environment. What's already set wins.
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const { loadEnv } = await import("./ask/env.js");
  loadEnv([path.join(here, "..", ".env"), path.join(here, "..", "..", "..", ".env")]); // src/ or dist/lib/src/ → lode's folder
}

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const origins: string[] = [];
for (let o = option("origin"); o; o = option("origin")) origins.push(o);
const json = option("json");
const cacheDir = option("cache");
const port = Number(option("port") ?? 0);
const [command, project, nodeId] = args;

const COMMANDS = ["index", "node", "serve", "open", "mcp"];
if (!project || !COMMANDS.includes(command) || (command === "node" && !nodeId)) {
  console.error(
    [
      "usage: lode index <project> [--json out] [--cache dir]",
      "       lode node <project> <node-id> [--cache dir]",
      "       lode serve <project> [--port n] [--cache dir] [--origin url]…",
      "       lode open <project> [--port n] [--cache dir]",
      "       lode mcp <project> [--cache dir]",
    ].join("\n"),
  );
  process.exit(1);
}

const start = performance.now();
const store = GraphStore.open(await pluginFor(project), project, { cacheDir }); // TS/JS, Ruby (+ Rails), or both
const ms = Math.round(performance.now() - start);
const { graph } = store;

if (command === "mcp") {
  // stdout is the protocol: everything else goes to stderr.
  const { createService } = await import("./service/index.js");
  const { serveMcp } = await import("./mcp/index.js");
  const service = createService(store);
  service.watch();
  serveMcp(service);
  process.stderr.write(`lode mcp · ${graph.size.nodes} nodes (${ms}ms) · ${store.root}\n`);
} else if (command === "serve" || command === "open") {
  const { startServer } = await import("./server/index.js");
  let staticDir: string | undefined;
  if (command === "open") {
    // An installed package ships the app prebuilt (dist/app, beside
    // dist/lib); from source, bundle it now.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const prebuilt = path.join(here, "..", "..", "app");
    if (here.endsWith(path.join("dist", "lib", "src")) && existsSync(path.join(prebuilt, "index.html"))) staticDir = prebuilt;
    else {
      const { buildApp } = await import("../hosts/app/build.js");
      staticDir = path.join(here, "..", "dist", "app");
      await buildApp(staticDir);
    }
  }
  const server = await startServer({ store, port, staticDir, watch: true, allowedOrigins: origins });
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
