// PL5 and PL6 (`docs/architecture-invariants.md`) are recorded as invariants but had no
// automated check — both hold today, but only because the plan's Task 14 Step 4 grepped for
// them by hand once. Adapted from `pairing.test.ts`'s own technique ("the code is never
// written anywhere persistent"): read the source, don't trust memory of what it does.
//
// Minor fix: this file is the mechanical check. `moon.yml` already lists `src/**/*` as a
// `test` input, so a file reappearing under a forbidden name, or a `fetch(` call creeping
// back in, invalidates the cache the same way any other source change does.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Every non-test `.ts` file under `src/`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("PL5: the plugin never merges", () => {
  it("unified.ts, lcs.ts and lines.ts are not present", () => {
    const names = new Set(sourceFiles(SRC_DIR).map((p) => p.split("/").pop()));
    for (const forbidden of ["unified.ts", "lcs.ts", "lines.ts"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe("PL6: requestUrl, never fetch", () => {
  it("no source file calls the bare fetch() function", () => {
    for (const file of sourceFiles(SRC_DIR)) {
      const src = readFileSync(file, "utf8");
      expect(src, `${file} calls fetch() directly`).not.toMatch(/\bfetch\(/);
    }
  });
});
