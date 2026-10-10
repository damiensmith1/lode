import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GraphStore } from "../src/graph/store.js";
import { tsPlugin } from "../src/ingest/ts/index.js";
import { createService, serveMessages } from "../src/service/index.js";
import { MessageConnection } from "../views/connection.js";
import { memoryStorage, serviceStorage } from "../views/storage.js";
import type { CodeBlock } from "../src/query/types.js";

const cacheDir = mkdtempSync(path.join(os.tmpdir(), "lode-embed-"));
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));
const service = createService(GraphStore.open(tsPlugin, "test/fixtures/ipc", { cacheDir }));

// Two ends of a message channel, as a webview and its extension would have.
function channel() {
  const handlers = { view: new Set<(m: unknown) => void>(), host: new Set<(m: unknown) => void>() };
  const end = (me: "view" | "host", other: "view" | "host") => ({
    send: (m: unknown) => queueMicrotask(() => handlers[other].forEach((h) => h(structuredClone(m)))),
    listen: (h: (m: unknown) => void) => (handlers[me].add(h), () => void handlers[me].delete(h)),
  });
  return { view: end("view", "host"), host: end("host", "view") };
}

describe("embedding without a server", () => {
  it("a view's connection reaches the service over messages", async () => {
    const { view, host } = channel();
    const stop = serveMessages(service, host);
    const connection = new MessageConnection(view);
    const block = await connection.call<CodeBlock>("block", { id: "src/main.ts#saveNote" });
    expect(block.node.name).toBe("saveNote");
    await expect(connection.call("nope")).rejects.toThrow("unknown method nope");
    stop();
  });

  it("ignores a host's other messages", async () => {
    const { view, host } = channel();
    const stop = serveMessages(service, host);
    const connection = new MessageConnection(view);
    view.send({ type: "something else", id: 1 });
    expect(await connection.call("info")).toMatchObject({ files: expect.any(Number) });
    stop();
  });

  it("state: saved per key with the project, null removes", async () => {
    const storage = serviceStorage({ call: (m, p) => service.call(m, p) as never, onChanged: () => () => {} });
    await storage.save("flow-a", { cards: [1] });
    await storage.save("flow-b", { cards: [2] });
    expect(await storage.load("flow-a")).toEqual({ cards: [1] });
    expect(await storage.load("flow-b")).toEqual({ cards: [2] });
    await storage.save("flow-a", null);
    expect(await storage.load("flow-a")).toBeNull();
    await expect(service.call("saveState", { key: "../escape", data: 1 })).rejects.toThrow("bad state key");
  });

  it("memory storage keeps copies", () => {
    const storage = memoryStorage();
    const value = { a: 1 };
    storage.save("k", value);
    value.a = 2;
    expect(storage.load("k")).toEqual({ a: 1 });
    storage.save("k", null);
    expect(storage.load("k")).toBeNull();
  });
});
