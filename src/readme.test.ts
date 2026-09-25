import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../", import.meta.url);

/**
 * `README.md` is read by a stranger deciding whether to install this, and by nobody who
 * will cross-check it against the code first — the same reason `manifest.test.ts`-shaped
 * checks exist elsewhere. A string comparison is not a human's job, so this file does it
 * mechanically. Adapted from an earlier prototype's `readme.test.ts`: same method (pin the two ways
 * this file has actually gone wrong — claiming less than the plugin does, and claiming
 * more), our own claims.
 *
 * What is deliberately NOT asserted: that the prose is *true*. A test cannot know that.
 */
const readme = readFileSync(new URL("README.md", ROOT), "utf8");
const manifest = JSON.parse(readFileSync(new URL("manifest.json", ROOT), "utf8")) as {
  description: string;
};

/**
 * Agent clients the public copy must not name until each is tested end to end against
 * the hosted MCP server. Claude Code is the only one as of 2026-09-24; move a name out of
 * this list in the same change that records its test. "Claude" alone is refused too: it
 * reads as claude.ai, whose `https://` OAuth callback has not been walked.
 */
const UNTESTED_CLIENTS = /ChatGPT|claude\.ai|Claude(?!\s+Code)|Muse|Codex|Gemini|Cursor/;

describe("README.md", () => {
  // regression-shaped: an earlier revision of this file said "there is no sync, no
  // pairing, and no plugin shell" while all three existed, because nothing checked it.
  // Under-claiming is the cheap failure; it only costs a stale paragraph.
  it("does not describe itself as a scaffold", () => {
    expect(readme).not.toMatch(/no sync|no pairing|no plugin shell|status\W*scaffold/i);
  });

  // Anchored on the verb forms actually used, the same reasoning an earlier prototype's comment
  // gives for its `pairs?`/`syncs` pair: a loose `/\bpair(s|ing)?\b/` or `/\bsync\b/` is
  // satisfied by a sentence saying pairing DOES NOT exist yet, which is the wrong polarity
  // to be testing for. Do not loosen these.
  it("names what the bundle actually does", () => {
    expect(readme).toMatch(/\bpairs\b/i);
    expect(readme).toMatch(/\bsyncs\b/i);
  });

  // **Five caveats this file used to pin describe gaps that have CLOSED**, each watched
  // closing against a real deployment on 2026-09-22: a device paired against production,
  // synced both ways, fetched inbound content, and propagated deletes and renames. A README
  // that still carried them would under-claim to a stranger deciding whether to install.
  // Pinned negatively, so a copy-paste from an old revision fails here.
  it("no longer carries caveats for gaps that have closed", () => {
    // `\s+`, not a literal space: the README is hard-wrapped, so a stale sentence that
    // comes back broken across a line must still match. A negative pin that a line break
    // defeats passes silently, which is the dangerous direction.
    expect(readme).not.toMatch(/cannot\s+reach\s+a\s+real\s+deployed\s+vault/i);
    expect(readme).not.toMatch(/inbound\s+content\s+fetch\s+has\s+no\s+wire\s+frame/i);
    expect(readme).not.toMatch(/refuses\s+a\s+local\s+delete\s+or\s+rename/i);
    expect(readme).not.toMatch(/being\s+built\s+alongside|nowhere\s+to\s+land/i);
  });

  // Until the plugin is listed, the README says so, and says how to install it anyway.
  // The BRAT steps were walked in a real Obsidian 1.13.7 on 2026-09-25: BRAT's own dialog,
  // this repository, "Latest version", then the plugin installed, enabled and loaded.
  it("says the plugin is not in the community directory, and how to install it with BRAT", () => {
    expect(readme).toMatch(/not\s+in\s+Obsidian's\s+community\s+directory/i);
    expect(readme).toMatch(/BRAT:\s+Plugins:\s+Add\s+a\s+beta\s+plugin\s+for\s+testing/);
    expect(readme).toMatch(/`ctrlnotes\/obsidian-cloud-mcp`/);
  });

  // The README states the minimum Obsidian a reader needs; it must be the manifest's, or a
  // reader on an older version installs and gets refused (0.0.1's 1.13.8 was one).
  it("states the manifest's minimum Obsidian version", () => {
    const { minAppVersion } = JSON.parse(readFileSync(new URL("manifest.json", ROOT), "utf8")) as {
      minAppVersion: string;
    };
    expect(readme).toContain(`Obsidian ${minAppVersion} or later`);
  });

  // Every relative link and every `src/…` path the README names must exist in this
  // repository: this plugin was developed inside the Ctrl Notes service's repository until
  // 2026-09-25, and a pointer back into it is a dead link to a stranger.
  it("names no path this repository lacks", () => {
    const links = [...readme.matchAll(/\]\(([^)#]+)\)/g)]
      .map((m) => m[1] ?? "")
      .filter((target) => !/^[a-z]+:/i.test(target));
    const paths = [...readme.matchAll(/`((?:src|tools)\/[^`\s]+)`/g)].map((m) => m[1] ?? "");
    expect(links.length + paths.length).toBeGreaterThan(0);
    for (const path of [...links, ...paths]) {
      expect(existsSync(new URL(path, ROOT)), path).toBe(true);
    }
    expect(readme).not.toMatch(/\bmoonx?\b|docs\/obsidian-community-directory/);
  });

  // The listing sells the plugin as a way to reach an agent, so the README has to say how.
  // The disclosure that the plugin never calls the MCP server is pinned on its truth as
  // well as its wording: no shipped source names the address.
  it("names the MCP server an agent connects to, and the plugin never calls it", () => {
    expect(readme).toMatch(/https:\/\/mcp\.ctrlnotes\.app\/mcp/);
    expect(readme).toMatch(/used\s+by\s+the\s+agent,\s+never\s+by\s+this\s+plugin/i);
    const shipped = readdirSync(new URL("src/", ROOT), {
      recursive: true,
      encoding: "utf8",
    }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("testing"));
    for (const file of shipped) {
      const source = readFileSync(new URL(`src/${file}`, ROOT), "utf8");
      expect(source, file).not.toMatch(/mcp\.ctrlnotes\.app/);
    }
  });

  it("names no agent client that has not been tested end to end", () => {
    expect(readme).not.toMatch(UNTESTED_CLIENTS);
    expect(manifest.description).not.toMatch(UNTESTED_CLIENTS);
  });

  // The one pairing caveat that IS current: a signed-out visitor to the confirm page is
  // offered sign-in, but the pairing request does not survive it (spec O10), so they must
  // start again from Obsidian.
  it("keeps the caveat that a signed-out visitor to the confirm page must start again", () => {
    expect(readme).toMatch(/\/app\/pair/);
    expect(readme).toMatch(/signed\s+out/i);
    expect(readme).toMatch(/press\s+\*\*Pair\*\*\s+in\s+Obsidian\s+again/i);
  });

  // The other half of the same paragraph: the README must not still advertise the flow that
  // was removed. A stranger following "it shows a code, approve it in a browser" would be
  // hunting a UI that no longer exists in either half of the product.
  it("no longer describes the retired code-and-approve flow", () => {
    expect(readme).not.toMatch(/shows a code|enter the code|approve the code/i);
  });

  // **The community directory's required disclosures** (Developer policies, "Disclosures"):
  // each is allowed only if the README clearly states it, and dropping one is a policy
  // violation that gets a plugin removed — so each is pinned on its substance, not a
  // keyword that a sentence denying it would also satisfy.
  it("discloses that an account is required", () => {
    expect(readme).toMatch(/\*\*An\s+account\s+is\s+required\.\*\*/);
  });

  it("discloses that payment is required, with the price", () => {
    expect(readme).toMatch(/\*\*Payment\s+is\s+required/);
    expect(readme).toMatch(/\$25\s+per\s+vault\s+per\s+month/);
  });

  it("discloses its network use, naming each service and why", () => {
    expect(readme).toMatch(/It\s+uses\s+the\s+network/);
    expect(readme).toMatch(/https:\/\/sync\.ctrlnotes\.app/);
    expect(readme).toMatch(/https:\/\/ctrlnotes\.app/);
  });

  it("links the privacy policy and says the plugin sends no telemetry", () => {
    expect(readme).toMatch(/\(https:\/\/ctrlnotes\.app\/privacy\)/);
    expect(readme).toMatch(/sends\s+no\s+analytics\s+or\s+usage\s+telemetry/i);
  });

  it("says it touches no files outside the vault and never syncs the config folder", () => {
    expect(readme).toMatch(/only\s+inside\s+this\s+vault/i);
    expect(readme).toMatch(/never\s+syncs\s+the\s+vault's\s+configuration\s+folder/i);
  });

  // The service is not open source, so an editable origin must not read as an offer to
  // self-host it — a promise a public licence would make look deliberate.
  it("names its licence and does not offer the service for self-hosting", () => {
    expect(readme).toMatch(/\[MIT-licensed\]\(LICENSE\)/);
    expect(readme).toMatch(/not\s+offered\s+for\s+self-hosting/i);
    expect(readme).not.toMatch(/for\s+a\s+self-hosted\s+deployment/i);
  });

  // This pinned "attachments are held back" until the vault grew `Op::PutBytes`. What is
  // worth pinning now is the two BOUNDS that remain, because both are cases where a file
  // is legitimately absent from sync and the user needs to know it is not a bug: mobile
  // carries none by preference, and anything past the vault's frame bound is skipped.
  it("keeps the caveat that mobile carries no attachments", () => {
    expect(readme).toMatch(/mobile\s+still\s+carries\s+no\s+attachments/i);
  });

  it("keeps the caveat that a file past the frame bound is skipped, with the size", () => {
    expect(readme).toMatch(/8\s*MiB/i);
  });

  // The other half of the same gap, and the one a user actually meets: a file with a text
  // extension whose BYTES are not text is withheld by the device (`sync/safe-path.ts`'s
  // `decodesAsText`). Under-claiming here is the expensive direction — a user whose note
  // is not syncing needs to be told it can be, by re-saving it — so it is pinned.
  //
  // Anchored on UTF-16 rather than on "not UTF-8": the README no longer says the latter,
  // because the blanket rule it described is gone and only the note case remains.
  //
  // **Proven able to fail**: deleting the UTF-16 sentence from gap 5 turns this red, and
  // the two assertions above stay green, so they are not standing in for each other.
  it("keeps the caveat that a note whose bytes are not text is withheld by this device", () => {
    expect(readme).toMatch(/UTF-16/i);
    expect(readme).toMatch(/withheld\s+by\s+this\s+device/i);
  });

  // What a stranger can run here. The service repository's `moonx` tasks do not exist in
  // this one, which the path test above also refuses.
  it("names the commands that check and build it", () => {
    for (const script of ["typecheck", "lint", "test", "build"]) {
      expect(readme).toMatch(new RegExp(`bun run ${script}\\b`));
    }
  });
});

/**
 * The directory's own `validate-manifest` rule runs in `lint` (`eslint.config.mjs`). These
 * are the listing rules it does not check: the description is what the in-app search
 * matches beside name and author, and a failing one is fixed only by a new release.
 */
describe("manifest.json", () => {
  it("has a description the directory accepts", () => {
    const d = manifest.description;
    expect(d.length).toBeLessThanOrEqual(250);
    expect(d).toMatch(/^[A-Z][a-z]+ /); // begins with a verb, not "This plugin…"
    expect(d).toMatch(/\.$/);
    expect(d).not.toMatch(/obsidian|plugin/i);
    expect(d).toMatch(/^[\x20-\x7e]+$/); // no emoji or special characters
  });

  // Obsidian serves an older install the newest release it can run from `versions.json`,
  // so the current version must be there, mapped to the manifest's own minimum.
  it("is listed in versions.json at its minAppVersion", () => {
    const versions = JSON.parse(readFileSync(new URL("versions.json", ROOT), "utf8")) as Record<
      string,
      string
    >;
    const m = JSON.parse(readFileSync(new URL("manifest.json", ROOT), "utf8")) as {
      version: string;
      minAppVersion: string;
    };
    expect(versions[m.version]).toBe(m.minAppVersion);
    for (const [plugin, app] of Object.entries(versions)) {
      expect(plugin).toMatch(/^\d+\.\d+\.\d+$/); // a release tag, so no "v" prefix
      expect(app).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
