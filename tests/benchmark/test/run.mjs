import assert from "node:assert/strict";
import cp from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CORPUS, PROJECTS, projectDir } from "../graph/corpus.mjs";
import {
  analyzePreflightDump,
  pubspecRequiresFlutter,
  assertPinnedCheckout,
} from "../graph/language.mjs";
import { javaSystemProperty } from "../graph/java-tool-options.mjs";
import { summarizeLspRequestTrace } from "../graph/lsp-request-summary.mjs";
import { assertPublicationCandidates } from "../graph/publication-gate.mjs";
import { agentPublicationDocument } from "../graph/publication-document.mjs";
import { removeTree } from "../graph/remove-tree.mjs";
import {
  invalidWebsiteCellReason,
  sanitizeWebsiteSamples,
} from "../graph/website-cell.mjs";
import ordinal from "../graph/ordinal.cjs";
import { assertDeclarationsPrecedeExecution } from "./declaration-order.mjs";
import { assertWorkflowOptionForms } from "./option-form.mjs";
import {
  assertBothIndexColumnsAreMeasured,
  assertStrictComparisonArithmetic,
} from "./two-columns.mjs";

const { compareNaturalOrdinal } = ordinal;

const here = path.dirname(fileURLToPath(import.meta.url));
const benchmarkDir = path.resolve(here, "..");
const repoRoot = path.resolve(benchmarkDir, "..", "..");
const graphDir = path.join(benchmarkDir, "graph");
const manifestPath = path.join(graphDir, "questions", "manifest.json");
const REFERENCE_MANIFEST = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const REFERENCE_PROMPTS = new Map(
  REFERENCE_MANIFEST.prompts.map((prompt) => [
    `${prompt.repo}|${prompt.family}`,
    prompt,
  ]),
);
const FIXTURE_HOST = Object.freeze({
  os: "fixture",
  cpu: "fixture",
  cores: 4,
  ramGB: 16,
});
const INDEX_PROJECT = "excalidraw";
const FIXTURE_COMMIT = PROJECTS[INDEX_PROJECT].commit;
const UNRELATED_PROJECT = "gin";
const UNRELATED_COMMIT = PROJECTS[UNRELATED_PROJECT].commit;
const FIXTURE_AGENT_CELL = Object.freeze({
  harness: "codex",
  tool: "samchon-graph",
  repo: "fixture",
  model: "codex-fixture",
  runs: 1,
  samples: {
    baseline: [{ tokens: 1 }],
    graph: [],
  },
});

testCorpusAndPromptProvenance();
testManifestGenerationIsDeterministic();
testNaturalOrdinalUsesArbitraryPrecision();
testCodexTraceAuditor();
testWebsiteCellValidityGate();
testPublicationRequiresMatchingCodexTraceAudit();
testFixtureAndPreflightIntegrity();
testReferenceRenderer();
assertBothIndexColumnsAreMeasured();
assertStrictComparisonArithmetic();
assertDeclarationsPrecedeExecution(graphDir, ["index-time.mjs"]);
assertWorkflowOptionForms(
  path.join(graphDir, "index-time.mjs"),
  path.join(repoRoot, ".github", "workflows", "index-time.yml"),
);
testPublishedIndexCellsNameTheirMachine();
testAgentPublicationPreservesIndexResults();
testIndexPublicationRefusesMalformedJson();
testIndexCellIsolationContract();
testLspRequestDiagnosisSummary();
testJavaToolOptionEncoding();
testReadOnlyCellCacheCleanup();
console.log("benchmark system tests: ok");

/**
 * A published indexing-time cell says which machine produced it.
 *
 * These cells are measured one language per runner, deliberately: a cold build
 * is a single sample with no median to hide behind, so two lanes sharing a host
 * would corrupt each other's wall clock. That makes thirteen VMs with thirteen
 * CPU models, and the publication used to keep one host panel naming whichever
 * fold landed last — twelve cells attributed to a machine they never touched.
 * The fix was to give every cell its own host, and this is what keeps it: a
 * reader comparing two rows has to be able to see whether they are one
 * comparison.
 *
 * Silent until an `index` key exists, and pointedly not silent after. Until the
 * measurement is published there is nothing to check and nothing to pretend
 * about; the moment there is, every cell answers for itself.
 */
function testPublishedIndexCellsNameTheirMachine() {
  const published = JSON.parse(
    fs.readFileSync(path.join(benchmarkDir, "results", "graph.json"), "utf8"),
  );
  if (published.index === undefined || published.index === null) return;
  const nameless = (published.index.cells ?? []).filter(
    (cell) => typeof cell?.host?.cpu !== "string",
  );
  assert.deepEqual(
    nameless.map((cell) => `${String(cell.project)}/${String(cell.tool)}`),
    [],
    "a published index cell must name the machine it was measured on",
  );
  // Three ways a cell can be legitimate: it timed the build, it has no build
  // step to time, or it ran out of time. The third was rejected here, which
  // would have failed the moment a timeout cell reached the publication —
  // exactly the cells added so that a language exceeding the cap contributes a
  // fact instead of nothing at all.
  const unmeasurable = (published.index.cells ?? []).filter(
    (cell) =>
      typeof cell?.buildMs !== "number" &&
      typeof cell?.timedOutMs !== "number" &&
      cell?.hasBuildStep !== false,
  );
  assert.deepEqual(
    unmeasurable.map((cell) => `${String(cell.project)}/${String(cell.tool)}`),
    [],
    "a published index cell carries a build time, a timeout, or says it has no build step",
  );
  if (published.index.schemaVersion === 2) {
    const stale = (published.index.cells ?? []).filter(
      (cell) =>
        cell?.fixtureCommit !== PROJECTS[cell?.project]?.commit ||
        published.index.fixtures?.[cell?.project] !== cell?.fixtureCommit,
    );
    assert.deepEqual(
      stale.map((cell) => `${String(cell.project)}/${String(cell.tool)}`),
      [],
      "a revision-bound index cell must name the exact currently selected fixture commit",
    );
  }
  // A fallback cell reports "no strict provider served" and so does a strict
  // cell whose provider failed. Only the recorded intent separates them, so a
  // publication that has both columns must say which is which or the comparison
  // it exists for reads as thirteen broken providers.
  const columns = new Set(
    (published.index.cells ?? []).map((cell) => String(cell?.tool)),
  );
  if (columns.has("samchon-graph") && columns.has("samchon-graph-fallback")) {
    const unlabelled = (published.index.cells ?? []).filter(
      (cell) =>
        String(cell?.tool).startsWith("samchon-graph") &&
        typeof cell?.strict !== "boolean",
    );
    assert.deepEqual(
      unlabelled.map(
        (cell) => `${String(cell.project)}/${String(cell.tool)}`,
      ),
      [],
      "a published cell must say whether it was measured with strict providers",
    );
  }
}

function testAgentPublicationPreservesIndexResults() {
  const index = {
    schemaVersion: 2,
    host: FIXTURE_HOST,
    fixtures: { [INDEX_PROJECT]: FIXTURE_COMMIT },
    scale: { [INDEX_PROJECT]: { files: 1, lines: 1 } },
    cells: [
      {
        project: INDEX_PROJECT,
        tool: "samchon-graph",
        buildMs: 1,
        fixtureCommit: FIXTURE_COMMIT,
        measuredAt: "2026-07-28T00:00:00.000Z",
        host: FIXTURE_HOST,
      },
    ],
  };
  const merged = agentPublicationDocument({
    schemaVersion: 1,
    structural: { retained: true },
    agent: { cells: [FIXTURE_AGENT_CELL] },
    index,
  });
  assert.equal(
    merged.index,
    index,
    "an agent-result writer must preserve the indexing axis it does not own",
  );
  assert.equal(
    Object.hasOwn(agentPublicationDocument(null), "index"),
    false,
    "an absent indexing axis must remain absent",
  );
  for (const [label, invalidPrior] of [
    [
      "unsupported schema",
      {
        schemaVersion: 2,
        structural: { retained: true },
        agent: { cells: [FIXTURE_AGENT_CELL] },
      },
    ],
    [
      "malformed agent block",
      {
        schemaVersion: 1,
        structural: { retained: true },
        agent: "not an agent result",
      },
    ],
    [
      "malformed index block",
      {
        schemaVersion: 1,
        structural: { retained: true },
        agent: { cells: [FIXTURE_AGENT_CELL] },
        index: { ...index, host: {} },
      },
    ],
    [
      "malformed stored agent cell",
      {
        schemaVersion: 1,
        structural: { retained: true },
        agent: { cells: [{ repo: "fixture" }] },
      },
    ],
    [
      "duplicate stored agent cell",
      {
        schemaVersion: 1,
        structural: { retained: true },
        agent: { cells: [FIXTURE_AGENT_CELL, { ...FIXTURE_AGENT_CELL }] },
      },
    ],
    [
      "duplicate stored index cell",
      {
        schemaVersion: 1,
        structural: { retained: true },
        agent: { cells: [FIXTURE_AGENT_CELL] },
        index: {
          ...index,
          cells: [index.cells[0], { ...index.cells[0] }],
        },
      },
    ],
  ]) {
    const before = JSON.stringify(invalidPrior);
    assert.throws(
      () => agentPublicationDocument(invalidPrior),
      TypeError,
      `an agent-result writer must reject an ${label}`,
    );
    assert.equal(
      JSON.stringify(invalidPrior),
      before,
      `rejecting an ${label} must not mutate it`,
    );
  }
}

/**
 * Publication is a preserving merge, never recovery by replacement.
 *
 * `graph.json` also carries structural and agent measurements. If either the
 * incoming report or that existing publication is malformed, the only safe
 * action is to leave the destination byte-for-byte alone and fail.
 */
function testIndexPublicationRefusesMalformedJson() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "samchon-graph-index-publish-"),
  );
  const publication = path.join(root, "graph.json");
  const report = path.join(root, "report.json");
  const validPublication = JSON.stringify({
    schemaVersion: 1,
    structural: { retained: true },
    agent: { cells: [FIXTURE_AGENT_CELL] },
  });
  const validReport = JSON.stringify({
    schemaVersion: 2,
    host: FIXTURE_HOST,
    projects: [INDEX_PROJECT],
    tools: ["samchon-graph"],
    fixtures: { [INDEX_PROJECT]: FIXTURE_COMMIT },
    scale: { [INDEX_PROJECT]: { files: 1, lines: 1 } },
    cells: [
      {
        project: INDEX_PROJECT,
        tool: "samchon-graph",
        buildMs: 1,
        fixtureCommit: FIXTURE_COMMIT,
        host: FIXTURE_HOST,
      },
    ],
  });
  const runner = path.join(graphDir, "index-time.mjs");

  fs.writeFileSync(publication, "{malformed publication");
  fs.writeFileSync(report, validReport);
  const malformedPrior = cp.spawnSync(
    process.execPath,
    [runner, `--publish=${report}`],
    {
      encoding: "utf8",
      env: { ...process.env, SAMCHON_BENCH_INDEX_JSON: publication },
      windowsHide: true,
    },
  );
  assert.notEqual(malformedPrior.status, 0);
  assert.equal(
    fs.readFileSync(publication, "utf8"),
    "{malformed publication",
    "a malformed prior publication must not be replaced",
  );

  fs.writeFileSync(publication, validPublication);
  fs.writeFileSync(report, "{malformed report");
  const malformedIncoming = cp.spawnSync(
    process.execPath,
    [runner, `--publish=${report}`],
    {
      encoding: "utf8",
      env: { ...process.env, SAMCHON_BENCH_INDEX_JSON: publication },
      windowsHide: true,
    },
  );
  assert.notEqual(malformedIncoming.status, 0);
  assert.equal(
    fs.readFileSync(publication, "utf8"),
    validPublication,
    "a malformed incoming report must not change the publication",
  );

  const invalidPriorShape = JSON.stringify({
    schemaVersion: 1,
    structural: { retained: true },
    agent: "not an agent result",
    index: { host: {}, scale: {}, cells: [] },
  });
  fs.writeFileSync(publication, invalidPriorShape);
  fs.writeFileSync(report, validReport);
  const shapeInvalidPrior = cp.spawnSync(
    process.execPath,
    [runner, `--publish=${report}`],
    {
      encoding: "utf8",
      env: { ...process.env, SAMCHON_BENCH_INDEX_JSON: publication },
      windowsHide: true,
    },
  );
  assert.notEqual(shapeInvalidPrior.status, 0);
  assert.equal(
    fs.readFileSync(publication, "utf8"),
    invalidPriorShape,
    "a shape-invalid prior publication must not be replaced",
  );

  const unsupportedPriorSchema = JSON.stringify({
    schemaVersion: 2,
    structural: { retained: true },
    agent: { cells: [FIXTURE_AGENT_CELL] },
  });
  fs.writeFileSync(publication, unsupportedPriorSchema);
  fs.writeFileSync(report, validReport);
  const unsupportedPrior = cp.spawnSync(
    process.execPath,
    [runner, `--publish=${report}`],
    {
      encoding: "utf8",
      env: { ...process.env, SAMCHON_BENCH_INDEX_JSON: publication },
      windowsHide: true,
    },
  );
  assert.notEqual(unsupportedPrior.status, 0);
  assert.equal(
    fs.readFileSync(publication, "utf8"),
    unsupportedPriorSchema,
    "an unsupported publication schema must not be rewritten as if it were understood",
  );

  fs.writeFileSync(publication, validPublication);
  const invalidIncomingShape = JSON.stringify({
    host: {},
    scale: {},
    cells: "not an index cell array",
  });
  fs.writeFileSync(report, invalidIncomingShape);
  const shapeInvalidIncoming = cp.spawnSync(
    process.execPath,
    [runner, `--publish=${report}`],
    {
      encoding: "utf8",
      env: { ...process.env, SAMCHON_BENCH_INDEX_JSON: publication },
      windowsHide: true,
    },
  );
  assert.notEqual(shapeInvalidIncoming.status, 0);
  assert.equal(
    fs.readFileSync(publication, "utf8"),
    validPublication,
    "a shape-invalid incoming report must not change the publication",
  );

  fs.writeFileSync(publication, validPublication);
  const hostlessIncomingReport = JSON.stringify({
    schemaVersion: 2,
    host: { cpu: "fixture" },
    projects: [INDEX_PROJECT],
    tools: ["samchon-graph"],
    fixtures: { [INDEX_PROJECT]: FIXTURE_COMMIT },
    scale: { [INDEX_PROJECT]: { files: 1, lines: 1 } },
    cells: [
      {
        project: INDEX_PROJECT,
        tool: "samchon-graph",
        buildMs: 1,
        fixtureCommit: FIXTURE_COMMIT,
        host: FIXTURE_HOST,
      },
    ],
  });
  fs.writeFileSync(report, hostlessIncomingReport);
  const hostlessIncoming = cp.spawnSync(
    process.execPath,
    [runner, `--publish=${report}`],
    {
      encoding: "utf8",
      env: { ...process.env, SAMCHON_BENCH_INDEX_JSON: publication },
      windowsHide: true,
    },
  );
  assert.notEqual(hostlessIncoming.status, 0);
  assert.equal(
    fs.readFileSync(publication, "utf8"),
    validPublication,
    "an incomplete incoming panel host must not change the publication",
  );

  for (const [label, invalidCell] of [
    [
      "unmeasurable",
      {
        project: INDEX_PROJECT,
        tool: "samchon-graph",
        host: FIXTURE_HOST,
      },
    ],
    [
      "contradictory",
      {
        project: INDEX_PROJECT,
        tool: "samchon-graph",
        buildMs: 1,
        timedOutMs: 2,
        host: FIXTURE_HOST,
      },
    ],
    [
      "hostless",
      {
        project: INDEX_PROJECT,
        tool: "samchon-graph",
        buildMs: 1,
      },
    ],
    [
      "incomplete-host",
      {
        project: INDEX_PROJECT,
        tool: "samchon-graph",
        buildMs: 1,
        host: { cpu: "fixture" },
      },
    ],
    [
      "invalid-measurement-date",
      {
        project: INDEX_PROJECT,
        tool: "samchon-graph",
        buildMs: 1,
        measuredAt: "not a date",
        host: FIXTURE_HOST,
      },
    ],
  ]) {
    fs.writeFileSync(publication, validPublication);
    const invalidOutcomeReport = JSON.stringify({
      schemaVersion: 2,
      host: FIXTURE_HOST,
      projects: [INDEX_PROJECT],
      tools: ["samchon-graph"],
      fixtures: { [INDEX_PROJECT]: FIXTURE_COMMIT },
      scale: { [INDEX_PROJECT]: { files: 1, lines: 1 } },
      cells: [{ fixtureCommit: FIXTURE_COMMIT, ...invalidCell }],
    });
    fs.writeFileSync(report, invalidOutcomeReport);
    const invalidOutcome = cp.spawnSync(
      process.execPath,
      [runner, `--publish=${report}`],
      {
        encoding: "utf8",
        env: { ...process.env, SAMCHON_BENCH_INDEX_JSON: publication },
        windowsHide: true,
      },
    );
    assert.notEqual(invalidOutcome.status, 0);
    assert.equal(
      fs.readFileSync(publication, "utf8"),
      validPublication,
      `a ${label} incoming cell must not change the publication`,
    );
  }
  const validReportDocument = JSON.parse(validReport);
  for (const [label, invalidScope] of [
    [
      "missing project scope",
      { ...validReportDocument, projects: undefined },
    ],
    [
      "duplicate tool scope",
      {
        ...validReportDocument,
        tools: ["samchon-graph", "samchon-graph"],
      },
    ],
    [
      "missing scoped scale",
      { ...validReportDocument, scale: {} },
    ],
    [
      "missing fixture revisions",
      { ...validReportDocument, fixtures: undefined },
    ],
    [
      "wrong scoped fixture revision",
      {
        ...validReportDocument,
        fixtures: { [INDEX_PROJECT]: "0".repeat(40) },
      },
    ],
    [
      "out-of-scope scale",
      {
        ...validReportDocument,
        scale: {
          ...validReportDocument.scale,
          [UNRELATED_PROJECT]: { files: 2, lines: 2 },
        },
      },
    ],
    [
      "out-of-scope fixture revision",
      {
        ...validReportDocument,
        fixtures: {
          ...validReportDocument.fixtures,
          [UNRELATED_PROJECT]: UNRELATED_COMMIT,
        },
        scale: {
          ...validReportDocument.scale,
          [UNRELATED_PROJECT]: { files: 2, lines: 2 },
        },
      },
    ],
    [
      "out-of-scope cell",
      {
        ...validReportDocument,
        cells: [
          {
            ...validReportDocument.cells[0],
            tool: "samchon-graph-fallback",
          },
        ],
      },
    ],
    [
      "cell fixture mismatch",
      {
        ...validReportDocument,
        cells: [
          {
            ...validReportDocument.cells[0],
            fixtureCommit: "0".repeat(40),
          },
        ],
      },
    ],
  ]) {
    fs.writeFileSync(publication, validPublication);
    fs.writeFileSync(report, JSON.stringify(invalidScope));
    const invalidScopeOutcome = cp.spawnSync(
      process.execPath,
      [runner, `--publish=${report}`],
      {
        encoding: "utf8",
        env: { ...process.env, SAMCHON_BENCH_INDEX_JSON: publication },
        windowsHide: true,
      },
    );
    assert.notEqual(invalidScopeOutcome.status, 0);
    assert.equal(
      fs.readFileSync(publication, "utf8"),
      validPublication,
      `a report with ${label} must not change the publication`,
    );
  }
  const partialPrior = {
    ...JSON.parse(validPublication),
    index: {
      schemaVersion: 2,
      host: FIXTURE_HOST,
      fixtures: {
        [INDEX_PROJECT]: FIXTURE_COMMIT,
        [UNRELATED_PROJECT]: UNRELATED_COMMIT,
      },
      scale: {
        [INDEX_PROJECT]: { files: 1, lines: 1 },
        [UNRELATED_PROJECT]: { files: 2, lines: 2 },
      },
      cells: [
        {
          project: INDEX_PROJECT,
          tool: "samchon-graph",
          buildMs: 1,
          fixtureCommit: FIXTURE_COMMIT,
          host: FIXTURE_HOST,
        },
        {
          project: INDEX_PROJECT,
          tool: "samchon-graph-fallback",
          buildMs: 2,
          fixtureCommit: FIXTURE_COMMIT,
          host: FIXTURE_HOST,
        },
        {
          project: UNRELATED_PROJECT,
          tool: "samchon-graph",
          buildMs: 3,
          fixtureCommit: UNRELATED_COMMIT,
          host: FIXTURE_HOST,
        },
      ],
    },
  };
  const incompletePairReport = {
    schemaVersion: 2,
    host: FIXTURE_HOST,
    projects: [INDEX_PROJECT],
    tools: ["samchon-graph", "samchon-graph-fallback"],
    fixtures: { [INDEX_PROJECT]: FIXTURE_COMMIT },
    scale: { [INDEX_PROJECT]: { files: 4, lines: 4 } },
    cells: [
      {
        project: INDEX_PROJECT,
        tool: "samchon-graph",
        buildMs: 4,
        fixtureCommit: FIXTURE_COMMIT,
        host: FIXTURE_HOST,
      },
    ],
  };
  fs.writeFileSync(publication, JSON.stringify(partialPrior));
  fs.writeFileSync(report, JSON.stringify(incompletePairReport));
  const partial = cp.spawnSync(
    process.execPath,
    [runner, `--publish=${report}`],
    {
      encoding: "utf8",
      env: { ...process.env, SAMCHON_BENCH_INDEX_JSON: publication },
      windowsHide: true,
    },
  );
  assert.equal(partial.status, 0, partial.stderr);
  const partialPublication = JSON.parse(fs.readFileSync(publication, "utf8"));
  assert.deepEqual(
    partialPublication.index.cells.map((cell) => [
      cell.project,
      cell.tool,
      cell.buildMs,
    ]),
    [
      [UNRELATED_PROJECT, "samchon-graph", 3],
      [INDEX_PROJECT, "samchon-graph", 4],
    ],
    "an incomplete partial report must remove every old cell in its declared project/tool scope",
  );
  assert.deepEqual(partialPublication.structural, { retained: true });
  assert.deepEqual(partialPublication.agent, {
    cells: [FIXTURE_AGENT_CELL],
  });
  const revisionlessPrior = {
    ...JSON.parse(validPublication),
    index: {
      host: FIXTURE_HOST,
      scale: { [UNRELATED_PROJECT]: { files: 2, lines: 2 } },
      cells: [
        {
          project: UNRELATED_PROJECT,
          tool: "samchon-graph",
          buildMs: 3,
          host: FIXTURE_HOST,
        },
      ],
    },
  };
  fs.writeFileSync(publication, JSON.stringify(revisionlessPrior));
  fs.writeFileSync(report, validReport);
  const migrated = cp.spawnSync(
    process.execPath,
    [runner, `--publish=${report}`],
    {
      encoding: "utf8",
      env: { ...process.env, SAMCHON_BENCH_INDEX_JSON: publication },
      windowsHide: true,
    },
  );
  assert.equal(migrated.status, 0, migrated.stderr);
  const migratedPublication = JSON.parse(
    fs.readFileSync(publication, "utf8"),
  );
  assert.deepEqual(
    {
      schemaVersion: migratedPublication.index.schemaVersion,
      fixtures: migratedPublication.index.fixtures,
      scale: migratedPublication.index.scale,
      cells: migratedPublication.index.cells.map((cell) => [
        cell.project,
        cell.fixtureCommit,
      ]),
    },
    {
      schemaVersion: 2,
      fixtures: { [INDEX_PROJECT]: FIXTURE_COMMIT },
      scale: { [INDEX_PROJECT]: { files: 1, lines: 1 } },
      cells: [[INDEX_PROJECT, FIXTURE_COMMIT]],
    },
    "a preserving fold must discard revisionless prior measurements instead of joining them to the current corpus",
  );
  const stalePublication = {
    ...JSON.parse(validPublication),
    index: {
      schemaVersion: 2,
      host: FIXTURE_HOST,
      fixtures: { [UNRELATED_PROJECT]: UNRELATED_COMMIT },
      scale: { [UNRELATED_PROJECT]: { files: 1, lines: 1 } },
      cells: [
        {
          project: UNRELATED_PROJECT,
          tool: "samchon-graph",
          buildMs: 1,
          fixtureCommit: UNRELATED_COMMIT,
          host: FIXTURE_HOST,
        },
      ],
    },
  };
  fs.writeFileSync(publication, JSON.stringify(stalePublication));
  const reset = cp.spawnSync(process.execPath, [runner, "--reset-index-only"], {
    encoding: "utf8",
    env: { ...process.env, SAMCHON_BENCH_INDEX_JSON: publication },
    windowsHide: true,
  });
  assert.equal(reset.status, 0, reset.stderr);
  const resetPublication = JSON.parse(fs.readFileSync(publication, "utf8"));
  assert.equal(
    resetPublication.index,
    undefined,
    "a complete matrix must not inherit an unmeasured stale index cell",
  );
  assert.deepEqual(resetPublication.structural, { retained: true });
  assert.deepEqual(resetPublication.agent, { cells: [FIXTURE_AGENT_CELL] });
  fs.rmSync(root, { recursive: true, force: true });
}

function testIndexCellIsolationContract() {
  const source = fs.readFileSync(
    path.join(graphDir, "index-time.mjs"),
    "utf8",
  );
  const workflow = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "index-time.yml"),
    "utf8",
  );
  const diagnosis = fs.readFileSync(
    path.join(graphDir, "lsp-request-diagnosis.mjs"),
    "utf8",
  );
  const prepared = source.indexOf(
    "cellRepoDir = prepareCellFixture(project, spec, repoDir, tool)",
  );
  const scaled = source.indexOf("report.scale[project] = measureScale(");
  const scopedReport = source.indexOf("writeJson(reportPath, report);", scaled);
  const measuredProjects = source.indexOf(
    "for (const project of selected)",
    scopedReport,
  );
  const quiet = source.indexOf(
    "const quietWait = await quietHostForCell(project, tool)",
  );
  const timed = source.indexOf("cell = runIndexCell({", quiet);
  assert.ok(
    scaled >= 0 &&
      scopedReport > scaled &&
      measuredProjects > scopedReport &&
      prepared > measuredProjects,
    "every selected project must have scale metadata before the first scoped cell can publish",
  );
  assert.ok(
    prepared >= 0 && quiet > prepared && timed > quiet,
    "each index-time cell must settle the host after preparation and immediately before timing",
  );
  for (const variable of [
    "NUGET_PACKAGES",
    "NUGET_HTTP_CACHE_PATH",
    "NUGET_SCRATCH",
    "NUGET_PLUGINS_CACHE_PATH",
    "DOTNET_CLI_HOME",
  ]) {
    assert.ok(
      source.includes(`env.${variable} = path.join(root,`),
      `C# cell isolation must redirect ${variable}`,
    );
  }
  assert.ok(
    source.includes("env.JAVA_TOOL_OPTIONS = [") &&
      source.includes("process.env.JAVA_TOOL_OPTIONS") &&
      source.includes(
        'javaSystemProperty("maven.repo.local", localRepository)',
      ) &&
      !source.includes("env.MAVEN_OPTS = ["),
    "Maven-launched JVMs and direct JDTLS must share one quoted, caller-preserving local-repository property",
  );
  assert.ok(
    !source.includes('SAMCHON_GRAPH_LSP_REQUEST_TRACE: "1"') &&
      source.includes('SAMCHON_GRAPH_LSP_REQUEST_TRACE: "0"') &&
      diagnosis.includes('SAMCHON_GRAPH_LSP_REQUEST_TRACE: "1"') &&
      diagnosis.includes("authoritative: false") &&
      diagnosis.includes('"--no-hardlinks"') &&
      diagnosis.includes("prepareFixture(spec, fixtureDir)") &&
      diagnosis.includes("removeTree(fixtureDir)"),
    "authoritative graph cells must stay trace-free while a separate diagnostic run records request evidence",
  );
  assert.ok(
    workflow.indexOf("Measure cold index build") >= 0 &&
      workflow.indexOf("Measure cold index build") <
      workflow.indexOf("Diagnose slow LSP requests outside the measurement") &&
      workflow.includes("--project=${{ matrix.project }}") &&
      workflow.includes("--timeout-ms=300000") &&
      workflow.includes("timeout-minutes: 10"),
    "slow-lane request diagnosis must run after the authoritative measurement with its own bounded budget",
  );
  assert.ok(
    source.includes("copyPreparedFixtureCompanion(spec, source, target)") &&
      source.includes("const cellRoot = path.dirname(path.resolve(target))") &&
      source.includes("removeTree(cellRoot)") &&
      source.includes('import { removeTree } from "./remove-tree.mjs"'),
    "a disposable cell must copy and remove its external prepared companion",
  );
  assert.ok(
    workflow.indexOf("--reset-index-only") >= 0 &&
      workflow.indexOf("--reset-index-only") <
        workflow.indexOf(
          'node tests/benchmark/graph/index-time.mjs --publish="$report"',
        ),
    "a complete matrix must discard stale index cells before folding current reports",
  );
}

function testLspRequestDiagnosisSummary() {
  const summary = summarizeLspRequestTrace(
    [
      "unrelated stderr",
      '@samchon/graph: lsp-request client=1 id=2 method="textDocument/references" phase=start',
      '@samchon/graph: lsp-request client=1 id=1 method="initialize" phase=start',
      '@samchon/graph: lsp-request client=1 id=1 method="initialize" phase=end status=success durationMs=12.500',
      '@samchon/graph: lsp-request client=1 id=3 method="textDocument/references" phase=start',
      '@samchon/graph: lsp-request client=1 id=3 method="textDocument/references" phase=end status=error durationMs=4.250',
    ].join("\n"),
  );
  assert.deepEqual(
    {
      cutoffObserved: summary.cutoffObserved,
      requestCount: summary.requestCount,
      completedCount: summary.completedCount,
      postCutoffEndCount: summary.postCutoffEndCount,
      postCutoffErrorCount: summary.postCutoffErrorCount,
      cleanupRequestCount: summary.cleanupRequestCount,
      cleanupCompletedCount: summary.cleanupCompletedCount,
      cleanupErrorCount: summary.cleanupErrorCount,
      inFlight: summary.inFlight,
      cleanupInFlight: summary.cleanupInFlight,
      methods: summary.methods,
    },
    {
      cutoffObserved: false,
      requestCount: 3,
      completedCount: 2,
      postCutoffEndCount: 0,
      postCutoffErrorCount: 0,
      cleanupRequestCount: 0,
      cleanupCompletedCount: 0,
      cleanupErrorCount: 0,
      inFlight: [
        { client: 1, id: 2, method: "textDocument/references" },
      ],
      cleanupInFlight: [],
      methods: {
        initialize: {
          started: 1,
          completed: 1,
          errors: 0,
          totalDurationMs: 12.5,
          maxDurationMs: 12.5,
          postCutoffEnds: 0,
          postCutoffErrors: 0,
          postCutoffMaxDurationMs: 0,
          cleanupStarted: 0,
          cleanupCompleted: 0,
          cleanupErrors: 0,
          cleanupTotalDurationMs: 0,
          cleanupMaxDurationMs: 0,
        },
        "textDocument/references": {
          started: 2,
          completed: 1,
          errors: 1,
          totalDurationMs: 4.25,
          maxDurationMs: 4.25,
          postCutoffEnds: 0,
          postCutoffErrors: 0,
          postCutoffMaxDurationMs: 0,
          cleanupStarted: 0,
          cleanupCompleted: 0,
          cleanupErrors: 0,
          cleanupTotalDurationMs: 0,
          cleanupMaxDurationMs: 0,
        },
      },
    },
    "request diagnosis must preserve completed progress and the exact call still in flight",
  );

  const cutoff = summarizeLspRequestTrace(
    [
      '@samchon/graph: lsp-request client=1 id=1 method="initialize" phase=start',
      '@samchon/graph: lsp-request client=1 id=1 method="initialize" phase=end status=success durationMs=12.500',
      '@samchon/graph: lsp-request client=1 id=2 method="textDocument/references" phase=start',
      '@samchon/graph: lsp-request client=2 id=1 method="textDocument/references" phase=start',
      "@samchon/graph: lsp-request phase=cutoff",
      '@samchon/graph: lsp-request client=1 id=2 method="textDocument/references" phase=end status=error durationMs=300001.000',
      '@samchon/graph: lsp-request client=2 id=1 method="textDocument/references" phase=end status=error durationMs=299999.000',
      '@samchon/graph: lsp-request client=1 id=3 method="shutdown" phase=start',
      '@samchon/graph: lsp-request client=1 id=3 method="shutdown" phase=end status=success durationMs=4.000',
    ].join("\n"),
  );
  assert.deepEqual(
    cutoff,
    {
      cutoffObserved: true,
      requestCount: 3,
      completedCount: 1,
      postCutoffEndCount: 2,
      postCutoffErrorCount: 2,
      cleanupRequestCount: 1,
      cleanupCompletedCount: 1,
      cleanupErrorCount: 0,
      inFlight: [
        { client: 1, id: 2, method: "textDocument/references" },
        { client: 2, id: 1, method: "textDocument/references" },
      ],
      cleanupInFlight: [],
      methods: {
        initialize: {
          started: 1,
          completed: 1,
          errors: 0,
          totalDurationMs: 12.5,
          maxDurationMs: 12.5,
          postCutoffEnds: 0,
          postCutoffErrors: 0,
          postCutoffMaxDurationMs: 0,
          cleanupStarted: 0,
          cleanupCompleted: 0,
          cleanupErrors: 0,
          cleanupTotalDurationMs: 0,
          cleanupMaxDurationMs: 0,
        },
        shutdown: {
          started: 0,
          completed: 0,
          errors: 0,
          totalDurationMs: 0,
          maxDurationMs: 0,
          postCutoffEnds: 0,
          postCutoffErrors: 0,
          postCutoffMaxDurationMs: 0,
          cleanupStarted: 1,
          cleanupCompleted: 1,
          cleanupErrors: 0,
          cleanupTotalDurationMs: 4,
          cleanupMaxDurationMs: 4,
        },
        "textDocument/references": {
          started: 2,
          completed: 0,
          errors: 0,
          totalDurationMs: 0,
          maxDurationMs: 0,
          postCutoffEnds: 2,
          postCutoffErrors: 2,
          postCutoffMaxDurationMs: 300001,
          cleanupStarted: 0,
          cleanupCompleted: 0,
          cleanupErrors: 0,
          cleanupTotalDurationMs: 0,
          cleanupMaxDurationMs: 0,
        },
      },
    },
    "request diagnosis must freeze in-flight identities before abort cleanup emits terminal errors",
  );

  for (const [label, lines, pattern] of [
    [
      "incomplete end",
      [
        '@samchon/graph: lsp-request client=1 id=1 method="initialize" phase=start',
        '@samchon/graph: lsp-request client=1 id=1 method="initialize" phase=end',
      ],
      /malformed LSP request trace/,
    ],
    [
      "duplicate start",
      [
        '@samchon/graph: lsp-request client=1 id=1 method="initialize" phase=start',
        '@samchon/graph: lsp-request client=1 id=1 method="initialize" phase=start',
      ],
      /duplicate LSP request start/,
    ],
    [
      "orphan end",
      [
        '@samchon/graph: lsp-request client=1 id=1 method="initialize" phase=end status=success durationMs=1.000',
      ],
      /orphan LSP request end/,
    ],
    [
      "changed method",
      [
        '@samchon/graph: lsp-request client=1 id=1 method="initialize" phase=start',
        '@samchon/graph: lsp-request client=1 id=1 method="shutdown" phase=end status=success durationMs=1.000',
      ],
      /changed method/,
    ],
    [
      "duplicate cutoff",
      [
        "@samchon/graph: lsp-request phase=cutoff",
        "@samchon/graph: lsp-request phase=cutoff",
      ],
      /duplicate LSP request cutoff/,
    ],
  ]) {
    assert.throws(
      () => summarizeLspRequestTrace(lines.join("\n")),
      pattern,
      `request diagnosis must reject a ${label}`,
    );
  }
}

function testJavaToolOptionEncoding() {
  assert.equal(
    javaSystemProperty(
      "maven.repo.local",
      "D:/benchmark output/cell cache/maven",
    ),
    '-Dmaven.repo.local="D:/benchmark output/cell cache/maven"',
    "the JVM-owned Maven repository property must preserve spaces in a legal output path",
  );
  assert.equal(
    javaSystemProperty("fixture", 'D:/benchmark "quoted"/cache'),
    '-Dfixture="D:/benchmark \\"quoted\\"/cache"',
    "the JVM-owned property must escape quotes inside its value",
  );
  assert.throws(
    () => javaSystemProperty("invalid property", "fixture"),
    /invalid Java system property name/,
  );
}

/**
 * Ecosystem caches are disposable benchmark state even when their tool marks
 * them read-only. Go's module cache does this on POSIX, and a retry without a
 * permission repair produced the exact same EACCES until the lane failed.
 */
function testReadOnlyCellCacheCleanup() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "samchon-graph-readonly-cache-"),
  );
  const nested = path.join(root, "module");
  const file = path.join(nested, ".gitignore");
  fs.mkdirSync(nested);
  fs.writeFileSync(file, "fixture\n");
  fs.chmodSync(file, 0o400);
  fs.chmodSync(nested, 0o500);
  try {
    removeTree(root);
    assert.equal(
      fs.existsSync(root),
      false,
      "a read-only module cache must not stop the next benchmark column",
    );
  } finally {
    if (fs.existsSync(root)) {
      if (fs.existsSync(nested)) fs.chmodSync(nested, 0o700);
      fs.chmodSync(root, 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

function testCorpusAndPromptProvenance() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(
    manifest.prompts.length,
    CORPUS.reduce(
      (count, spec) =>
        count +
        1 +
        Number(fs.existsSync(path.join(graphDir, "questions", `${spec.name}.md`))),
      0,
    ),
  );
  assert.deepEqual(Object.keys(PROJECTS), CORPUS.map((entry) => entry.name));
  for (const spec of CORPUS) {
    assert.match(spec.commit, /^[0-9a-f]{40}$/);
    assert.equal(PROJECTS[spec.name].sourceRepo, spec.url);
    assert.equal(PROJECTS[spec.name].sourceBranch, spec.commit);
    assert.ok(spec.preflight.nodes > 0);
    assert.ok(spec.preflight.edges > 0);
    assert.ok(spec.preflight.semanticEdges > 0);
    assert.ok(spec.preflight.semanticEdgeKinds > 0);
    if (spec.language === "csharp") {
      assert.equal(spec.prepare, undefined);
      assert.ok(spec.dotnetSolution?.projects.length > 0);
    }
    assert.equal(
      projectDir("C:/work", spec).replace(/\\/g, "/"),
      `C:/work/${spec.name}@${spec.commit.slice(0, 12)}`,
    );
    const families = fs.existsSync(
      path.join(graphDir, "questions", `${spec.name}.md`),
    )
      ? ["dedicated", "common"]
      : ["common"];
    for (const family of families) {
      const prompt = manifest.prompts.find(
        (entry) => entry.repo === spec.name && entry.family === family,
      );
      assert.ok(prompt, `${spec.name}/${family} prompt is present`);
      assert.equal(prompt.fixtureCommit, spec.commit);
      assert.equal(prompt.language, spec.language);
      const text = fs
        .readFileSync(path.join(graphDir, "questions", prompt.file), "utf8")
        .replace(/\r\n/g, "\n")
        .trim();
      assert.equal(sha256(text), prompt.questionSha256);
    }
  }
}

function testManifestGenerationIsDeterministic() {
  const before = fs.readFileSync(manifestPath);
  run(process.execPath, [path.join(graphDir, "generate-manifest.mjs")]);
  const after = fs.readFileSync(manifestPath);
  assert.deepEqual(after, before);
}

function testNaturalOrdinalUsesArbitraryPrecision() {
  const nineHundredNines = `graph-run-${"9".repeat(400)}.stream.jsonl`;
  const oneFollowedByFourHundredZeroes = `graph-run-1${"0".repeat(400)}.stream.jsonl`;
  assert.ok(compareNaturalOrdinal(nineHundredNines, oneFollowedByFourHundredZeroes) < 0);
  assert.deepEqual(
    [oneFollowedByFourHundredZeroes, nineHundredNines].sort(compareNaturalOrdinal),
    [nineHundredNines, oneFollowedByFourHundredZeroes],
  );
}

function testCodexTraceAuditor() {
  run(process.execPath, [path.join(graphDir, "audit-codex-traces.mjs"), "--self-test"]);
}

function testWebsiteCellValidityGate() {
  const valid = {
    runs: 1,
    samples: {
      baseline: [{ ok: true, tokens: 100, shell: 2, sourceTouches: 2, graph: 0 }],
      graph: [{ ok: true, tokens: 20, shell: 0, sourceTouches: 0, graph: 1 }],
    },
  };
  assert.equal(invalidWebsiteCellReason(valid), null);
  assert.match(
    invalidWebsiteCellReason({
      ...valid,
      samples: { ...valid.samples, graph: [{ ...valid.samples.graph[0], graph: 0 }] },
    }),
    /no MCP call/,
  );
  assert.match(
    invalidWebsiteCellReason({
      ...valid,
      samples: { ...valid.samples, graph: [{ ...valid.samples.graph[0], shell: 1 }] },
    }),
    /shell\/source\/web-fallback/,
  );
  assert.match(
    invalidWebsiteCellReason({
      ...valid,
      samples: { ...valid.samples, graph: [{ ...valid.samples.graph[0], web: 1 }] },
    }),
    /shell\/source\/web-fallback/,
  );
  assert.match(
    invalidWebsiteCellReason({
      ...valid,
      samples: { ...valid.samples, graph: [{ ...valid.samples.graph[0], ok: false }] },
    }),
    /failed sample/,
  );
  assert.match(
    invalidWebsiteCellReason({
      ...valid,
      samples: sanitizeWebsiteSamples({
        ...valid.samples,
        graph: [{ ...valid.samples.graph[0], ok: false }],
      }),
    }),
    /failed sample/,
  );
  assert.match(
    invalidWebsiteCellReason({ ...valid, runs: 2 }),
    /1\/2 requested samples/,
  );
  assert.match(
    invalidWebsiteCellReason({ runs: 1, samples: { baseline: [], graph: [] } }),
    /no samples/,
  );
}

function testPublicationRequiresMatchingCodexTraceAudit() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "samchon-publication-gate-"));
  const traceDir = path.join(root, "traces");
  const reportPath = path.join(root, "report.json");
  const auditPath = path.join(root, "audit.json");
  fs.mkdirSync(traceDir);
  fs.writeFileSync(
    path.join(traceDir, "graph-run-1.stream.jsonl"),
    [
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          server: "samchon-graph",
          tool: "inspect",
          arguments: {},
          result: { content: [{ type: "text", text: "{}" }] },
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "done" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 7,
          cached_input_tokens: 0,
          output_tokens: 3,
          reasoning_output_tokens: 0,
        },
      }),
      "",
    ].join("\n"),
  );
  const sample = {
    ok: true,
    tokens: 10,
    cached: 0,
    reasoning: 0,
    turns: 1,
    tools: 1,
    shell: 0,
    graph: 1,
    web: 0,
    sourceTouches: 0,
    run: 1,
  };
  const report = {
    repo: "fixture",
    commit: "1".repeat(40),
    fixtureTree: "2".repeat(40),
    fixtureBranch: "1".repeat(40),
    question: "question",
    questionSha256: sha256("question"),
    traceDir,
    runs: 1,
    samples: {
      baseline: [],
      graph: [{ ...sample, questionSha256: sha256("question") }],
    },
  };
  fs.writeFileSync(reportPath, JSON.stringify(report));
  const cell = {
    runs: 1,
    samples: report.samples,
    harness: "codex",
    repo: "fixture",
    fixtureBranch: "1".repeat(40),
    questionSha256: sha256("question"),
  };
  assert.equal(
    assertPublicationCandidates(
      [{ cell, harness: "codex", reportPath }],
      { auditPath },
    ),
    auditPath,
  );
  fs.writeFileSync(
    reportPath,
    JSON.stringify({
      ...report,
      samples: {
        baseline: [],
        graph: [
          {
            ...sample,
            tokens: 11,
            questionSha256: sha256("question"),
          },
        ],
      },
    }),
  );
  assert.throws(
    () =>
      assertPublicationCandidates(
        [{ cell, harness: "codex", reportPath }],
        { auditPath },
      ),
    /tokens trace=10 sample=11/,
  );
  fs.rmSync(root, { recursive: true, force: true });
}

function testFixtureAndPreflightIntegrity() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "samchon-fixture-git-"));
  run("git", ["init", "--quiet", root]);
  run("git", ["-C", root, "config", "user.email", "benchmark@example.test"]);
  run("git", ["-C", root, "config", "user.name", "Benchmark Test"]);
  const source = path.join(root, "source.txt");
  fs.writeFileSync(source, "pinned\n");
  run("git", ["-C", root, "add", "source.txt"]);
  run("git", ["-C", root, "commit", "--quiet", "-m", "fixture"]);
  const commit = output("git", ["-C", root, "rev-parse", "HEAD"]).trim();
  const spec = { name: "fixture", commit };
  assert.equal(assertPinnedCheckout(spec, root).commit, commit);
  const extra = path.join(root, "extra.txt");
  fs.writeFileSync(extra, "untracked\n");
  assert.throws(() => assertPinnedCheckout(spec, root), /clean pinned snapshot/);
  fs.rmSync(extra);
  fs.writeFileSync(source, "changed\n");
  assert.throws(() => assertPinnedCheckout(spec, root), /clean pinned snapshot/);
  fs.writeFileSync(source, "pinned\n");
  assert.equal(assertPinnedCheckout(spec, root).commit, commit);

  const flightSpec = {
    name: "fixture",
    preflight: {
      nodes: 2,
      edges: 4,
      semanticEdges: 2,
      semanticEdgeKinds: 2,
    },
  };
  const dump = {
    indexer: "lsp",
    nodes: [{}, {}],
    edges: [
      { kind: "contains" },
      { kind: "exports" },
      { kind: "calls" },
      { kind: "type_ref" },
    ],
    warnings: [],
  };
  assert.equal(analyzePreflightDump(flightSpec, dump).ok, true);
  const structuralOnly = analyzePreflightDump(flightSpec, {
    ...dump,
    edges: dump.edges.slice(0, 2),
    warnings: ["server kept structural edges only"],
  });
  assert.equal(structuralOnly.ok, false);
  assert.match(structuralOnly.failures.join("; "), /fatal warning/);
  assert.match(structuralOnly.failures.join("; "), /semantic edges/);
  assert.equal(
    pubspecRequiresFlutter("dependencies:\n  flutter:\n    sdk: flutter\n"),
    true,
  );
  assert.equal(
    pubspecRequiresFlutter("environment:\n  sdk: ^3.4.0\n"),
    false,
  );
  fs.rmSync(root, { recursive: true, force: true });
}

function testReferenceRenderer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "samchon-graph-render-"));
  const input = path.join(root, "graph.json");
  const out = path.join(root, "out");
  fs.writeFileSync(input, JSON.stringify(sampleReport()));
  const env = {
    ...process.env,
    SAMCHON_GRAPH_BENCH_INPUT: input,
    SAMCHON_GRAPH_BENCH_RENDER_OUT: out,
  };
  run(
    process.execPath,
    [path.join(benchmarkDir, "build", "graph-benchmark-svg.cjs"), "--png"],
    env,
  );
  const first = snapshot(out);
  const chartNames = [
    "graph-common-codex-gpt-5.6-terra",
    "graph-excalidraw-common-codex-gpt-5.6-terra",
    "graph-gin-common-codex-gpt-5.6-terra",
    "graph-time-to-answer",
  ];
  assert.deepEqual(
    [...first.keys()],
    [
      ...chartNames.map((name) => `png/${name}.png`),
      ...chartNames.map((name) => `svg/${name}.svg`),
    ].sort(),
    "the reference renderer emits the grouped, per-repo, and time charts in both formats",
  );
  run(
    process.execPath,
    [path.join(benchmarkDir, "build", "graph-benchmark-svg.cjs"), "--png"],
    env,
  );
  assert.deepEqual(snapshot(out), first, "renderer output is byte deterministic");

  const grouped = fs.readFileSync(
    path.join(out, "svg", `${chartNames[0]}.svg`),
    "utf8",
  );
  for (const label of [
    "baseline",
    "@samchon/graph",
    "codegraph",
    "codebase-memory",
    "serena",
  ])
    assert.match(grouped, new RegExp(escapeRegExp(label)));
  assert.match(
    grouped,
    /M2\.5 5\.5 5\.4 8l2\.6-4/,
    "the reference crown geometry marks the winner",
  );

  const time = fs.readFileSync(
    path.join(out, "svg", "graph-time-to-answer.svg"),
    "utf8",
  );
  assert.match(time, /Cold time to a first answer/);
  assert.match(time, /faded = index build, solid = LLM answering/);
  assert.match(time, /20,000 lines/);

  const staleReport = sampleReport();
  staleReport.index.fixtures.excalidraw = "0".repeat(40);
  for (const cell of staleReport.index.cells) {
    if (cell.project === "excalidraw") cell.fixtureCommit = "0".repeat(40);
  }
  const staleOut = path.join(root, "stale-out");
  fs.writeFileSync(input, JSON.stringify(staleReport));
  run(
    process.execPath,
    [path.join(benchmarkDir, "build", "graph-benchmark-svg.cjs")],
    {
      ...env,
      SAMCHON_GRAPH_BENCH_RENDER_OUT: staleOut,
    },
  );
  const staleTime = fs.readFileSync(
    path.join(staleOut, "svg", "graph-time-to-answer.svg"),
    "utf8",
  );
  assert.doesNotMatch(staleTime, /Excalidraw|20,000 lines/);
  assert.match(staleTime, /Gin|12,000 lines/);

  const legacyReport = sampleReport();
  delete legacyReport.index.schemaVersion;
  delete legacyReport.index.fixtures;
  for (const cell of legacyReport.index.cells) delete cell.fixtureCommit;
  const legacyOut = path.join(root, "legacy-out");
  fs.mkdirSync(path.join(legacyOut, "svg"), { recursive: true });
  fs.mkdirSync(path.join(legacyOut, "png"), { recursive: true });
  fs.writeFileSync(
    path.join(legacyOut, "svg", "graph-time-to-answer.svg"),
    "stale",
  );
  fs.writeFileSync(
    path.join(legacyOut, "png", "graph-time-to-answer.png"),
    "stale",
  );
  fs.writeFileSync(input, JSON.stringify(legacyReport));
  run(
    process.execPath,
    [path.join(benchmarkDir, "build", "graph-benchmark-svg.cjs")],
    {
      ...env,
      SAMCHON_GRAPH_BENCH_RENDER_OUT: legacyOut,
    },
  );
  assert.equal(
    fs.existsSync(path.join(legacyOut, "svg", "graph-time-to-answer.svg")),
    false,
    "the renderer removes revisionless SVG index-time evidence",
  );
  assert.equal(
    fs.existsSync(path.join(legacyOut, "png", "graph-time-to-answer.png")),
    false,
    "the renderer removes revisionless PNG index-time evidence",
  );

  const staleAgentReport = sampleReport();
  const staleAgentOut = path.join(root, "stale-agent-out");
  fs.writeFileSync(input, JSON.stringify(sampleReport()));
  run(
    process.execPath,
    [path.join(benchmarkDir, "build", "graph-benchmark-svg.cjs"), "--png"],
    {
      ...env,
      SAMCHON_GRAPH_BENCH_RENDER_OUT: staleAgentOut,
    },
  );
  assert.equal(
    fs.existsSync(
      path.join(staleAgentOut, "png", "graph-time-to-answer.png"),
    ),
    true,
  );
  for (const cell of staleAgentReport.agent.cells) {
    if (cell.repo === "excalidraw") cell.fixtureBranch = "0".repeat(40);
  }
  fs.writeFileSync(input, JSON.stringify(staleAgentReport));
  run(
    process.execPath,
    [path.join(benchmarkDir, "build", "graph-benchmark-svg.cjs")],
    {
      ...env,
      SAMCHON_GRAPH_BENCH_RENDER_OUT: staleAgentOut,
    },
  );
  const staleAgentFiles = [...snapshot(staleAgentOut).keys()];
  assert.deepEqual(
    staleAgentFiles,
    [
      "png/graph-gin-common-codex-gpt-5.6-terra.png",
      "svg/graph-common-codex-gpt-5.6-terra.svg",
      "svg/graph-gin-common-codex-gpt-5.6-terra.svg",
      "svg/graph-time-to-answer.svg",
    ],
    "stale agent charts and same-name PNG pixels are removed while unchanged current PNGs survive",
  );
  for (const name of [
    "graph-common-codex-gpt-5.6-terra.svg",
    "graph-time-to-answer.svg",
  ]) {
    const svg = fs.readFileSync(path.join(staleAgentOut, "svg", name), "utf8");
    assert.doesNotMatch(svg, /Excalidraw|20,000 lines/);
    assert.match(svg, /Gin|12,000 lines/);
  }

  const staleQuestionReport = sampleReport();
  for (const cell of staleQuestionReport.agent.cells) {
    if (cell.repo === "excalidraw") {
      cell.questionSha256 = "0".repeat(64);
    }
  }
  const staleQuestionOut = path.join(root, "stale-question-out");
  fs.writeFileSync(input, JSON.stringify(staleQuestionReport));
  run(
    process.execPath,
    [path.join(benchmarkDir, "build", "graph-benchmark-svg.cjs")],
    {
      ...env,
      SAMCHON_GRAPH_BENCH_RENDER_OUT: staleQuestionOut,
    },
  );
  const staleQuestionTime = fs.readFileSync(
    path.join(staleQuestionOut, "svg", "graph-time-to-answer.svg"),
    "utf8",
  );
  assert.doesNotMatch(staleQuestionTime, /Excalidraw|20,000 lines/);
  assert.match(staleQuestionTime, /Gin|12,000 lines/);
  assert.equal(
    fs.existsSync(
      path.join(
        staleQuestionOut,
        "svg",
        "graph-excalidraw-common-codex-gpt-5.6-terra.svg",
      ),
    ),
    false,
    "an old question hash cannot produce a current token chart",
  );

  const outcomeReport = sampleReport();
  outcomeReport.agent.cells = outcomeReport.agent.cells.filter(
    (cell) => cell.repo === "gin",
  );
  const timeoutCell = outcomeReport.index.cells.find(
    (cell) => cell.project === "gin" && cell.tool === "samchon-graph",
  );
  delete timeoutCell.buildMs;
  timeoutCell.timedOutMs = 3_600_000;
  outcomeReport.index.cells = outcomeReport.index.cells.filter(
    (cell) => cell.project !== "gin" || cell.tool !== "codegraph",
  );
  const noBuildCell = outcomeReport.index.cells.find(
    (cell) => cell.project === "gin" && cell.tool === "codebase-memory",
  );
  delete noBuildCell.buildMs;
  noBuildCell.hasBuildStep = false;
  const outcomeOut = path.join(root, "outcome-out");
  fs.writeFileSync(input, JSON.stringify(outcomeReport));
  run(
    process.execPath,
    [path.join(benchmarkDir, "build", "graph-benchmark-svg.cjs")],
    {
      ...env,
      SAMCHON_GRAPH_BENCH_RENDER_OUT: outcomeOut,
    },
  );
  const outcomeTime = fs.readFileSync(
    path.join(outcomeOut, "svg", "graph-time-to-answer.svg"),
    "utf8",
  );
  assert.doesNotMatch(outcomeTime, />@samchon\/graph<\/text>/);
  assert.doesNotMatch(outcomeTime, />codegraph<\/text>/);
  assert.match(outcomeTime, /baseline[\s\S]{0,300}>0s \/ 20s<\/text>/);
  assert.match(
    outcomeTime,
    /codebase-memory[\s\S]{0,300}>0s \/ 13s<\/text>/,
  );
  assert.match(outcomeTime, /serena[\s\S]{0,300}>2\.1s \/ 15s<\/text>/);

  const revisionlessAgentReport = sampleReport();
  for (const cell of revisionlessAgentReport.agent.cells) {
    delete cell.fixtureBranch;
  }
  revisionlessAgentReport.agent.cells.push({
    ...revisionlessAgentReport.agent.cells[0],
    repo: "outside-manifest",
  });
  const revisionlessAgentOut = path.join(root, "revisionless-agent-out");
  fs.mkdirSync(path.join(revisionlessAgentOut, "svg"), { recursive: true });
  fs.mkdirSync(path.join(revisionlessAgentOut, "png"), { recursive: true });
  fs.writeFileSync(
    path.join(revisionlessAgentOut, "svg", "graph-time-to-answer.svg"),
    "stale",
  );
  fs.writeFileSync(
    path.join(revisionlessAgentOut, "png", "graph-time-to-answer.png"),
    "stale",
  );
  fs.writeFileSync(input, JSON.stringify(revisionlessAgentReport));
  run(
    process.execPath,
    [path.join(benchmarkDir, "build", "graph-benchmark-svg.cjs")],
    {
      ...env,
      SAMCHON_GRAPH_BENCH_RENDER_OUT: revisionlessAgentOut,
    },
  );
  assert.deepEqual(
    [...snapshot(revisionlessAgentOut).keys()],
    [],
    "known and outside-manifest revisionless agent evidence cannot leave a token or time chart behind",
  );

  for (const [relative] of first) {
    if (!relative.endsWith(".svg")) continue;
    const svg = fs.readFileSync(path.join(out, relative), "utf8");
    assert.match(svg, /<svg\b/);
    assert.match(svg, /DejaVu Sans, Arial/);
    const width = Number(svg.match(/<svg[^>]*width="([\d.]+)"/)?.[1]);
    const height = Number(svg.match(/<svg[^>]*height="([\d.]+)"/)?.[1]);
    const png = fs.readFileSync(
      path.join(out, relative.replace(/^svg[\\/]/, "png/").replace(/\.svg$/, ".png")),
    );
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), width * 2);
    assert.equal(png.readUInt32BE(20), height * 2);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

function sampleReport() {
  const cells = [];
  for (const [repo, baseline, graph] of [
    ["excalidraw", 10_000, 3_000],
    ["gin", 8_000, 2_800],
  ]) {
    const prompt = REFERENCE_PROMPTS.get(`${repo}|common`);
    assert.ok(prompt, `${repo}/common reference prompt exists`);
    const base = {
      harness: "codex",
      repo,
      fixtureBranch: PROJECTS[repo].commit,
      model: "terra",
      modelVersion: "gpt-5.6-terra",
      promptId: prompt.id,
      promptFamily: prompt.family,
      questionSha256: prompt.questionSha256,
    };
    cells.push({
      ...base,
      tool: "baseline",
      samples: { baseline: [{ tokens: baseline, durMs: 20_000 }], graph: [] },
    });
    for (const [tool, value, durMs] of [
      ["samchon-graph", graph, 9_000],
      ["codegraph", graph + 500, 11_000],
      ["codebase-memory", graph + 900, 13_000],
      ["serena", graph + 1_200, 15_000],
    ])
      cells.push({
        ...base,
        tool,
        samples: { baseline: [], graph: [{ tokens: value, durMs }] },
      });
  }
  return {
    schemaVersion: 1,
    agent: { cells },
    index: {
      schemaVersion: 2,
      host: { cpu: "test", cores: 8, ramGB: 32, os: "test" },
      fixtures: {
        excalidraw: PROJECTS.excalidraw.commit,
        gin: PROJECTS.gin.commit,
      },
      scale: {
        excalidraw: { files: 100, lines: 20_000 },
        gin: { files: 80, lines: 12_000 },
      },
      cells: ["excalidraw", "gin"].flatMap((project, projectIndex) =>
        ["samchon-graph", "codegraph", "codebase-memory", "serena"].map(
          (tool, toolIndex) => ({
            project,
            tool,
            fixtureCommit: PROJECTS[project].commit,
            buildMs: 1_000 + projectIndex * 500 + toolIndex * 200,
          }),
        ),
      ),
    },
  };
}

function snapshot(root) {
  const entries = [];
  for (const file of walk(root)) {
    const relative = path.relative(root, file).replace(/\\/g, "/");
    entries.push([relative, sha256(fs.readFileSync(file))]);
  }
  return new Map(entries);
}

function walk(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

function run(command, args, env = process.env) {
  const result = cp.spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
}

function output(command, args, env = process.env) {
  const result = cp.spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
  }
  return result.stdout ?? "";
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
