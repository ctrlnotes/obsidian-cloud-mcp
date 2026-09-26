// The frames this vault speaks — write-surface design §8.1, §8.2. Ours, not an earlier prototype's:
// their wire described a hint-only socket with an HTTP content path and a `patch` op; this
// vault sends whole content over one duplex WebSocket and never asks a client to apply a
// diff (design §3.2).
//
// **Types and field names are pinned against `apps/vault/src/sync/wire.rs`, the
// authoritative definition.** `wire/vault-sync/*.json` is the cross-language contract both
// sides assert against (`wire/vault-sync/README.md`); `wire.contract.test.ts` is what
// exercises `encodeUp`/`decodeDown` here against those fixtures.
//
// **Two forward-compatibility rules, and they are opposite on purpose:**
//
// - **An unknown `Down` frame TYPE is tolerated, not fatal.** A vault newer than this
//   plugin build may add a frame type this build has never heard of; closing the socket
//   over it would turn a forward-compatible addition into an outage. `decodeDown` still
//   throws for it (`UnknownDownFrameError`) — it stays a decoder that is honest about what
//   it decoded — but `readDownFrame` is the tolerant entry point a live connection uses: it
//   catches exactly that error, logs, and returns `null` for the caller to skip.
// - **An unknown `wire_version` inside `challenge` is the opposite.** That is the version
//   handshake itself, not an extension to it, so a mismatch refuses loudly
//   (`WireVersionMismatchError`, left to propagate out of both `decodeDown` and
//   `readDownFrame`) rather than being logged and continued past.
//
// `SyncSocket` drives these; this module is where the two
// rules live so that module has only to call the right function.

/**
 * Bumped by the vault when a change would make an older client misread a frame.
 *
 * **2: snapshots page.** `DownSnapshot` gained `more`, and a build that did not
 * understand it would apply page one of several as though it were the whole
 * vault — deleting every path in the pages that had not arrived, because a
 * snapshot is authoritative. `vault::sync::pure::admit` compares this exactly
 * and refuses a mismatch with the version to speak, so such a build cannot
 * connect at all. Keep this in step with `apps/vault/src/sync/wire.rs`.
 *
 * **3: an idle socket is closed** (vault-sleep design VS1, VS2). The vault now sends
 * `closing` with `IDLE_REASON` after 90 s of silence, and a build that does not know that
 * string treats it as terminal: it stops syncing until Obsidian restarts. No frame changed
 * shape; the bump exists so that such a build is refused at the handshake with a sentence
 * telling its user to update, instead.
 *
 * **4: every closing says whether to retry** (bulk-ingest design BI1). `DownClosing` gained
 * `retry`, and this build decides from that field alone whether a closing is worth
 * reconnecting after — never from the reason's text. A v3 build reads any reason it does not
 * know as terminal, and a v4 vault sends new ones (`busy`), which is the whole bump: a build
 * that would stop syncing on them is refused at the handshake instead.
 */
export const WIRE_VERSION = 4;

/**
 * The oldest version this build still speaks, and it answers `hello` in whichever version the
 * vault's `challenge` named.
 *
 * **3 is still spoken because release-11 vaults speak it**, and the vault compares exactly
 * (`vault::sync::pure::admit`): speaking only 4 would lock this plugin out of every vault not
 * yet moved to a v4 release. A v3 closing carries no `retry` (decoded as `later`), and a v3
 * `ready` no batch limits ("no batching").
 *
 * TODO(v3): once no v3 vault remains, delete this, the per-connection `wireVersion` in
 * `socket.ts` (and its v3 pre-ready exemption), `optionalNum` and the v3 revoked-device advice
 * on `status.ts`'s retrying clause.
 */
export const MIN_WIRE_VERSION = 3;

/**
 * The largest single upload this vault will accept — pinned to
 * `apps/vault/src/sync/wire.rs`'s `MAX_FRAME_BYTES`.
 *
 * **This is a hard vault-side wall, not a preference.** `Upload::begin`
 * (`apps/vault/src/sync/upload.rs`) refuses any `Up::Put` whose declared `bytes`
 * exceeds this *before allocating anything* — unconditionally, for text and
 * attachments alike, since our wire has no separate byte channel with its own cap
 * the way an earlier prototype's `MAX_ATTACHMENT_BYTES` did. `derive.ts` uses this to refuse a
 * change client-side rather than let the vault refuse it after a full read+hash.
 *
 * Read the doc comment on the Rust constant before assuming this can be raised: it
 * is a MEMORY bound tied to `Vec::with_capacity(bytes)` on the connection handling
 * the upload, not a statement about how large a note or attachment may be.
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * How large one binary frame of a put's content is — and so the largest put a `put_batch`
 * carries, since a batch entry is exactly one frame ({@link UpPutBatch}).
 *
 * **Not `MAX_FRAME_BYTES`.** That is the vault's wall on a WHOLE upload; this is how finely
 * one upload is sliced on the way up, so a large attachment never holds the socket's send
 * buffer at megabytes. The vault assembles any number of chunks (`Upload::push`).
 */
export const PUT_CHUNK_BYTES = 256 * 1024;

// ---- Up: plugin -> vault ----

export interface UpHello {
  readonly type: "hello";
  readonly wire_version: number;
  readonly device_id: string;
  /** base64url of the signature over the challenge's context message. */
  readonly signature: string;
  /** Where this device left off. `null` means "everything". */
  readonly since_seq: number | null;
}

export interface UpAck {
  readonly type: "ack";
  readonly seq: number;
}

export interface UpPut {
  readonly type: "put";
  readonly path: string;
  readonly base_sha: string | null;
  readonly sha: string;
  readonly bytes: number;
}

export interface UpDelete {
  readonly type: "delete";
  readonly path: string;
  readonly base_sha: string | null;
}

export interface UpRename {
  readonly type: "rename";
  readonly from: string;
  readonly to: string;
}

export interface UpSnapshot {
  readonly type: "snapshot";
}

/**
 * Ask for the bytes behind one or more shas.
 *
 * Events carry a sha and never content, so this is the only way this device
 * obtains bytes it does not already hold. The vault answers each entry in
 * order with a `blob` header plus its binary frames, or a `no_blob`.
 *
 * The list is on the wire from the start even though slice one always sends
 * exactly one entry — batching later is then a change of call pattern rather
 * than of protocol.
 */
export interface UpWant {
  readonly type: "want";
  readonly shas: readonly string[];
}

/** One entry of a {@link UpPutBatch}: the header of a `put`, without its `type`. */
export interface BatchPutEntry {
  readonly path: string;
  readonly base_sha: string | null;
  readonly sha: string;
  readonly bytes: number;
}

/**
 * Several puts in one frame (bulk-ingest design BI5), answered by one {@link DownAppliedBatch}.
 *
 * **Exactly `puts.length` binary frames follow, one per entry, in order** — entry i's WHOLE
 * content in frame i, a zero-length frame for an empty file, nothing interleaved. The vault
 * correlates by position, and a frame whose length is not its entry's `bytes` refuses that
 * entry alone. So only content that fits one frame is ever batched
 * ({@link PUT_CHUNK_BYTES}); anything larger goes alone as an ordinary chunked `put`.
 *
 * **Sent only to a vault that advertised it** in `ready` (`DownReady.max_batch_ops`). A vault
 * without it drops an unknown frame in silence, and the pump would wait for an answer that
 * never comes. Puts only: a delete or a rename is always its own frame.
 */
export interface UpPutBatch {
  readonly type: "put_batch";
  readonly puts: readonly BatchPutEntry[];
}

export type Up = UpHello | UpAck | UpPut | UpPutBatch | UpDelete | UpRename | UpSnapshot | UpWant;

/** The plugin only ever sends `Up` frames; this is the whole of that job. */
export function encodeUp(up: Up): string {
  return JSON.stringify(up);
}

// ---- Down: vault -> plugin ----

export interface DownChallenge {
  readonly type: "challenge";
  readonly wire_version: number;
  readonly challenge: string;
}

export interface DownReady {
  readonly type: "ready";
  readonly seq: number;
  /**
   * The most entries this vault takes in one {@link UpPutBatch}, and the most content bytes
   * across them (bulk-ingest design BI5). **0 means "no batching"**, which is what a vault
   * older than the frame looks like: it sends neither field, and every put goes singly.
   */
  readonly max_batch_ops: number;
  readonly max_batch_bytes: number;
}

export interface DownEvent {
  readonly type: "event";
  readonly seq: number;
  readonly kind: string;
  readonly path: string;
  readonly sha: string | null;
  /** Where a `rename` moved FROM; `null` for every other kind. */
  readonly from: string | null;
  readonly at_ms: number;
}

export interface DownApplied {
  readonly type: "applied";
  readonly path: string;
  readonly seq: number | null;
  readonly sha: string;
}

export interface DownRefused {
  readonly type: "refused";
  readonly path: string;
  readonly reason: string;
  readonly current_sha: string | null;
}

/** One entry of a batch that landed. `seq` is that entry's own event, or `null` when the vault
 * already held those bytes there and wrote nothing. */
export interface AppliedBatchEntry {
  readonly path: string;
  readonly seq: number | null;
  readonly sha: string;
}

/** One entry of a batch the vault refused — the same meaning as a {@link DownRefused}. */
export interface RefusedBatchEntry {
  readonly path: string;
  readonly reason: string;
  readonly current_sha: string | null;
}

/**
 * The one answer to a {@link UpPutBatch} (bulk-ingest design BI5). **Every entry of the batch
 * appears in exactly one of the two lists**, keyed by path (a batch's paths are distinct). A
 * refused entry never refuses its neighbours: a stale base on one path is reconciled or
 * refused alone, and the rest land.
 */
export interface DownAppliedBatch {
  readonly type: "applied_batch";
  readonly applied: readonly AppliedBatchEntry[];
  readonly refused: readonly RefusedBatchEntry[];
}

export interface SnapshotEntry {
  readonly path: string;
  readonly sha: string;
}

export interface DownSnapshot {
  readonly type: "snapshot";
  readonly seq: number;
  readonly files: readonly SnapshotEntry[];
  /**
   * Another page follows, and **this one must not be applied**.
   *
   * A snapshot is authoritative — anything it does not name is trashed — so
   * applying one page of several deletes every path in the pages that have not
   * arrived. Only the page carrying `more: false` completes the set.
   */
  readonly more: boolean;
}

/**
 * Whether a `closing` is worth reconnecting after (bulk-ingest design BI1).
 *
 * `later` is back off and reconnect: a handshake that timed out, a busy vault, a restart, an
 * idle close. `never` is stop until a person acts: an unknown or revoked device, a version
 * mismatch, a protocol bug. The decision is the vault's, made from its own typed reason, so
 * this build never has to parse a sentence to make it.
 */
export type ClosingRetry = "later" | "never";

/** What a `closing` without a usable `reason` reads as. */
export const NO_REASON_GIVEN = "no reason given";

export interface DownClosing {
  readonly type: "closing";
  /** Free text for a human. Nothing here decides whether to retry from it. */
  readonly reason: string;
  readonly retry: ClosingRetry;
}

/**
 * The bytes for a sha follow, as `bytes` worth of binary frames.
 *
 * **The frames are contiguous** — the vault sends nothing between this header
 * and the last of them, which is what lets `want` carry no request ids. The
 * reader correlates by position.
 */
export interface DownBlob {
  readonly type: "blob";
  readonly sha: string;
  readonly bytes: number;
}

/**
 * The vault cannot supply that sha, and never will.
 *
 * **Permanent, and that is the whole point of it existing.** A transport
 * failure is worth retrying and this is not; conflating the two gives either a
 * device that retries forever or one that abandons content it could have had.
 */
export interface DownNoBlob {
  readonly type: "no_blob";
  readonly sha: string;
  readonly reason: string;
}

export type Down =
  | DownChallenge
  | DownReady
  | DownEvent
  | DownApplied
  | DownRefused
  | DownAppliedBatch
  | DownSnapshot
  | DownBlob
  | DownNoBlob
  | DownClosing;

/** Thrown by {@link decodeDown} on a frame this build cannot make sense of at all. */
export class DownDecodeError extends Error {}

/**
 * Thrown by {@link decodeDown} for a `type` this build has never heard of.
 *
 * A subtype of {@link DownDecodeError} rather than a sibling, so nothing that already
 * catches `DownDecodeError` stops working — {@link readDownFrame} is what treats this one
 * specifically as non-fatal.
 */
export class UnknownDownFrameError extends DownDecodeError {
  constructor(readonly frameType: string) {
    super(`unknown down frame type: ${frameType}`);
  }
}

/**
 * Thrown by {@link decodeDown} when a `challenge` frame names a `wire_version` this build
 * does not speak — the opposite of {@link UnknownDownFrameError}'s handling. This is the
 * version handshake itself, so a mismatch refuses loudly rather than being logged and
 * skipped: continuing past it would mean guessing at a frame shape that may have changed
 * incompatibly.
 */
export class WireVersionMismatchError extends Error {
  constructor(readonly serverWireVersion: number) {
    super(
      `the vault wants to speak wire version ${serverWireVersion}; this plugin build only ` +
        `speaks versions ${MIN_WIRE_VERSION} to ${WIRE_VERSION}; update the plugin`,
    );
  }
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string") throw new DownDecodeError(`\`${field}\` must be a string`);
  return v;
}

function num(v: unknown, field: string): number {
  if (typeof v !== "number") throw new DownDecodeError(`\`${field}\` must be a number`);
  return v;
}

function strOrNull(v: unknown, field: string): string | null {
  return v === null ? null : str(v, field);
}

/**
 * Like {@link strOrNull}, but an ABSENT key is `null` rather than an error.
 *
 * **The two sides deploy independently, and that is the whole reason.** A vault
 * older than the frame field simply does not send it, and a plugin that treated
 * the missing key as malformed would refuse the frame and terminate a
 * connection that is perfectly serviceable — for a field that only `rename`
 * populates. The same forward-compatibility `readDownFrame` already extends to
 * frame TYPES it has never heard of, one level down.
 *
 * A key that is PRESENT and not a string is still an error: that is a vault
 * saying something this build cannot read, not one staying quiet.
 */
function optionalStrOrNull(v: unknown, field: string): string | null {
  return v === undefined ? null : strOrNull(v, field);
}

function numOrNull(v: unknown, field: string): number | null {
  return v === null ? null : num(v, field);
}

/**
 * A count a vault older than the field does not send: absent (or `null`) is 0, which every
 * caller reads as "not offered". Present and not a number is still an error.
 */
function optionalNum(v: unknown, field: string): number {
  return v === undefined || v === null ? 0 : num(v, field);
}

function array(v: unknown, field: string): unknown[] {
  if (!Array.isArray(v)) throw new DownDecodeError(`\`${field}\` must be an array`);
  return v;
}

function record(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new DownDecodeError("a frame must be a JSON object");
  }
  return v as Record<string, unknown>;
}

/**
 * Parse one `Down` frame. Strict: this always throws rather than swallowing a problem, on
 * both of the forward-compatibility cases this module names above. {@link readDownFrame}
 * is the entry point that treats an unrecognised `type` as tolerable — this function
 * itself does not, so it stays honest about what it did and did not decode.
 */
export function decodeDown(raw: unknown): Down {
  const v = record(raw);
  const type = str(v.type, "type");
  switch (type) {
    case "challenge": {
      const wireVersion = num(v.wire_version, "wire_version");
      if (wireVersion < MIN_WIRE_VERSION || wireVersion > WIRE_VERSION) {
        throw new WireVersionMismatchError(wireVersion);
      }
      return {
        type: "challenge",
        wire_version: wireVersion,
        challenge: str(v.challenge, "challenge"),
      };
    }
    case "ready":
      return {
        type: "ready",
        seq: num(v.seq, "seq"),
        max_batch_ops: optionalNum(v.max_batch_ops, "max_batch_ops"),
        max_batch_bytes: optionalNum(v.max_batch_bytes, "max_batch_bytes"),
      };
    case "event":
      return {
        type: "event",
        seq: num(v.seq, "seq"),
        kind: str(v.kind, "kind"),
        path: str(v.path, "path"),
        sha: strOrNull(v.sha, "sha"),
        from: optionalStrOrNull(v.from, "from"),
        at_ms: num(v.at_ms, "at_ms"),
      };
    case "applied":
      return {
        type: "applied",
        path: str(v.path, "path"),
        seq: numOrNull(v.seq, "seq"),
        sha: str(v.sha, "sha"),
      };
    case "refused":
      return {
        type: "refused",
        path: str(v.path, "path"),
        reason: str(v.reason, "reason"),
        current_sha: strOrNull(v.current_sha, "current_sha"),
      };
    case "applied_batch":
      return {
        type: "applied_batch",
        applied: array(v.applied, "applied").map((a) => {
          const e = record(a);
          return {
            path: str(e.path, "path"),
            seq: numOrNull(e.seq, "seq"),
            sha: str(e.sha, "sha"),
          };
        }),
        refused: array(v.refused, "refused").map((r) => {
          const e = record(r);
          return {
            path: str(e.path, "path"),
            reason: str(e.reason, "reason"),
            current_sha: strOrNull(e.current_sha, "current_sha"),
          };
        }),
      };
    case "snapshot": {
      const files = v.files;
      if (!Array.isArray(files)) throw new DownDecodeError("`files` must be an array");
      return {
        type: "snapshot",
        seq: num(v.seq, "seq"),
        // Absent means "this is the whole thing", which is what a single-page
        // snapshot looks like and what every pre-paging vault sent. Defaulting
        // the OTHER way would make a complete snapshot never apply.
        more: v.more === true,
        files: files.map((f) => {
          const e = record(f);
          return { path: str(e.path, "path"), sha: str(e.sha, "sha") };
        }),
      };
    }
    case "blob":
      return { type: "blob", sha: str(v.sha, "sha"), bytes: num(v.bytes, "bytes") };
    case "no_blob":
      return { type: "no_blob", sha: str(v.sha, "sha"), reason: str(v.reason, "reason") };
    case "closing":
      // **Lenient, and it must never throw.** A decode error after the handshake is terminal
      // (`socket.ts`), so a strict decode here would turn a malformed closing into exactly the
      // stop BI1 exists to prevent. Only an explicit `never` stops this device; a missing
      // reason gets a stand-in.
      return {
        type: "closing",
        reason: typeof v.reason === "string" ? v.reason : NO_REASON_GIVEN,
        retry: v.retry === "never" ? "never" : "later",
      };
    default:
      throw new UnknownDownFrameError(type);
  }
}

/**
 * The entry point a live connection should decode with — {@link decodeDown}, except an
 * unrecognised `type` is a forward-compatibility signal rather than a fatal error. A vault
 * newer than this plugin build may send a frame this build has never heard of; closing the
 * socket over that would turn a forward-compatible server change into an outage for every
 * older client. So: log it and hand the caller `null` to skip, rather than throwing.
 *
 * **A `WireVersionMismatchError` is not caught here** — it propagates, on purpose. That is
 * the version handshake itself, not an addition to the frame set, so it gets the opposite
 * treatment: refuse loudly rather than continue past it.
 *
 * `warn` is injectable so a test can assert on it without spying on the real `console`;
 * the default is what a live connection actually gets.
 */
export function readDownFrame(
  raw: unknown,
  warn: (message: string) => void = (message) => console.warn(`Ctrl Notes: ${message}`),
): Down | null {
  try {
    return decodeDown(raw);
  } catch (e) {
    if (e instanceof UnknownDownFrameError) {
      warn(
        `ignoring an unrecognised down frame (type: "${e.frameType}"); this vault may be ` +
          "newer than this plugin build",
      );
      return null;
    }
    throw e;
  }
}
