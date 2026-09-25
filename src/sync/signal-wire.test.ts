// The plugin's half of `GET /v1/sync/signal`'s wire contract (vault-sleep VS8, PL7).
//
// The control plane builds `{"seq": n}` or `{"seq": null}` and
// `apps/controlplane/tests/wire_contract.rs` asserts its real response body EQUALS each
// fixture below; this file asserts `readSignal` reads the same bytes as the number and as
// "unknown". A fixture only one side rereads is not a contract, so both read these files
// (`wire/controlplane/README.md`).

import { describe, expect, test } from "vitest";
import { fixture } from "../testing/wire-fixture.ts";
import { readSignal } from "./park.ts";

describe("GET /v1/sync/signal: readSignal parses the control plane's fixtures", () => {
  test("a number", () => {
    expect(readSignal(fixture("controlplane/v1-sync-signal.response.json"))).toBe(42);
  });

  test("null is unknown, not malformed", () => {
    expect(readSignal(fixture("controlplane/v1-sync-signal.response.null.json"))).toBeNull();
  });
});
