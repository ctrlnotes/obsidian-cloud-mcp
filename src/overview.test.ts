import { describe, expect, it } from "vitest";
import {
  capabilityText,
  fetchOverview,
  interpretOverview,
  lastUsedText,
  readOverview,
} from "./overview.ts";

const body = {
  vault: { vault_id: "v1", name: null },
  agents: [{ name: "A", capability: "r", issued_at: 1, last_used_at: null, expires_at: 2 }],
};

const answer = (status: number, json: unknown) =>
  ({ ok: true, value: { status, body: json } }) as const;

describe("reading the overview", () => {
  it("accepts a vault with no name and an agent never used", () => {
    expect(readOverview(body)?.vault.name).toBeNull();
    expect(readOverview(body)?.agents[0]?.last_used_at).toBeNull();
  });

  it("accepts an empty agents list", () => {
    expect(readOverview({ ...body, agents: [] })?.agents).toEqual([]);
  });

  /** All or nothing: dropping an agent the plugin cannot read would tell the user fewer
   * things can reach their notes than really can. */
  it("refuses the whole body for one agent it cannot read", () => {
    const admin = { ...body.agents[0], capability: "admin" };
    expect(readOverview({ ...body, agents: [...body.agents, admin] })).toBeUndefined();
  });

  it.each([
    ["no vault", { agents: [] }],
    ["an empty vault id", { vault: { vault_id: "", name: null }, agents: [] }],
    ["agents not a list", { vault: body.vault, agents: {} }],
    ["a time that is not a number", { ...body, agents: [{ ...body.agents[0], issued_at: "1" }] }],
    ["a numeric name", { ...body, agents: [{ ...body.agents[0], name: 7 }] }],
    ["not an object", "nope"],
  ])("refuses %s", (_what, raw) => {
    expect(readOverview(raw)).toBeUndefined();
  });
});

describe("what an answer means", () => {
  it("a 200 on contract is loaded", () => {
    expect(interpretOverview(answer(200, body)).status).toBe("loaded");
  });

  /** A control plane older than the route: the pane hides the section, it does not warn. */
  it("a 404 is absent, not a failure", () => {
    expect(interpretOverview(answer(404, null))).toEqual({ status: "absent" });
  });

  it.each([401, 500, 503])("a %i is a failure", (status) => {
    expect(interpretOverview(answer(status, { detail: "no" }))).toEqual({
      status: "failed",
      reason: `http_${status}`,
    });
  });

  it("a 200 off contract is a failure", () => {
    expect(interpretOverview(answer(200, { vault: null }))).toEqual({
      status: "failed",
      reason: "unexpected_response",
    });
  });

  it("no network is a failure", () => {
    expect(interpretOverview({ ok: false, reason: "transport_failed" })).toEqual({
      status: "failed",
      reason: "transport_failed",
    });
  });
});

describe("fetching it", () => {
  it("asks the overview route with the routing proof as its query", async () => {
    const asked: string[] = [];
    const result = await fetchOverview("https://cp.test", "d=dev&k=key&t=1&s=sig", (o, p) => {
      asked.push(`${o}${p}`);
      return Promise.resolve(answer(200, body));
    });
    expect(asked).toEqual(["https://cp.test/v1/sync/overview?d=dev&k=key&t=1&s=sig"]);
    expect(result.status).toBe("loaded");
  });

  it("sends nothing without a proof", async () => {
    const asked: string[] = [];
    const result = await fetchOverview("https://cp.test", null, (o, p) => {
      asked.push(`${o}${p}`);
      return Promise.resolve(answer(200, body));
    });
    expect(asked).toEqual([]);
    expect(result.status).toBe("failed");
  });
});

describe("last used", () => {
  const DAY = 86_400_000;
  const now = 100 * DAY;

  it.each([
    [null, "Never used"],
    [now - 1000, "Last used today"],
    [now - DAY, "Last used yesterday"],
    [now - 3 * DAY - 5, "Last used 3 days ago"],
    // A clock behind the control plane's is not "-1 days ago".
    [now + DAY, "Last used today"],
  ])("%s reads %s", (at, text) => {
    expect(lastUsedText(at, now)).toBe(text);
  });

  it("says what a capability allows", () => {
    expect(capabilityText("r")).toBe("Read only");
    expect(capabilityText("rw")).toBe("Read and write");
  });
});
