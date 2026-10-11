import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RubyPack } from "../ruby/index.js";

// Sinatra (and the classic style): `get "/users/:id" do … end` is a route:
// the block a callable named by its verb and path, an entry; before/after
// filters likewise. Works at the top level and in a Sinatra::Base subclass.

const VERB = /^(get|post|put|patch|delete|options|head|link|unlink)$/;

export const sinatraPack: RubyPack = {
  name: "sinatra",

  detect(project) {
    const gemfile = ["Gemfile", "Gemfile.lock"].map((f) => read(project.root, f)).join("\n");
    if (/\bsinatra\b/.test(gemfile)) return true;
    return project.facts.some((f) => f.requires.some((r) => /^sinatra(\/base)?$/.test(r)));
  },

  prepare(project) {
    for (const f of project.facts) {
      for (const call of f.calls) {
        if (call.recv.kind !== "none" || !call.block || call.inBlock) continue;
        const from = project.decls.get(call.from);
        if (!from || (from.kind !== "file" && from.kind !== "class")) continue;
        if (from.kind === "class" && !project.inherits(from.path, /(^|::)Sinatra::(Base|Application)$|^(Base|Application)$/)) continue;
        const first = call.args?.[0];
        if (VERB.test(call.name) && (first?.t === "str" || first?.t === "other")) {
          const route = first.t === "str" ? first.v : first.v.replace(/^%r\{|\}$|^\/|\/$/g, "");
          const key = `${call.name.toUpperCase()} ${route}`;
          project.promote(call, f.file, key, { registration: { call: call.name.toUpperCase(), key: route, category: "routes" } });
        } else if (/^(before|after)$/.test(call.name)) {
          project.promote(call, f.file, `${call.name}${first?.t === "str" ? ` ${first.v}` : ""}`, { registration: { call: call.name, key: first?.t === "str" ? first.v : null, category: "routes" } });
        }
      }
    }
  },

  link(project) {
    for (const [id, r] of project.registrations) if (r.category === "routes") project.tag(project.decls.get(id)!.file, "web");
  },
};

function read(root: string, file: string): string {
  const full = path.join(root, file);
  try {
    return existsSync(full) ? readFileSync(full, "utf8") : "";
  } catch {
    return "";
  }
}
