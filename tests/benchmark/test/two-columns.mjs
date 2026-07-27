import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

/**
 * The comparison the table exists for cannot quietly stop being measured.
 *
 * What a strict provider is worth is one number, and it is only obtainable from
 * two cells taken in one run on one host: separate runs compare machines as much
 * as providers, and the corpus moves between them. That makes the second column
 * a property of the measurement rather than an option of the runner, so a
 * workflow that asks for one column is a defect the same way a missing lane is.
 *
 * Checked structurally rather than by running it, because the run costs hours
 * and the mistake is visible in a string.
 */
export function assertBothIndexColumnsAreMeasured() {
  const workflow = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "index-time.yml"),
    "utf8",
  );
  const asked = [...workflow.matchAll(/--tools=(\S+)/g)].map((match) =>
    // The workflow wraps its arguments, so a value can carry the line
    // continuation that followed it.
    match[1].replace(/\\$/, ""),
  );
  assert.ok(asked.length > 0, "index-time.yml asks for no tools at all");
  for (const value of asked) {
    const names = value.split(",");
    assert.ok(
      names.includes("samchon-graph"),
      `--tools=${value} does not measure the strict column`,
    );
    assert.ok(
      names.includes("samchon-graph-fallback"),
      `--tools=${value} does not measure the fallback column, so nothing in ` +
        `the published table can say what a strict provider was worth`,
    );
  }

  // And the runner has to still offer it. A column asked for by name that the
  // runner has dropped fails the lane at its first argument, an hour of
  // provisioning after the mistake was made.
  const runner = fs.readFileSync(
    path.join(repoRoot, "tests", "benchmark", "graph", "index-time.mjs"),
    "utf8",
  );
  assert.match(
    runner,
    /TOOL_SAMCHON_FALLBACK\s*=\s*"samchon-graph-fallback"/,
    "the runner no longer defines the fallback column the workflow asks for",
  );
  assert.match(
    runner,
    /"--no-strict"/,
    "the fallback column no longer stands the strict providers down",
  );
}
