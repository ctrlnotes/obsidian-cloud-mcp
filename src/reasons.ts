// What a failure's `reason` means, in words — for a Notice.
//
// Every failure in this plugin is a value carrying a `reason` (`controlplane-http.ts`'s
// posture), and a few of those are this plugin's own codes: `origin_not_configured`,
// `transport_failed` and the rest below. Until 2026-09-25 each Notice pasted the reason in
// brackets — "Could not start pairing with Ctrl Notes (transport_failed)" — which told a
// user nothing they could act on and read as a crash.
//
// **Known codes get a sentence; anything else gets a generic one**, and the raw reason goes
// to `console.warn`, where a bug report can quote it. The unknown case is most often the
// control plane's own RFC 7807 `detail`, which is written for an operator ("no such pairing
// intent") rather than for the person holding the phone.

const KNOWN: Readonly<Record<string, string>> = {
  origin_not_configured:
    "Set the control plane and web app addresses under Advanced in the settings first.",
  transport_failed: "The service could not be reached. Check your connection and try again.",
  timeout: "The service took too long to answer. Try again in a moment.",
  browser_failed: "Your browser could not be opened. Use Open browser again in the settings.",
  unexpected_response: "The service sent an answer this version does not understand.",
};

/** A sentence for `reason`, or `null` when it is not one of this plugin's own codes. */
export const knownReason = (reason: string): string | null => KNOWN[reason] ?? null;

/**
 * `lead` (a full sentence, ending with a period) followed by what `reason` means. An unknown
 * reason is logged under `context` rather than shown.
 */
export function failureMessage(lead: string, reason: string, context: string): string {
  const known = knownReason(reason);
  if (known !== null) return `${lead} ${known}`;
  console.warn(`Ctrl Notes: ${context}: ${reason}`);
  return `${lead} Try again in a moment.`;
}

/** `text` as a sentence: a free-text reason from the vault may or may not end with one. */
export const asSentence = (text: string): string => (/[.!?…]$/.test(text) ? text : `${text}.`);
