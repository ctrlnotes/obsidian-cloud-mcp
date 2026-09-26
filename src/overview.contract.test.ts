// The plugin's half of `GET /v1/sync/overview`'s wire contract.
//
// The control plane asserts its real response body against its own copy of this fixture;
// this file reads the same bytes with `readOverview` and holds the parsed value to the
// fixture's shape in both directions (`assertShape`), as `wire.contract.test.ts` does for the
// sync frames. The service's copy is not in this repository and nothing connects the two, so
// a change to the response is made in both by hand, deliberately.

import { describe, expect, test } from "vitest";
import { readOverview } from "./overview.ts";
import { assertShape, fixture, type JsonValue } from "./testing/wire-fixture.ts";

describe("GET /v1/sync/overview: readOverview accepts the control plane's fixture", () => {
  const f = fixture("controlplane/v1-sync-overview.response.json");

  test("verbatim, in shape too", () => {
    const parsed = readOverview(f);
    expect(parsed).toBeDefined();
    assertShape(f, parsed as unknown as JsonValue);
  });

  test("with the values the fixture carries", () => {
    const parsed = readOverview(f);
    expect(parsed?.vault).toEqual({ vault_id: "e000518f8653638e404ca98c6d0a8f10", name: "Work" });
    expect(parsed?.agents.map((a) => [a.name, a.capability, a.last_used_at])).toEqual([
      ["Claude Code", "rw", 1790373000000],
      [null, "r", null],
    ]);
  });
});
