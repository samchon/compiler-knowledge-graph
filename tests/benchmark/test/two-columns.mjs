import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PROJECTS } from "../graph/corpus.mjs";

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
  assert.match(
    runner,
    /cellRepoDir = prepareCellFixture[\s\S]*runIndexCell\(\{[\s\S]*repoDir: cellRepoDir[\s\S]*cleanupCellFixture\(cellRepoDir\)/,
    "each measured column must use and clean up its own prepared checkout",
  );
  assert.match(
    runner,
    /\["clone", "--quiet", "--local", "--no-hardlinks", source, target\]/,
    "cell checkouts must not share writable file inodes with the source fixture",
  );
  assert.match(
    runner,
    /function prepareCellFixture[\s\S]*catch \(error\) \{[\s\S]*rethrowWithCleanup\([\s\S]*cleanupCellFixture\(target\)/,
    "a failed cell preparation must clean its partial checkout before throwing",
  );
  assert.match(
    runner,
    /function runWithCleanup[\s\S]*cleanupFailures\(cleanups\)[\s\S]*new AggregateError\([\s\S]*\[\.\.\.\(failed \? \[failure\] : \[\]\), \.\.\.cleanup\]/,
    "cell cleanup failures must preserve the operation failure they followed",
  );
  assert.match(
    runner,
    /function prepareCellCache[\s\S]*catch \(error\) \{[\s\S]*rethrowWithCleanup\([\s\S]*cleanupCellCache\(root\)/,
    "a failed cache preparation must clean its partial cache before throwing",
  );
}

/**
 * The headline number is arithmetic, and arithmetic printed by nobody's test is
 * arithmetic nobody has checked.
 *
 * What a strict provider was worth is the one figure this whole measurement
 * exists to produce, and it is computed in the summary from two cells that must
 * be paired correctly, skipped when either did not finish, and refused when the
 * strict cell's provider never served.
 */
export function assertStrictComparisonArithmetic() {
  const host = { cpu: "fixture", cores: 1, ramGB: 1, os: "fixture", node: "x" };
  const cell = (project, tool, extra) => ({
    project,
    tool,
    host,
    fixtureCommit: PROJECTS[project].commit,
    strict: tool === "samchon-graph",
    ...extra,
  });
  const servedProject = "excalidraw";
  const absentProject = "flask";
  const timeoutProject = "gin";
  const staticProject = "gson";
  const projects = [
    servedProject,
    absentProject,
    timeoutProject,
    staticProject,
  ];
  const fixture = {
    schemaVersion: 1,
    index: {
      schemaVersion: 2,
      host,
      fixtures: Object.fromEntries(
        projects.map((project) => [project, PROJECTS[project].commit]),
      ),
      scale: Object.fromEntries(
        projects.map((project) => [project, { files: 1, lines: 1 }]),
      ),
      cells: [
        // Served, both finished: a ratio.
        cell(servedProject, "samchon-graph", {
          buildMs: 10_000,
          servedBy: "lsp scip-fake(go)",
        }),
        cell(servedProject, "samchon-graph-fallback", {
          buildMs: 250_000,
          servedBy: "lsp no strict provider served",
        }),
        // Never served: both cells measured the same lane, so 1.0x would read
        // as a provider that bought nothing rather than one that never ran.
        cell(absentProject, "samchon-graph", {
          buildMs: 20_000,
          servedBy: "lsp no strict provider served",
        }),
        cell(absentProject, "samchon-graph-fallback", {
          buildMs: 21_000,
          servedBy: "lsp no strict provider served",
        }),
        // Fallback ran out of time: a timeout bounds a duration from below, so
        // dividing by it would understate the very gap it is meant to show.
        cell(timeoutProject, "samchon-graph", {
          buildMs: 5_000,
          servedBy: "lsp scip-fake(c)",
        }),
        cell(timeoutProject, "samchon-graph-fallback", {
          buildMs: null,
          timedOutMs: 3_600_000,
          servedBy: "attempted no strict provider selected",
        }),
        // A static fallback finished, but it did not build a semantic graph.
        // Its duration is useful raw evidence, not a divisor for provider
        // savings because the cells performed materially different work.
        cell(staticProject, "samchon-graph", {
          buildMs: 30_000,
          servedBy: "lsp scip-fake(java)",
        }),
        cell(staticProject, "samchon-graph-fallback", {
          buildMs: 3_000,
          servedBy: "static no strict provider served",
        }),
      ],
    },
  };

  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "samchon-graph-summary-")),
    "graph.json",
  );
  fs.writeFileSync(file, JSON.stringify(fixture));
  const ran = cp.spawnSync(
    process.execPath,
    [path.join(repoRoot, "tests", "benchmark", "graph", "index-time-summary.mjs")],
    {
      encoding: "utf8",
      env: { ...process.env, SAMCHON_BENCH_INDEX_JSON: file },
      windowsHide: true,
    },
  );
  assert.equal(ran.status, 0, ran.stderr ?? "");
  const out = ran.stdout ?? "";

  assert.match(
    out,
    new RegExp(`${servedProject}[^\\n]*25\\.0x`),
    "a served project reports how much the strict provider saved",
  );
  assert.match(
    out,
    new RegExp(
      `${absentProject}[^\\n]*both cells measured the same lane`,
    ),
    "a project whose provider never served must not report a ratio",
  );
  assert.doesNotMatch(
    out,
    new RegExp(`${timeoutProject}[^\\n]*x$`, "m"),
    "a project with an unfinished cell must not be given a ratio",
  );
  assert.match(
    out,
    new RegExp(
      `${staticProject}[^\\n]*no semantic index; times are not comparable`,
    ),
    "a static strict-off cell must be reported as non-comparable",
  );
  assert.doesNotMatch(
    out,
    new RegExp(`${staticProject}[^\\n]*x$`, "m"),
    "a static strict-off cell must not be given a semantic savings ratio",
  );
}
