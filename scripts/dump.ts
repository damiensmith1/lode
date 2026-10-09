// Usage: npm run dump -- <path/to/tsconfig.json> [out.json]
import { writeFileSync } from "node:fs";
import { ingestTsProject } from "../src/ingest/ts/ingest.js";

const [tsconfig, out] = process.argv.slice(2);
if (!tsconfig) throw new Error("usage: dump <tsconfig.json> [out.json]");

const start = performance.now();
const facts = ingestTsProject(tsconfig);
const ms = Math.round(performance.now() - start);

const internal = facts.calls.filter((c) => c.calleeId && !c.calleeId.startsWith("ext:"));
const external = facts.calls.filter((c) => c.calleeId?.startsWith("ext:"));
const unresolved = facts.calls.filter((c) => !c.calleeId);
console.log(`${facts.decls.length} decls, ${facts.calls.length} calls in ${ms}ms`);
console.log(`  internal ${internal.length} · external ${external.length} · unresolved ${unresolved.length}`);

if (out) writeFileSync(out, JSON.stringify(facts, null, 2));
