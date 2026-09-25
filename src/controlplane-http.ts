// The one HTTP transport every control-plane call in this plugin goes through.
//
// **Extracted, not new.** The retired `pairing.ts` grew this pair of functions first; the
// pairing-intent flow needs exactly the same two, and two copies of "how a refusal becomes
// a value" is how the two drift into disagreeing about what a 409 means. Nothing here
// changed in the move.
//
// **`requestUrl`, never `fetch`** (plan rule PL6, design §11): the plugin's origins are
// `app://obsidian.md` and `capacitor://localhost`, so `fetch` meets a CORS preflight on
// every call. `requestUrl` is not a browser context and is not subject to it.
//
// **`throw: false`, and nothing here ever throws.** A modelled refusal — an expired intent,
// a rate-limited source, a signature that does not verify — is a value this module returns,
// never an exception that loses its HTTP status. A sync-adjacent flow runs unattended
// inside somebody else's application; an unhandled rejection with this plugin's name on it
// is not an acceptable failure mode for a network hiccup.

import { requestUrl } from "obsidian";

interface ProblemBody {
  readonly type?: unknown;
  readonly detail?: unknown;
}

/**
 * The one shape every refusal on these surfaces takes: an RFC 7807 `Problem`
 * (`crates/share/src/problem.rs`). `detail` is the human sentence; `type` is a stable slug
 * (`.../errors/<slug>`) worth falling back to when a body is present but malformed.
 *
 * Some legs answer with a bare status and no JSON body at all — the vault's own half of
 * `/redeem`, reached by replay, is one — so the last fallback must be total.
 */
export function reasonFrom(status: number, body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const p = body as ProblemBody;
    if (typeof p.detail === "string" && p.detail !== "") return p.detail;
    if (typeof p.type === "string" && p.type !== "") return p.type;
  }
  return `http_${status}`;
}

export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

export type Requested =
  | { readonly ok: true; readonly value: HttpResult }
  | { readonly ok: false; readonly reason: string };

/** One request: a status and a JSON body, or a transport failure as a value. */
export async function request(
  origin: string,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<Requested> {
  try {
    const res = await requestUrl({
      url: `${origin}${path}`,
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false,
    });
    return { ok: true, value: { status: res.status, body: res.json } };
  } catch {
    return { ok: false, reason: "transport_failed" };
  }
}
