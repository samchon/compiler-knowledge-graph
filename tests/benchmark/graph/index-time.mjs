#!/usr/bin/env node
/**
 * Cold index build-time benchmark for the graph tool axis: what _readiness_
 * costs before a tool can answer its first question, per (tool × fixture).
 *
 * The agent benchmark (`graph.mjs`) measures what a question costs once a tool
 * is ready; this runner measures the readiness itself. Per cell it deletes the
 * tool's index, runs its build step once, and takes wall time:
 *
 * - `samchon-graph`: `samchon-graph dump --cwd <fixture> --language <language>`
 *   — the MCP launcher builds the same LSP graph at startup, so the agent's
 *   first question waits on it. The dump is stateless, so every run is cold.
 * - `samchon-graph-fallback`: the same command with `--no-strict`, so the
 *   project is indexed by the generic language-server lane alone. Two cells
 *   from one run on one host is the only way to state what a strict provider
 *   is worth; comparing separate runs compares machines as much as providers.
 * - `codegraph`: `codegraph init <fixture>` after removing `.codegraph/`.
 * - `codebase-memory`: `codebase-memory-mcp cli index_repository` into an
 *   isolated `CBM_CACHE_DIR` after removing `.codebase-memory/`.
 * - `serena`: `serena project create` (declining, on stdin, every language its
 *   interview detects — VS Code detects twenty-two, and an unanswered prompt
 *   aborts on EOF) and then `serena project index`, which is the step timed.
 *   serena's own docs recommend it for larger projects, and this harness had
 *   never run it: a benchmark that withholds a tool's prescribed setup measures
 *   the withholding.
 *
 * One run per cell, sequentially, on a QUIET host — never beside the agent
 * benchmark, whose parallel cells would corrupt every wall-clock number.
 * Results land under a top-level `index` key in
 * `tests/benchmark/results/graph.json`, beside `structural` and `agent`, which
 * this runner must not disturb.
 */
import cp from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PROJECTS, projectDir, resolveWorkDir } from "./corpus.mjs";
import currentIndex from "./current-index.cjs";
import {
  assertPinnedCheckout,
  assertPreparedFixture,
  ensureLocalIgnored,
  graphLauncher,
  prepareFixture,
  preparedFixtureCompanion,
  serverArgsForPreparedFixture,
} from "./language.mjs";
import {
  assertIndexReport,
  assertWebsitePublication,
} from "./publication-document.mjs";
import {
  ALL_TOOLS,
  TOOL_CODEBASE_MEMORY,
  TOOL_CODEGRAPH,
  TOOL_SAMCHON,
  TOOL_SAMCHON_FALLBACK,
  TOOL_SERENA,
  strictIntentOfTool,
  timedOutIndexCell,
} from "./index-time-cell.mjs";
import { javaSystemProperty } from "./java-tool-options.mjs";
import { removeTree } from "./remove-tree.mjs";

const { selectCurrentIndex } = currentIndex;
const SELECTED_FIXTURES = Object.fromEntries(
  Object.entries(PROJECTS).map(([project, spec]) => [project, spec.commit]),
);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const workDir = resolveWorkDir(repoRoot);
const websiteJson =
  process.env.SAMCHON_BENCH_INDEX_JSON ??
  path.join(repoRoot, "tests", "benchmark", "results", "graph.json");

// Above every top-level statement that can reach it, deliberately. The project
// loop below calls `measureScale`, which reads this table, and a `const`
// declared after that loop is still in its temporal dead zone when the loop
// runs. That is exactly how this file died on its first execution — it had been
// complete and unrun for as long as it had existed, so the order had never been
// tested by anything except reading it. `tests/benchmark/test/run.mjs` now
// checks the ordering so the next one is caught before a runner is.
const SOURCE_EXTENSIONS = {
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  go: [".go"],
  python: [".py"],
  rust: [".rs"],
  java: [".java"],
  c: [".c", ".h"],
  cpp: [
    ".cc",
    ".cpp",
    ".cxx",
    ".c++",
    ".C",
    ".h",
    ".hh",
    ".hpp",
    ".hxx",
    ".h++",
    ".H",
    ".ipp",
    ".tpp",
    ".tcc",
    ".inl",
  ],
  ruby: [".rb"],
  php: [".php"],
  csharp: [".cs"],
  kotlin: [".kt", ".kts"],
  lua: [".lua"],
  dart: [".dart"],
};

// The same tool on the same project with every strict provider stood down.
// What a strict provider is worth cannot be read off one number: redis went
// from 263 s to 15.6 s when scip-clang finally served, and that was only
// visible by comparing two runs days apart on different machines. Two cells in
// one run, one host, one clock is the comparison the table was missing.

// `serena project create` interviews the operator about every language it
// detects, one prompt each, and VS Code detects twenty-two of them. Decline them
// all: the fixture is TypeScript, and an unanswered prompt aborts the command on
// EOF.
const SERENA_DECLINE_ALL = "n\n".repeat(80);

const parsed = parseArgs(process.argv.slice(2));
const toolchainManifest = parsed.values["toolchain-manifest"];
assertToolchainManifestOption(process.argv.slice(2));
const selected = selectProjects(parsed);
const tools = selectTools(parsed.values.tools ?? parsed.values.tool ?? "all");
const outDir = path.resolve(
  parsed.values.out ?? path.join(workDir, "graph-index", timestamp()),
);
const reportPath = path.join(outDir, "report.json");
const awaitQuietSeconds = Number(parsed.values["await-quiet"] ?? 0);

if (parsed.flags.has("--list")) {
  for (const project of Object.keys(PROJECTS)) {
    const spec = PROJECTS[project];
    process.stdout.write(
      `${project}: ${projectDir(workDir, spec)} (${spec.language} @ ${spec.commit.slice(0, 12)})\n`,
    );
  }
  process.exit(0);
}

if (parsed.flags.has("--reset-index-only")) {
  resetWebsiteIndex();
  process.stdout.write("Index-time publication reset for a complete matrix.\n");
  process.exit(0);
}

// --publish <report.json> folds an already-measured report into the website JSON
// without rebuilding anything. A tool whose code has not changed since it was
// timed does not need to be timed again, and re-running it only to refill the
// same number spends an hour to reproduce it: `@samchon/graph` is remeasured when
// its dump changes, and the comparators' cells are republished from the run that
// measured them on the same quiet host.
if (parsed.values.publish) {
  publishWebsiteIndex(loadJson(path.resolve(parsed.values.publish)));
  process.stdout.write(
    `Index-time cells published from ${parsed.values.publish}\n`,
  );
  process.exit(0);
}

if (selected.length === 0) {
  throw new Error("index-time benchmark requires --project <name> or --all");
}

fs.mkdirSync(outDir, { recursive: true });

if (!parsed.flags.has("--no-setup")) {
  ensureFixtures(selected);
} else {
  for (const project of selected) {
    const spec = PROJECTS[project];
    assertPreparedFixture(spec, projectDir(workDir, spec));
  }
}

const report = {
  schemaVersion: 2,
  date: new Date().toISOString(),
  measurementId: randomUUID(),
  outDir,
  tools,
  projects: selected,
  fixtures: Object.fromEntries(
    selected.map((project) => [project, PROJECTS[project].commit]),
  ),
  host: hostSpec(),
  toolchain: loadToolchainEvidence(toolchainManifest),
  scale: {},
  cells: [],
};

// Complete the declared scope before the first expensive cell starts. The
// report owns `projects × tools`, including authoritative absence after a
// later failure, so every scoped project's scale must already be present when
// the first successful cell is published.
for (const project of selected) {
  const spec = PROJECTS[project];
  const repoDir = projectDir(workDir, spec);
  if (!fs.existsSync(repoDir))
    throw new Error(`missing graph benchmark clone: ${repoDir}`);
  // Project scale, so a build time can be read against the work it had to do:
  // forty seconds on VS Code and one second on a small backend are the same
  // tool, not two. Tracked TypeScript/TSX sources (git ls-files) naturally
  // exclude node_modules, build output, and anything else the fixture ignores;
  // `.d.ts` is excluded because it is shipped output, not source.
  report.scale[project] = measureScale(
    project,
    spec,
    indexDir(spec, repoDir),
  );
}
// Refuse malformed provisioning evidence before the first stopwatch starts.
// A one-shot cell without the exact tools that produced it cannot be repaired
// afterwards, and spending the measurement before discovering that would turn
// an avoidable harness error into another hour-long missing result.
assertIndexReport(report, "new index-time result");
writeJson(reportPath, report);

for (const project of selected) {
  const spec = PROJECTS[project];
  const repoDir = projectDir(workDir, spec);
  for (const tool of tools) {
    let cellRepoDir;
    let cellCache;
    await runWithCleanup(
      async () => {
        cellRepoDir = prepareCellFixture(project, spec, repoDir, tool);
        cellCache = prepareCellCache(project, spec, tool);
        // Preparation can clone dependencies, generate a compilation database,
        // or run a full build. The quiet observation belongs here, immediately
        // before the timer, rather than before the work that heats the host.
        const quietWait = await quietHostForCell(project, tool);
        let cell;
        try {
          cell = runIndexCell({
            project,
            spec,
            repoDir: cellRepoDir,
            tool,
            env: cellCache.env,
          });
        } catch (error) {
          // Only a timeout becomes a cell. Anything else is still a broken run
          // and has to stop the lane, or a genuine defect would publish as a
          // number.
          if (typeof error?.timedOutMs !== "number") throw error;
          cell = timedOutIndexCell({
            project,
            tool,
            timedOutMs: error.timedOutMs,
            // The process was killed before it could write its provenance line,
            // so this cannot say what produced the graph — there is none. It can
            // say what was being attempted, because that is announced before
            // the first candidate runs, and "timed out running scip-ruby" is a
            // finding where "timed out" alone is a mystery.
            servedBy: servedBy(error.logStem ?? ""),
          });
        }
        assertPinnedCheckout(spec, cellRepoDir);
        // The machine and its quietness travel with the cell, not with the
        // publication. One host panel is only truthful when one sweep measured
        // everything, and `index-time.yml` deliberately gives each language its
        // own runner — thirteen VMs with thirteen CPU models, because two lanes
        // sharing a machine would corrupt each other's wall clock. Folding those
        // under a single panel would attribute twelve cells to a machine they
        // never ran on, and the workflow's own header says cells from different
        // hosts are not one comparison. A cold build is one sample; what it ran
        // on is part of it.
        report.cells.push({
          ...cell,
          measurementId: report.measurementId,
          fixtureCommit: spec.commit,
          measuredAt: new Date().toISOString(),
          cacheIsolation: cellCache.kind,
          host: report.host,
          toolchain: report.toolchain,
          quietWait,
        });
        writeJson(reportPath, report);
        printCellSummary(project, cell);
        publishWebsiteIndex(report);
      },
      [
        {
          label: `remove isolated fixture ${project}/${tool}`,
          run: () => {
            if (cellRepoDir !== undefined) {
              cleanupCellFixture(cellRepoDir);
            }
          },
        },
        {
          label: `remove isolated cache ${project}/${tool}`,
          run: () => {
            if (cellCache !== undefined) cleanupCellCache(cellCache.root);
          },
        },
      ],
      `benchmark cell ${project}/${tool}`,
    );
  }
}

writeJson(reportPath, report);
process.stdout.write(
  `\nIndex-time benchmark report: ${path.relative(repoRoot, reportPath)}\n`,
);
if (!parsed.flags.has("--no-website")) {
  process.stdout.write(
    `Index-time benchmark website JSON: ${path.relative(repoRoot, websiteJson)}\n`,
  );
}

function runIndexCell({ project, spec, repoDir, tool, env }) {
  if (tool === TOOL_SERENA) {
    // serena does ship a build step -- `serena project index`, which its own
    // docs recommend for larger projects -- and the harness had never run it.
    // A benchmark that withholds a tool's prescribed setup measures the
    // withholding, so it is timed here like every other tool.
    //
    // `project create` comes first because `index` needs a project config, and
    // it interviews the operator about every language it detects (VS Code
    // detects twenty-two). Headless, that interview is an EOF and the command
    // aborts, so every optional language is declined on stdin. Only the index
    // itself is timed; the interview is setup, not work.
    ensureLocalIgnored(repoDir, ".serena/");
    cleanupInsideFixture(repoDir, ".serena");
    try {
      runChecked(...serenaCommand(["project", "create", indexDir(spec, repoDir)]), {
        label: `serena project create ${project}`,
        logBase: path.join(outDir, `serena-create-${project}`),
        cwd: repoDir,
        env,
        input: SERENA_DECLINE_ALL,
      });
      const ms = timeChecked(...serenaCommand(["project", "index"]), {
        label: `serena project index ${project}`,
        logBase: path.join(outDir, `serena-index-${project}`),
        cwd: repoDir,
        env,
        input: SERENA_DECLINE_ALL,
      });
      return { project, tool, buildMs: ms };
    } finally {
      cleanupInsideFixture(repoDir, ".serena");
    }
  }
  if (tool === TOOL_SAMCHON || tool === TOOL_SAMCHON_FALLBACK) {
    const strict = tool === TOOL_SAMCHON;
    const logStem = path.join(
      outDir,
      strict
        ? `samchon-graph-index-${project}`
        : `samchon-graph-fallback-index-${project}`,
    );
    const ms = timeChecked(
      process.execPath,
      [
        graphLauncher,
        "dump",
        "--cwd",
        indexDir(spec, repoDir),
        "--language",
        spec.language,
        "--mode",
        "lsp",
        // Stood down rather than tripped. Capping files or naming a server
        // also disables a strict provider, but by making it refuse — which
        // measures the refusal, not the lane underneath it.
        ...(strict ? [] : ["--no-strict"]),
        ...serverArgsForPreparedFixture(spec, repoDir).flatMap((arg) => [
          "--server-arg",
          arg,
        ]),
      ],
      {
        label: `${tool} dump ${project}`,
        logBase: logStem,
        // Per-request tracing is intentionally absent here. Its formatting and
        // stderr writes scale with generic-LSP requests while bulk strict
        // providers bypass that path, so enabling it inside this clock would
        // asymmetrically inflate the fallback column. Slow-lane diagnosis runs
        // afterwards through lsp-request-diagnosis.mjs.
        env: {
          ...env,
          // A caller may have enabled diagnosis in its shell. The publication
          // contract owns this process and forces that opt-in back off.
          SAMCHON_GRAPH_LSP_REQUEST_TRACE: "0",
        },
        // The dump JSON reaches hundreds of MB on vscode; the payload is the
        // wire benchmark's concern, not this one's, so stdout is discarded.
        discardStdout: true,
      },
    );
    // Which path produced the number. A cell used to carry a duration and
    // nothing else, so a published time could not say whether a strict provider
    // built it or the generic language-server lane did — and those differ by
    // orders of magnitude. The dump writes one provenance line to stderr, which
    // is captured even while stdout goes to /dev/null, so reading it back costs
    // nothing and happens after the clock has stopped.
    // `strict` alongside `servedBy`, because those two say different things
    // that read identically. A fallback cell reports "no strict provider
    // served" — and so does a strict cell whose provider failed. One was asked
    // for and the other is a defect, and a table that cannot tell them apart
    // reports every fallback measurement as a broken provider.
    return {
      project,
      tool,
      buildMs: ms,
      strict,
      servedBy: servedBy(logStem),
    };
  }
  if (tool === TOOL_CODEGRAPH) {
    ensureLocalIgnored(repoDir, ".codegraph/");
    cleanupInsideFixture(repoDir, ".codegraph");
    try {
      const ms = timeChecked(...codegraphCommand(["init", indexDir(spec, repoDir)]), {
        label: `codegraph init ${project}`,
        logBase: path.join(outDir, `codegraph-index-${project}`),
        env,
      });
      return { project, tool, buildMs: ms };
    } finally {
      cleanupInsideFixture(repoDir, ".codegraph");
    }
  }
  if (tool === TOOL_CODEBASE_MEMORY) {
    ensureLocalIgnored(repoDir, ".codebase-memory/");
    cleanupInsideFixture(repoDir, ".codebase-memory");
    const cacheDir = path.join(
      outDir,
      "codebase-memory-cache",
      filenamePart(project),
    );
    removeTree(cacheDir);
    fs.mkdirSync(cacheDir, { recursive: true });
    try {
      const ms = timeChecked(
        ...codebaseMemoryCommand([
          "cli",
          "index_repository",
          JSON.stringify({
            repo_path: indexDir(spec, repoDir),
            // codebase-memory-mcp index mode: full (default) | moderate |
            // fast. `fast` is the only mode that can index large repos
            // (vscode) on a 64 GB host without the full mode's blowup.
            ...(process.env.SAMCHON_BENCH_CBM_MODE
              ? { mode: process.env.SAMCHON_BENCH_CBM_MODE }
              : {}),
          }),
        ]),
        {
          label: `codebase-memory index ${project}`,
          logBase: path.join(outDir, `codebase-memory-index-${project}`),
          env: {
            ...env,
            CBM_CACHE_DIR: cacheDir,
            CBM_LOG_LEVEL: process.env.CBM_LOG_LEVEL ?? "warn",
          },
        },
      );
      return {
        project,
        tool,
        buildMs: ms,
        ...(process.env.SAMCHON_BENCH_CBM_MODE
          ? { mode: process.env.SAMCHON_BENCH_CBM_MODE }
          : {}),
      };
    } finally {
      cleanupInsideFixture(repoDir, ".codebase-memory");
      removeTree(cacheDir);
    }
  }
  throw new Error(`unknown tool ${tool}`);
}

/**
 * The directory a tool should be pointed at, which is not always the checkout.
 *
 * A repository can keep its build somewhere other than its own root — koin puts
 * every module under projects/ — and an indexer run at the checkout root finds
 * no build file and declines. The clone is still the git root, so the pinned
 * tree, the local ignores and the cleanup all stay there; only the question
 * "what am I indexing" moves.
 *
 * Every tool gets the same answer, or the comparison stops being one.
 */
function indexDir(spec, repoDir) {
  return spec.indexRoot === undefined
    ? repoDir
    : path.join(repoDir, spec.indexRoot);
}

function measureScale(project, spec, repoDir) {
  const extensions = SOURCE_EXTENSIONS[spec.language] ?? [];
  const listed = cp.spawnSync(
    "git",
    ["-C", repoDir, "ls-files", "-z"],
    { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  if (listed.error) throw listed.error;
  if (listed.status !== 0) {
    throw new Error(
      `git ls-files failed for ${project}: ${listed.stderr ?? ""}`,
    );
  }
  const files = (listed.stdout ?? "")
    .split("\0")
    .filter(Boolean)
    .filter((file) => matchesSourceExtension(file, extensions))
    .filter((file) => !/\.d\.(ts|mts|cts)$/.test(file));
  let lines = 0;
  for (const file of files) {
    const text = fs.readFileSync(path.join(repoDir, file), "utf8");
    // Count lines the way `wc -l` does — newlines, plus one for an
    // unterminated final line — so the scale block is reproducible against
    // standard tooling.
    const newlines = (text.match(/\n/g) ?? []).length;
    lines += newlines + (text.length > 0 && !text.endsWith("\n") ? 1 : 0);
  }
  return { files: files.length, lines };
}

function matchesSourceExtension(file, extensions) {
  const exact = path.extname(file);
  if (exact === ".C" || exact === ".H") {
    return extensions.includes(exact);
  }
  const folded = file.toLowerCase();
  return extensions.some((extension) => folded.endsWith(extension));
}

/**
 * Settle and gate the host after this cell's setup, immediately before timing.
 *
 * A cold build is one sample with no median to hide behind. Warn by default,
 * abort under SAMCHON_BENCH_REQUIRE_QUIET=1, and only skip the gate when the
 * operator explicitly sets SAMCHON_BENCH_SKIP_LOAD_CHECK=1. Windows reports
 * zero load averages, so its quietness remains the operator's responsibility.
 */
async function quietHostForCell(project, tool) {
  const limit =
    Number.isFinite(awaitQuietSeconds) && awaitQuietSeconds > 0
      ? awaitQuietSeconds
      : 0;
  const observation = await awaitQuietHost(limit);
  process.stdout.write(
    `[index-time] ${project}/${tool} host ratio ` +
      `${observation.ratio.toFixed(2)} after ` +
      `${String(observation.waitedSeconds)}s quiet wait\n`,
  );
  if (
    process.env.SAMCHON_BENCH_SKIP_LOAD_CHECK !== "1" &&
    observation.ratio > 0.5
  ) {
    const load1 = observation.ratio * observation.cores;
    const msg =
      `host load is high (1-min loadavg ${load1.toFixed(2)} on ` +
      `${observation.cores} CPUs, ratio ${observation.ratio.toFixed(2)}); ` +
      `a one-shot cold build may drift far from a quiet baseline. ` +
      `Set SAMCHON_BENCH_SKIP_LOAD_CHECK=1 to ignore.`;
    if (process.env.SAMCHON_BENCH_REQUIRE_QUIET === "1") {
      throw new Error(`index-time: ${msg}`);
    }
    process.stderr.write(`[index-time] warning: ${msg}\n`);
  }
  return observation;
}

/**
 * Wait until the one-minute load average falls under the gate's own threshold.
 *
 * The same ratio the gate uses, deliberately: two thresholds would drift, and
 * the point is to make the gate's claim true rather than to sneak past it. A
 * checkout, a dependency install, and a language-server download leave a load
 * average that has nothing to do with the measurement and everything to do with
 * a cold build's wall clock.
 *
 * Returns how long it waited and what the ratio finally was, so the report can
 * say the host was allowed to settle instead of leaving a reader to assume it.
 * A host that never settles falls through to the gate and is refused, which is
 * the honest end for a machine that cannot take this measurement.
 *
 * `os.loadavg()` reports zeros on Windows, where this returns immediately and
 * quietness stays the operator's responsibility — exactly as the gate does.
 */
async function awaitQuietHost(limitSeconds) {
  const cpuCount = Math.max(os.cpus().length, 1);
  const started = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e9;
  let ratio = os.loadavg()[0] / cpuCount;
  while (ratio > 0.5 && elapsed() < limitSeconds) {
    process.stdout.write(
      `[index-time] waiting for a quiet host: ratio ${ratio.toFixed(2)}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
    ratio = os.loadavg()[0] / cpuCount;
  }
  return {
    waitedSeconds: Math.round(elapsed()),
    limitSeconds,
    ratio,
    cores: cpuCount,
  };
}

// The same host block shape performance.json publishes — a wall-clock number
// without the machine it ran on is not a measurement.
function hostSpec() {
  const cpus = os.cpus();
  let osName = `${os.type()} ${os.release()}`;
  try {
    const pretty = fs
      .readFileSync("/etc/os-release", "utf8")
      .match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    if (pretty) osName = pretty[1];
  } catch {
    // Keep os.type/os.release fallback.
  }
  return {
    os: osName,
    kernel: os.release(),
    cpu: cpus[0]?.model?.trim() ?? "unknown",
    cores: cpus.length,
    ramGB: Math.round(os.totalmem() / 2 ** 30),
    node: process.version,
  };
}

function publishWebsiteIndex(currentReport) {
  if (parsed.flags.has("--no-website")) return;
  assertIndexReport(currentReport, "incoming index-time result");
  assertIncomingReportScope(currentReport);
  const prior = fs.existsSync(websiteJson) ? loadJson(websiteJson) : null;
  if (prior !== null) {
    assertWebsitePublication(prior);
  }
  const keepPrior = !parsed.flags.has("--reset-index");
  const priorIndex = keepPrior ? (prior?.index ?? null) : null;
  // A schema-1 cell has no fixture revision and a schema-2 cell can name a
  // revision that the current corpus no longer selects. Neither may survive a
  // preserving fold or another public consumer.
  const { index: currentPriorIndex } = selectCurrentIndex(
    priorIndex,
    SELECTED_FIXTURES,
  );
  const priorScale = currentPriorIndex.scale;
  const priorFixtures = currentPriorIndex.fixtures;
  const scale = { ...priorScale, ...currentReport.scale };
  const fixtures = { ...priorFixtures, ...currentReport.fixtures };
  const projects = new Set(currentReport.projects);
  const tools = new Set(currentReport.tools);
  const cells = currentPriorIndex.cells.filter(
    (cell) =>
      (!projects.has(cell.project) || !tools.has(cell.tool)),
  );
  for (const cell of currentReport.cells) {
    cells.push(cell);
  }
  const out = {
    schemaVersion: prior?.schemaVersion ?? 1,
    generatedAt: new Date().toISOString(),
    structural: prior?.structural ?? null,
    agent: prior?.agent ?? { cells: [] },
    // The panel still names the machine of the latest write, as
    // performance.json does — but it is no longer the only record of one, and
    // it is no longer what a reader should trust. Each cell now carries the
    // host it was measured on, because this benchmark's cells are produced by
    // thirteen separate runners on purpose and a single panel would speak for
    // twelve machines it never saw. Read the cell; the panel is a summary of
    // whichever fold happened to land last.
    index: {
      schemaVersion: 2,
      host: currentReport.host,
      fixtures,
      scale,
      cells,
    },
  };
  fs.mkdirSync(path.dirname(websiteJson), { recursive: true });
  fs.writeFileSync(websiteJson, `${JSON.stringify(out)}\n`);
}

/**
 * A measured report owns the whole project/tool rectangle it declares.
 *
 * The file is written before the first tool and after every successful tool.
 * If a later tool crashes, its final uploaded report is intentionally
 * incomplete. Folding only the cells that happened to finish would retain the
 * failed tool's old value and manufacture a strict/fallback pair from separate
 * runs. The scope metadata makes absence authoritative instead.
 */
function assertIncomingReportScope(incoming) {
  if (incoming.toolchain === undefined) {
    throw new TypeError(
      "incoming index-time result.toolchain is required",
    );
  }
  if (
    typeof incoming.measurementId !== "string" ||
    incoming.measurementId.trim() === ""
  ) {
    throw new TypeError(
      "incoming index-time result.measurementId must be a nonempty string",
    );
  }
  for (const field of ["projects", "tools"]) {
    const values = incoming[field];
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((value) => typeof value !== "string" || value.trim() === "")
    ) {
      throw new TypeError(
        `incoming index-time result.${field} must be a nonempty string array`,
      );
    }
    if (new Set(values).size !== values.length) {
      throw new TypeError(
        `incoming index-time result.${field} must not contain duplicates`,
      );
    }
  }
  const projects = new Set(incoming.projects);
  const tools = new Set(incoming.tools);
  for (const tool of tools) {
    if (!ALL_TOOLS.includes(tool)) {
      throw new TypeError(
        `incoming index-time result.tools names unknown tool ${tool}`,
      );
    }
  }
  if (
    incoming.schemaVersion !== 2 ||
    typeof incoming.fixtures !== "object" ||
    incoming.fixtures === null ||
    Array.isArray(incoming.fixtures)
  ) {
    throw new TypeError(
      "incoming index-time result must use revision-bound schemaVersion 2",
    );
  }
  for (const project of projects) {
    const selectedCommit = PROJECTS[project]?.commit;
    if (incoming.fixtures[project] !== selectedCommit) {
      throw new TypeError(
        `incoming index-time result.fixtures must bind ${project} to the selected corpus revision`,
      );
    }
    if (!Object.hasOwn(incoming.scale, project)) {
      throw new TypeError(
        `incoming index-time result.scale must describe scoped project ${project}`,
      );
    }
  }
  for (const project of Object.keys(incoming.scale)) {
    if (!projects.has(project)) {
      throw new TypeError(
        `incoming index-time result.scale describes out-of-scope project ${project}`,
      );
    }
  }
  for (const project of Object.keys(incoming.fixtures)) {
    if (!projects.has(project)) {
      throw new TypeError(
        `incoming index-time result.fixtures describes out-of-scope project ${project}`,
      );
    }
  }
  for (const cell of incoming.cells) {
    if (!projects.has(cell.project) || !tools.has(cell.tool)) {
      throw new TypeError(
        `incoming index-time result cell ${cell.project}/${cell.tool} is outside its declared scope`,
      );
    }
    if (cell.fixtureCommit !== incoming.fixtures[cell.project]) {
      throw new TypeError(
        `incoming index-time result cell ${cell.project}/${cell.tool} does not match its scoped fixture revision`,
      );
    }
    if (cell.measurementId !== incoming.measurementId) {
      throw new TypeError(
        `incoming index-time result cell ${cell.project}/${cell.tool} does not match its measurement`,
      );
    }
    if (!sameHostEvidence(cell.host, incoming.host)) {
      throw new TypeError(
        `incoming index-time result cell ${cell.project}/${cell.tool} does not match its host evidence`,
      );
    }
    if (
      JSON.stringify(cell.toolchain) !==
      JSON.stringify(incoming.toolchain)
    ) {
      throw new TypeError(
        `incoming index-time result cell ${cell.project}/${cell.tool} does not match its toolchain evidence`,
      );
    }
    const expectedStrict = strictIntentOfTool(cell.tool);
    if (cell.strict !== expectedStrict) {
      throw new TypeError(
        `incoming index-time result cell ${cell.project}/${cell.tool} does not match its strict-provider intent`,
      );
    }
  }
}

function sameHostEvidence(left, right) {
  return ["cpu", "cores", "ramGB", "os", "kernel", "node"].every(
    (field) => left[field] === right[field],
  );
}

/**
 * Preserve the setup manifest in every cell that its tools produced.
 *
 * CI supplies this file from the real-language provisioner. A manual run may
 * use a machine-owned toolchain instead; that is represented explicitly as
 * unreported rather than by an empty array a reader could mistake for a proof
 * that no external tools participated.
 */
function loadToolchainEvidence(manifest) {
  if (manifest === undefined) {
    return {
      status: "unreported",
      tools: [],
    };
  }
  const tools = loadJson(path.resolve(manifest));
  return {
    status: "recorded",
    tools,
  };
}

/**
 * Keep the ordinary parser authoritative while rejecting ambiguous evidence.
 *
 * Generic valued options retain their last spelling. A toolchain manifest is
 * provenance for a one-shot measurement, so two spellings cannot silently let
 * the latter replace the former, and an empty path cannot mean unreported.
 */
function assertToolchainManifestOption(argv) {
  const prefix = "--toolchain-manifest=";
  const values = argv
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
  if (values.length > 1) {
    throw new Error("index-time accepts one --toolchain-manifest");
  }
  if (values[0] === "") {
    throw new Error("--toolchain-manifest must name a file");
  }
}

/**
 * Begin a complete matrix without inheriting cells this run did not produce.
 *
 * Partial manual dispatches replace their declared project/tool rectangle and
 * preserve every unrelated cell. A full workflow run is different: if one
 * lane fails before writing any report, no scoped fold can remove its old
 * cells. Preserve the unrelated benchmark axes and remove the whole index axis
 * before the first full-matrix report is folded.
 */
function resetWebsiteIndex() {
  const prior = fs.existsSync(websiteJson) ? loadJson(websiteJson) : null;
  if (prior !== null) assertWebsitePublication(prior);
  const out = {
    schemaVersion: prior?.schemaVersion ?? 1,
    generatedAt: new Date().toISOString(),
    structural: prior?.structural ?? null,
    agent: prior?.agent ?? { cells: [] },
  };
  fs.mkdirSync(path.dirname(websiteJson), { recursive: true });
  fs.writeFileSync(websiteJson, `${JSON.stringify(out)}\n`);
}

/** One place, so the limit reported always matches the limit enforced. */
function benchTimeoutMs() {
  return Number(process.env.SAMCHON_GRAPH_BENCH_TIMEOUT_MS ?? 1_800_000);
}

function printCellSummary(project, cell) {
  if (typeof cell.timedOutMs === "number") {
    process.stdout.write(
      `[index-time] ${project} ${cell.tool}: timed out after ${(
        cell.timedOutMs / 1000
      ).toFixed(0)} s\n`,
    );
    return;
  }
  if (cell.hasBuildStep === false) {
    process.stdout.write(
      `[index-time] ${project} ${cell.tool}: no build step\n`,
    );
    return;
  }
  process.stdout.write(
    `[index-time] ${project} ${cell.tool}: ${(cell.buildMs / 1000).toFixed(1)} s\n`,
  );
}

function timeChecked(command, args, options) {
  const start = process.hrtime.bigint();
  runChecked(command, args, options);
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function runChecked(
  command,
  args,
  { label, logBase, cwd = repoRoot, env = {}, discardStdout = false, input },
) {
  process.stdout.write(`[index-time] ${label}\n`);
  const devNull = discardStdout ? fs.openSync(os.devNull, "w") : null;
  let result;
  try {
    result = cp.spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      // A tool that interviews the operator (serena, on every language it
      // detects) would otherwise hit EOF and abort in a headless run.
      ...(input === undefined ? {} : { input }),
      env: { ...process.env, ...env },
      windowsHide: true,
      maxBuffer: 512 * 1024 * 1024,
      timeout: benchTimeoutMs(),
      ...(devNull !== null ? { stdio: ["ignore", devNull, "pipe"] } : {}),
    });
  } finally {
    if (devNull !== null) fs.closeSync(devNull);
  }
  fs.writeFileSync(`${logBase}.out.log`, result.stdout ?? "");
  fs.writeFileSync(`${logBase}.err.log`, result.stderr ?? "");
  if (result.error) {
    // A timeout is a measurement, not a crash. "ruby's language-server lane does
    // not finish inside an hour" is one of the more useful things this benchmark
    // can say, and spawnSync reports it as an ETIMEDOUT that took the whole lane
    // down instead — losing the columns that had already been measured and
    // publishing nothing at all for that language.
    //
    // Marked rather than swallowed: the caller decides, because the same helper
    // fetches git objects and creates serena projects, and a timeout there is an
    // error like any other.
    if (result.error.code === "ETIMEDOUT") {
      const limitMs = benchTimeoutMs();
      const timedOut = new Error(
        `${label} did not finish within ${String(Math.round(limitMs / 1000))}s; ` +
          `see ${path.relative(repoRoot, `${logBase}.err.log`)}`,
      );
      timedOut.timedOutMs = limitMs;
      // Where the killed run's own account of itself is. The caller turns this
      // into a cell and would otherwise have no way back to the log it just
      // wrote, so a timed-out cell could only ever say "unknown".
      timedOut.logStem = logBase;
      throw timedOut;
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (${result.status}); see ${path.relative(repoRoot, `${logBase}.err.log`)}`,
    );
  }
}

/**
 * The provenance line the dump wrote beside its payload, or an honest absence.
 *
 * Read from the captured stderr rather than parsed out of the graph itself: the
 * payload is discarded on purpose, and re-running the build to learn what built
 * it would cost as much as the measurement. A line that is not there is
 * reported as unknown rather than guessed at, because "no strict provider
 * served" and "this dump predates the line" are different facts.
 */
function servedBy(logStem) {
  const served = "@samchon/graph: indexer=";
  // What it set out to run, written before the first candidate starts. A build
  // that finishes says what produced it; a build that is killed says nothing at
  // all, and the killed ones are the expensive ones. Reading the intent turns a
  // timed-out cell from "unknown" into "was running scip-ruby when the hour
  // ran out", which is the difference between a mystery and a finding.
  const attempting = "@samchon/graph: indexing with ";
  try {
    const lines = fs
      .readFileSync(`${logStem}.err.log`, "utf8")
      .split(/\r?\n/);
    const outcome = lines.find((line) => line.startsWith(served));
    if (outcome !== undefined) return outcome.slice(served.length).trim();
    const intent = lines.find((line) => line.startsWith(attempting));
    // Marked as an attempt rather than presented as a result: it says what was
    // selected, not what published, and those differ exactly when a provider
    // was chosen and then failed.
    return intent === undefined
      ? "unknown"
      : `attempted ${intent.slice(attempting.length).trim()}`;
  } catch {
    return "unknown";
  }
}

function codegraphCommand(args) {
  if (process.platform !== "win32") return ["codegraph", args];
  return ["cmd.exe", ["/d", "/s", "/c", "codegraph", ...args]];
}

// serena is launched the way the agent harness launches it: through uvx, from
// its git source, so the measured tool is the one the agent cells talked to.
function serenaCommand(args) {
  const binary =
    parsed.values["serena-command"] ?? process.env.SERENA_MCP_COMMAND ?? "uvx";
  const full = [
    "--from",
    parsed.values["serena-source"] ??
      process.env.SERENA_SOURCE ??
      "git+https://github.com/oraios/serena",
    "serena",
    ...args,
  ];
  if (process.platform !== "win32") return [binary, full];
  return ["cmd.exe", ["/d", "/s", "/c", binary, ...full]];
}

function codebaseMemoryCommand(args) {
  const binary =
    parsed.values["codebase-memory-binary"] ??
    parsed.values["cbm-binary"] ??
    process.env.CODEBASE_MEMORY_MCP_BINARY ??
    "codebase-memory-mcp";
  const resolved =
    path.isAbsolute(binary) || /[\\/]/.test(binary)
      ? path.resolve(binary)
      : binary;
  if (process.platform !== "win32") return [resolved, args];
  return ["cmd.exe", ["/d", "/s", "/c", resolved, ...args]];
}


function cleanupInsideFixture(repoDir, name) {
  const root = path.resolve(repoDir);
  const target = path.resolve(repoDir, name);
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`refusing to remove path outside fixture: ${target}`);
  }
  removeTree(target);
}

/**
 * Give one measured tool one project state.
 *
 * Strict producers run real builds. Reusing their checkout for the fallback
 * column lets the second cell inherit `target/`, `build/`, `bin/`, or `obj/`
 * from the first and turns a provider comparison into a cache-order
 * comparison. A local clone preserves the exact source commit and host while
 * keeping those project outputs private to one timer.
 */
function prepareCellFixture(project, spec, source, tool) {
  const root = path.join(outDir, "fixtures");
  const cellRoot = path.join(
    root,
    `${filenamePart(project)}-${filenamePart(tool)}`,
  );
  // Preserve the checkout basename inside a per-cell container. External
  // prepared companions use relative project paths, so copying the same
  // basename and directory geometry keeps those paths valid without rerunning
  // setup under --no-setup.
  const target = path.join(cellRoot, path.basename(source));
  fs.mkdirSync(root, { recursive: true });
  cleanupCellFixture(target);
  fs.mkdirSync(cellRoot, { recursive: true });
  try {
    if (parsed.flags.has("--no-setup")) {
      fs.cpSync(source, target, {
        recursive: true,
        verbatimSymlinks: true,
      });
      copyPreparedFixtureCompanion(spec, source, target);
      assertPreparedFixture(spec, target);
      return target;
    }
    runChecked(
      "git",
      ["clone", "--quiet", "--local", "--no-hardlinks", source, target],
      {
        label: `clone isolated fixture ${project}/${tool}`,
        logBase: path.join(
          outDir,
          `setup-${filenamePart(project)}-${filenamePart(tool)}-clone`,
        ),
      },
    );
    prepareFixture(spec, target, {
      noInstall: parsed.flags.has("--no-install"),
    });
    return target;
  } catch (error) {
    // The caller only receives a path after preparation succeeds. Own partial
    // copies here so a failed clone or dependency setup cannot strand a full
    // fixture outside the caller's finally block.
    rethrowWithCleanup(
      error,
      [
        {
          label: `remove partial fixture ${project}/${tool}`,
          run: () => cleanupCellFixture(target),
        },
      ],
      `prepare isolated fixture ${project}/${tool}`,
    );
  }
}

function cleanupCellFixture(target) {
  const root = path.resolve(outDir, "fixtures");
  const cellRoot = path.dirname(path.resolve(target));
  const relative = path.relative(root, cellRoot);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `refusing to remove cell fixture outside output: ${cellRoot}`,
    );
  }
  removeTree(cellRoot);
}

function copyPreparedFixtureCompanion(spec, source, target) {
  const from = preparedFixtureCompanion(spec, source);
  const to = preparedFixtureCompanion(spec, target);
  if (from === undefined || to === undefined) return;
  if (!fs.existsSync(from)) {
    throw new Error(`${spec.name} is missing prepared companion ${from}`);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

/**
 * Isolate ecosystem caches whose build tools otherwise make the second column
 * warm merely because it ran second.
 *
 * Only caches used by a corpus language are redirected. In particular Dart's
 * installed `scip_dart` executable lives in the provisioned pub cache, so
 * moving `PUB_CACHE` would remove the tool being measured rather than isolate
 * its project dependencies.
 */
function prepareCellCache(project, spec, tool) {
  const root = path.join(
    outDir,
    "cell-caches",
    filenamePart(project),
    filenamePart(tool),
  );
  cleanupCellCache(root);
  try {
    fs.mkdirSync(root, { recursive: true });
    const env = {};
    if (spec.language === "java" || spec.language === "kotlin") {
      env.GRADLE_USER_HOME = path.join(root, "gradle");
      const localRepository = path.join(root, "maven").replaceAll("\\", "/");
      env.JAVA_TOOL_OPTIONS = [
        process.env.JAVA_TOOL_OPTIONS,
        javaSystemProperty("maven.repo.local", localRepository),
      ]
        .filter(Boolean)
        .join(" ");
    } else if (spec.language === "csharp") {
      env.NUGET_PACKAGES = path.join(root, "nuget");
      env.NUGET_HTTP_CACHE_PATH = path.join(root, "nuget-http");
      env.NUGET_SCRATCH = path.join(root, "nuget-scratch");
      env.NUGET_PLUGINS_CACHE_PATH = path.join(root, "nuget-plugins");
      env.DOTNET_CLI_HOME = path.join(root, "dotnet-home");
    } else if (spec.language === "go") {
      env.GOCACHE = path.join(root, "go-build");
      env.GOMODCACHE = path.join(root, "go-mod");
    } else if (spec.language === "rust") {
      env.CARGO_HOME = path.join(root, "cargo");
    }
    return {
      root,
      env,
      kind:
        Object.keys(env).length === 0 ? "project" : "project-and-ecosystem",
    };
  } catch (error) {
    rethrowWithCleanup(
      error,
      [
        {
          label: `remove partial cache ${project}/${tool}`,
          run: () => cleanupCellCache(root),
        },
      ],
      `prepare isolated cache ${project}/${tool}`,
    );
  }
}

function cleanupCellCache(target) {
  const root = path.resolve(outDir, "cell-caches");
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`refusing to remove cell cache outside output: ${target}`);
  }
  removeTree(resolved);
}

/**
 * Run one operation and every cleanup without letting a later cleanup erase an
 * earlier failure.
 */
async function runWithCleanup(operation, cleanups, label) {
  let failed = false;
  let failure;
  let result;
  try {
    result = await operation();
  } catch (error) {
    failed = true;
    failure = error;
  }
  const cleanup = cleanupFailures(cleanups);
  if (cleanup.length > 0) {
    throw new AggregateError(
      [...(failed ? [failure] : []), ...cleanup],
      failed
        ? `${label} failed, and its cleanup also failed`
        : `${label} cleanup failed`,
    );
  }
  if (failed) throw failure;
  return result;
}

/** Rethrow one known failure after attempting all of its cleanup. */
function rethrowWithCleanup(failure, cleanups, label) {
  const cleanup = cleanupFailures(cleanups);
  if (cleanup.length > 0) {
    throw new AggregateError(
      [failure, ...cleanup],
      `${label} failed, and its cleanup also failed`,
    );
  }
  throw failure;
}

function cleanupFailures(cleanups) {
  const failures = [];
  for (const cleanup of cleanups) {
    try {
      cleanup.run();
    } catch (error) {
      failures.push(
        new Error(
          `${cleanup.label}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        ),
      );
    }
  }
  return failures;
}

function ensureFixtures(projects) {
  for (const project of projects) {
    const spec = PROJECTS[project];
    const repoDir = projectDir(workDir, spec);
    if (!fs.existsSync(repoDir)) {
      fs.mkdirSync(repoDir, { recursive: true });
      for (const [label, args] of [
        ["init", ["init", "--quiet"]],
        ["remote", ["remote", "add", "origin", spec.sourceRepo]],
        ["fetch", ["fetch", "--quiet", "--depth", "1", "origin", spec.commit]],
        ["checkout", ["checkout", "--quiet", spec.commit]],
      ])
        runChecked("git", args, {
          label: `${label} graph fixture ${project}`,
          logBase: path.join(outDir, `setup-${project}-${label}`),
          cwd: repoDir,
        });
    } else {
      assertPinnedCheckout(spec, repoDir);
      process.stdout.write(`[index-time] reusing fixture ${project}\n`);
    }
  }
}

function selectTools(value) {
  const names = splitList(value);
  const expanded = names.includes("all")
    ? ALL_TOOLS
    : names.map((name) =>
        name === "codebase-memory-mcp" ? TOOL_CODEBASE_MEMORY : name,
      );
  const allowed = new Set(ALL_TOOLS);
  if (expanded.length === 0)
    throw new Error(
      `--tools must name one of ${ALL_TOOLS.join(", ")} or all`,
    );
  for (const name of expanded) {
    if (!allowed.has(name))
      throw new Error(
        `--tools must name one of ${ALL_TOOLS.join(", ")} or all`,
      );
  }
  return [...new Set(expanded)];
}

function selectProjects({ flags, values, positional }) {
  const explicit = [...splitList(values.project ?? ""), ...positional];
  const names = flags.has("--all") ? Object.keys(PROJECTS) : explicit;
  for (const name of names) {
    if (!PROJECTS[name])
      throw new Error(
        `unknown project ${name}; choose ${Object.keys(PROJECTS).join(", ")}`,
      );
  }
  return [...new Set(names)];
}

function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project") {
      values.project = appendCsv(values.project, argv[++i]);
    } else if (arg.startsWith("--project=")) {
      values.project = appendCsv(
        values.project,
        arg.slice("--project=".length),
      );
    } else if (arg.startsWith("--")) {
      const match = /^--([^=]+)=(.*)$/.exec(arg);
      if (match) values[match[1]] = match[2];
      else flags.add(arg);
    } else {
      positional.push(arg);
    }
  }
  return { values, flags, positional };
}

function appendCsv(left, right) {
  return [left, right].filter(Boolean).join(",");
}

function splitList(value) {
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function filenamePart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
