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

const host = index.host ?? {};
process.stdout.write(
  `host: ${host.cpu ?? "unknown"} — ${String(host.cores ?? "?")} cores, ` +
    `${String(host.ramGB ?? "?")} GB, ${host.os ?? "unknown"}, node ${host.node ?? "?"}\n\n`,
);

for (const row of rows) {
  const scale =
    row.files === null
      ? "scale unmeasured"
      : `${String(row.files)} files / ${String(row.lines)} lines`;
  if (row.tools.length === 0) {
    process.stdout.write(
      `  ${pad(row.project, 12)} ${pad(row.language, 11)} ${pad(row.commit, 13)} NOT MEASURED\n`,
    );
    continue;
  }
  for (const [tool, cell] of row.tools) {
    const time =
      typeof cell.buildMs === "number"
        ? `${(cell.buildMs / 1000).toFixed(1)} s`
        : "no build step";
    process.stdout.write(
      `  ${pad(row.project, 12)} ${pad(row.language, 11)} ${pad(row.commit, 13)} ${pad(tool, 17)} ${pad(time, 12)} ${scale}\n`,
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
