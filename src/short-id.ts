// How an opaque identifier is shown to a person: its first eight characters, in two groups
// of four, then an ellipsis when there is more.
//
// **An identifier, not identification.** A vault id is 32 hex characters and a device id is
// as long; nobody compares either by eye, and a full one mid-sentence pushed the words that
// actually matter off the line. Eight characters are enough to tell two of your own vaults
// apart and to match what the web app shows, which is all a person does with one. The full
// value is never needed in the UI: nothing a user types takes it.

/** `e000518f8653…` becomes `e000 518f…`. Shorter values are shown whole, still grouped. */
export function shortId(id: string): string {
  const head = id.slice(0, 8);
  const grouped = head.length > 4 ? `${head.slice(0, 4)} ${head.slice(4)}` : head;
  return id.length > 8 ? `${grouped}…` : grouped;
}
