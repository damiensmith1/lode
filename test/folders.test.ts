import { describe, expect, it } from "vitest";
import { folderLabel, inFolder, splitFolder } from "../views/folders.js";

// A canvas's cards from another folder: ids under the folder's label.
describe("folders on a canvas", () => {
  it("labels a folder by its name, unique", () => {
    expect(folderLabel("/repo/.claude/worktrees/fix-login/", new Set())).toBe("fix-login");
    expect(folderLabel("/a/api", new Set(["api", "api-2"]))).toBe("api-3");
  });

  it("splits a label off an id only when it's a known folder's", () => {
    const known = (l: string) => l === "api";
    expect(splitFolder("api//src/a.ts#run", known)).toEqual({ label: "api", id: "src/a.ts#run" });
    expect(splitFolder("web//src/a.ts", known)).toEqual({ label: null, id: "web//src/a.ts" });
    expect(splitFolder("app/models/user.rb#User::Admin", known)).toEqual({ label: null, id: "app/models/user.rb#User::Admin" });
  });

  it("puts a result's node ids, files and changed files under the label", () => {
    const block = { node: { id: "src/a.ts#run", name: "run", file: "src/a.ts" }, lines: [{ n: 1, text: "x" }], links: [{ line: 1, target: { id: "src/b.ts#go", name: "go", file: "src/b.ts" } }] };
    const out = inFolder(block, "api");
    expect(out.node).toEqual({ id: "api//src/a.ts#run", name: "run", file: "api//src/a.ts" });
    expect(out.links[0].target.id).toBe("api//src/b.ts#go");
    expect(out.lines).toEqual([{ n: 1, text: "x" }]);
    expect(block.node.id).toBe("src/a.ts#run"); // a copy
    expect(inFolder({ files: [{ file: "src/a.ts", hunks: [], symbols: [] }] }, "api").files[0].file).toBe("api//src/a.ts");
  });
});
