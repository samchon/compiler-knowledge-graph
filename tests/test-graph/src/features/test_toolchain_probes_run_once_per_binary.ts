import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import path from "node:path";

import { createResidentGraphSource } from "../../../../packages/graph/src/indexer/createResidentGraphSource";
import type { IIndexerResult } from "../../../../packages/graph/src/indexer/IIndexerResult";
import type { IGraphProvider } from "../../../../packages/graph/src/provider/IGraphProvider";
import { providerTopology } from "../../../../packages/graph/src/provider/providerTopology";
import { toolchainVersion } from "../../../../packages/graph/src/provider/toolchainVersion";
import { GraphPaths } from "../internal/GraphPaths";
import { ProviderFixtures } from "../internal/ProviderFixtures";

/**
 * A toolchain version is a property of the binary, asked once.
 *
 * Deriving one launches a process, and the rows were re-derived on every
 * resident load — once by the topology snapshot and again by the session it
 * was about to refresh. The launches were the visible cost; the failure was
 * what the topology did with them. A probe that failed for a reason unrelated
 * to the project produced a row saying the tool was unavailable, the serialized
 * topology moved, and the resident answered by discarding a valid index and
 * rebuilding every language.
 *
 * These cases pin the three separated facts: absence is decided without a
 * launch, a launch that does not answer is its own state, and a binary that did
 * not move is not asked twice.
 */
export const test_toolchain_probes_run_once_per_binary = async () => {
  assertAnAnswerIsReusedUntilTheBinaryMoves();
  assertResolutionRatherThanTheProbeDecidesAbsence();
  assertEveryProbedLineSurvivesOnOneLine();
  assertTopologyNeverLaunchesAToolchain();
  await assertATransientProbeFailureKeepsTheResidentIndex();
};

function assertAnAnswerIsReusedUntilTheBinaryMoves(): void {
  const root = GraphPaths.createTempDirectory("graph-toolchain-probe-");
  const log = path.join(root, "probe.log");
  const binary = shim(root, "reused-toolchain");
  const env = probeEnvironment(log, binary, "SAMCHON_GRAPH_FIXTURE_TOOLCHAIN");

  const first = toolchainVersion({
    root,
    env,
    command: "reused-toolchain",
    override: "SAMCHON_GRAPH_FIXTURE_TOOLCHAIN",
    args: ["--version"],
  });
  const second = toolchainVersion({
    root,
    env,
    command: "reused-toolchain",
    override: "SAMCHON_GRAPH_FIXTURE_TOOLCHAIN",
    args: ["--version"],
  });
  TestValidator.equals("a repeated probe answers identically", first, second);
  TestValidator.equals(
    "a binary that did not move is launched once",
    launches(log),
    1,
  );

  // A different program of the same name is a different program. Rewriting the
  // shim in place is the event a name-keyed cache would miss, and it is exactly
  // how a developer replaces a toolchain under a running server.
  shim(root, "reused-toolchain", "moved");
  toolchainVersion({
    root,
    env,
    command: "reused-toolchain",
    override: "SAMCHON_GRAPH_FIXTURE_TOOLCHAIN",
    args: ["--version"],
  });
  TestValidator.equals(
    "a replaced binary is probed again",
    launches(log),
    2,
  );
}

function assertResolutionRatherThanTheProbeDecidesAbsence(): void {
  const root = GraphPaths.createTempDirectory("graph-toolchain-absent-");
  const log = path.join(root, "probe.log");
  const binary = shim(root, "refusing-toolchain");
  TestValidator.equals(
    "a tool that does not resolve is unavailable without a launch",
    toolchainVersion({
      root,
      env: probeEnvironment(log, binary, "SAMCHON_GRAPH_FIXTURE_UNUSED"),
      command: "missing-toolchain",
      override: "SAMCHON_GRAPH_FIXTURE_TOOLCHAIN",
      args: ["--version"],
    }),
    "missing-toolchain=unavailable",
  );
  TestValidator.equals(
    "deciding absence launches nothing",
    launches(log),
    0,
  );

  const refusing = {
    ...probeEnvironment(log, binary, "SAMCHON_GRAPH_FIXTURE_TOOLCHAIN"),
    SAMCHON_GRAPH_FIXTURE_PROBE_FAIL: "1",
  };
  TestValidator.equals(
    "an installed tool whose probe refuses is unreported",
    toolchainVersion({
      root,
      env: refusing,
      command: "refusing-toolchain",
      override: "SAMCHON_GRAPH_FIXTURE_TOOLCHAIN",
      args: ["--version"],
    }),
    "refusing-toolchain=unreported",
  );
  // A refusal is never remembered: the tool is installed, so the next question
  // is worth asking. Remembering it would freeze a transient failure for the
  // life of the process.
  TestValidator.equals(
    "a refused probe is retried rather than cached",
    toolchainVersion({
      root,
      env: refusing,
      command: "refusing-toolchain",
      override: "SAMCHON_GRAPH_FIXTURE_TOOLCHAIN",
      args: ["--version"],
    }),
    "refusing-toolchain=unreported",
  );
  TestValidator.equals("both refusals were launched", launches(log), 2);
}

function assertEveryProbedLineSurvivesOnOneLine(): void {
  const root = GraphPaths.createTempDirectory("graph-toolchain-lines-");
  const log = path.join(root, "probe.log");
  const binary = shim(root, "verbose-toolchain");
  const row = toolchainVersion({
    root,
    env: probeEnvironment(log, binary, "SAMCHON_GRAPH_FIXTURE_TOOLCHAIN"),
    command: "verbose-toolchain",
    override: "SAMCHON_GRAPH_FIXTURE_TOOLCHAIN",
    args: ["--version"],
  });
  // `java --version`, `clang --version`, and `rustc -vV` all answer in several
  // lines whose tail carries the host triple and the runtime build. Keeping
  // only the first drops them; keeping the newlines puts a multi-line value in
  // a provenance field every other publisher fills with one line.
  TestValidator.equals(
    "a multi-line probe becomes one row without losing a line",
    row,
    "verbose-toolchain=fake-toolchain 1.2.3; Runtime Environment (build 1.2.3+7); 64-Bit Server VM",
  );
}

function assertTopologyNeverLaunchesAToolchain(): void {
  const root = GraphPaths.createTempDirectory("graph-toolchain-topology-");
  const provider: IGraphProvider = {
    ...ProviderFixtures.provider({ name: "probing-provider" }),
    configuration: () => {
      throw new Error("the topology snapshot must not derive configuration");
    },
  };
  const rows = providerTopology.available(
    root,
    ["typescript"],
    { cwd: root },
    { PATH: "", Path: "" },
    [provider],
  );
  TestValidator.equals(
    "eligibility is reported without asking for a build universe",
    rows.map((row) => row.provider),
    ["probing-provider"],
  );
}

async function assertATransientProbeFailureKeepsTheResidentIndex(): Promise<void> {
  const root = GraphPaths.createTempDirectory("graph-toolchain-resident-");
  const file = path.join(root, "a.ts");
  fs.writeFileSync(file, "export const value = 1;\n");

  // The failure this replays: the row moved because a launch failed, not
  // because anything about the project or the toolchain changed. The topology
  // used to carry that row, so the resident discarded a valid index over it.
  let derivations = 0;
  let unstable = false;
  const provider: IGraphProvider = {
    ...ProviderFixtures.provider({ name: "unstable-configuration-provider" }),
    configuration: () => {
      derivations += 1;
      return [unstable ? "toolchain=unreported" : "toolchain=1.0.0"];
    },
  };
  let builds = 0;
  const source = createResidentGraphSource(
    { cwd: root },
    {
      providers: [provider],
      buildLspGraph: async () => {
        builds += 1;
        return {
          ...resultOf(root, file),
          providers: new Map([["typescript", provider]]),
        };
      },
    },
  );
  await source.load();
  const afterCold = derivations;
  unstable = true;
  await source.load();
  TestValidator.equals(
    "a moved configuration row does not rebuild the resident state",
    builds,
    1,
  );
  TestValidator.equals(
    "a warm load derives no provider configuration at all",
    derivations,
    afterCold,
  );
  await source.close();
}

function resultOf(root: string, file: string): IIndexerResult {
  return {
    dump: {
      project: root,
      indexer: "lsp",
      languages: ["typescript"],
      nodes: [
        {
          id: "a.ts#value:variable",
          kind: "variable",
          language: "typescript",
          name: "value",
          file: "a.ts",
          external: false,
        },
      ],
      edges: [],
    },
    warnings: [],
    sessions: new Map(),
    sources: new Map([[file, fs.readFileSync(file, "utf8")]]),
  };
}

/** Write one executable shim that runs the observable fake toolchain. */
function shim(root: string, name: string, suffix = ""): string {
  const file = path.join(
    root,
    process.platform === "win32" ? `${name}.cmd` : name,
  );
  const fixture = GraphPaths.fakeToolchain;
  const marker = suffix === "" ? "" : ` rem ${suffix}`;
  fs.writeFileSync(
    file,
    process.platform === "win32"
      ? [
          "@echo off",
          `"${process.execPath}" "${fixture}" %*${marker}`,
          "",
        ].join("\r\n")
      : [
          "#!/bin/sh",
          `exec "${process.execPath}" "${fixture}" "$@"${suffix === "" ? "" : ` # ${suffix}`}`,
          "",
        ].join("\n"),
  );
  fs.chmodSync(file, 0o755);
  return file;
}

function probeEnvironment(
  log: string,
  binary: string,
  override: string,
): NodeJS.ProcessEnv {
  return {
    PATH: "",
    Path: "",
    PATHEXT: ".EXE;.CMD;.BAT",
    SystemRoot: process.env.SystemRoot,
    SAMCHON_GRAPH_FIXTURE_PROBE_LOG: log,
    [override]: binary,
  };
}

function launches(log: string): number {
  try {
    return fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line !== "").length;
    /* c8 ignore next 3 -- an absent log is zero launches, which is what the
     * absence case asserts. */
  } catch {
    return 0;
  }
}
