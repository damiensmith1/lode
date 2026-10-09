import type { TsFacts } from "./facts.js";

// Framework knowledge for the runtime lens: which process a file runs in.
// A file is seeded by the APIs it calls; a file with no seed of its own runs
// wherever the files importing it run. Used from more than one runtime: "shared".
const SEEDS: { runtime: string; callee: RegExp }[] = [
  {
    runtime: "main",
    callee: /^ext:electron#(App|BrowserWindow|IpcMain|Tray|Menu|MenuItem|GlobalShortcut|Dialog|Protocol|Session|SystemPreferences|PowerMonitor|NativeTheme|AutoUpdater|UtilityProcess|WebContents|Notification|Screen)\b/,
  },
  { runtime: "preload", callee: /^ext:electron#(ContextBridge|IpcRenderer|WebFrame)\b/ },
  { runtime: "renderer", callee: /^ext:lib#(Document|Window|HTMLElement|Element|EventTarget|Node)\./ },
];

export function runtimesOf(facts: TsFacts): Map<string, string> {
  const seeds = new Map<string, Set<string>>();
  for (const call of facts.calls) {
    const seed = call.calleeId && SEEDS.find((s) => s.callee.test(call.calleeId!));
    if (seed) add(seeds, call.loc.file, seed.runtime);
  }
  // Calling into the preload bridge (window.api.x()) only happens in renderers.
  for (const e of facts.channels) if (e.family === "electron-bridge" && e.role === "send") add(seeds, e.loc.file, "renderer");

  // Push each seed down the import graph.
  const runtimes = new Map<string, Set<string>>();
  for (const [file, own] of seeds) {
    for (const runtime of own) {
      const stack = [file];
      const visited = new Set<string>();
      while (stack.length) {
        const current = stack.pop()!;
        if (visited.has(current)) continue;
        visited.add(current);
        add(runtimes, current, runtime);
        stack.push(...(facts.imports[current] ?? []));
      }
    }
  }

  const result = new Map<string, string>();
  for (const [file, set] of runtimes) result.set(file, set.size === 1 ? [...set][0] : "shared");
  return result;
}

function add(map: Map<string, Set<string>>, key: string, value: string) {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}
