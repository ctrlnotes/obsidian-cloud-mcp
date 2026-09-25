// A whole fake Obsidian `App`, for the tests that exercise the SHELL (`main.ts`) rather
// than one pure module underneath it. Adapted from glass-1's own `testing/fake-host.ts`:
// same reasoning (the shell is where a late defect actually lives — nothing reachable from
// a unit test of the module underneath), a much smaller surface, because this plugin has
// no manifest exchange, no attachment HTTP channel and no `obsidian://` redirect to fake.

import type { App, PluginManifest } from "obsidian";
import { vi } from "vitest";
import CtrlNotesPlugin from "../main.ts";
import { fakeDocument } from "./fake-obsidian.ts";
import { timerWindow } from "./window-timers.ts";

export const manifest = {
  id: "ctrl-notes-cloud-mcp",
  name: "Ctrl Notes Cloud MCP",
  version: "0.0.1",
} as PluginManifest;

/** The vault listeners the plugin registered, by event name — the plugin's entire
 * disk→wire boundary, so a case reaches it the same way Obsidian would rather than by
 * writing into private state directly. */
export const vaultListeners = new Map<string, ((...args: unknown[]) => void)[]>();

/** Fire one, as Obsidian's watcher would. `oldPath` is `rename`'s second argument. */
export const fireVaultEvent = (event: string, path: string, oldPath?: string): void => {
  for (const cb of vaultListeners.get(event) ?? []) cb({ path }, oldPath);
};

export interface FakeAppOptions {
  /** Secrets already present before the plugin ever loads — a device identity seeded from
   * an earlier session, most commonly. */
  readonly secrets?: Record<string, string>;
  /**
   * `saveLocalStorage` records already present before the plugin ever loads, **by key** —
   * a `SyncState` under `ctrlrouter:sync-state` (`state.ts`'s own shape:
   * `{vaultId, cursor, hashes}`), a `PairingState` under `ctrlrouter:pairing-intent`
   * (`pairing-intent.ts`). Lets a test simulate "this device already synced X", or "this
   * device started pairing and was then killed" — neither reachable through the plugin's
   * own public API.
   *
   * **Keyed, not a single slot.** An earlier revision of this fake ignored the key and held
   * one value for every caller, which made the two records above overwrite each other the
   * moment `main.ts` used both: a saved pairing intent silently ate this device's sync
   * ledger, and the fake reported a plugin that works.
   */
  readonly localStorage?: Readonly<Record<string, unknown>>;
  /**
   * Paths that are listed, exist and `stat` normally, but whose CONTENT reads reject.
   *
   * The filesystem failure a `null` return cannot express, and the one the sync path's
   * three readers each have to survive on their own: EACCES, EIO, and the check-then-use
   * race where ENOENT lands between `vaultFiles`'s `exists` and its `readBinary`. Every
   * other way a file can be unreadable in this fake resolves to "not there", which
   * `scanManifest` and `deriveChanges` have always handled; this is the one that throws.
   *
   * A path named here must also be in `files`, or nothing lists it.
   */
  readonly unreadable?: readonly string[];
}

/**
 * Reads held open until a test releases them: a path here makes `readBinary` wait on its
 * promise first. How a test puts a derive in flight across something else happening — the
 * idle close landing while this device is still reading what it is about to send.
 */
export const readGates = new Map<string, Promise<void>>();

/** A map value as bytes — a string is UTF-8 encoded, bytes are themselves. */
const bytesOf = (held: string | Uint8Array | undefined): Uint8Array =>
  typeof held === "string" || held === undefined ? new TextEncoder().encode(held ?? "") : held;

/**
 * An `App` with a real-enough vault: a path→content map behind the adapter, exactly the
 * shape `main.ts`'s `vaultFiles()` drives.
 *
 * **A value may be raw bytes as well as a string**, because the one thing a `string` map
 * cannot represent is the case the sync path's content gate exists for: a file whose bytes
 * are not UTF-8. Anything a test writes as a string is stored as one and encoded on the
 * way out, so every existing caller is unaffected.
 */
export const fakeApp = (
  files: Record<string, string | Uint8Array> = {},
  options: FakeAppOptions = {},
): App => {
  const local = new Map<string, unknown>(Object.entries(options.localStorage ?? {}));
  const secrets: Record<string, string> = { ...options.secrets };
  const unreadable = new Set(options.unreadable ?? []);
  vaultListeners.clear();
  removedPaths.length = 0;
  readGates.clear();
  fakeDocument.visibilityState = "visible";

  /**
   * What a real `DataAdapter` does when asked for content it cannot give: it REJECTS.
   *
   * **Not `undefined`, and not `""`.** A missing path used to reach `bytesOf(undefined)`,
   * which encodes the empty string — so this double answered "here is a file, and it is
   * empty" for a path that does not exist, which is the one answer that can turn a lost
   * file into an empty one written over every other device. Node's own `fs` throws ENOENT
   * here and so does Obsidian; a double that is gentler than the thing it stands in for
   * lets a caller pass a test it would fail in a vault.
   */
  const contentOf = (p: string): Uint8Array => {
    if (unreadable.has(p)) throw new Error(`EACCES: permission denied, open '${p}'`);
    if (!(p in files)) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
    return bytesOf(files[p]);
  };

  return {
    workspace: { onLayoutReady: (cb: () => void) => cb() },
    vault: {
      getName: () => "My Vault",
      on: (event: string, cb: (...args: unknown[]) => void) => {
        const held = vaultListeners.get(event) ?? [];
        held.push(cb);
        vaultListeners.set(event, held);
        return { off: () => {} };
      },
      getFiles: () => Object.keys(files).map((path) => ({ path })),
      adapter: {
        // `exists` and `stat` answer for an `unreadable` path exactly as they do for any
        // other: that is the point of it. The file IS there — this device just cannot read
        // its bytes right now.
        //
        // **Case-INSENSITIVE unless `sensitive` is true, because APFS and NTFS
        // are.** A double that answers case-sensitively for free cannot express
        // what `foo.md` → `Foo.md` does on the two platforms most Obsidian
        // users run: the device that performed the rename asks whether its own
        // source is still there, the host says yes because `Foo.md` resolves,
        // and the caller takes the branch that throws. `obsidian.d.ts`
        // documents the parameter as forcing a case-sensitivity check.
        exists: (p: string, sensitive?: boolean) =>
          Promise.resolve(
            sensitive === true
              ? p in files
              : Object.keys(files).some((k) => k.toLowerCase() === p.toLowerCase()),
          ),
        // Obsidian's own `read` is a NON-fatal decode of a file that EXISTS, which is why
        // nothing in the sync path uses it any more (`sync/safe-path.ts`'s
        // `decodesAsText`). Both halves are modelled: the lossy decode, so a test cannot
        // pass here by accident, and the rejection for a path that is not there, so the
        // two cases stay distinguishable (below-cap fix — this answered `""` for a missing
        // path, and `vaultFiles()` dropping `read` in the same change meant no suite could
        // see it).
        read: async (p: string) => new TextDecoder().decode(contentOf(p)),
        write: (p: string, c: string) => {
          files[p] = c;
          return Promise.resolve();
        },
        readBinary: async (p: string) => {
          await readGates.get(p);
          return contentOf(p).slice().buffer;
        },
        // **The raw bytes, not a decoding of them.** This stored
        // `new TextDecoder().decode(bytes)`, which is a lossy round trip in exactly the
        // place it must not be — a non-fatal decode strips a leading BOM and replaces a
        // bad sequence with U+FFFD — so the double could not represent a byte-exact
        // inbound write at all, and a test of one would have passed whatever the shell
        // did. `bytesOf` lets every existing caller keep writing strings.
        writeBinary: (p: string, bytes: ArrayBuffer) => {
          files[p] = new Uint8Array(bytes);
          return Promise.resolve();
        },
        stat: (p: string) =>
          Promise.resolve(p in files ? { type: "file", size: bytesOf(files[p]).byteLength } : null),
        mkdir: () => Promise.resolve(),
        // **Throws on a path that is not there, because Obsidian's does.** A
        // forgiving double cannot express the defect measured on 2026-09-22:
        // the vault echoes this device's own delete back, `trashLocal` raised
        // `ENOENT`, and the throw withheld the ack.
        trashLocal: (p: string) => {
          if (!(p in files)) {
            return Promise.reject(new Error(`ENOENT: no such file or directory, rename '${p}'`));
          }
          delete files[p];
          return Promise.resolve();
        },
        // The wrong call `main.ts`'s own comment names as load-bearing to never make — kept
        // observable (`removedPaths`), rather than merely absent, so a regression shows up
        // as a failed assertion instead of a silent behaviour change nothing exercises.
        remove: (p: string) => {
          removedPaths.push(p);
          delete files[p];
          return Promise.resolve();
        },
        // Same reasoning as `trashLocal` above: Obsidian refuses a rename
        // onto an existing path with "Destination file already exists!", and
        // refuses one whose source is gone. The old double silently did
        // nothing for both, which is why an echoed rename looked applied in
        // every test and failed on a real device.
        rename: (from: string, to: string) => {
          if (!(from in files)) {
            return Promise.reject(new Error(`ENOENT: no such file or directory, rename '${from}'`));
          }
          if (to in files) return Promise.reject(new Error("Destination file already exists!"));
          // Guarded above, so the fallback an earlier draft had here would
          // only ever have hidden a bug in this double.
          const held = files[from] as string | Uint8Array;
          delete files[from];
          files[to] = held;
          return Promise.resolve();
        },
      },
    },
    secretStorage: {
      getSecret: (id: string) => Promise.resolve(id in secrets ? secrets[id] : null),
      setSecret: (id: string, secret: string) => {
        secrets[id] = secret;
        return Promise.resolve();
      },
      listSecrets: () => Promise.resolve(Object.keys(secrets)),
    },
    loadLocalStorage: (key: string) => local.get(key) ?? null,
    // Obsidian removes the entry on `null`, which is what "there is nothing here" is —
    // `clearPairingState` relies on it, so the fake must model it rather than storing the
    // `null` and answering with it.
    saveLocalStorage: (key: string, v: unknown) => {
      if (v === null || v === undefined) local.delete(key);
      else local.set(key, v);
    },
  } as unknown as App;
};

/**
 * Every path `adapter.remove` was asked to permanently delete — should stay empty for the
 * life of every test. `apply.ts`'s own doc comment on `VaultFiles.trash` (and `main.ts`'s
 * own comment where it wires `trash`) both call `trashLocal`, never `remove`, load-bearing:
 * a delete this device should not have applied must stay recoverable by the user. Cleared
 * inside `fakeApp()`, the same lifetime as `vaultListeners`.
 */
export const removedPaths: string[] = [];

/** Every WebSocket the plugin opened, and the frames each one sent — a test drives one by
 * hand, the same shape `sync/socket.test.ts`'s own `FakeSocket` uses, just reachable
 * through `main.ts`'s own `createSocket` factory (`(url) => new WebSocket(url)`) instead
 * of injected directly. */
export class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = [];

  readonly sent: (string | Uint8Array)[] = [];
  closed = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: { readonly code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  /** Test-only: the server closes with `code`, as a real `CloseEvent` reports it. */
  closeWith(code: number): void {
    this.closed = true;
    this.onclose?.({ code });
  }

  /** Test-only: deliver a frame, as a real server response would. */
  emit(down: unknown): void {
    this.onmessage?.({ data: JSON.stringify(down) });
  }

  /** Every `Up` frame sent so far, decoded — every JSON-shaped send in these tests is one. */
  upFrames(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

/** Put the fake `WebSocket` in place of the real one, for the suites that load a plugin
 * already paired: `startSyncing` opens one immediately, and without this every such test
 * would dial a real socket. */
export const stubWebSocket = (): void => {
  FakeWebSocket.instances.length = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket);
};

/**
 * Every URL the plugin asked the SYSTEM browser to open, and a stub for the `window.open`
 * that reaches it (`pairing-intent.ts`'s `openInSystemBrowser`).
 *
 * This suite runs on Node, where there is no `window` at all — so without this a pairing
 * test does not merely fail to observe the browser step, it throws inside it. Mirrors
 * `stubWebSocket` above, for the same reason and with the same lifetime.
 */
export const openedUrls: string[] = [];

export const stubSystemBrowser = (): void => {
  openedUrls.length = 0;
  vi.stubGlobal("window", {
    // The timers go with it: the code calls `window.setTimeout`, and a stub holding only
    // `open` would make every timer in a pairing test throw (`testing/window-timers.ts`).
    ...timerWindow,
    open: (url: string) => {
      openedUrls.push(url);
      return null;
    },
  });
};

const loaded: CtrlNotesPlugin[] = [];

export interface LoadOptions {
  readonly controlplaneOrigin?: string;
  /** Where the system browser is sent for `/app/pair` — a separate host from the control
   * plane, and its own setting (design §7). */
  readonly webAppOrigin?: string;
  readonly vaultId?: string;
  readonly deviceId?: string | null;
  readonly appOptions?: FakeAppOptions;
  /**
   * Run against the constructed plugin BEFORE `onload`.
   *
   * `onload` is where a persisted pairing intent is resumed (the mobile cold-launch case
   * D13 exists for), so a test of that path has to replace the D19 confirmation seam before
   * `onload` runs rather than after it. Nothing else needs this hook.
   */
  readonly prepare?: (plugin: CtrlNotesPlugin) => void;
}

/** Start a plugin and let its `onload` (and, if already paired, its load-time reconnect)
 * finish. */
export const load = async (
  files: Record<string, string | Uint8Array> = {},
  options: LoadOptions = {},
): Promise<CtrlNotesPlugin> => {
  const plugin = new CtrlNotesPlugin(fakeApp(files, options.appOptions), manifest);
  await plugin.saveData({
    controlplaneOrigin: options.controlplaneOrigin ?? "",
    webAppOrigin: options.webAppOrigin ?? "",
    vaultId: options.vaultId ?? "",
    deviceId: options.deviceId ?? null,
  });
  options.prepare?.(plugin);
  await plugin.onload();
  loaded.push(plugin);
  await plugin.ready;
  // The socket's URL is minted asynchronously — it carries a signed routing
  // proof (O6) — so `ready` resolves a real ed25519 signature BEFORE the
  // transport exists. Without this, a test that reaches for
  // `FakeWebSocket.instances[0]` right after loading finds nothing.
  await settleMicrotasks();
  return plugin;
};

/** Unload everything `load` started. Call from `afterEach` — without it a settler armed by
 * one case fires during a later one and surfaces as noise attributed to the wrong test. */
export const unloadAll = (): void => {
  while (loaded.length > 0) loaded.pop()?.unload();
};

/**
 * Let pending work resolve — including a REAL device-identity signature.
 *
 * **A pure microtask loop (`await Promise.resolve()`) is not enough here**, and this was
 * measured rather than assumed: `DeviceIdentity.signChallenge` calls `@noble/ed25519`'s
 * `signAsync`, which hashes with `crypto.subtle.digest`. Node's WebCrypto completes that
 * through the libuv thread pool, whose callback only runs once the event loop actually
 * turns — a microtask-only spin never yields to it, so a case awaiting one never observed
 * the `hello` frame `answerChallenge` had already queued to send. A real (if short) macro-
 * task wait does. Callers driving a test under `vi.useFakeTimers()` must call this BEFORE
 * enabling them — real timers are exactly what this needs, and fake ones is the thing that
 * was missing them in the first place.
 *
 * **Before a POSITIVE assertion, wait for the condition instead** (`vi.waitFor`; `UNTIL` in
 * `main.test.ts`). A fixed wait is a guess about machine load: under load the work lands
 * after it, and that is how `main.test.ts` failed a third of runs until 2026-09-22. What
 * this is still right for is the quiet window before a NEGATIVE assertion.
 */
export const settleMicrotasks = async (ms = 30): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};
