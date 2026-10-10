// How views reach lode: call a method, hear when the project re-indexed.
// The WebSocket client (./client.ts) is one connection; MessageConnection
// is another, for hosts that pass messages (a VS Code webview, an Electron
// preload, an iframe) to a lode service running on their Node side.
export interface LodeConnection {
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  // Called after the project re-indexes; returns an unsubscribe function.
  onChanged(listener: (files: string[]) => void): () => void;
  // Events the server pushes while a call runs (an explanation streaming
  // in). Optional: without it, answers arrive whole.
  onEvent?(listener: (name: string, payload: unknown) => void): () => void;
}

// The message protocol both ends speak (see serveMessages in src/service):
//   view → service   { lode: 1, id, method, params }
//   service → view   { lode: 1, id, result } | { lode: 1, id, error }
//                    { lode: 1, method: "changed", params: { files } }
// The `lode` tag keeps them apart from a host's other messages.
export interface LodeMessagePort {
  send(message: unknown): void;
  // Subscribe to incoming messages; returns an unsubscribe function.
  listen(handler: (message: unknown) => void): () => void;
}

export class MessageConnection implements LodeConnection {
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly changeListeners = new Set<(files: string[]) => void>();
  private readonly eventListeners = new Set<(name: string, payload: unknown) => void>();
  private nextId = 1;
  readonly close: () => void;

  constructor(private readonly port: LodeMessagePort) {
    this.close = port.listen((raw) => {
      const message = raw as { lode?: unknown; id?: number; method?: string; params?: { files: string[] }; result?: unknown; error?: string };
      if (!message || typeof message !== "object" || message.lode !== 1) return;
      if (message.method === "changed") {
        for (const listener of this.changeListeners) listener(message.params?.files ?? []);
        return;
      }
      if (message.method === "event") {
        const p = message.params as unknown as { name: string; payload: unknown };
        for (const listener of this.eventListeners) listener(p.name, p.payload);
        return;
      }
      if (message.method !== undefined) return; // a request (ours, echoed on a shared channel)
      const waiting = message.id === undefined ? undefined : this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id!);
      if (message.error !== undefined) waiting.reject(new Error(message.error));
      else waiting.resolve(message.result);
    });
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.send({ lode: 1, id, method, params });
    });
  }

  onChanged(listener: (files: string[]) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onEvent(listener: (name: string, payload: unknown) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
}
