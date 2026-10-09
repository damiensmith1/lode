import { makeNote } from "./util.mjs";

export function save(text) {
  const note = makeNote(text);
  persist(note);
}

function persist(note) {}
