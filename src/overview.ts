// `GET /v1/sync/overview` — which AI agents can reach this device's vault, and the vault's
// name, for the settings pane.
//
//   plugin  --GET /v1/sync/overview?d=…&k=…&t=…&s=…-->  control plane
//           <-- 200 {vault: {vault_id, name}, agents: [{name, capability, …}]} ---------
//
// **The same routing proof as `/v1/sync` and `/v1/sync/signal`, and no other credential.**
// The control plane authorises it exactly as it does those two (`verified_device`), plus a
// refusal for a device this vault's owner has revoked; every refusal is the same uniform 401
// (AT8). `main.ts`'s `routingProof` mints the query, so there is one signature scheme on
// this device, not two that could drift apart.
//
// **Display only, and never load-bearing.** Nothing here gates sync, and every failure is a
// value: a control plane older than this route answers 404, which the pane takes as "this
// deployment has no agents list" and hides the section; anything else (401, a 5xx, a body
// off contract, no network) is one muted line. A pane that threw here would take the whole
// settings tab down with it, and sync does not read this at all.
//
// The response keeps the wire's own field names, as `wire.ts`'s `decodeDown` does, so the
// contract test can hold the parsed value against the fixture field for field.

import { type Requested, request } from "./controlplane-http.ts";

/** One agent that can reach this vault. Times are milliseconds since the epoch. */
export interface OverviewAgent {
  /** The token's current name, or `null` when it was never given one. */
  readonly name: string | null;
  /** THIS vault's grant. The control plane never sends another vault's. */
  readonly capability: "r" | "rw";
  readonly issued_at: number;
  /** Day granularity: the control plane touches it at most once a day. `null` is never. */
  readonly last_used_at: number | null;
  readonly expires_at: number;
}

export interface Overview {
  readonly vault: { readonly vault_id: string; readonly name: string | null };
  /** Active agents only, most recently used first (never-used last). */
  readonly agents: readonly OverviewAgent[];
}

export type OverviewResult =
  | { readonly status: "loaded"; readonly overview: Overview }
  /** 404: a control plane that predates the route. The pane shows nothing at all. */
  | { readonly status: "absent" }
  /** Anything else. `reason` is for `console.warn`, never for the pane. */
  | { readonly status: "failed"; readonly reason: string };

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

const readAgent = (raw: unknown): OverviewAgent | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { name, capability, issued_at, last_used_at, expires_at } = raw as Record<string, unknown>;
  if (name !== null && typeof name !== "string") return undefined;
  if (capability !== "r" && capability !== "rw") return undefined;
  if (!isTime(issued_at) || !isTime(expires_at)) return undefined;
  if (last_used_at !== null && !isTime(last_used_at)) return undefined;
  return { name, capability, issued_at, last_used_at, expires_at };
};

/**
 * The 200 body, or `undefined` for anything off contract.
 *
 * **All or nothing.** One agent with a capability this plugin does not know (a future
 * "admin", say) fails the whole body rather than being dropped from the list: a list that
 * silently leaves an agent out is a pane telling the user fewer things can reach their notes
 * than really can, which is the one wrong answer this section must not give.
 */
export function readOverview(body: unknown): Overview | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { vault, agents } = body as { vault?: unknown; agents?: unknown };
  if (typeof vault !== "object" || vault === null || !Array.isArray(agents)) return undefined;
  const { vault_id, name } = vault as { vault_id?: unknown; name?: unknown };
  if (typeof vault_id !== "string" || vault_id === "") return undefined;
  if (name !== null && typeof name !== "string") return undefined;
  const read: OverviewAgent[] = [];
  for (const raw of agents) {
    const agent = readAgent(raw);
    if (agent === undefined) return undefined;
    read.push(agent);
  }
  return { vault: { vault_id, name }, agents: read };
}

/** What one answer from the route means. Separate from the request so every branch is
 * testable without a transport. */
export function interpretOverview(got: Requested): OverviewResult {
  if (!got.ok) return { status: "failed", reason: got.reason };
  const { status, body } = got.value;
  if (status === 404) return { status: "absent" };
  if (status !== 200) return { status: "failed", reason: `http_${status}` };
  const overview = readOverview(body);
  return overview === undefined
    ? { status: "failed", reason: "unexpected_response" }
    : { status: "loaded", overview };
}

/**
 * Fetch the overview. `proof` is the `d`, `k`, `t`, `s` query `main.ts`'s `routingProof`
 * mints — `null` when this device has nothing to prove with, which is a failure rather than
 * an unsigned request the control plane would only refuse. `get` is the transport, which
 * `main.ts` bounds with the signal poll's timeout.
 */
export async function fetchOverview(
  controlplaneOrigin: string,
  proof: string | null,
  get: (origin: string, path: string) => Promise<Requested> = (origin, path) =>
    request(origin, path, "GET"),
): Promise<OverviewResult> {
  if (proof === null) return { status: "failed", reason: "not_paired" };
  return interpretOverview(await get(controlplaneOrigin, `/v1/sync/overview?${proof}`));
}

/**
 * "Last used today", "yesterday", "3 days ago", "never".
 *
 * **`now` is a parameter, not a clock read.** This plugin has one sanctioned wall clock,
 * `main.ts`'s injectable `now` (the seam `pairing-intent.ts` also takes), so a test can put
 * "three days later" wherever it likes without sleeping. Whole elapsed days rather than
 * calendar days: the control plane records a use at most once a day, so the precision a
 * calendar would imply is not in the data, and a calendar needs the local time zone.
 */
export function lastUsedText(lastUsedAt: number | null, now: number): string {
  if (lastUsedAt === null) return "Never used";
  const days = Math.floor(Math.max(0, now - lastUsedAt) / DAY_MS);
  if (days === 0) return "Last used today";
  if (days === 1) return "Last used yesterday";
  return `Last used ${days} days ago`;
}

const DAY_MS = 86_400_000;

/** A capability, in words. */
export const capabilityText = (capability: OverviewAgent["capability"]): string =>
  capability === "rw" ? "Read and write" : "Read only";
