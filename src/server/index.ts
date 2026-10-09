import { randomBytes, timingSafeEqual } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { GraphStore } from "../graph/store.js";
import { Queries } from "../query/index.js";

// The lode server: the graph and its queries over JSON-RPC on a WebSocket
// (`/rpc`), so views can run anywhere a host can open a web page. Optionally
// serves a host's static files too (the standalone app).
//
// Security: localhost only, and every WebSocket must present the session's
// random token (`/rpc?token=…`), come from an allowed Origin (or none, for
// non-browser hosts), and name a localhost Host (blocks DNS rebinding).
// Otherwise any web page the user visits could read the project's source.
//
// Requests:  { id, method, params }  →  { id, result } | { id, error }
// Pushes:    { method: "changed", params: { files } }  after re-indexing

export interface ServerOptions {
  store: GraphStore;
  port?: number; // 0 picks a free port
  staticDir?: string; // files served at /, e.g. the standalone app
  watch?: boolean; // re-index when project files change
  token?: string; // defaults to a fresh random one
  allowedOrigins?: string[]; // extra browser origins, e.g. a host's webview
}

export interface LodeServer {
  port: number;
  url: string; // the app, with the token in the fragment
  rpcUrl: string; // what a host's LodeClient connects to
  token: string;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};

export async function startServer(options: ServerOptions): Promise<LodeServer> {
  const { store } = options;
  const token = options.token ?? randomBytes(24).toString("hex");
  let port = 0; // known once listening
  const localHosts = () => [`127.0.0.1:${port}`, `localhost:${port}`];
  const isLocalHost = (host: string | undefined) => !!host && localHosts().includes(host);
  const tokenMatches = (given: string | null) =>
    !!given && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));
  const queries = new Queries(() => store.graph, store.root);

  const methods: Record<string, (params: Record<string, unknown>) => unknown> = {
    info: () => queries.info(),
    files: () => queries.files(),
    search: (p) => queries.search(String(p.query ?? "")),
    focus: (p) => queries.focus(String(p.id)),
    map: (p) => queries.map(String(p.lens ?? "runtime"), (p.parent as string | undefined) ?? null, Boolean(p.includeExternal)),
    source: (p) => queries.source(String(p.file)),
  };

  const http: Server = createServer(async (req, res) => {
    if (!options.staticDir || !isLocalHost(req.headers.host)) return void res.writeHead(404).end();
    const url = new URL(req.url ?? "/", "http://localhost");
    const file = path.resolve(options.staticDir, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!file.startsWith(path.resolve(options.staticDir) + path.sep)) return void res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });

  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({
    server: http,
    path: "/rpc",
    verifyClient: ({ origin, req }: { origin?: string; req: IncomingMessage }) => {
      const allowed = [...localHosts().map((h) => `http://${h}`), ...(options.allowedOrigins ?? [])];
      const url = new URL(req.url ?? "/", "http://localhost");
      return isLocalHost(req.headers.host) && (origin === undefined || allowed.includes(origin)) && tokenMatches(url.searchParams.get("token"));
    },
  });
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (raw) => {
      let request: { id?: unknown; method?: unknown; params?: unknown };
      try {
        request = JSON.parse(String(raw));
      } catch {
        return;
      }
      const { id } = request;
      const method = typeof request.method === "string" ? methods[request.method] : undefined;
      if (!method) return void socket.send(JSON.stringify({ id, error: `unknown method ${String(request.method)}` }));
      try {
        const result = method((request.params as Record<string, unknown>) ?? {});
        socket.send(JSON.stringify({ id, result }));
      } catch (error) {
        socket.send(JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });

  // Re-index on change, debounced, and tell every connected view.
  let watcher: FSWatcher | undefined;
  if (options.watch) {
    let timer: NodeJS.Timeout | undefined;
    watcher = watch(store.root, { recursive: true }, (_event, name) => {
      if (!name || /(^|[\\/])(node_modules|\.git|dist|out)([\\/]|$)/.test(name)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const files = store.refresh();
        if (!files.length) return;
        const message = JSON.stringify({ method: "changed", params: { files } });
        for (const s of sockets) s.send(message);
      }, 250);
    });
  }

  await new Promise<void>((resolve) => http.listen(options.port ?? 0, "127.0.0.1", resolve));
  port = (http.address() as { port: number }).port;
  return {
    port,
    url: `http://127.0.0.1:${port}/#token=${token}`,
    rpcUrl: `ws://127.0.0.1:${port}/rpc?token=${token}`,
    token,
    close: async () => {
      watcher?.close();
      for (const s of sockets) s.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
