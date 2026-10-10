import { existsSync, readFileSync } from "node:fs";

// What lode reads from .env files: only its own keys, never anything else
// a .env might hold (NODE_OPTIONS, PATH, …), since one may come from the
// working directory.
export const ENV_KEYS = ["TYPESAFE_API_KEY"] as const;

// Load `keys` from KEY=value lines in .env files into process.env (what's
// already set wins). No expansion or multi-line values.
export function loadEnv(files: string[], keys: readonly string[] = ENV_KEYS) {
  const allowed = new Set(keys);
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
      if (!m || raw.trimStart().startsWith("#") || !allowed.has(m[1])) continue;
      const value = m[2].replace(/^(["'])(.*)\1$/, "$2");
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  }
}
