import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No em or en dash in any text this plugin can show: settings, notices, the
 * status line, and the console lines a user may be asked to paste. The same
 * rule the web app holds (`apps/client/src/lib/copy.test.ts`).
 *
 * It reads the STRING LITERALS of every non-test module, not the whole file:
 * this code's comments use dashes freely and nobody sees them. A literal is
 * a double-quoted, single-quoted or template string on one line, which is
 * every form the copy here takes.
 */
const SRC = import.meta.dirname;

function modules(dir = ""): string[] {
  return readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return modules(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
  });
}

/** The string literals in a file, with block and line comments removed first. */
function literals(path: string): string[] {
  const code = readFileSync(join(SRC, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return code.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? [];
}

describe("shown copy", () => {
  const all = modules();

  it("finds the modules it checks", () => {
    expect(all.length).toBeGreaterThan(10);
  });

  it.each(all)("%s has no em or en dash in a string", (file) => {
    expect(literals(file).filter((s) => /[–—]/.test(s))).toEqual([]);
  });
});
