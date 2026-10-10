import type { LodeConnection } from "./connection.js";

// Where views keep their state (a flow's cards, arrows, camera, selection),
// under a key per view instance, so each tab restores its own. A host
// passes one in LodeHost.storage: its own (VS Code workspaceState, Clance's
// store, a database) or one of these. Values are plain JSON; saving null
// removes the key.
export interface LodeStorage {
  load(key: string): unknown | Promise<unknown>;
  save(key: string, value: unknown): void | Promise<void>;
}

// With the project, in lode's cache directory, through the connection. The
// default: it survives restarts and follows the project, whatever shows it.
export function serviceStorage(connection: LodeConnection): LodeStorage {
  return {
    load: (key) => connection.call("loadState", { key }).catch(() => null),
    save: (key, value) => connection.call("saveState", { key, data: value }).then(() => undefined),
  };
}

// In this browser's localStorage, under `prefix` (one per project, say).
export function localStorageStorage(prefix = "lode:"): LodeStorage {
  return {
    load: (key) => {
      try {
        const text = localStorage.getItem(prefix + key);
        return text === null ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save: (key, value) => {
      try {
        if (value === null || value === undefined) localStorage.removeItem(prefix + key);
        else localStorage.setItem(prefix + key, JSON.stringify(value));
      } catch {
        // Full or blocked: the state just isn't kept.
      }
    },
  };
}

// In memory only: kept while the page lives (or for as long as the host
// holds the object), shared by every view given it.
export function memoryStorage(initial: Record<string, unknown> = {}): LodeStorage & { readonly data: Map<string, unknown> } {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
  return {
    data,
    load: (key) => (data.has(key) ? structuredClone(data.get(key)) : null),
    save: (key, value) => void (value === null || value === undefined ? data.delete(key) : data.set(key, structuredClone(value))),
  };
}
