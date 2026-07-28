#!/usr/bin/env node
/**
 * Non-authoritative request-level diagnosis for a slow generic-LSP lane.
 *
 * The published index-time cell must not pay for per-request formatting or
 * stderr writes. This command therefore runs after that measurement and emits
 * a separate trace whose only purpose is to distinguish one long server
 * request from a client lane completing many smaller requests.
 */
import cp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PROJECTS,
  projectDir,
  resolveWorkDir,
} from "./corpus.mjs";
import {
  assertPinnedCheckout,
  assertPreparedFixture,
  graphLauncher,
  prepareFixture,
  repoRoot,
  serverArgsForPreparedFixture,
} from "./language.mjs";
import {
  assertLspRequestDiagnosisEvidence,
  summarizeLspRequestTrace,
} from "./lsp-request-summary.mjs";
import { removeTree } from "./remove-tree.mjs";

const values = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (match === null) {
      throw new Error(
        `lsp request diagnosis expects --name=value, got ${argument}`,
      );
    }
    return [match[1], match[2]];
  }),
);
const project = values.project;
const spec = PROJECTS[project];
if (spec === undefined) {
  throw new Error(
    `--project must name one of ${Object.keys(PROJECTS).join(", ")}`,
  );
}
const timeoutMs = positiveInteger(values["timeout-ms"] ?? "300000");
const outDir = path.resolve(
  values.out ??
    path.join(repoRoot, "index-time-out", project),
);
const repoDir = projectDir(resolveWorkDir(repoRoot), spec);
assertPinnedCheckout(spec, repoDir);
fs.mkdirSync(outDir, { recursive: true });

const logBase = path.join(outDir, `lsp-request-diagnosis-${project}`);
const fixtureDir = path.join(
  outDir,
  `lsp-request-diagnosis-fixture-${project}`,
);
let result;
let elapsedMs;
removeTree(fixtureDir);
try {
  const cloned = cp.spawnSync(
    "git",
    [
      "clone",
      "--quiet",
      "--local",
      "--no-hardlinks",
      repoDir,
      fixtureDir,
    ],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true },
  );
  if (cloned.error !== undefined) throw cloned.error;
  if (cloned.status !== 0) {
    throw new Error(
      `${project}: diagnostic fixture clone failed: ${cloned.stderr ?? ""}`,
    );
  }
  prepareFixture(spec, fixtureDir);
  assertPreparedFixture(spec, fixtureDir);
  const targetDir =
    spec.indexRoot === undefined
      ? fixtureDir
      : path.join(fixtureDir, spec.indexRoot);
  const devNull = fs.openSync(os.devNull, "w");
  const started = process.hrtime.bigint();
  try {
    result = cp.spawnSync(
      process.execPath,
      [
        graphLauncher,
        "dump",
        "--cwd",
        targetDir,
        "--language",
        spec.language,
        "--mode",
        "lsp",
        "--no-strict",
        ...serverArgsForPreparedFixture(spec, fixtureDir).flatMap(
          (argument) => [
            "--server-arg",
            argument,
          ],
        ),
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          SAMCHON_GRAPH_LSP_REQUEST_TRACE: "1",
        },
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
        timeout: timeoutMs,
        stdio: ["ignore", devNull, "pipe"],
        windowsHide: true,
      },
    );
  } finally {
    elapsedMs =
      Number(process.hrtime.bigint() - started) / 1e6;
    fs.closeSync(devNull);
  }
} finally {
  removeTree(fixtureDir);
}
const stderr = result.stderr ?? "";
fs.writeFileSync(`${logBase}.err.log`, stderr);

const trace = summarizeLspRequestTrace(stderr);
const timedOut = result.error?.code === "ETIMEDOUT";
const summary = {
  authoritative: false,
  purpose:
    "request-level diagnosis collected after the published index-time measurement",
  project,
  language: spec.language,
  commit: spec.commit,
  timeoutMs,
  elapsedMs,
  outcome: timedOut
    ? "timed-out"
    : result.error !== undefined || result.status !== 0
      ? "failed"
      : "completed",
  exitStatus: result.status,
  signal: result.signal,
  cutoffObserved: trace.cutoffObserved,
  requestCount: trace.requestCount,
  completedCount: trace.completedCount,
  postCutoffEndCount: trace.postCutoffEndCount,
  postCutoffErrorCount: trace.postCutoffErrorCount,
  cleanupRequestCount: trace.cleanupRequestCount,
  cleanupCompletedCount: trace.cleanupCompletedCount,
  cleanupErrorCount: trace.cleanupErrorCount,
  inFlight: trace.inFlight,
  cleanupInFlight: trace.cleanupInFlight,
  methods: trace.methods,
};
fs.writeFileSync(
  `${logBase}.json`,
  `${JSON.stringify(summary, null, 2)}\n`,
);
process.stdout.write(
  `[lsp-request-diagnosis] ${project}: ${summary.outcome}; ` +
    `${String(summary.completedCount)}/${String(summary.requestCount)} requests completed, ` +
    `${String(summary.inFlight.length)} in flight\n`,
);
if (result.error !== undefined && !timedOut) throw result.error;
assertLspRequestDiagnosisEvidence(project, timedOut, trace);

function positiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`expected a positive integer, got ${value}`);
  }
  return parsed;
}
