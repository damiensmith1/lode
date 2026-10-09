import type { Message } from "./types.js";

let current: Message | null = null;
const cache = new Map<string, Message>();

export function setCurrent(m: Message) {
  current = m;
  cache.set(m.text, m);
}

export function getCurrent(): Message | null {
  return current;
}

export function lookup(key: string) {
  return cache.get(key);
}

export class Counter {
  count = 0;
  inc() {
    this.count++;
  }
  read() {
    return this.count;
  }
}

function register(fn: (m: Message) => void) {}

export function wire() {
  register(setCurrent);
}
