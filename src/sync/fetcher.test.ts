import { describe, expect, it } from "vitest";
import type { Up } from "../wire.ts";
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
    // Slice one sends one at a time; this pins that the call shape cannot
    // silently grow past the wire's own bound.
    const f = make();
    void f.want("only");
    const [first] = sent;
    expect(first?.type).toBe("want");
    expect(first?.type === "want" && first.shas.length).toBeLessThanOrEqual(64);
  });
});
