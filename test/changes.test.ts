import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GraphStore } from "../src/graph/store.js";
import { tsPlugin } from "../src/ingest/ts/index.js";
import { parseDiff } from "../src/query/git.js";
import { createService } from "../src/service/index.js";
import type { ChangesResult } from "../src/query/types.js";

describe("parseDiff", () => {
  it("reads hunks in new-file lines, with removed text, renames and deletions", () => {
    const files = parseDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -3 +3,2 @@ fn",
        "-old",
        "+new",
        "+more",
        "@@ -10,2 +11,0 @@",
        "-gone 1",
        "-gone 2",
        "diff --git a/old.ts b/new.ts",
        "similarity index 100%",
        "rename from old.ts",
        "rename to new.ts",
        "diff --git a/dead.ts b/dead.ts",
        "deleted file mode 100644",
        "--- a/dead.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-x",
      ].join("\n"),
    );
    expect(files[0]).toMatchObject({ file: "src/a.ts", status: "modified", added: 2, removed: 3, hunks: [{ start: 3, added: 2, removed: ["old"] }, { start: 11, added: 0, removed: ["gone 1", "gone 2"] }] });
    expect(files[1]).toMatchObject({ file: "new.ts", from: "old.ts", status: "renamed" });
    expect(files[2]).toMatchObject({ file: "dead.ts", status: "deleted", removed: 1 });
  });
});

describe("changes", () => {
  const project = mkdtempSync(path.join(os.tmpdir(), "lode-changes-"));
  afterAll(() => rmSync(project, { recursive: true, force: true }));
  cpSync("test/fixtures/ipc", project, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");

  it("maps changed lines to the symbols they're in, untracked files included", async () => {
    const util = path.join(project, "src/util.ts");
    const lines = readFileSync(util, "utf8").split("\n");
    const at = lines.findIndex((l) => /function \w+/.test(l));
    lines.splice(at + 1, 0, "  // changed inside");
    writeFileSync(util, lines.join("\n"));
    appendFileSync(path.join(project, "src/extra.ts"), "export const extra = 1;\n");
    const svc = createService(GraphStore.open(tsPlugin, project, { cacheDir: path.join(project, ".cache") }));
    const result = (await svc.call("changes", {})) as ChangesResult;
    expect(result.error).toBeUndefined();
    const changed = result.files.find((f) => f.file === "src/util.ts")!;
    expect(changed).toMatchObject({ status: "modified", added: 1, removed: 0, indexed: true });
    const name = /function (\w+)/.exec(lines[at])![1];
    expect(changed.symbols.map((s) => s.node.name)).toEqual([name]);
    expect(result.files.find((f) => f.file === "src/extra.ts")).toMatchObject({ status: "untracked", added: 1 });
  });

  it("explains a bad base or a folder that isn't a repository", async () => {
    const svc = createService(GraphStore.open(tsPlugin, project, { cacheDir: path.join(project, ".cache") }));
    expect(((await svc.call("changes", { base: "--output=x" })) as ChangesResult).error).toMatch(/not a ref/);
    expect(((await svc.call("changes", { base: "no-such-branch" })) as ChangesResult).error).toBeTruthy();
    const plain = mkdtempSync(path.join(os.tmpdir(), "lode-nogit-"));
    cpSync("test/fixtures/basic", plain, { recursive: true });
    const other = createService(GraphStore.open(tsPlugin, plain, { cacheDir: path.join(plain, ".cache") }));
    expect(((await other.call("changes", {})) as ChangesResult).error).toBe("not a git repository");
    rmSync(plain, { recursive: true, force: true });
  });
});

describe("text files and the change hierarchy", () => {
  const project = mkdtempSync(path.join(os.tmpdir(), "lode-text-"));
  afterAll(() => rmSync(project, { recursive: true, force: true }));
  cpSync("test/fixtures/ipc", project, { recursive: true });
  writeFileSync(path.join(project, "README.md"), "# Title\n\nIntro.\n\n## One\n\na\nb\nc\nd\n\n## Two\n\ne\n");
  writeFileSync(path.join(project, "logo.bin"), Buffer.from([0, 1, 2, 0]));
  const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  const svc = createService(GraphStore.open(tsPlugin, project, { cacheDir: path.join(project, ".cache") }));

  it("lists every project file, text ones marked, and reads them as text", async () => {
    const files = (await svc.call("files")) as { file: string; indexed?: boolean }[];
    expect(files).toContainEqual({ file: "README.md", indexed: false });
    expect(files.find((f) => f.file === "src/main.ts")?.indexed).toBe(true);
    const block = (await svc.call("block", { id: "README.md" })) as { lines: unknown[]; regions: { start: number; end: number }[]; node: { kind: string } };
    expect(block.lines).toHaveLength(14);
    expect(block.regions.map((r) => [r.start, r.end])).toEqual([[1, 14], [5, 10], [12, 14]]);
    expect(await svc.call("block", { id: "logo.bin" })).toBeNull();
    expect(await svc.call("block", { id: "../outside.md" })).toBeNull();
  });

  it("edits a text file like code", async () => {
    const result = await svc.call("editFile", { file: "README.md", edits: [{ start: 3, end: 3, expected: ["Intro."], lines: ["Intro, edited."] }] });
    expect(result).toMatchObject({ ok: true });
    expect(readFileSync(path.join(project, "README.md"), "utf8").split("\n")[2]).toBe("Intro, edited.");
  });

  it("nests changed methods under their class", async () => {
    writeFileSync(path.join(project, "src/shape.ts"), "export class Shape {\n  area() {\n    return 1;\n  }\n}\n");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "shape");
    writeFileSync(path.join(project, "src/shape.ts"), "export class Shape {\n  area() {\n    return 2;\n  }\n}\n");
    svc.refresh();
    const result = (await svc.call("changes", {})) as ChangesResult;
    const shape = result.files.find((f) => f.file === "src/shape.ts")!;
    expect(shape.symbols.map((s) => [s.node.name, s.parent?.split("#").pop() ?? null, s.added])).toEqual([
      ["Shape", null, 0],
      ["area", "Shape", 1],
    ]);
  });
});
