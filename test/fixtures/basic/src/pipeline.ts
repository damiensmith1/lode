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

export function withLocals(cb: () => void) {
  const fmt = (s: string) => s.trim();
  fmt(" x ");
  cb();
}

export function prepare(msg: Message): Envelope {
  return enrich(msg);
}

export const relay = (msg: Message, bus: Bus) => bus.dispatch(enrich(msg));

export async function load(): Promise<Message> {
  return { text: "loaded" };
}

export async function fromStorage(bus: Bus) {
  const { text } = await load();
  bus.dispatch({ msg: { text }, ts: 0 });
  [1].map((n) => enrich({ text: String(n) }));
}

export function makeBus(): Bus {
  return new Bus();
}

export function viaReceiver(msg: Message) {
  const bus = makeBus();
  bus.dispatch(prepare(msg));
}
