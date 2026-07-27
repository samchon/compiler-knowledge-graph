#!/usr/bin/env node
/**
 * Read back what the indexing-time publication actually contains.
 *
 * `index-time.mjs` writes cells one at a time and says nothing about the shape
 * of the result; after thirteen jobs fold their reports into one file, the
 * question a reader has is not "did it run" but "which languages are in here,
 * on what machine, and against how much source". A measurement whose coverage
 * has to be reconstructed by hand is one nobody checks.
 *
 * Absence is reported as absence. A corpus project with no cell is named as
 * unmeasured rather than left out of the table, because a missing language is
 * the finding, and a table that only lists successes reads as complete.
 *
 *   node tests/benchmark/graph/index-time-summary.mjs [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PROJECTS } from "./corpus.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const websiteJson = path.resolve(here, "..", "results", "graph.json");

const published = readJson(websiteJson);
const index = published?.index ?? null;
if (index === null) {
  process.stdout.write(
    `No index-time measurement in ${path.relative(process.cwd(), websiteJson)}.\n`,
  );
  process.exit(0);
}

const cells = Array.isArray(index.cells) ? index.cells : [];
const measured = new Map();
for (const cell of cells) {
  if (typeof cell?.project !== "string") continue;
  const perTool = measured.get(cell.project) ?? new Map();
  perTool.set(cell.tool, cell);
  measured.set(cell.project, perTool);
}

const rows = Object.keys(PROJECTS).map((project) => {
  const spec = PROJECTS[project];
  const scale = index.scale?.[project];
  const perTool = measured.get(project);
  return {
    project,
    language: spec.language,
    commit: String(spec.commit).slice(0, 12),
    files: scale?.files ?? null,
    lines: scale?.lines ?? null,
    tools: perTool === undefined ? [] : [...perTool.entries()],
  };
});

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ host: index.host, rows }, null, 2)}\n`);
  process.exit(0);
}

// One banner only when one machine really did measure everything. These cells
// normally come from thirteen runners, one per language, because two lanes
// sharing a host would corrupt each other's wall clock — so a single header
// would be naming a CPU that twelve of the rows never touched. When the cells
// disagree, each says what it ran on and the reader can see that two rows are
// not one comparison.
const hosts = new Set(
  cells.map((cell) => cell.host?.cpu).filter((cpu) => typeof cpu === "string"),
);
const uniform = hosts.size === 1 ? (cells[0]?.host ?? index.host) : null;
if (uniform)
  process.stdout.write(
    `host: ${uniform.cpu ?? "unknown"} — ${String(uniform.cores ?? "?")} cores, ` +
      `${String(uniform.ramGB ?? "?")} GB, ${uniform.os ?? "unknown"}, node ${uniform.node ?? "?"}\n\n`,
  );
else
  process.stdout.write(
    `measured across ${String(hosts.size)} distinct hosts; each row names its own.\n\n`,
  );

for (const row of rows) {
  const scale =
    row.files === null
      ? "scale unmeasured"
      : `${String(row.files)} files / ${String(row.lines)} lines`;
  if (row.tools.length === 0) {
    // The scale still prints. A project can be cloned and counted and then fail
    // to index, and saying so is more use than a bare NOT MEASURED.
    process.stdout.write(
      `  ${pad(row.project, 12)} ${pad(row.language, 11)} ${pad(row.commit, 13)} ${pad("NOT MEASURED", 17)} ${pad("", 12)} ${scale}\n`,
    );
    continue;
  }
  for (const [tool, cell] of row.tools) {
    // A timed-out cell has no duration and is not a tool without a build step.
    // Both would print the same words if this only asked whether buildMs is a
    // number, and "this configuration does not finish inside the limit" is a
    // measurement — arguably the most important one this table can carry.
    const time =
      typeof cell.buildMs === "number"
        ? `${(cell.buildMs / 1000).toFixed(1)} s`
        : typeof cell.timedOutMs === "number"
          ? `>${(cell.timedOutMs / 1000).toFixed(0)} s`
          : "no build step";
    const where = uniform ? "" : `  [${cell.host?.cpu ?? "host unrecorded"}]`;
    // Which path produced it, because a strict provider, the language-server
    // lane, and the static syntax reader differ by orders of magnitude and a
    // bare duration hides that. A static cell is marked, not merely labelled: a
    // TypeScript corpus indexed in 2.8 s reads as the flagship provider being
    // fast, and it was the best-effort syntax fallback doing almost none of the
    // work the other rows did.
    const via =
      typeof cell.servedBy === "string" ? `  via ${cell.servedBy}` : "";
    const caveat =
      typeof cell.servedBy === "string" && cell.servedBy.startsWith("static")
        ? "  <- NOT A SEMANTIC INDEX"
        : "";
    process.stdout.write(
      `  ${pad(row.project, 12)} ${pad(row.language, 11)} ${pad(row.commit, 13)} ${pad(tool, 17)} ${pad(time, 12)} ${scale}${where}${via}${caveat}\n`,
    );
  }
}

// What the strict provider was worth, per project.
//
// The point of the whole table, and until both cells were measured in one run
// it could only be guessed at across runs on different machines. A ratio is
// printed only where both cells finished: a timeout bounds a duration from
// below, so dividing by one would understate the very gap it is meant to show.
const paired = rows
  .map((row) => {
    const of = (tool) => (row.tools.find(([name]) => name === tool) ?? [])[1];
    return {
      row,
      strict: of("samchon-graph"),
      fallback: of("samchon-graph-fallback"),
    };
  })
  .filter(
    ({ strict, fallback }) =>
      typeof strict?.buildMs === "number" &&
      typeof fallback?.buildMs === "number",
  );

if (paired.length > 0) {
  process.stdout.write("\nstrict provider vs the same project with none:\n\n");
  for (const { row, strict, fallback } of paired) {
    const served =
      typeof strict.servedBy === "string" &&
      !/no strict provider/.test(strict.servedBy);
    const verdict = served
      ? `${(fallback.buildMs / strict.buildMs).toFixed(1)}x`
      : "no strict provider served, so both cells measured the same lane";
    const strictTime = `${(strict.buildMs / 1000).toFixed(1)} s`;
    const fallbackTime = `${(fallback.buildMs / 1000).toFixed(1)} s`;
    process.stdout.write(
      `  ${pad(row.project, 12)} ${pad(row.language, 11)} ` +
        `${pad(strictTime, 10)} ${pad(fallbackTime, 10)} ${verdict}\n`,
    );
  }
}

const unmeasured = rows.filter((row) => row.tools.length === 0);
process.stdout.write(
  `\n${String(rows.length - unmeasured.length)} of ${String(rows.length)} corpus projects measured.\n`,
);
if (unmeasured.length > 0) {
  process.stdout.write(
    `unmeasured: ${unmeasured.map((row) => `${row.project} (${row.language})`).join(", ")}\n`,
  );
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
