import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No `passWithNoTests`: a run that finds zero tests (a moved config, a broken include)
    // must fail, not report green.
    //
    // vitest's default timeout is 5000ms, a generic default rather than a considered
    // bound, and three tests here exceed it under load: `pump.test.ts`'s "content follows
    // the put header as binary frames" frames 600,000 bytes, and two
    // `derive.property.test.ts` properties run a full fast-check suite each. All three
    // timed out at 5000ms on a busy machine and pass when the suite runs alone, so that
    // deadline was measuring machine load, not the code under test.
    //
    // 30s is a HANG guard, not a latency assertion. Nothing here should take seconds when
    // the machine is idle; what this stops is a test that awaits something structurally
    // unreachable running until CI's whole budget is gone with no test name attached.
    //
    // If a test genuinely needs longer, give that test its own timeout rather than raising
    // this: a global ceiling that has to cover the slowest test stops bounding every other.
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
