// `npm run build`: the package, which is lode for building on: no app.
//   dist/lib    compiled ESM + .d.ts for src (core, queries, service,
//               server, MCP, CLI), plugins and views
//   dist/views  a self-contained view bundle, for pages without a bundler
//               (a VS Code webview, a plain <script type="module">)
// The standalone app (hosts/app) is a host in this repo, not in the
// package: `npm run lode -- open` builds and serves it from a clone.
import { execFileSync } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
for (const out of ["lib", "views", "app"]) rmSync(path.join(dist, out), { recursive: true, force: true });
execFileSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(root, "tsconfig.build.json")], { stdio: "inherit" });
chmodSync(path.join(dist, "lib", "src", "cli.js"), 0o755);
await build({
  entryPoints: { "lode-views": path.join(root, "views", "index.ts") },
  outdir: path.join(dist, "views"),
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: true,
  logLevel: "warning",
});
console.log("built dist/lib, dist/views");
