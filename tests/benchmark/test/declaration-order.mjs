import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * A runner's top-level statements may not call into constants declared below
 * them.
 *
 * `index-time.mjs` crashed on its first real execution with
 * `Cannot access 'SOURCE_EXTENSIONS' before initialization`. Its project loop
 * calls `measureScale`, and the extension table that function reads was
 * declared two hundred lines further down, still inside its temporal dead zone
 * when the loop ran. The file had been complete and unrun for as long as it had
 * existed, so the order had never been tested by anything except reading it.
 *
 * These runners do their work at import time, so a test cannot simply import
 * one and look — importing it would run the benchmark. The check is structural
 * instead, and it is narrower than "declare everything first", because that
 * would condemn code that is fine. A top-level `const` read only by top-level
 * code further down cannot be reached early; `--list` and `--publish` exit
 * above the quiet-host options and never touch them. What bites is a constant
 * that a *function* reads, because function declarations hoist: any statement
 * above the constant can call one, and the call arrives inside the dead zone.
 *
 * So: a constant referenced from inside any function body has to be declared
 * before the first top-level statement. Comment lines are not references — a
 * constant named in prose is not read by anything.
 */
export function assertDeclarationsPrecedeExecution(directory, runners) {
  for (const runner of runners) {
    const lines = fs
      .readFileSync(path.join(directory, runner), "utf8")
      .split(/\r?\n/);
    const executes = lines.findIndex((line) =>
      /^(?:for|while|if|switch|await|try)\b/.test(line),
    );
    assert.notEqual(
      executes,
      -1,
      `${runner}: no top-level statement to check against`,
    );

    const read = referencedInsideFunctions(lines);
    const late = lines
      .map((line, index) => [index, /^const ([A-Za-z_$][\w$]*) =/.exec(line)])
      .filter(
        ([index, match]) =>
          index > executes && match !== null && read.has(match[1]),
      )
      .map(([index, match]) => `${match[1]} (line ${String(index + 1)})`);

    assert.deepEqual(
      late,
      [],
      `${runner}: the top-level statement at line ${String(executes + 1)} can ` +
        `call a function that reads ${late.join(", ")}, which is declared ` +
        `below it and is still in its temporal dead zone when it runs`,
    );
  }
}

/**
 * Every identifier named by code inside a top-level function body.
 *
 * Bodies are found by their bracing rather than by parsing: these runners are
 * formatted by Prettier, so a top-level `function` opens at column zero and the
 * `}` that closes it is the next line that is exactly `}`. Comment lines are
 * skipped so prose naming a constant does not count as reading it.
 */
function referencedInsideFunctions(lines) {
  const read = new Set();
  let inside = false;
  for (const line of lines) {
    if (!inside) {
      if (/^(?:export )?(?:async )?function /.test(line)) inside = true;
      continue;
    }
    if (line === "}") {
      inside = false;
      continue;
    }
    if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue;
    for (const identifier of line.match(/[A-Za-z_$][\w$]*/g) ?? [])
      read.add(identifier);
  }
  return read;
}
