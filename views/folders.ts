// A canvas can hold code from more than one folder (a project and its
// worktree, a frontend repo and its API): each extra folder has its own
// lode (a connection the host gives, LodeHost.folder), and its cards' ids
// are its node ids under a label, "label//id" ("api//src/server.ts#start"),
// so they never collide with the canvas's own and the rest of the view
// treats them like any other id. Labels never contain "/", and real ids
// never start "something//", so a prefix is unambiguous.

export const FOLDER_SEP = "//";

// A folder's label: its last path segment, made unique.
export function folderLabel(path: string, taken: Set<string>): string {
  const base = (path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "folder").replace(/[^\w.-]+/g, "-");
  let label = base;
  for (let n = 2; taken.has(label); n++) label = `${base}-${n}`;
  return label;
}

// The label and the folder's own id, for an id from an extra folder (null:
// the canvas's own folder).
export function splitFolder(id: string, known: (label: string) => boolean): { label: string | null; id: string } {
  const at = id.indexOf(FOLDER_SEP);
  if (at > 0) {
    const label = id.slice(0, at);
    if (!label.includes("/") && known(label)) return { label, id: id.slice(at + FOLDER_SEP.length) };
  }
  return { label: null, id };
}

// A service result from a folder, with its ids and files under the label:
// node refs (anything with an id and a name) and file changes (a file with
// hunks). Everything else is copied as is.
export function inFolder<T>(value: T, label: string): T {
  const pre = (s: string) => `${label}${FOLDER_SEP}${s}`;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x);
    if (typeof o.id === "string" && typeof o.name === "string") {
      o.id = pre(o.id);
      if (typeof o.file === "string") o.file = pre(o.file);
    } else if (typeof o.file === "string" && Array.isArray(o.hunks)) o.file = pre(o.file);
    return o;
  };
  return walk(value) as T;
}
