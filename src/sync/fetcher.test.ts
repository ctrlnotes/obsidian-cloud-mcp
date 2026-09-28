import { describe, expect, it } from "vitest";
import { MAX_WANT_SHAS, type Up } from "../wire.ts";
import { Fetcher } from "./fetcher.ts";

const sent: Up[] = [];
const make = (ok = true) => {
  sent.length = 0;
  return new Fetcher({
    send: (up) => {
      sent.push(up);
      return ok;
    },
    timeoutMs: 50,
  });
};

describe("Fetcher", () => {
  it("sends a want naming exactly the sha asked for", async () => {
    const f = make();
    const p = f.want("abc");
    expect(sent).toEqual([{ type: "want", shas: ["abc"] }]);
    f.onFrame({ type: "blob", sha: "abc", bytes: 3 });
    f.onBytes(new Uint8Array([1, 2, 3]));
    await expect(p).resolves.toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3]) });
  });

  it("reassembles bytes split across several frames", async () => {
    const f = make();
    const p = f.want("s");
    f.onFrame({ type: "blob", sha: "s", bytes: 5 });
    f.onBytes(new Uint8Array([1, 2]));
    f.onBytes(new Uint8Array([3]));
    f.onBytes(new Uint8Array([4, 5]));
    const got = await p;
    expect(got.ok && Array.from(got.bytes)).toEqual([1, 2, 3, 4, 5]);
  });

  it("completes a zero-byte file on its header alone, with no frames", async () => {
    // `Up::Put`'s own chunker always sends at least one frame for an empty
    // file; the vault's blob reply does not, so this end must not wait for one.
    const f = make();
    const p = f.want("empty");
    f.onFrame({ type: "blob", sha: "empty", bytes: 0 });
    const got = await p;
    expect(got.ok && got.bytes.byteLength).toBe(0);
  });

  it("reports a no_blob as PERMANENT", async () => {
    // The distinction the whole module exists for: `apply.ts` acks past this
    // and refuses to ack past a transient failure.
    const f = make();
    const p = f.want("gone");
    f.onFrame({ type: "no_blob", sha: "gone", reason: "collected" });
    await expect(p).resolves.toEqual({ ok: false, permanent: true, reason: "collected" });
  });

  it("reports a disconnect as TRANSIENT, so the caller retries", async () => {
    const f = make();
    const p = f.want("x");
    f.reset("disconnected");
    await expect(p).resolves.toEqual({ ok: false, permanent: false, reason: "disconnected" });
  });

  it("fails queued requests on reset instead of leaving them unsettled", async () => {
    // An unsettled promise here latches the settle loop forever — the same
    // shape of bug an abandoned Pump push once caused.
    const f = make();
    const first = f.want("a");
    const second = f.want("b");
    f.reset("gone");
    await expect(first).resolves.toMatchObject({ ok: false, permanent: false });
    await expect(second).resolves.toMatchObject({ ok: false, permanent: false });
  });

  it("times out as TRANSIENT rather than hanging", async () => {
    const f = make();
    const got = await f.want("slow");
    expect(got).toEqual({ ok: false, permanent: false, reason: "timeout" });
  });

  it("treats a send that cannot happen as TRANSIENT", async () => {
    const f = make(false);
    await expect(f.want("x")).resolves.toMatchObject({ ok: false, permanent: false });
  });

  it("refuses more bytes than the header declared rather than truncating", async () => {
    // A truncated file written to disk is worse than one not written: the
    // ledger would record a hash for content that is not what the vault holds.
    const f = make();
    const p = f.want("s");
    f.onFrame({ type: "blob", sha: "s", bytes: 2 });
    f.onBytes(new Uint8Array([1, 2, 3]));
    await expect(p).resolves.toMatchObject({ ok: false, permanent: false, reason: "overrun" });
  });

  it("ignores a header for a sha it did not ask for", async () => {
    const f = make();
    const p = f.want("mine");
    expect(f.onFrame({ type: "blob", sha: "theirs", bytes: 1 })).toBe(false);
    f.onFrame({ type: "blob", sha: "mine", bytes: 1 });
    f.onBytes(new Uint8Array([7]));
    const got = await p;
    expect(got.ok && Array.from(got.bytes)).toEqual([7]);
  });

  it("drops bytes arriving before any header names a length", async () => {
    const f = make();
    const p = f.want("s");
    expect(f.onBytes(new Uint8Array([9]))).toBe(false);
    f.onFrame({ type: "blob", sha: "s", bytes: 1 });
    f.onBytes(new Uint8Array([1]));
    const got = await p;
    expect(got.ok && Array.from(got.bytes)).toEqual([1]);
  });

  it("serialises: the second want is not sent until the first is answered", async () => {
    const f = make();
    const a = f.want("a");
    const b = f.want("b");
    expect(sent).toEqual([{ type: "want", shas: ["a"] }]);
    f.onFrame({ type: "blob", sha: "a", bytes: 1 });
    f.onBytes(new Uint8Array([1]));
    await a;
    expect(sent).toEqual([
      { type: "want", shas: ["a"] },
      { type: "want", shas: ["b"] },
    ]);
    f.onFrame({ type: "no_blob", sha: "b", reason: "unknown" });
    await expect(b).resolves.toMatchObject({ permanent: true });
  });

  it("says whether a want is outstanding, until it is answered or reset", async () => {
    const f = make();
    expect(f.hasOutstanding()).toBe(false);
    const a = f.want("a");
    void f.want("b"); // queued behind `a`
    expect(f.hasOutstanding()).toBe(true);
    f.onFrame({ type: "no_blob", sha: "a", reason: "unknown" });
    await a;
    expect(f.hasOutstanding()).toBe(true); // `b` is now the one in flight
    f.reset("parked");
    expect(f.hasOutstanding()).toBe(false);
  });

  it("never sends more shas than the protocol allows in one want", () => {
    // The vault closes a connection whose `want` names more than this, rather
    // than truncating — so the bound is enforced here, not trusted.
    const f = make();
    void f.wantMany(Array.from({ length: MAX_WANT_SHAS * 2 + 5 }, (_, i) => `s${i}`));
    const [first] = sent;
    expect(first?.type === "want" && first.shas.length).toBe(MAX_WANT_SHAS);
  });
});

describe("Fetcher.wantMany — several shas per round trip", () => {
  /** Answer the want at the head of `sent`: bytes for a sha in `have`, `no_blob` otherwise. */
  const answer = (f: Fetcher, want: Up | undefined, have: Record<string, number[]>) => {
    if (want?.type !== "want") throw new Error(`expected a want, got ${want?.type}`);
    for (const sha of want.shas) {
      const bytes = have[sha];
      if (bytes === undefined) {
        f.onFrame({ type: "no_blob", sha, reason: "unknown" });
        continue;
      }
      f.onFrame({ type: "blob", sha, bytes: bytes.length });
      if (bytes.length > 0) f.onBytes(new Uint8Array(bytes));
    }
  };

  it("asks for every sha in one want, and maps each answer back to its sha", async () => {
    const f = make();
    const p = f.wantMany(["a", "gone", "b", "empty"]);
    expect(sent).toEqual([{ type: "want", shas: ["a", "gone", "b", "empty"] }]);
    answer(f, sent[0], { a: [1], b: [2, 3], empty: [] });
    const got = await p;
    expect(got.get("a")).toEqual({ ok: true, bytes: new Uint8Array([1]) });
    expect(got.get("b")).toEqual({ ok: true, bytes: new Uint8Array([2, 3]) });
    expect(got.get("empty")).toEqual({ ok: true, bytes: new Uint8Array(0) });
    // A sha the vault does not have is an answer, and a PERMANENT one.
    expect(got.get("gone")).toEqual({ ok: false, permanent: true, reason: "unknown" });
    expect(got.size).toBe(4);
  });

  it("splits a long list into bounded wants, one outstanding at a time", async () => {
    const f = new Fetcher({
      send: (up) => {
        sent.push(up);
        return true;
      },
      timeoutMs: 50,
      maxShas: 2,
    });
    sent.length = 0;
    const p = f.wantMany(["a", "b", "c", "d", "e"]);
    // Only the first is sent: the answers carry no id, so two in flight could not be told apart.
    expect(sent).toEqual([{ type: "want", shas: ["a", "b"] }]);
    answer(f, sent[0], { a: [1], b: [2] });
    await Promise.resolve();
    expect(sent[1]).toEqual({ type: "want", shas: ["c", "d"] });
    answer(f, sent[1], { c: [3] });
    await Promise.resolve();
    expect(sent[2]).toEqual({ type: "want", shas: ["e"] });
    answer(f, sent[2], { e: [5] });
    const got = await p;
    expect([...got.keys()].sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(got.get("d")).toMatchObject({ ok: false, permanent: true });
    expect(got.get("e")).toEqual({ ok: true, bytes: new Uint8Array([5]) });
  });

  it("never asks past the wire's bound, whatever it is configured with", () => {
    sent.length = 0;
    const f = new Fetcher({
      send: (up) => {
        sent.push(up);
        return true;
      },
      maxShas: 10_000,
    });
    void f.wantMany(Array.from({ length: 500 }, (_, i) => `s${i}`));
    expect(sent[0]?.type === "want" && sent[0].shas.length).toBe(MAX_WANT_SHAS);
    f.reset();
  });

  it("asks for a repeated sha once", async () => {
    const f = make();
    const p = f.wantMany(["a", "a", "b"]);
    expect(sent).toEqual([{ type: "want", shas: ["a", "b"] }]);
    answer(f, sent[0], { a: [1], b: [2] });
    expect((await p).size).toBe(2);
  });

  it("fails what is unanswered as TRANSIENT on a disconnect, keeping what already arrived", async () => {
    const f = make();
    const p = f.wantMany(["a", "b"]);
    f.onFrame({ type: "blob", sha: "a", bytes: 1 });
    f.onBytes(new Uint8Array([1]));
    f.reset("disconnected");
    const got = await p;
    expect(got.get("a")).toEqual({ ok: true, bytes: new Uint8Array([1]) });
    expect(got.get("b")).toEqual({ ok: false, permanent: false, reason: "disconnected" });
  });

  it("times out on silence, not on a batch's length: progress re-arms the timer", async () => {
    // Each answer lands inside the timeout, and the whole batch takes longer than it.
    const f = make(); // timeoutMs: 50
    const p = f.wantMany(["a", "b", "c"]);
    for (const sha of ["a", "b", "c"]) {
      await new Promise((r) => setTimeout(r, 30));
      f.onFrame({ type: "blob", sha, bytes: 1 });
      f.onBytes(new Uint8Array([1]));
    }
    const got = await p;
    expect([...got.values()].every((g) => g.ok)).toBe(true);
  });
});
