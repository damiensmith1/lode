// The app's explain panel: a conversation beside the flow about what's on
// it. It's the app's, not lode's: lode explains (the service's `explain`,
// streaming text and CanvasActions) and the flow gives the pieces (scope,
// apply, highlight); how an answer is shown is up to the host. This is one
// way, built only on lode's public API, the way any host would.
//
//   const panel = new ExplainPanel(element, client, storage);
//   panel.attach(flow, "flow-1"); // the flow it talks about, and where its chat is kept
import { codeNames, lodeApi, renderMarkdown, type CanvasAction, type LodeConnection, type LodeFlow, type LodeStorage } from "../../views/index.js";

type Model = { id: string; label: string; group?: string };

// What was asked, and what came back (with what the model read and the
// cards it added).
interface ChatEntry {
  role: "user" | "assistant";
  text: string;
  scope?: string; // a question: what it was about ("2 selected cards")
  notes?: { text: string; added?: boolean; ids?: string[] }[]; // searched, read, added cards (added), acted on cards (ids)
  links?: Record<string, string>; // names in the answer that are real symbols: name → id
  model?: string; // which model answered (its label)
  error?: string;
  stopped?: boolean;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export class ExplainPanel {
  private flow: LodeFlow | null = null;
  private key = ""; // where the current flow's chat is kept
  private chat: ChatEntry[] = [];
  private explaining = false;
  private stream = "";
  private shown = new Map<ChatEntry, number>(); // answers being written out: how much shows so far
  private models: Model[] = [];
  private defaultModel: string | undefined;
  private readonly log: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly select: HTMLSelectElement;
  private readonly api: ReturnType<typeof lodeApi>;

  constructor(
    private readonly el: HTMLElement,
    private readonly client: LodeConnection,
    private readonly storage: LodeStorage,
  ) {
    this.api = lodeApi(client);
    el.innerHTML = `
      <div class="explain-resize" title="Drag to resize"></div>
      <div class="explain-head"><span class="explain-title">Explain</span><span class="explain-about"></span><button class="icon" data-action="new" title="New conversation">new</button><button class="icon" data-action="close" title="Close (i)">×</button></div>
      <div class="explain-log"></div>
      <div class="composer">
        <div class="suggest"></div>
        <div class="box"><textarea class="explain-input" rows="1" placeholder="Ask about these cards, or to show more…"></textarea><select class="model" title="Which model answers"></select><button class="send" data-action="send" title="Send (Enter)">↑</button></div>
        <div class="composer-hint">Enter to send · Shift+Enter for a new line · select cards to ask about just those</div>
      </div>`;
    this.log = el.querySelector(".explain-log")!;
    this.input = el.querySelector(".explain-input")!;
    this.select = el.querySelector(".model")!;
    el.addEventListener("click", (e) => this.onClick(e));
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendFromInput();
      } else if (e.key === "Escape") this.input.blur();
    });
    this.input.addEventListener("input", () => this.fitInput());
    // Names in answers light up their cards on hover.
    this.log.addEventListener("mouseover", (e) => this.flow?.highlight((e.target as Element).closest<HTMLElement>("code.sym")?.dataset.id ?? null));
    this.log.addEventListener("mouseleave", () => this.flow?.highlight(null));
    this.setupResize();
    void this.loadModels();
  }

  get open() {
    return !this.el.hidden;
  }

  // Open (focusing the input) or close the panel.
  toggle(open = !this.open) {
    this.el.hidden = !open;
    if (open) {
      this.render();
      this.input.focus();
    }
  }

  // Talk about this flow from now on; its conversation is kept under `key`.
  async attach(flow: LodeFlow | null, key: string) {
    if (flow === this.flow) return;
    if (this.explaining) this.stop();
    this.flow = flow;
    this.key = `${key}-explain`;
    this.chat = [];
    this.render();
    const saved = (await Promise.resolve(this.storage.load(this.key)).catch(() => null)) as ChatEntry[] | null;
    if (this.flow === flow && Array.isArray(saved)) this.chat = saved;
    this.render();
  }

  // The selection or the canvas changed: the header and suggestions follow.
  refresh() {
    if (this.open) this.renderChrome();
  }

  // Ask `text` about the flow (or its selection; with `selection`, even a
  // single selected card). Streams in; what the model does to the canvas
  // happens as it does it, and undoes in one step.
  async send(text: string, selection = false) {
    const flow = this.flow;
    if (!flow || this.explaining || !text.trim()) return;
    this.toggle(true);
    const { label, request } = flow.scope(selection);
    const model = this.model();
    const request_ = {
      ...request,
      messages: [...this.chat.filter((m) => m.text && !m.error).map((m) => ({ role: m.role, text: m.text })), { role: "user" as const, text }],
      ...(model && { model }),
    };
    this.chat.push({ role: "user", text, ...(request.canvas.cards.length && { scope: label }) });
    const chosen = this.models.find((m) => m.id === model);
    const grouped = new Set(this.models.map((m) => m.group ?? "")).size > 1;
    const by = chosen && (grouped && chosen.group ? `${chosen.label} · ${chosen.group}` : chosen.label);
    const answer: ChatEntry = { role: "assistant", text: "", notes: [], ...(by && { model: by }) };
    this.chat.push(answer);
    this.explaining = true;
    const stream = (this.stream = Math.random().toString(36).slice(2));
    const undoGroup = `explain-${stream}`;
    this.render(true);
    // Write the answer out as it arrives: real streaming passes straight
    // through; a block that arrives all at once types out over a second.
    this.shown.set(answer, 0);
    let frame = 0;
    let rate = 4;
    const redraw = () => {
      if (frame) return;
      const tick = () => {
        const have = answer.text.length;
        const at = this.shown.get(answer) ?? have;
        rate = Math.max(rate, Math.ceil((have - at) / 48));
        if (at < have) this.shown.set(answer, Math.min(have, at + rate));
        this.renderLog();
        frame = (this.shown.get(answer) ?? have) < answer.text.length ? requestAnimationFrame(tick) : 0;
      };
      frame = requestAnimationFrame(tick);
    };
    const revealed = () =>
      new Promise<void>((done) => {
        const wait = () => ((this.shown.get(answer) ?? Infinity) >= answer.text.length || answer.stopped ? done() : requestAnimationFrame(wait));
        wait();
      });
    let acting = Promise.resolve();
    const stopListening = this.client.onEvent?.((name, payload) => {
      const p = payload as { stream: string; event: { type: string; text?: string; summary?: string; action?: CanvasAction } };
      if (name !== "explain" || p.stream !== stream || answer.stopped) return;
      const e = p.event;
      if (e.type === "text") answer.text += e.text ?? "";
      else if (e.type === "tool") answer.notes!.push({ text: (e.summary ?? "").replace(/`/g, "") });
      else if (e.type === "action" && e.action) {
        answer.notes!.push(actionNote(e.action, e.summary ?? e.action.kind));
        acting = flow.apply(e.action, { undoGroup });
      }
      redraw();
    });
    try {
      const result = await this.api.explain(request_, stream);
      if (!answer.stopped) answer.text = result.text || answer.text;
      // Without streaming, the actions arrive with the answer.
      if (!stopListening && !answer.stopped) {
        for (const a of result.actions ?? []) answer.notes!.push(actionNote(a, a.kind));
        acting = flow.apply(result.actions ?? [], { undoGroup });
      }
      redraw();
      await Promise.all([this.linkAnswer(answer, flow), revealed(), acting]);
    } catch (error) {
      if (!answer.stopped) answer.error = error instanceof Error ? error.message : String(error);
    } finally {
      stopListening?.();
      this.shown.delete(answer);
      this.explaining = false;
      this.render();
      this.save();
    }
  }

  private onClick(e: Event) {
    const el = (e.target as Element).closest<HTMLElement>("[data-action], code.sym");
    if (!el) return;
    if (el.matches("code.sym") && el.dataset.id) return void this.flow?.show(el.dataset.id);
    const action = el.dataset.action;
    if (action === "close") return this.toggle(false);
    if (action === "new") return this.newChat();
    if (action === "send") return this.explaining ? this.stop() : this.sendFromInput();
    if (action === "suggest" && el.dataset.text) return void this.send(el.dataset.text, el.dataset.selection === "1");
    if (action === "copy" && el.dataset.i) return void navigator.clipboard?.writeText(this.chat[Number(el.dataset.i)]?.text ?? "");
    if (action === "focus" && el.dataset.ids) return void this.flow?.apply({ kind: "focus", cards: el.dataset.ids.split(" ") });
  }

  private newChat() {
    if (this.explaining) this.stop();
    this.chat = [];
    this.render();
    this.save();
  }

  // Stop the answer being written: the server stops asking the model; what
  // came so far stays.
  private stop() {
    const answer = this.chat[this.chat.length - 1];
    if (!this.explaining || answer?.role !== "assistant") return;
    answer.stopped = true;
    this.shown.delete(answer);
    void this.api.explainCancel(this.stream).catch(() => {});
    this.explaining = false;
    this.render();
  }

  private save() {
    if (this.key) void Promise.resolve(this.storage.save(this.key, this.chat.length ? this.chat : null)).catch(() => {});
  }

  private sendFromInput() {
    const text = this.input.value.trim();
    if (!text || this.explaining) return;
    this.input.value = "";
    this.fitInput();
    void this.send(text);
  }

  private fitInput() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(160, this.input.scrollHeight)}px`;
  }

  // Which names in an answer are real symbols (asked once it's written);
  // only those become links. Symbols in the canvas's files win.
  private async linkAnswer(answer: ChatEntry, flow: LodeFlow) {
    const names = codeNames(answer.text);
    if (!names.length) return;
    const prefer = [...new Set(flow.cards().map((c) => c.node.file).filter(Boolean))];
    answer.links = await this.api.resolve(names, prefer as string[]).catch(() => ({}));
  }

  // While an answer streams (or for older ones without links): names of
  // cards on the canvas.
  private linkFor(entry: ChatEntry) {
    const cards = this.flow?.cards() ?? [];
    return (name: string) => {
      if (entry.links) return entry.links[name];
      const bare = name.replace(/\(\)$/, "").replace(/^this\./, "");
      return cards.find((c) => c.node.name === bare || c.key.endsWith(`#${bare}`))?.key;
    };
  }

  // --- models: the server's providers, the one chosen remembered per browser ---

  private async loadModels() {
    const info = await this.api.explainModels().catch(() => null);
    this.models = (info?.providers ?? []).flatMap((p) => p.models.map((m) => ({ ...m, group: p.label })));
    this.defaultModel = info?.default;
    const groups = [...new Set(this.models.map((m) => m.group ?? ""))];
    const option = (m: Model) => `<option value="${escape(m.id)}">${escape(m.label)}</option>`;
    this.select.hidden = this.models.length < 2;
    this.select.innerHTML =
      groups.length > 1
        ? groups.map((g) => `<optgroup label="${escape(g || "Other")}">${this.models.filter((m) => (m.group ?? "") === g).map(option).join("")}</optgroup>`).join("")
        : this.models.map(option).join("");
    if (this.defaultModel && this.models.some((m) => m.id === this.defaultModel)) this.select.value = this.defaultModel;
    try {
      const saved = localStorage.getItem("lode:explain-model");
      if (saved && this.models.some((m) => m.id === saved)) this.select.value = saved;
    } catch {
      // No storage: the default.
    }
    this.select.addEventListener("change", () => {
      try {
        localStorage.setItem("lode:explain-model", this.select.value);
      } catch {
        // Not remembered.
      }
    });
  }

  private model(): string | undefined {
    if (!this.models.length) return undefined;
    return this.models.some((m) => m.id === this.select.value) ? this.select.value : this.models[0].id;
  }

  // Drag the panel's left edge to resize it (remembered in this browser).
  private setupResize() {
    try {
      const w = Number(localStorage.getItem("lode:explain-width"));
      if (w >= 320) this.el.style.setProperty("--explain-width", `${w}px`);
    } catch {
      // The default width.
    }
    const grip = this.el.querySelector<HTMLElement>(".explain-resize")!;
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      grip.classList.add("dragging");
      const startX = e.clientX;
      const startW = this.el.offsetWidth;
      const move = (m: PointerEvent) => this.el.style.setProperty("--explain-width", `${Math.max(320, Math.min(900, startW + startX - m.clientX))}px`);
      const up = () => {
        grip.classList.remove("dragging");
        grip.removeEventListener("pointermove", move);
        try {
          localStorage.setItem("lode:explain-width", String(this.el.offsetWidth));
        } catch {
          // Not remembered.
        }
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up, { once: true });
    });
  }

  // --- drawing ---------------------------------------------------------------------

  private render(scroll = false) {
    if (!this.open) return;
    this.renderChrome();
    this.renderLog(scroll);
  }

  // The header and composer follow the selection.
  private renderChrome() {
    const flow = this.flow;
    const cards = flow?.cards() ?? [];
    const { label, focus } = flow?.scope() ?? { label: "", focus: [] };
    this.el.querySelector(".explain-about")!.innerHTML = cards.length ? `about <b>${escape(label)}</b>` : "nothing on the canvas yet";
    const send = this.el.querySelector<HTMLButtonElement>(".send")!;
    send.classList.toggle("stop", this.explaining);
    send.textContent = this.explaining ? "■" : "↑";
    send.title = this.explaining ? "Stop" : "Send (Enter)";
    // Suggestions for where the conversation is.
    const selected = flow?.selection() ?? [];
    const last = this.chat[this.chat.length - 1];
    const one = selected.length === 1 ? selected[0].node.name : undefined;
    const ideas: { text: string; label: string; selection?: boolean }[] = [];
    if (!this.explaining && cards.length) {
      if (focus.length) ideas.push({ text: "Explain these cards and how they connect.", label: `Explain the ${focus.length} selected`, selection: true });
      else if (one) ideas.push({ text: `Explain \`${one}\`.`, label: `Explain ${one}`, selection: true });
      if (!this.chat.length) {
        ideas.push({ text: "Explain this flow: what it does and how the pieces fit together.", label: "Explain this flow" });
        ideas.push({ text: "What could break here, and why?", label: "What could break?" });
        ideas.push({ text: "Show more of this flow: add the cards that matter next.", label: "Show more of the flow" });
      } else if (last?.role === "assistant") {
        ideas.push({ text: "Go deeper on that.", label: "Go deeper" });
        ideas.push({ text: "Show more of this flow: add the cards that matter next.", label: "Show more" });
        ideas.push({ text: "What could break here, and why?", label: "What could break?" });
      }
    }
    this.el.querySelector(".suggest")!.innerHTML = ideas
      .slice(0, 4)
      .map((i) => `<button data-action="suggest" data-text="${escape(i.text)}"${i.selection ? ' data-selection="1"' : ""}>${escape(i.label)}</button>`)
      .join("");
  }

  private renderLog(scroll = false) {
    const log = this.log;
    const atBottom = scroll || log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    if (!this.chat.length) {
      log.innerHTML = `<div class="explain-empty"><b>Ask about what's on the canvas</b>What it does, why it's built this way, what could break. Ask to show more and the cards appear. Select cards first to ask about just those.</div>`;
      return;
    }
    const turns: string[] = [];
    for (let i = 0; i < this.chat.length; i++) {
      const m = this.chat[i];
      if (m.role === "user") {
        turns.push(`<div class="turn"><div class="q">${escape(m.text)}${m.scope ? ` <span class="scope">· ${escape(m.scope)}</span>` : ""}</div>`);
        continue;
      }
      const live = this.explaining && i === this.chat.length - 1;
      const text = this.shown.has(m) ? m.text.slice(0, this.shown.get(m)) : m.text;
      const added = (m.notes ?? []).flatMap((n) => (n.added && n.ids) || []);
      const steps = [
        ...(m.notes ?? []).map((n) =>
          n.added
            ? `<span class="step added" data-action="focus" data-ids="${escape((n.ids ?? []).join(" "))}" title="${escape((n.ids ?? []).map(prettyName).join(", "))}">＋ ${escape(n.text)}</span>`
            : n.ids?.length
              ? `<span class="step acted" data-action="focus" data-ids="${escape(n.ids.join(" "))}">↳ ${escape(n.text)}</span>`
              : n.ids
                ? `<span class="step acted">↳ ${escape(n.text)}</span>`
                : `<span class="step">${escape(n.text)}</span>`,
        ),
        ...(live && !text ? ['<span class="step thinking">thinking <i></i><i></i><i></i></span>'] : []),
      ];
      const foot = !live && text ? `<div class="a-foot">${m.model ? `<span class="by">${escape(m.model)}</span>` : ""}<button data-action="copy" data-i="${i}">copy</button>${added.length ? `<button data-action="focus" data-ids="${escape(added.join(" "))}">show the ${added.length} added</button>` : ""}</div>` : "";
      turns.push(
        `<div class="a">${steps.length ? `<div class="steps">${steps.join("")}</div>` : ""}${renderMarkdown(text, this.linkFor(m))}${m.stopped ? '<p class="stopped">stopped</p>' : ""}${m.error ? `<p class="error">${escape(m.error)}</p>` : ""}${foot}</div></div>`,
      );
    }
    log.innerHTML = turns.join("");
    if (atBottom || this.explaining) log.scrollTop = log.scrollHeight;
  }
}

// How the model's action shows in its answer: cards it added (＋, click to
// see them), cards it acted on (↳, click to see them), or what it did.
function actionNote(a: CanvasAction, summary: string): { text: string; added?: boolean; ids: string[] } {
  if (a.kind === "add") return { text: summary, added: true, ids: a.ids };
  if (a.kind === "plan") return { text: summary, added: true, ids: a.plan.cards.map((c) => c.id) };
  const ids = a.kind === "expand" || a.kind === "fold" ? [a.card] : a.kind === "select" || a.kind === "focus" ? a.cards : [];
  return { text: summary, ids };
}

// A symbol id as a person reads it: "src/a.ts#Cls.method" → "Cls.method";
// a callback "start.addEventListener:click" → "addEventListener:click in start".
function prettyName(id: string): string {
  const name = id.replace(/@\d+-\d+$/, "").replace(/^.*#/, "");
  const dot = name.indexOf(".");
  return dot > 0 && /[:@]/.test(name) ? `${name.slice(dot + 1)} in ${name.slice(0, dot)}` : name;
}
