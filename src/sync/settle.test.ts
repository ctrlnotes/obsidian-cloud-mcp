import { afterEach, describe, expect, it, vi } from "vitest";
import { CEILING_MS, QUIET_MS, Settler } from "./settle.ts";

// Not a trailing `vi.useRealTimers()` per test: a failing assertion skips the rest of the
// body, and faked timers then leak into every test after it — including other files.
afterEach(() => {
  vi.useRealTimers();
});

describe("Settler", () => {
  it("fires once the vault goes quiet", () => {
    vi.useFakeTimers();
    const fired: number[] = [];
    const s = new Settler(() => fired.push(1));
    s.touch();
    vi.advanceTimersByTime(QUIET_MS - 1);
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(fired).toHaveLength(1);
  });

  it("restarts the quiet window on each event", () => {
    vi.useFakeTimers();
    const fired: number[] = [];
    const s = new Settler(() => fired.push(1));
    for (let i = 0; i < 5; i++) {
      s.touch();
      vi.advanceTimersByTime(QUIET_MS - 10);
    }
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(QUIET_MS);
    expect(fired).toHaveLength(1);
  });

  it("fires anyway once the ceiling elapses, however busy the vault is", () => {
    // §6a: a continuously-active vault must still sync. Without the ceiling, typing
    // steadily in one note defers the push forever.
    vi.useFakeTimers();
    const fired: number[] = [];
    const s = new Settler(() => fired.push(1));
    for (let elapsed = 0; elapsed < CEILING_MS + QUIET_MS; elapsed += QUIET_MS - 10) {
      s.touch();
      vi.advanceTimersByTime(QUIET_MS - 10);
    }
    // Exactly one firing, and it can only have come from the ceiling: the loop touches
    // every QUIET_MS - 10, so the quiet window never once elapses. Asserting
    // `>= 1` would have passed even if the debounce had fired instead.
    expect(fired).toHaveLength(1);
  });

  it("does not fire when nothing was touched", () => {
    vi.useFakeTimers();
    const fired: number[] = [];
    new Settler(() => fired.push(1));
    vi.advanceTimersByTime(CEILING_MS * 2);
    expect(fired).toHaveLength(0);
  });

  it("stops firing after cancel, so unload leaves no timer behind", () => {
    vi.useFakeTimers();
    const fired: number[] = [];
    const s = new Settler(() => fired.push(1));
    s.touch();
    s.cancel();
    vi.advanceTimersByTime(CEILING_MS * 2);
    expect(fired).toHaveLength(0);
  });

  it("starts a fresh window after firing", () => {
    vi.useFakeTimers();
    const fired: number[] = [];
    const s = new Settler(() => fired.push(1));
    s.touch();
    vi.advanceTimersByTime(QUIET_MS);
    s.touch();
    vi.advanceTimersByTime(QUIET_MS);
    expect(fired).toHaveLength(2);
  });
});
