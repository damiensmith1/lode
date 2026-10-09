import type { Envelope, Message } from "./types.js";

export function enrich(msg: Message): Envelope {
  return { msg, ts: Date.now() };
}

export class Bus {
  dispatch(env: Envelope): void {}
}

export function send(msg: Message, bus: Bus) {
  const env = enrich(msg);
  bus.dispatch(env);
}

declare const ipc: { on(channel: string, fn: (msg: Message) => void): void };
const CHANNEL = "message:send";

export function registerHandlers(bus: Bus) {
  ipc.on(CHANNEL, (msg) => {
    send(msg, bus);
  });
  setTimeout(() => bus.dispatch(enrich({ text: "tick" })), 10);
  [1, 2].map((n) => n * 2);
}
