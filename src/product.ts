// The product's name, in one place.
//
// Its own module because `sync/status.ts` needs it for the status bar's label, and
// `settings-tab.ts`, where it used to live, imports `sync/status.ts`. Left there, the status
// line would have imported the settings pane to spell one word. `settings-tab.ts` re-exports
// it, so every existing import keeps working.
//
// **The UI says "Ctrl Notes", not the manifest's name.** `manifest.json`'s `name` and `id`
// are what the community directory lists and are deliberately unchanged here (a directory
// decision is pending); copy a user reads names the product.

/**
 * The product's name, for UI text that names it. **Interpolated, not written into the
 * literal**: `obsidianmd/ui/sentence-case` does not know it is a brand and wants "ctrl
 * notes" in a plain string, which is why four notices said "ctrlrouter" until 2026-09-24.
 * The rule checks only a plain string or a template with no expressions, so a message
 * that interpolates this is not case-checked at all — the brand is not exempted, the
 * whole string is. We assume the directory's scan runs with its own configuration rather
 * than this repository's, so a `brands` option here would not reach it (unverified).
 */
export const PRODUCT_NAME = "Ctrl Notes";
