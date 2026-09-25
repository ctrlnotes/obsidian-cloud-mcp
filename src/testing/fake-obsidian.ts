// A behavioural fake of the slice of Obsidian's API this plugin actually uses, aliased in
// for `obsidian` at test time (`vitest.config.ts`) — the real `obsidian` package is
// types-only and importing it at runtime throws.
//
// **Adapted from glass-1's `testing/fake-obsidian.ts`, not ported whole.** That file also
// carried a `FakeWebSocket` with subprotocol capture, which does not apply here:
// `SyncSocket` (Task 9) drives the `WebSocket` global directly rather than through anything
// `obsidian` exports, so its own tests fake that global themselves.
//
// It also carried `obsidian://` protocol-handler recording, which this file dropped on the
// stated grounds that "this design has no deep-link pairing". That was true of the sync
// slice and is not true of device pairing: the browser returns to Obsidian by deep link
// (D4), so the recording is back below. What the callback may carry — nothing (D15) — is
// `../protocol.ts`'s subject; what the fake owes is only a way to deliver one.
//
// **A named gap, same as glass-1's:** this fake ships with no contract test run against a
// real Obsidian, because the real `obsidian` npm package is types-only and Obsidian's API
// exists only inside Obsidian. It is checked by the type checker (every member `main.ts`
// or `settings-tab.ts` actually calls is typed against the real `obsidian.d.ts`) and by
// manual acceptance, and by nothing else.

/** Obsidian's `Component`: things registered during load are torn down on unload. */
export class Component {
  readonly #cleanups: Array<() => void> = [];

  register(cb: () => void): void {
    this.#cleanups.push(cb);
  }

  load(): void {
    this.onload();
  }

  unload(): void {
    while (this.#cleanups.length > 0) this.#cleanups.pop()?.();
    this.onunload();
  }

  onload(): void {}
  onunload(): void {}
}

/**
 * Every `obsidian://` action the loaded plugins have claimed, by action string.
 *
 * A test delivers a callback by calling the recorded handler: "what does the plugin do when
 * this URI arrives" is the whole behaviour, and it is unreachable without a way to deliver
 * one. Cleared by each suite that uses it, because a handler left behind by an earlier test
 * answers for a plugin that has already been torn down.
 */
export const protocolHandlers = new Map<string, (params: Record<string, string>) => unknown>();

export class Plugin extends Component {
  #data: unknown = null;

  constructor(
    readonly app: unknown,
    readonly manifest: unknown,
  ) {
    super();
  }

  /** `data.json` inside the vault, held in memory here. */
  loadData(): Promise<unknown> {
    return Promise.resolve(this.#data);
  }

  saveData(data: unknown): Promise<void> {
    this.#data = data;
    return Promise.resolve();
  }

  /** Obsidian's host computes a tab's definitions when it is registered: `update()`. */
  addSettingTab(tab: { update?: () => void }): void {
    tab.update?.();
  }

  /** Obsidian hands back an `EventRef` and unregisters it on unload; the fake registers
   * the same teardown so a listener never outlives the plugin that owns it. */
  registerEvent(ref: unknown): void {
    const off = (ref as { off?: () => void }).off;
    if (off !== undefined) this.register(() => off());
  }

  /**
   * Obsidian's `obsidian://<action>` dispatch.
   *
   * Registered WITH a teardown, for the reason `registerEvent` gives: a callback delivered
   * after `onunload` would nudge from a closure holding a plugin that no longer exists,
   * and on a real host that is the reload window nobody tests by hand.
   */
  registerObsidianProtocolHandler(
    action: string,
    handler: (params: Record<string, string>) => unknown,
  ): void {
    protocolHandlers.set(action, handler);
    this.register(() => protocolHandlers.delete(action));
  }

  /** A command in the palette. Recorded in `commands` until unload, so a test can run one the
   * way a user picking it does. */
  addCommand(command: FakeCommand): FakeCommand {
    commands.push(command);
    this.register(() => {
      const at = commands.indexOf(command);
      if (at >= 0) commands.splice(at, 1);
    });
    return command;
  }

  /**
   * Obsidian's `registerDomEvent`: the listener is removed on unload. Recorded by event type
   * in `domListeners` rather than attached to anything — the suite has no DOM — and a test
   * fires one with `fireDomEvent`. The element is not kept: nothing here listens for the
   * same type on two elements.
   */
  registerDomEvent(_el: unknown, type: string, callback: () => unknown): void {
    const held = domListeners.get(type) ?? [];
    held.push(callback);
    domListeners.set(type, held);
    this.register(() => {
      const now = domListeners.get(type) ?? [];
      domListeners.set(
        type,
        now.filter((cb) => cb !== callback),
      );
    });
  }

  /** Obsidian's `registerInterval`: cleared on unload. The id is a real one from
   * `window.setInterval`, so fake timers drive it like any other. */
  registerInterval(id: number): number {
    this.register(() => window.clearInterval(id));
    return id;
  }
}

export interface FakeCommand {
  readonly id: string;
  readonly name: string;
  readonly callback?: () => unknown;
}

/** Every command a loaded plugin has added, in order. */
export const commands: FakeCommand[] = [];

/** Every live `registerDomEvent` listener, by event type. */
export const domListeners = new Map<string, Array<() => unknown>>();

/** Fire a DOM event at every listener registered for its type, as the browser would. */
export const fireDomEvent = (type: string): void => {
  for (const cb of domListeners.get(type) ?? []) cb();
};

/**
 * Obsidian's `activeDocument` global, holding the one member the plugin reads. A test sets
 * `visibilityState` to put Obsidian in the background; `fake-host.ts`'s `fakeApp` resets it.
 */
export const fakeDocument: { visibilityState: "visible" | "hidden" } = {
  visibilityState: "visible",
};

if (!("activeDocument" in globalThis)) {
  Object.defineProperty(globalThis, "activeDocument", {
    value: fakeDocument,
    configurable: true,
    writable: true,
  });
}

/**
 * The slice of Obsidian's DOM extensions a modal actually touches.
 *
 * The suite runs on Node with no DOM, so this records rather than renders: `texts` is every
 * string that reached the user through this element, which is what a test asking "was the
 * user told what they were consenting to" needs. The real members are typed against
 * `obsidian.d.ts`'s own `HTMLElement` augmentation, so a call this fake does not model is a
 * typecheck failure at the call site rather than a silent no-op here.
 */
export interface FakeEl {
  readonly texts: string[];
  setText(text: string): void;
  empty(): void;
  createEl(tag: string, o?: { text?: string; cls?: string } | string): FakeEl;
}

const fakeEl = (): FakeEl => {
  const texts: string[] = [];
  const el: FakeEl = {
    texts,
    setText: (text) => {
      texts.push(text);
    },
    empty: () => {
      texts.length = 0;
    },
    createEl: (_tag, o) => {
      const text = typeof o === "string" ? o : o?.text;
      if (text !== undefined) texts.push(text);
      return el;
    },
  };
  return el;
};

/**
 * Every modal currently open, oldest first. A test dismisses one (`close()`) the way Escape,
 * the X and a click outside all do on a real host — which is the path a consent modal must
 * treat as a refusal, and the one nobody tests by hand.
 */
export const openModals: Modal[] = [];

export class Modal {
  readonly titleEl = fakeEl();
  readonly contentEl = fakeEl();
  opened = false;

  constructor(readonly app: unknown) {}

  open(): void {
    this.opened = true;
    openModals.push(this);
    void this.onOpen();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    const at = openModals.indexOf(this);
    if (at >= 0) openModals.splice(at, 1);
    this.onClose();
  }

  onOpen(): Promise<void> | void {}
  onClose(): void {}
}

/** Obsidian's host-detection flags. Always "desktop" unless a test overrides it. */
export const Platform = {
  isMobile: false,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
};

/**
 * Every toast raised, oldest first. What a Notice says is user-facing behaviour on the
 * pairing and sync paths, and a test is entitled to hold it to account.
 */
export const notices: Notice[] = [];

export class Notice {
  hidden = false;

  constructor(
    readonly message: string | DocumentFragment,
    readonly duration?: number,
  ) {
    notices.push(this);
  }

  hide(): void {
    this.hidden = true;
  }
}

export const noticeText = (n: Notice): string =>
  typeof n.message === "string" ? n.message : (n.message.textContent ?? "");

/**
 * The slice of Obsidian 1.13's declarative settings definitions this fake renders — the
 * shapes `settings-tab.ts` returns from `getSettingDefinitions()`.
 */
interface FakeSettingDefinition {
  name: string;
  desc?: string;
  visible?: boolean | (() => boolean);
  control?: { type: "text"; key: string; placeholder?: string };
  render?: (setting: Setting, group: unknown) => void | (() => void);
}

/**
 * Obsidian's settings pane host, as of 1.13: a subclass returns DEFINITIONS and the host
 * renders them. Nothing here drives real layout — the suite runs on Node with no DOM — so
 * the fake renders each visible definition into `settingRows`, `fakeTextComponents` and
 * `buttons`, exactly the surfaces the imperative `Setting` below already fills.
 *
 * **Modelled on Obsidian 1.13.7's own host code, not invented**: `update()` is the ONLY
 * thing that re-reads the definitions (and redraws a pane that is open); registering the
 * tab calls it once, and `display()` draws whatever the last `update()` cached — so a
 * description computed from a value the user has since changed stays stale until
 * something calls `update()`. A `control` reads through
 * `getControlValue` and writes through `setControlValue`, a `render` callback may return a
 * cleanup that runs before its row is torn down, and `visible` is evaluated on each
 * render. `display()` is the host's own render here — a subclass no longer overrides it
 * (it is deprecated since 1.13), and the tests still call it the way Obsidian does when
 * the pane opens.
 */
export class PluginSettingTab {
  readonly containerEl = { empty: () => {}, isConnected: false };
  settingItems: unknown[] = [];
  #cleanups: Array<() => void> = [];

  constructor(
    readonly app: unknown,
    readonly plugin: unknown,
  ) {}

  getSettingDefinitions(): unknown[] {
    return [];
  }

  getControlValue(_key: string): unknown {
    return undefined;
  }

  setControlValue(_key: string, _value: unknown): void | Promise<void> {}

  update(): void {
    this.settingItems = this.getSettingDefinitions();
    if (this.containerEl.isConnected) this.display();
  }

  display(): void {
    this.#teardown();
    for (const item of this.settingItems as FakeSettingDefinition[]) this.#render(item);
  }

  hide(): void {
    this.#teardown();
  }

  #render(def: FakeSettingDefinition): void {
    const visible = typeof def.visible === "function" ? def.visible() : (def.visible ?? true);
    if (!visible) return;
    const setting = new Setting(this.containerEl).setName(def.name);
    if (def.desc !== undefined) setting.setDesc(def.desc);
    const control = def.control;
    if (control !== undefined) {
      setting.addText((text) =>
        text
          .setPlaceholder(control.placeholder ?? "")
          .setValue(String(this.getControlValue(control.key) ?? ""))
          .onChange((value) => this.setControlValue(control.key, value)),
      );
    }
    const cleanup = def.render?.(setting, undefined);
    if (typeof cleanup === "function") this.#cleanups.push(cleanup);
  }

  #teardown(): void {
    for (const cleanup of this.#cleanups.splice(0)) cleanup();
  }
}

/** Every button drawn into a settings pane, by its label, so a test can press one. */
export const buttons: Array<{ text: string; click: () => unknown }> = [];

class FakeTextComponent {
  #value = "";
  #onChange: ((v: string) => unknown) | null = null;

  get value(): string {
    return this.#value;
  }

  setPlaceholder(_value: string): this {
    return this;
  }

  setValue(value: string): this {
    this.#value = value;
    return this;
  }

  onChange(cb: (value: string) => unknown): this {
    this.#onChange = cb;
    return this;
  }

  /** Test-only: type into this field, as the real DOM input's change handler would. */
  type(value: string): void {
    this.#value = value;
    this.#onChange?.(value);
  }
}

/** Every `FakeTextComponent` drawn, in order, so a test can `.type()` into one. */
export const fakeTextComponents: FakeTextComponent[] = [];

class FakeButtonComponent {
  #text = "";
  #disabled = false;

  setButtonText(text: string): this {
    this.#text = text;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.#disabled = disabled;
    return this;
  }

  onClick(cb: () => unknown): this {
    buttons.push({
      text: this.#text,
      click: () => {
        if (!this.#disabled) return cb();
      },
    });
    return this;
  }
}

/**
 * Every settings row drawn, in order, with the words that reached the user.
 *
 * The suite runs on Node with no DOM, so a row's NAME and DESCRIPTION were previously
 * dropped on the floor — which meant the settings tab's copy was the one user-facing
 * surface in this plugin that no test could see. That is not acceptable for a pane whose
 * whole job is telling a user what "Disconnect this device" does and does not do (design
 * §6.3): the copy IS the deliverable there, not decoration around a button. Same reasoning
 * as `FakeEl.texts`, one surface over. Clear it in `afterEach`.
 */
export const settingRows: Array<{ name: string; desc: string }> = [];

/** Every word any settings row put in front of the user, joined — what a copy assertion
 * actually wants to search. */
export const settingsText = (): string => settingRows.map((r) => `${r.name} ${r.desc}`).join("\n");

export class Setting {
  readonly #row: { name: string; desc: string } = { name: "", desc: "" };

  constructor(readonly containerEl: unknown) {
    settingRows.push(this.#row);
  }

  setName(name: string): this {
    this.#row.name = name;
    return this;
  }

  setDesc(desc: string): this {
    this.#row.desc = desc;
    return this;
  }

  addText(cb: (text: FakeTextComponent) => unknown): this {
    const text = new FakeTextComponent();
    fakeTextComponents.push(text);
    cb(text);
    return this;
  }

  addButton(cb: (button: FakeButtonComponent) => unknown): this {
    cb(new FakeButtonComponent());
    return this;
  }
}

/**
 * Obsidian's HTTP client (`controlplane-http.ts`'s whole transport). A queue a test fills:
 * each call
 * shifts the next scripted response, and an empty queue REJECTS rather than returning a
 * default — a request nobody scripted is a test that does not know what it is asserting.
 */
export interface FakeResponse {
  readonly status: number;
  readonly json: unknown;
}

export const requestUrlQueue: FakeResponse[] = [];
export const requestUrlCalls: Array<{ url: string; method?: string; body?: string }> = [];
/** How many of the next requests never settle: a half-open connection, which `requestUrl`
 * (no abort) waits on for a very long time. */
export const requestUrlHangs = { next: 0 };
/**
 * How many of the next requests wait for the test to answer them, and the answers owed, in
 * order. An answer that lands at a moment the test chooses — after an unload, say — which
 * the queue above cannot express: it answers on the spot.
 */
export const requestUrlHeld: { next: number; readonly answers: Array<(r: FakeResponse) => void> } =
  { next: 0, answers: [] };

export const requestUrl = (options: {
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  throw?: boolean;
}): Promise<{ status: number; json: unknown; text: string }> => {
  requestUrlCalls.push({ url: options.url, method: options.method, body: options.body });
  if (requestUrlHangs.next > 0) {
    requestUrlHangs.next -= 1;
    return new Promise(() => {});
  }
  if (requestUrlHeld.next > 0) {
    requestUrlHeld.next -= 1;
    return new Promise((resolve) => {
      requestUrlHeld.answers.push((r) =>
        resolve({ status: r.status, json: r.json, text: JSON.stringify(r.json) }),
      );
    });
  }
  const next = requestUrlQueue.shift();
  if (next === undefined) {
    return Promise.reject(new Error(`unscripted request to ${options.url}`));
  }
  return Promise.resolve({ status: next.status, json: next.json, text: JSON.stringify(next.json) });
};

/** A tab as Obsidian holds it once a plugin has called `addSettingTab`: definitions read. */
export const registerTab = <T extends { update(): void }>(tab: T): T => {
  tab.update();
  return tab;
};
