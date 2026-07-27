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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PROJECTS, projectDir, resolveWorkDir } from "./corpus.mjs";
import {
  assertPinnedCheckout,
  assertPreparedFixture,
  graphLauncher,
  prepareFixture,
  serverArgsForPreparedFixture,
} from "./language.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const workDir = resolveWorkDir(repoRoot);
const websiteJson = path.join(
  repoRoot,
  "tests",
  "benchmark",
  "results",
  "graph.json",
);

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
  cpp: [".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"],
  ruby: [".rb"],
  php: [".php"],
  csharp: [".cs"],
  kotlin: [".kt", ".kts"],
  lua: [".lua"],
  dart: [".dart"],
};

const TOOL_SAMCHON = "samchon-graph";
const TOOL_CODEGRAPH = "codegraph";
const TOOL_CODEBASE_MEMORY = "codebase-memory";
const TOOL_SERENA = "serena";
const ALL_TOOLS = [
  TOOL_SAMCHON,
  TOOL_CODEGRAPH,
  TOOL_CODEBASE_MEMORY,
  TOOL_SERENA,
];

// `serena project create` interviews the operator about every language it
// detects, one prompt each, and VS Code detects twenty-two of them. Decline them
// all: the fixture is TypeScript, and an unanswered prompt aborts the command on
// EOF.
const SERENA_DECLINE_ALL = "n\n".repeat(80);

const parsed = parseArgs(process.argv.slice(2));
const selected = selectProjects(parsed);
const tools = selectTools(parsed.values.tools ?? parsed.values.tool ?? "all");
const outDir = path.resolve(
  parsed.values.out ?? path.join(workDir, "graph-index", timestamp()),
);
const reportPath = path.join(outDir, "report.json");

if (parsed.flags.has("--list")) {
  for (const project of Object.keys(PROJECTS)) {
    const spec = PROJECTS[project];
    process.stdout.write(
      `${project}: ${projectDir(workDir, spec)} (${spec.language} @ ${spec.commit.slice(0, 12)})\n`,
    );
  }
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

// Quiet-host gate, mirrored from performance.mjs: a cold build is one sample
// with no median to hide behind, so a noisy host corrupts the cell outright.
// Warns by default, aborts under SAMCHON_BENCH_REQUIRE_QUIET=1 (set it for every
// publication run), and is silenced by SAMCHON_BENCH_SKIP_LOAD_CHECK=1. Note
// os.loadavg() reports zeros on Windows, so the gate only bites on POSIX
// hosts; on Windows quietness stays the operator's responsibility.
// `--await-quiet=<seconds>` waits for the host to settle before that gate reads
// it, rather than reading a machine still hot from whatever prepared it. A
// checkout, a dependency install, and a language-server download leave a
// one-minute load average that has nothing to do with the measurement and every
// bit of a cold build's wall clock. Waiting makes the quiet claim true;
// disabling the gate would only stop it being checked.
//
// The wait is bounded and its outcome is recorded. A host that never settles
// falls through to the gate below and is refused, which is the honest end for a
// machine that cannot take this measurement.
const awaitQuietSeconds = Number(parsed.values["await-quiet"] ?? 0);
let quietWait = null;
if (Number.isFinite(awaitQuietSeconds) && awaitQuietSeconds > 0) {
  quietWait = await awaitQuietHost(awaitQuietSeconds);
  process.stdout.write(
    `[index-time] host settled to ratio ${quietWait.ratio.toFixed(2)} after ` +
      `${String(quietWait.waitedSeconds)}s (limit ${String(awaitQuietSeconds)}s)\n`,
  );
}

if (process.env.SAMCHON_BENCH_SKIP_LOAD_CHECK !== "1") {
  const cpuCount = Math.max(os.cpus().length, 1);
  const load1 = os.loadavg()[0];
  const ratio = load1 / cpuCount;
  if (ratio > 0.5) {
    const msg =
      `host load is high (1-min loadavg ${load1.toFixed(2)} on ` +
      `${cpuCount} CPUs, ratio ${ratio.toFixed(2)}); a one-shot cold build ` +
      `may drift far from a quiet baseline. ` +
      `Set SAMCHON_BENCH_SKIP_LOAD_CHECK=1 to ignore.`;
    if (process.env.SAMCHON_BENCH_REQUIRE_QUIET === "1") {
      throw new Error(`index-time: ${msg}`);
    }
    process.stderr.write(`[index-time] warning: ${msg}\n`);
  }
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
  date: new Date().toISOString(),
  outDir,
  tools,
  projects: selected,
  host: hostSpec(),
  // What the machine looked like when it was allowed to take the measurement.
  // A cold build is one sample, so how quiet the host was is part of the result
  // rather than a detail of how it was produced.
  quietWait,
  scale: {},
  cells: [],
};

for (const project of selected) {
  const spec = PROJECTS[project];
  const repoDir = projectDir(workDir, spec);
  if (!fs.existsSync(repoDir))
    throw new Error(`missing graph benchmark clone: ${repoDir}`);
  // Project scale, so a build time can be read against the work it had to do:
  // forty seconds on VS Code and one second on a small backend are the same
  // tool, not two. Tracked TypeScript/TSX sources (git ls-files) naturally
  // exclude node_modules, build output, and anything else the fixture
  // ignores; `.d.ts` is excluded because it is shipped output, not source.
  report.scale[project] = measureScale(project, spec, repoDir);
  writeJson(reportPath, report);

  for (const tool of tools) {
    let cell;
    try {
      cell = runIndexCell({ project, spec, repoDir, tool });
    } catch (error) {
      // Only a timeout becomes a cell. Anything else is still a broken run and
      // has to stop the lane, or a genuine defect would publish as a number.
      if (typeof error?.timedOutMs !== "number") throw error;
      cell = {
        project,
        tool,
        buildMs: null,
        timedOutMs: error.timedOutMs,
        // The process was killed, so it never wrote its provenance line. Saying
        // unknown is the honest reading: what would have built this is exactly
        // what the run failed to establish.
        servedBy: "unknown",
      };
    }
    assertPinnedCheckout(spec, repoDir);
    // The machine and its quietness travel with the cell, not with the
    // publication. One host panel is only truthful when one sweep measured
    // everything, and `index-time.yml` deliberately gives each language its own
    // runner — thirteen VMs with thirteen CPU models, because two lanes sharing
    // a machine would corrupt each other's wall clock. Folding those under a
    // single panel would attribute twelve cells to a machine they never ran on,
    // and the workflow's own header says cells from different hosts are not one
    // comparison. A cold build is one sample; what it ran on is part of it.
    report.cells.push({ ...cell, host: report.host, quietWait });
    writeJson(reportPath, report);
    printCellSummary(project, cell);
    publishWebsiteIndex(report);
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

function runIndexCell({ project, spec, repoDir, tool }) {
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
      runChecked(...serenaCommand(["project", "create", repoDir]), {
        label: `serena project create ${project}`,
        logBase: path.join(outDir, `serena-create-${project}`),
        cwd: repoDir,
        input: SERENA_DECLINE_ALL,
      });
      const ms = timeChecked(...serenaCommand(["project", "index"]), {
        label: `serena project index ${project}`,
        logBase: path.join(outDir, `serena-index-${project}`),
        cwd: repoDir,
        input: SERENA_DECLINE_ALL,
      });
      return { project, tool, buildMs: ms };
    } finally {
      cleanupInsideFixture(repoDir, ".serena");
    }
  }
  if (tool === TOOL_SAMCHON) {
    const logStem = path.join(outDir, `samchon-graph-index-${project}`);
    const ms = timeChecked(
      process.execPath,
      [
        graphLauncher,
        "dump",
        "--cwd",
        repoDir,
        "--language",
        spec.language,
        "--mode",
        "lsp",
        ...serverArgsForPreparedFixture(spec, repoDir).flatMap((arg) => [
          "--server-arg",
          arg,
        ]),
      ],
      {
        label: `samchon-graph dump ${project}`,
        logBase: logStem,
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
    return { project, tool, buildMs: ms, servedBy: servedBy(logStem) };
  }
  if (tool === TOOL_CODEGRAPH) {
    ensureLocalIgnored(repoDir, ".codegraph/");
    cleanupInsideFixture(repoDir, ".codegraph");
    try {
      const ms = timeChecked(...codegraphCommand(["init", repoDir]), {
        label: `codegraph init ${project}`,
        logBase: path.join(outDir, `codegraph-index-${project}`),
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
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    try {
      const ms = timeChecked(
        ...codebaseMemoryCommand([
          "cli",
          "index_repository",
          JSON.stringify({
            repo_path: repoDir,
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
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  }
  throw new Error(`unknown tool ${tool}`);
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
    .filter((file) => extensions.some((ext) => file.toLowerCase().endsWith(ext)))
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
  const prior = fs.existsSync(websiteJson) ? loadJson(websiteJson) : null;
  const keepPrior = !parsed.flags.has("--reset-index");
  const priorIndex = keepPrior ? (prior?.index ?? null) : null;
  const scale = { ...(priorIndex?.scale ?? {}), ...currentReport.scale };
  const cells = [...(priorIndex?.cells ?? [])];
  for (const cell of currentReport.cells) {
    const at = cells.findIndex(
      (old) => old.project === cell.project && old.tool === cell.tool,
    );
    if (at >= 0) cells[at] = cell;
    else cells.push(cell);
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
    index: { host: currentReport.host, scale, cells },
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
  const marker = "@samchon/graph: indexer=";
  try {
    const line = fs
      .readFileSync(`${logStem}.err.log`, "utf8")
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith(marker));
    return line === undefined ? "unknown" : line.slice(marker.length).trim();
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

function ensureLocalIgnored(repoDir, entry) {
  const exclude = path.join(repoDir, ".git", "info", "exclude");
  if (!fs.existsSync(exclude)) return;
  const text = fs.readFileSync(exclude, "utf8");
  if (new RegExp(`^${entry.replace(/[.\\/]/g, "\\$&")}$`, "m").test(text))
    return;
  fs.appendFileSync(
    exclude,
    `${text.endsWith("\n") ? "" : "\n"}# generated by graph benchmark\n${entry}\n`,
  );
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
  fs.rmSync(target, { recursive: true, force: true });
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
    prepareFixture(spec, repoDir, {
      noInstall: parsed.flags.has("--no-install"),
    });
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
      "--tools must contain samchon-graph, codegraph, codebase-memory, serena, or all",
    );
  for (const name of expanded) {
    if (!allowed.has(name))
      throw new Error(
        "--tools must contain samchon-graph, codegraph, codebase-memory, serena, or all",
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
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
