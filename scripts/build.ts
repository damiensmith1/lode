// `npm run build`: the package.
//   dist/lib    compiled ESM + .d.ts for src (core, server, CLI), views, the app
//   dist/app    the standalone app, bundled (what `lode open` serves)
//   dist/views  self-contained view bundles, for pages without a bundler
//               (a VS Code webview, a plain <script type="module">)
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildApp } from "../hosts/app/build.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
rmSync(path.join(dist, "lib"), { recursive: true, force: true });
execFileSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(root, "tsconfig.build.json")], { stdio: "inherit" });
for (const file of ["index.html", "app.css"]) copyFileSync(path.join(root, "hosts", "app", file), path.join(dist, "lib", "hosts", "app", file));
chmodSync(path.join(dist, "lib", "src", "cli.js"), 0o755);
await buildApp(path.join(dist, "app"));
await build({
  entryPoints: { "lode-views": path.join(root, "views", "index.ts"), "lode-highlight": path.join(root, "views", "highlight.ts") },
  outdir: path.join(dist, "views"),
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: true,
  logLevel: "warning",
});
console.log("built dist/lib, dist/app, dist/views");
