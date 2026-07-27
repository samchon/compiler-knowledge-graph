// Publish the @samchon/graph benchmark results into the website.
//
// The three graph benchmarks each write a local, git-ignored report:
//   - bench.mjs            -> report.json                 (structural: counts + coverage)
//   - agent-ab.mjs         -> agent-ab-report.json        (Claude agent-cost A/B)
//   - agent-ab-codex.mjs   -> agent-ab-codex-report.json  (codex / GPT agent-cost A/B)
//
// This script folds whichever of those exist into the committed, served
// `tests/benchmark/results/graph.json`. It merges in place:
// each agent cell is keyed by `websiteCellKey` and upserted, so running one
// repo/model at a time accumulates cells across separate quiet-host runs instead
// of clobbering the others. The structural block is replaced whole.
//
// Only raw per-run samples are stored; medians and saved-percentages are left
// for the reader to derive, so the published JSON never carries a derived
// statistic that could drift out of sync with the prose at
// the benchmark report that consumes this artifact.
//
// Usage:
//   node tests/benchmark/graph/publish.mjs              # fold graph/*.json reports
//   node tests/benchmark/graph/publish.mjs --from <dir> # fold graph.mjs suite output
//   node tests/benchmark/graph/publish.mjs --reset      # drop prior cells first
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  agentPublicationDocument,
  sanitizeWebsiteSamples,
  websiteCellKey,
} from "./website-cell.mjs";
import { assertPublicationCandidates } from "./publication-gate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const benchmarkDir = path.resolve(here, "..");
const websiteJson = path.resolve(
  repoRoot,
  "tests",
  "benchmark",
  "results",
  "graph.json",
);

const args = process.argv.slice(2);
const reset = args.includes("--reset");
const sourceDirs = parseSourceDirs(args);

const prior =
  !reset && fs.existsSync(websiteJson)
    ? JSON.parse(fs.readFileSync(websiteJson, "utf8"))
    : { schemaVersion: 1, structural: null, agent: { cells: [] } };

// Every block the document carries survives a publish that does not write it.
// This one rebuilt `out` from `structural` and `agent` alone, so a run that
// folded agent cells silently deleted the `index` axis — the cold build time,
// one cell per tool per repository, and the two charts that read it stopped
// being generated at all. The site went on serving the SVGs left on disk from
// the last build, which is worse than serving none, because a missing chart is
// visible and a stale one is not.
const out = agentPublicationDocument(prior);
const agentCandidates = [];
for (const sourceDir of sourceDirs) {
  foldSourceDir(sourceDir);
}
assertPublicationCandidates(agentCandidates, {
  auditPath: path.join(
    benchmarkDir,
    ".work",
    "publication-audit",
    "codex-trace-audit.json",
  ),
});
for (const { cell } of agentCandidates) upsertAgentCell(cell);

fs.mkdirSync(path.dirname(websiteJson), { recursive: true });
fs.writeFileSync(websiteJson, `${JSON.stringify(out)}\n`);
console.log(
  `\nWrote ${path.relative(repoRoot, websiteJson)} ` +
    `(${out.agent.cells.length} agent cell(s)).`,
);

function foldSourceDir(sourceDir) {
  const mainReport = readJson(path.join(sourceDir, "report.json"));
  if (mainReport?.cells) {
    foldSuite(mainReport, sourceDir);
  } else if (mainReport) {
    foldStructural(mainReport);
  }

  // Agent cells: upsert each available report by harness/tool/repo/model.
  foldAgent(path.join(sourceDir, "agent-ab-report.json"), "claude-code");
  foldAgent(path.join(sourceDir, "agent-ab-codex-report.json"), "codex");
}

function foldStructural(structural) {
  if (typeof structural.project === "string") {
    structural.project = structural.project.split(path.sep).join("/");
  }
  out.structural = structural;
  console.log(
    `structural: ${structural.nodes} nodes, ${structural.totalEdges} edges, ` +
      `coverage ${(structural.coverage * 100).toFixed(1)}%`,
  );
}

function foldSuite(report, sourceDir) {
  for (const cell of report.cells ?? []) {
    const sourceReportPath = resolveReportPath(cell.report, sourceDir);
    const sourceReport = readJson(sourceReportPath);
    if (!sourceReport) {
      throw new Error(`missing suite cell report: ${cell.report}`);
    }
    const rawModel =
      sourceReport.modelVersion ??
      sourceReport.model ??
      cell.modelVersion ??
      cell.model;
    const stableModel = stableAgentModel(cell.harness, cell.model, rawModel);
    const version = modelVersionId(rawModel);
    const samples = sanitizeWebsiteSamples(sourceReport.samples);
    if (samples.baseline.length === 0 && samples.graph.length === 0) {
      continue;
    }
    queueAgentCell({
      harness: cell.harness,
      tool: cell.tool ?? sourceReport.tool ?? "samchon-graph",
      ...(cell.toolSetupMs !== undefined
        ? { toolSetupMs: cell.toolSetupMs }
        : sourceReport.toolSetupMs !== undefined
          ? { toolSetupMs: sourceReport.toolSetupMs }
          : {}),
      repo: sourceReport.repo ?? cell.project,
      model: stableModel,
      ...(version ? { modelVersion: version } : {}),
      ...(sourceReport.effort ? { effort: sourceReport.effort } : {}),
      ...(sourceReport.promptId ? { promptId: sourceReport.promptId } : {}),
      promptFamily: sourceReport.promptFamily ?? cell.promptFamily,
      ...(sourceReport.questionSha256
        ? { questionSha256: sourceReport.questionSha256 }
        : {}),
      ...(sourceReport.fixtureBranch
        ? { fixtureBranch: sourceReport.fixtureBranch }
        : cell.branch
          ? { fixtureBranch: cell.branch }
          : {}),
      ...(sourceReport.daemon !== undefined
        ? { daemon: sourceReport.daemon }
        : {}),
      runs: sourceReport.runs,
      question: sourceReport.question,
      samples,
    }, cell.harness, sourceReportPath);
  }
  console.log(
    `suite: ${path.relative(repoRoot, sourceDir)} (${report.cells?.length ?? 0} cell(s))`,
  );
}

function foldAgent(reportPath, harness) {
  const report = readJson(reportPath);
  if (!report) return;
  const samples = sanitizeWebsiteSamples(report.samples);
  if (samples.baseline.length === 0 && samples.graph.length === 0) return;
  const rawModel = report.modelVersion ?? report.model ?? "unknown";
  const stableModel = stableAgentModel(harness, undefined, rawModel);
  const version = modelVersionId(rawModel);
  queueAgentCell({
    harness,
    tool: report.tool ?? "samchon-graph",
    repo: report.repo,
    model: stableModel,
    ...(version ? { modelVersion: version } : {}),
    ...(report.effort ? { effort: report.effort } : {}),
    ...(report.promptId ? { promptId: report.promptId } : {}),
    promptFamily: report.promptFamily ?? "project-specific",
    ...(report.questionSha256 ? { questionSha256: report.questionSha256 } : {}),
    ...(report.fixtureBranch ? { fixtureBranch: report.fixtureBranch } : {}),
    ...(report.daemon !== undefined ? { daemon: report.daemon } : {}),
    ...(report.toolSetupMs !== undefined
      ? { toolSetupMs: report.toolSetupMs }
      : {}),
    runs: report.runs,
    question: report.question,
    samples,
  }, harness, reportPath);
  const n = (report.samples?.graph ?? []).length;
  console.log(
    `agent: ${harness} / ${report.tool ?? "samchon-graph"} / ${report.repo} / ${
      report.promptFamily ?? "project-specific"
    } / ${report.model} (${n} graph runs)`,
  );
}

function stableAgentModel(harness, stableModel, rawModel) {
  if (
    stableModel?.startsWith("codex-") ||
    stableModel?.startsWith("claude-code-")
  )
    return stableModel;
  if (rawModel?.startsWith("codex-") || rawModel?.startsWith("claude-code-"))
    return rawModel;
  if (rawModel === "sonnet" || rawModel?.startsWith("claude-sonnet-"))
    return "claude-code-sonnet";
  if (rawModel === "opus" || rawModel?.startsWith("claude-opus-"))
    return "claude-code-opus";
  if (rawModel?.startsWith("gpt-")) return agentLabel(rawModel);
  if (harness === "claude-code") return `claude-code-${rawModel ?? "unknown"}`;
  return rawModel ?? "unknown";
}

function modelVersionId(rawModel) {
  if (rawModel?.startsWith("claude-") || rawModel?.startsWith("gpt-"))
    return rawModel;
  return undefined;
}

function agentLabel(resolvedModel) {
  const tier = resolvedModel
    .split("-")
    .filter((token) => token && !/^[0-9.]+$/.test(token))
    .join("-");
  return `codex-${tier}`;
}

function upsertAgentCell(cell) {
  // A manifest promptId narrows the cell within a family, so two prompt variants
  // of the same family upsert separately instead of clobbering. Plain --repo
  // runs (no promptId) keep keying by family, as before.
  const at = out.agent.cells.findIndex(
    (c) => websiteCellKey(c) === websiteCellKey(cell),
  );
  if (at >= 0) {
    const existing = out.agent.cells[at];
    const existingBaseline = existing.samples?.baseline?.length ?? 0;
    const existingGraph = existing.samples?.graph?.length ?? 0;
    const nextBaseline = cell.samples?.baseline?.length ?? 0;
    const nextGraph = cell.samples?.graph?.length ?? 0;
    if (nextBaseline < existingBaseline || nextGraph < existingGraph) {
      console.warn(
        `skip thinner agent cell: ${cell.tool ?? "samchon-graph"} / ${
          cell.repo
        } / ${cell.modelVersion ?? cell.model} / ${
          cell.promptFamily ?? "project-specific"
        } (${nextBaseline}/${nextGraph} < ${existingBaseline}/${existingGraph})`,
      );
      return;
    }
    out.agent.cells[at] = { ...existing, ...cell };
  } else out.agent.cells.push(cell);
}

function queueAgentCell(cell, harness, reportPath) {
  agentCandidates.push({ cell, harness, reportPath: path.resolve(reportPath) });
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function resolveReportPath(reportPath, sourceDir) {
  if (!reportPath) return "";
  if (path.isAbsolute(reportPath)) return reportPath;
  const fromRoot = path.resolve(repoRoot, reportPath);
  if (fs.existsSync(fromRoot)) return fromRoot;
  return path.resolve(sourceDir, reportPath);
}

function parseSourceDirs(argv) {
  const dirs = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--from" || arg === "--source") {
      const next = argv[++i];
      if (!next) throw new Error(`${arg} requires a directory`);
      dirs.push(path.resolve(repoRoot, next));
    } else if (arg.startsWith("--from=")) {
      dirs.push(path.resolve(repoRoot, arg.slice("--from=".length)));
    } else if (arg.startsWith("--source=")) {
      dirs.push(path.resolve(repoRoot, arg.slice("--source=".length)));
    }
  }
  return dirs.length > 0 ? dirs : [here];
}
