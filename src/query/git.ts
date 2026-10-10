import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DiffHunk, FileChange } from "./types.js";

const run = promisify(execFile);
const MAX_UNTRACKED = 1_000_000; // bytes: bigger untracked files are listed, not read

// A ref a reader can type: HEAD, main, origin/main, HEAD~3, a1b2c3d, v1.2.
export function validBase(base: string): boolean {
  return /^[A-Za-z0-9._/~^@{}-]{1,200}$/.test(base) && !base.startsWith("-");
}

// The working tree's changes against `base` (default HEAD), for the files
// under `root`, untracked files included (as all added). Paths are
// relative to `root`. Symbols are filled in by Queries.changes().
export async function gitChanges(root: string, base: string): Promise<FileChange[]> {
  const git = (...args: string[]) => run("git", ["-C", root, ...args], { maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout);
  const diff = await git("diff", "--relative", "--no-color", "--no-ext-diff", "-U0", "-M", "--end-of-options", base, "--", ".");
  const files = parseDiff(diff);
  const untracked = (await git("ls-files", "--others", "--exclude-standard", "-z", "--", ".")).split("\0").filter(Boolean);
  for (const file of untracked) {
    const change: FileChange = { file, status: "untracked", indexed: false, added: 0, removed: 0, hunks: [], symbols: [] };
    try {
      const text = await readFile(path.join(root, file), "utf8");
      if (text.length <= MAX_UNTRACKED && !text.includes("\0")) {
        const lines = text.split(/\r?\n/);
        const count = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
        change.added = count;
        change.hunks = count ? [{ start: 1, added: count, removed: [] }] : [];
      }
    } catch {
      // Unreadable: listed without lines.
    }
    files.push(change);
  }
  return files;
}

// `git diff -U0` output → files with hunks in new-file line numbers.
export function parseDiff(diff: string): FileChange[] {
  const files: FileChange[] = [];
  let current: FileChange | null = null;
  let hunk: DiffHunk | null = null;
  const unquote = (p: string) => (p.startsWith('"') ? JSON.parse(p) : p);
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { file: "", status: "modified", indexed: false, added: 0, removed: 0, hunks: [], symbols: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("rename from ")) (current.status = "renamed"), (current.from = unquote(line.slice(12)));
    else if (line.startsWith("rename to ")) current.file = unquote(line.slice(10));
    else if (line.startsWith("--- ")) {
      if (current.status === "deleted") current.file = unquote(line.slice(4)).replace(/^a\//, "");
    } else if (line.startsWith("+++ ")) {
      const to = unquote(line.slice(4));
      if (to !== "/dev/null") current.file = to.replace(/^b\//, "");
    } else if (line.startsWith("@@")) {
      const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const added = m[3] === undefined ? 1 : Number(m[3]);
      hunk = { start: Number(m[2]), added, removed: [] };
      current.hunks.push(hunk);
      current.added += added;
    } else if (hunk && line.startsWith("-")) {
      hunk.removed.push(line.slice(1));
      current.removed++;
    }
  }
  return files.filter((f) => f.file);
}

// Every file under `root` worth listing: git's tracked and untracked files,
// minus ignored ones (and deleted ones); outside a repository, a walk that
// skips node_modules, .git, dist and out. Relative to `root`, cached for a
// moment (several calls come together).
const LIST_TTL = 1500;
const MAX_FILES = 20_000;
const listed = new Map<string, { at: number; files: string[] }>();

export function listFiles(root: string): string[] {
  const hit = listed.get(root);
  if (hit && Date.now() - hit.at < LIST_TTL) return hit.files;
  let files: string[];
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], { maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).toString();
    files = out.split("\0").filter((f) => f && existsSync(path.join(root, f)));
  } catch {
    files = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
        if (files.length >= MAX_FILES) return;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!/^(node_modules|\.git|dist|out)$/.test(entry.name)) walk(rel);
        } else if (entry.isFile()) files.push(rel);
      }
    };
    try {
      walk("");
    } catch {
      // Unreadable: what was found so far.
    }
  }
  files = [...new Set(files)].slice(0, MAX_FILES);
  listed.set(root, { at: Date.now(), files });
  return files;
}
