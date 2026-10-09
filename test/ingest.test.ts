import { describe, expect, it } from "vitest";
import { ingestTsProject } from "../src/ingest/ts/ingest.js";

describe("ingestTsProject", () => {
  const facts = ingestTsProject("test/fixtures/basic/tsconfig.json");

  it("records declarations with stable ids and containers", () => {
    const ids = facts.decls.map((d) => d.id);
    expect(ids).toContain("src/types.ts#Envelope");
    expect(ids).toContain("src/pipeline.ts#Bus.dispatch");
    expect(facts.decls.find((d) => d.id === "src/pipeline.ts#Bus.dispatch")?.containerId).toBe("src/pipeline.ts#Bus");
  });

  it("resolves calls across declarations with argument and return types", () => {
    const fromSend = facts.calls.filter((c) => c.callerId === "src/pipeline.ts#send");
    expect(fromSend).toContainEqual(
      expect.objectContaining({ calleeId: "src/pipeline.ts#enrich", argTypes: ["Message"], returnType: "Envelope" }),
    );
    expect(fromSend).toContainEqual(
      expect.objectContaining({ calleeId: "src/pipeline.ts#Bus.dispatch", argTypes: ["Envelope"], returnType: "void" }),
    );
  });

  it("marks calls into libraries as external", () => {
    const now = facts.calls.find((c) => c.calleeText === "Date.now");
    expect(now?.calleeId).toBe("ext:lib#DateConstructor.now");
    expect(now?.callerId).toBe("src/pipeline.ts#enrich");
  });
});

describe("registered callbacks", () => {
  const facts = ingestTsProject("test/fixtures/basic/tsconfig.json");
  const handler = "src/pipeline.ts#registerHandlers.on:message:send";

  it("become nodes named after their channel, resolved through consts", () => {
    expect(facts.decls.find((d) => d.id === handler)?.registration).toEqual({ call: "on", key: "message:send" });
  });

  it("own the calls made inside them", () => {
    expect(facts.calls).toContainEqual(expect.objectContaining({ callerId: handler, calleeId: "src/pipeline.ts#send" }));
    expect(facts.calls.some((c) => c.callerId === "src/pipeline.ts#registerHandlers" && c.calleeId === "src/pipeline.ts#send")).toBe(false);
  });

  it("are named by line when there's no key", () => {
    expect(facts.decls.map((d) => d.id)).toContain("src/pipeline.ts#registerHandlers.setTimeout@L23");
  });

  it("leave ordinary callbacks like map alone", () => {
    expect(facts.decls.some((d) => d.name.startsWith("map"))).toBe(false);
  });
});
