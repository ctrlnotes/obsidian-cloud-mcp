/**
 * "The vault has gone quiet" — inferred, because Obsidian will not tell us (§6a).
 *
 * There is no "Obsidian Sync finished" signal. What we have is a burst of vault events
 * during startup sync that then stops, so quiet is the proxy: no events for `QUIET_MS`.
 *
 * The ceiling is not a refinement, it is the other half. A vault being typed in
 * continuously never goes quiet, and a pure debounce would defer its push forever.
 *
 * **This is a heuristic, and nothing that loses data may depend on it.** §6a is explicit:
 * a deletion is believed only when it was OBSERVED as a delete event. This class decides
 * *when* to send, never *what*.
 */
export const QUIET_MS = 2_000;
export const CEILING_MS = 30_000;

export class Settler {
  // `private`, not `#`. The plugin compiles to `target: es2018`, which downlevels a real
  // private field into a `WeakMap` plus accessor helpers — runtime weight in a bundle that
  // ships to mobile and is re-scanned every release. `private` is erased entirely.
  private quiet: number | null = null;
  private ceiling: number | null = null;

  constructor(private readonly onSettled: () => void) {}

  /** A vault event happened. */
  touch(): void {
    if (this.quiet !== null) window.clearTimeout(this.quiet);
    this.quiet = window.setTimeout(() => this.fire(), QUIET_MS);
    // Started on the FIRST touch of a window and never restarted, so a busy vault is
    // bounded by the ceiling rather than pushed forward by every keystroke.
    this.ceiling ??= window.setTimeout(() => this.fire(), CEILING_MS);
  }

  /** Drop any pending window. Called on unload so no timer outlives the plugin. */
  cancel(): void {
    if (this.quiet !== null) window.clearTimeout(this.quiet);
    if (this.ceiling !== null) window.clearTimeout(this.ceiling);
    this.quiet = null;
    this.ceiling = null;
  }

  private fire(): void {
    this.cancel();
    this.onSettled();
  }
}
