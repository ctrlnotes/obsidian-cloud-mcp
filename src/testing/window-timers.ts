/**
 * A `window` for the Node test run, holding only what the shipped code reaches on it.
 *
 * **The code calls `window.setTimeout`, not the bare global** — Obsidian's review lint
 * (`obsidianmd/prefer-window-timers`) requires it, because a popout window has its own
 * timer queue. Node has no `window`, so without this every timer the plugin sets would
 * throw in a test.
 *
 * **Forwarded at call time, never captured.** `vi.useFakeTimers()` replaces
 * `globalThis.setTimeout` after this module has loaded; a copy taken here would keep the
 * REAL timer, and every fake-timer test would silently stop controlling the code it tests.
 */
export const timerWindow = {
  setTimeout: (...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
  clearTimeout: (id: Parameters<typeof clearTimeout>[0]) => globalThis.clearTimeout(id),
  setInterval: (...args: Parameters<typeof setInterval>) => globalThis.setInterval(...args),
  clearInterval: (id: Parameters<typeof clearInterval>[0]) => globalThis.clearInterval(id),
};

if (!("window" in globalThis)) {
  Object.defineProperty(globalThis, "window", {
    value: timerWindow,
    configurable: true,
    writable: true,
  });
}
