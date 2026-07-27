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
const FIXTURE_HOST = Object.freeze({
  os: "fixture",
  cpu: "fixture",
  cores: 4,
  ramGB: 16,
});
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
assertDeclarationsPrecedeExecution(graphDir, ["index-time.mjs"]);
assertWorkflowOptionForms(
  path.join(graphDir, "index-time.mjs"),
  path.join(repoRoot, ".github", "workflows", "index-time.yml"),
);
testPublishedIndexCellsNameTheirMachine();
testAgentPublicationPreservesIndexResults();
testIndexPublicationRefusesMalformedJson();
testIndexCellIsolationContract();
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
    host: FIXTURE_HOST,
    scale: { fixture: { files: 1, lines: 1 } },
    cells: [
      {
        project: "fixture",
        tool: "samchon-graph",
        buildMs: 1,
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
    host: FIXTURE_HOST,
    scale: { fixture: { files: 1, lines: 1 } },
    cells: [
      {
        project: "fixture",
        tool: "samchon-graph",
        buildMs: 1,
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
    host: { cpu: "fixture" },
    scale: { fixture: { files: 1, lines: 1 } },
    cells: [
      {
        project: "fixture",
        tool: "samchon-graph",
        buildMs: 1,
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
        project: "fixture",
        tool: "samchon-graph",
        host: FIXTURE_HOST,
      },
    ],
    [
      "contradictory",
      {
        project: "fixture",
        tool: "samchon-graph",
        buildMs: 1,
        timedOutMs: 2,
        host: FIXTURE_HOST,
      },
    ],
    [
      "hostless",
      {
        project: "fixture",
        tool: "samchon-graph",
        buildMs: 1,
      },
    ],
    [
      "incomplete-host",
      {
        project: "fixture",
        tool: "samchon-graph",
        buildMs: 1,
        host: { cpu: "fixture" },
      },
    ],
    [
      "invalid-measurement-date",
      {
        project: "fixture",
        tool: "samchon-graph",
        buildMs: 1,
        measuredAt: "not a date",
        host: FIXTURE_HOST,
      },
    ],
  ]) {
    fs.writeFileSync(publication, validPublication);
    const invalidOutcomeReport = JSON.stringify({
      host: FIXTURE_HOST,
      scale: { fixture: { files: 1, lines: 1 } },
      cells: [invalidCell],
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
  const stalePublication = {
    ...JSON.parse(validPublication),
    index: {
      host: FIXTURE_HOST,
      scale: { stale: { files: 1, lines: 1 } },
      cells: [
        {
          project: "stale",
          tool: "samchon-graph",
          buildMs: 1,
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
  const prepared = source.indexOf(
    "cellRepoDir = prepareCellFixture(project, spec, repoDir, tool)",
  );
  const quiet = source.indexOf(
    "const quietWait = await quietHostForCell(project, tool)",
  );
  const timed = source.indexOf("cell = runIndexCell({", quiet);
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
    source.includes("`-Dmaven.repo.local=${localRepository}`") &&
      !source.includes('`-Dmaven.repo.local="${localRepository}"`'),
    "Maven must receive an absolute local repository without literal quote characters",
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
    const base = {
      harness: "codex",
      repo,
      model: "terra",
      modelVersion: "gpt-5.6-terra",
      promptFamily: "common",
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
      host: { cpu: "test", cores: 8, ramGB: 32, os: "test" },
      scale: {
        excalidraw: { files: 100, lines: 20_000 },
        gin: { files: 80, lines: 12_000 },
      },
      cells: ["excalidraw", "gin"].flatMap((project, projectIndex) =>
        ["samchon-graph", "codegraph", "codebase-memory", "serena"].map(
          (tool, toolIndex) => ({
            project,
            tool,
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
