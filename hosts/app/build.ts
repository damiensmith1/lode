import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));

// Bundles the standalone app (and the views it embeds) into outDir.
export async function buildApp(outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [path.join(here, "main.ts")],
    outfile: path.join(outDir, "app.js"),
    bundle: true,
    format: "esm",
    target: "es2022",
    sourcemap: true,
    logLevel: "warning",
  });
  for (const file of ["index.html", "app.css"]) copyFileSync(path.join(here, file), path.join(outDir, file));
}

// `npm run build:web` → dist/app
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await buildApp(path.join(here, "..", "..", "dist", "app"));
}
