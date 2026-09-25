import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Task 1 has no test files yet, and vitest 4 exits non-zero on zero matches by default.
    // Every later task adds real tests; this only keeps the scaffolding-only tree green.
    passWithNoTests: true,
    // vitest's default is 5000ms, which is a generic default rather than a
    // considered bound, and three tests here exceed it under CI contention:
    // `pump.test.ts`'s "content follows the put header as binary frames"
    // frames 600,000 bytes, and two `derive.property.test.ts` properties run a
    // full fast-check suite each. All three failed as "Test timed out in
    // 5000ms" during a parallel run of every test suite in the repository this was developed in, and all 485 pass when the
    // suite runs alone — so the deadline was measuring machine load, not the
    // code under test.
    //
    // 30s is a HANG guard, not a latency assertion. Nothing here should take
    // seconds when the machine is idle; what this stops is a test that awaits
    // something structurally unreachable running until CI's whole budget is
    // gone with no test name attached — the same reasoning, and the same job,
    // as `slow-timeout` in `.config/nextest.toml` on the Rust side.
    //
    // If a test genuinely needs longer, give that test its own timeout rather
    // than raising this: a global ceiling that has to cover the slowest test
    // stops bounding every other one.
    testTimeout: 30_000,
    // A `window` whose timers forward to the (possibly faked) globals — see the file.
    setupFiles: ["./src/testing/window-timers.ts"],
    // The `obsidian` package is types-only — importing it at runtime fails. Tests reach
    // the API through a behavioural fake instead, ported alongside the module that needs it.
    alias: {
      obsidian: fileURLToPath(new URL("./src/testing/fake-obsidian.ts", import.meta.url)),
    },
  },
});
