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
import currentIndex from "./current-index.cjs";
import { assertWebsitePublication } from "./publication-document.mjs";

const { selectCurrentIndex } = currentIndex;
const SELECTED_FIXTURES = Object.fromEntries(
  Object.entries(PROJECTS).map(([project, spec]) => [project, spec.commit]),
);
const here = path.dirname(fileURLToPath(import.meta.url));
// The publication by default, and a named one when asked. The headline number
// this prints — what a strict provider was worth — is computed here and was
// checked by nobody, because the only input was a file the tests must not
// rewrite. Reading a given path makes the arithmetic testable against a fixture
// without touching the real measurement.
const websiteJson =
  process.env.SAMCHON_BENCH_INDEX_JSON ??
  path.resolve(here, "..", "results", "graph.json");

const published = readJson(websiteJson);
if (published !== null) assertWebsitePublication(published);
const index = published?.index ?? null;
if (index === null) {
  process.stdout.write(
    `No index-time measurement in ${path.relative(process.cwd(), websiteJson)}.\n`,
  );
  process.exit(0);
}

const { index: currentIndexReport, staleCellCount } = selectCurrentIndex(
  index,
  SELECTED_FIXTURES,
);
const measured = new Map();
for (const cell of currentIndexReport.cells) {
  const perTool = measured.get(cell.project) ?? new Map();
  perTool.set(cell.tool, cell);
  measured.set(cell.project, perTool);
}

const rows = Object.keys(PROJECTS).map((project) => {
  const spec = PROJECTS[project];
  const scale = currentIndexReport.scale?.[project];
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
const currentCells = [...measured.values()].flatMap((perTool) => [
  ...perTool.values(),
]);
const measurementKeys = currentCells.map(measurementKey);
const allMeasurementsIdentified = measurementKeys.every(
  (key) => key !== null,
);
const identifiedMeasurements = new Set(
  measurementKeys.filter((key) => key !== null),
);
const uniform =
  currentCells.length > 0 &&
  allMeasurementsIdentified &&
  measurementKeys.every((key) => key === measurementKeys[0])
    ? (currentCells[0]?.host ?? index.host)
    : null;

if (process.argv.includes("--json")) {
  process.stdout.write(
    `${JSON.stringify(
      {
        host: uniform,
        measurementRunCount: allMeasurementsIdentified
          ? identifiedMeasurements.size
          : null,
        staleCellCount,
        rows,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

// One banner only when one machine really did measure everything. These cells
// normally come from thirteen runners, one per language, because two lanes
// sharing a host would corrupt each other's wall clock — so a single header
// would be naming a CPU that twelve of the rows never touched. When the cells
// disagree, each says what it ran on and the reader can see that two rows are
// not one comparison.
if (uniform)
  process.stdout.write(
    `host: ${uniform.cpu ?? "unknown"} — ${String(uniform.cores ?? "?")} cores, ` +
      `${String(uniform.ramGB ?? "?")} GB, ${uniform.os ?? "unknown"}, node ${uniform.node ?? "?"}\n\n`,
  );
else
  process.stdout.write(
    allMeasurementsIdentified
      ? `measured across ${String(identifiedMeasurements.size)} measurement runs; each row names its host.\n\n`
      : "measurement runs are not uniformly identified; each row names its host.\n\n",
  );

if (index.schemaVersion !== 2 || staleCellCount > 0) {
  process.stdout.write(
    `ignored ${String(staleCellCount)} cell(s) without the currently selected full fixture revision.\n\n`,
  );
}

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
    // A cell measured with the providers stood down says so, because
    // "no strict provider served" is also what a failed provider produces and
    // the two must not read alike.
    const via =
      cell.strict === false
        ? "  strict providers stood down"
        : typeof cell.servedBy === "string"
          ? `  via ${cell.servedBy}`
          : "";
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
// printed only where both cells finished semantic work: a timeout bounds a
// duration from below, while a static fallback measures a different product,
// so dividing by either would understate or misdescribe the comparison.
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
      strict.servedBy.startsWith("lsp ") &&
      !/no strict provider/.test(strict.servedBy);
    const strictFallbackSemantic =
      !served &&
      typeof strict.servedBy === "string" &&
      strict.servedBy.startsWith("lsp ");
    const fallbackSemantic =
      typeof fallback.servedBy === "string" &&
      fallback.servedBy.startsWith("lsp ");
    const sameMeasurement =
      typeof strict.measurementId === "string" &&
      strict.measurementId === fallback.measurementId &&
      sameHost(strict.host, fallback.host);
    const verdict = !served && (!strictFallbackSemantic || !fallbackSemantic)
      ? "strict provider did not serve and at least one cell produced no semantic index; times are not comparable"
      : !served && !sameMeasurement
        ? "strict provider did not serve and cells were not measured together on the same host; times are not comparable"
        : !served
          ? "no strict provider served, so both cells measured the same lane (LSP)"
          : !fallbackSemantic
            ? "strict-off cell produced no semantic index; times are not comparable"
            : !sameMeasurement
              ? "cells were not measured together on the same host; times are not comparable"
              : `${(fallback.buildMs / strict.buildMs).toFixed(1)}x`;
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

function sameHost(left, right) {
  return ["cpu", "cores", "ramGB", "os", "kernel", "node"].every(
    (field) => left?.[field] === right?.[field],
  );
}

function measurementKey(cell) {
  return typeof cell.measurementId === "string"
    ? JSON.stringify([
        cell.measurementId,
        ...["cpu", "cores", "ramGB", "os", "kernel", "node"].map(
          (field) => cell.host?.[field],
        ),
      ])
    : null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
