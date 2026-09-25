// What an `obsidian://` callback means to this plugin: **nothing it can act on** (design
// §5.2, decisions D4 and D15).
//
//   browser  --obsidian://ctrlnotes/paired?vault=<obsidian vault name>-->  this plugin
//
// The browser sends one of these after a signed-in human has bound a pairing to the intent
// this device registered It is the smoother experience on mobile, which is why
// D4 keeps it — but it is a *hint that the browser step finished*, and nothing more.
//
// **Nothing in a claimable channel is a credential.** `obsidian://` is a namespace any
// installed application can register for, on every platform Obsidian ships. Drafts one to
// three each put something in this URL — a device code, then a nonce, then a nonce and a
// key hash — and each was complete authority to register a device, held by whichever app
// won the scheme. The design's answer is not to make the channel safer, because it cannot
// be: it is to put nothing in it. What arrives is the Obsidian vault name, which §5.2 needs
// so that Obsidian's own desktop dispatch can pick the right window, and which a stranger
// reading the URL learns nothing from.
//
// **The result is retrieved elsewhere, by proving possession of the device key** —
// `pairing-intent.ts`'s `retrieveWhenBound`, which runs whether or not a callback ever
// arrives (D15). That is what makes this file's emptiness affordable: a lost, late, or
// hijacked callback costs time and nothing else. It follows that a callback can never be
// *required* either, and no arm here may become the only way a pairing completes.
//
// **So the whole module decides one thing: nudge, or do nothing.** It reads one parameter,
// carries no credential, makes no network call and touches no state.
//
// **This is informed by an earlier prototype's `protocol.ts`, not a port of it.** The shape is the same
// — a pure decision function over the parameter bag, with registration left to `main.ts` —
// but the arms are not the same arms. An earlier prototype's `wrong-vault` is about Obsidian having
// switched to a vault that does not hold the link id in the URI, and it is a real refusal
// of a real request. Here there is no request: `ignore` is housekeeping over a message that
// grants nothing either way. Reading the two as equivalent is how a "check" that defends
// nothing gets counted as a defence.

/**
 * The `obsidian://` actions this plugin claims for the pairing callback.
 *
 * **There are two because which one Obsidian dispatches is not knowable from here, and
 * guessing wrong makes the deep link silently dead.** Design §5.2 pins the URL as
 * `obsidian://ctrlnotes/paired?vault=…`, which has a host (`ctrlnotes`) and a path
 * (`/paired`). Obsidian's `registerObsidianProtocolHandler` documents the action only
 * through single-segment examples — "'open' corresponds to `obsidian://open`"
 * (`obsidian.d.ts` 1.13.1) — and says nothing about a path, and the dispatch itself lives
 * inside a closed-source application that no test in this repository can run.
 *
 * Claiming both readings costs one line and removes the guess: exactly one of them ever
 * matches a given dispatch, so a callback is delivered once under either implementation.
 * The cost of the broader one is that `obsidian://ctrlnotes/<anything>` also reaches us if
 * Obsidian keys on the host alone — which is harmless precisely because of what this module
 * does with a callback, and would not be if it did anything more.
 *
 * **A named gap, the same one `testing/fake-obsidian.ts` declares**: which of the two is
 * live is settled by manual acceptance on each platform and by nothing else.
 */
export const PAIRED_ACTIONS: readonly string[] = ["ctrlnotes/paired", "ctrlnotes"];

/**
 * What a caller may do about a callback.
 *
 * **`nudge` is permission to poll sooner and nothing else.** It is not evidence that a
 * pairing exists, that it names this user's vault, or that anyone consented to it — the
 * callback is unauthenticated and anyone can send one. A caller that persists, redeems or
 * uploads on a nudge has moved the pairing decision into a channel a stranger can write to,
 * which is the failure D15 exists to prevent. The answer to "is there a result yet" comes
 * from `retrieveWhenBound`, and the answer to "may we adopt it" comes from D19's local
 * confirmation.
 */
export type ProtocolAction = "nudge" | "ignore";

/** The whole outcome of handling a callback. Deliberately two fields, neither of which can
 * carry a value out of the URL. */
export interface ProtocolOutcome {
  readonly action: ProtocolAction;
  /**
   * Every parameter `handleProtocol` actually read, in first-read order, recorded rather
   * than declared.
   *
   * **This exists so that D15 is a test that can fail.** A comment saying "we only read
   * `vault`" is worth nothing the day someone adds an arm, and a hand-written list beside
   * the code is the same comment with quotes around it. This is produced by the read
   * itself, so the assertion in `protocol.test.ts` breaks on the arm rather than on
   * somebody remembering to update it.
   */
  readonly usedParams: readonly string[];
}

/**
 * Decide what one `obsidian://` callback means to this device.
 *
 * `myVaultName` is this Obsidian vault's own name — `app.vault.getName()`, the same value
 * the plugin sent as the intent's `vault_name_suggestion` and the same value the control
 * plane handed back to the browser to build this URL with.
 *
 * **Absent `vault` nudges.** On desktop Obsidian's main process uses `?vault=` to pick the
 * window and then deletes it before dispatching (§5.2), so the ordinary desktop callback
 * arrives with no vault name on it. Treating that as "not ours" would leave the deep link
 * dead on the platform the parameter exists for. A hand-typed `obsidian://ctrlnotes` lands
 * in the same arm, and costs a poll that was going to happen anyway.
 *
 * **A named vault that is not ours is ignored.** That is tidiness, not a control — see the
 * module comment. It matters when Obsidian's dispatch lands somewhere the URL did not mean:
 * a renamed vault, or a `?vault=` a stranger chose.
 *
 * Pure: no I/O, no clock, no state. `main.ts` owns registration and owns what a nudge does.
 */
export const handleProtocol = (
  // Obsidian's `ObsidianProtocolData` is an index signature over the decoded query, plus
  // the `action` it dispatched under. This takes the same shape rather than a weak type
  // with one optional field, which nothing carrying an index signature is assignable to.
  params: Readonly<Record<string, string>>,
  myVaultName: string,
): ProtocolOutcome => {
  const usedParams: string[] = [];
  // The reads go through a proxy so `usedParams` is a fact about the code below rather
  // than a claim about it. `Proxy` is ES2015 and the bundle targets es2018
  // (`esbuild.config.mjs`), so this reaches both hosts; one deep link per pairing makes
  // its cost irrelevant.
  const watched = new Proxy(params, {
    get(target, key, receiver) {
      if (typeof key === "string" && !usedParams.includes(key)) usedParams.push(key);
      const value: unknown = Reflect.get(target, key, receiver);
      return value;
    },
  });

  const named = watched.vault;
  const action: ProtocolAction = named === undefined || named === myVaultName ? "nudge" : "ignore";
  return { action, usedParams };
};
