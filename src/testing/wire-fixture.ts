// Loads the Ctrl Notes service's wire examples (`test-fixtures/wire/`) and checks a value
// against one by shape. The rules are a port of the service's own Rust checker, so the two
// languages agree about what "matches the fixture" means.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** JSON, structurally — the same shape `serde_json::Value` gives the Rust side. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Load a fixture from `test-fixtures/wire/`: the Ctrl Notes service's wire examples, copied
 * here when the plugin moved out of the service's repository (2026-09-25). The service keeps
 * the originals and tests its own side against them; this copy is what the plugin is held
 * to, and a protocol change on either side is a deliberate edit here.
 *
 * Resolved from this file's own location (`import.meta.url`), not from `process.cwd()`, so a
 * test run from any directory finds it.
 */
export function fixture(relative: string): JsonValue {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const path = new URL(`../../test-fixtures/wire/${relative}`, `file://${here}`);
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as JsonValue;
}

function kind(v: JsonValue): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  switch (typeof v) {
    case "boolean":
      return "a boolean";
    case "number":
      return "a number";
    case "string":
      return "a string";
    default:
      return "an object";
  }
}

/**
 * Assert that `actual` has the same SHAPE as `fixture` — field names and JSON types,
 * recursively. Values are ignored: a fixture carries example data, and demanding equality
 * would make this a golden-file test of the data rather than a contract test of the
 * interface. A byte-for-byte port of `share_testkit::wire::assert_shape`'s rules; see that
 * module's doc comment for the reasoning behind each one.
 *
 * Null is always acceptable in `actual`, and a null in the fixture means "any type here" —
 * every optional field on this wire is `T | null`, and which fields are null depends on the
 * moment.
 */
export function assertShape(expected: JsonValue, actual: JsonValue, at = "$"): void {
  const problems: string[] = [];
  compare(expected, actual, at, problems);
  if (problems.length > 0) {
    throw new Error(`the value does not match the wire fixture:\n  ${problems.join("\n  ")}`);
  }
}

function compare(expected: JsonValue, actual: JsonValue, at: string, out: string[]): void {
  if (expected === null || actual === null) return;

  const bothObjects =
    typeof expected === "object" &&
    !Array.isArray(expected) &&
    typeof actual === "object" &&
    !Array.isArray(actual);
  if (bothObjects) {
    const e = expected as { [key: string]: JsonValue };
    const a = actual as { [key: string]: JsonValue };
    // Sets of OWN keys, built from `Object.keys` rather than `in`/`hasOwnProperty` — a
    // JSON-decoded object's keys are arbitrary strings, and either of those would answer
    // `true` for an inherited name like `"constructor"` that was never actually present.
    const eKeys = new Set(Object.keys(e));
    const aKeys = new Set(Object.keys(a));
    for (const k of eKeys) {
      if (aKeys.has(k)) {
        compare(e[k] as JsonValue, a[k] as JsonValue, `${at}.${k}`, out);
      } else {
        out.push(`${at}: missing field \`${k}\``);
      }
    }
    for (const k of aKeys) {
      if (!eKeys.has(k)) {
        out.push(`${at}: field \`${k}\` is not in the wire fixture; add it there first`);
      }
    }
    return;
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    const shape = expected[0];
    if (shape === undefined) return;
    for (const [i, item] of actual.entries()) {
      compare(shape as JsonValue, item, `${at}[${i}]`, out);
    }
    return;
  }

  if (kind(expected) !== kind(actual)) {
    out.push(`${at}: fixture has ${kind(expected)}, value has ${kind(actual)}`);
  }
}
