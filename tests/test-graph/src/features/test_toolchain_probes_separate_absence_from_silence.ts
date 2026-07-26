import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import path from "node:path";

import { createResidentGraphSource } from "../../../../packages/graph/src/indexer/createResidentGraphSource";
import type { IIndexerResult } from "../../../../packages/graph/src/indexer/IIndexerResult";
import type { IGraphProvider } from "../../../../packages/graph/src/provider/IGraphProvider";
import { BatchGraphSession } from "../../../../packages/graph/src/provider/BatchGraphSession";
import { providerTopology } from "../../../../packages/graph/src/provider/providerTopology";
import { standardScipProviders } from "../../../../packages/graph/src/provider/scip/standardScipProviders";
import { toolchainVersion } from "../../../../packages/graph/src/provider/toolchainVersion";
import { GraphPaths } from "../internal/GraphPaths";
import { ProviderFixtures } from "../internal/ProviderFixtures";

/**
 * A toolchain probe says three things, and a failed launch is not one of them.
 *
 * The row used to collapse "not installed" and "the launch did not answer" into
 * `unavailable`. A build universe computed from that value rebuilt itself over a
 * spawn failure, and the resident source went further: the topology snapshot
 * carried the same row, so one failed launch discarded a valid index and
 * rebuilt every language.
 *
 * The probe still runs every time it is asked, and that is deliberate — the
 * programs behind these names are dispatcher shims whose answer changes after
 * an upgrade that leaves the file identical. What changed is what a failure
 * means, and who asks.
 */
export const test_toolchain_probes_separate_absence_from_silence = async () => {
  assertAnUpgradedToolchainIsAlwaysObserved();
  assertResolutionRatherThanTheProbeDecidesAbsence();
  assertAFailedProbeIsTheSameFactEveryTime();
  assertEveryProbedLineSurvivesOnOneLine();
  assertTopologyAsksOnlyTheProvidersWithoutASession();
  assertAStaleOverrideFallsThroughToTheAliases();
  assertALaunchThatNeverRanSaysNothing();
  await assertAnUnaskedQuestionDoesNotMoveTheUniverse();
  await assertAServingProviderIsNotAskedTwice();
  await assertANonServingCandidateStillReportsItsRepair();
};

function assertAStaleOverrideFallsThroughToTheAliases(): void {
  const root = GraphPaths.createTempDirectory("graph-toolchain-alias-");
  const bin = path.join(root, ".samchon-graph", "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ["scip-python", "scip", "python"]) shim(bin, name);
  const python = standardScipProviders.find(
    (provider) => provider.name === "scip-python",
  )!;
  const rows = python.configuration?.(root, {
    PATH: "",
    Path: "",
    PATHEXT: ".EXE;.CMD;.BAT",
    SystemRoot: process.env.SystemRoot,
    SAMCHON_GRAPH_SCIP_PYTHON: platformExecutable(bin, "scip-python"),
    SAMCHON_GRAPH_SCIP: platformExecutable(bin, "scip"),
    // Pointed at a build that is no longer there. Falling through to the
    // aliases is the decision, not an accident: the row then names the
    // interpreter that answered rather than the one that was asked for.
    SAMCHON_GRAPH_PYTHON_TOOLCHAIN: path.join(bin, "absent-python"),
  });
  TestValidator.equals(
    "a stale override falls through and the row names what answered",
    rows?.filter((row) => !row.startsWith("scip")),
    [
      "python=fake-toolchain 1.2.3 | Runtime Environment (build 1.2.3+7) | 64-Bit Server VM",
    ],
  );

  // And when no spelling resolves at all, the row still names what was looked
  // for. An absent field would leave a reader unable to tell a toolchain the
  // build has no opinion about from one it could not find.
  // A different root, because a project-local `.samchon-graph/bin` resolves
  // whatever `PATH` says.
  const bare = GraphPaths.createTempDirectory("graph-toolchain-bare-");
  TestValidator.equals(
    "a toolchain with no spelling on this machine is named and unavailable",
    python
      .configuration?.(bare, {
        PATH: "",
        Path: "",
        PATHEXT: ".EXE;.CMD;.BAT",
        SystemRoot: process.env.SystemRoot,
      })
      .filter((row) => !row.startsWith("scip")),
    ["python3=unavailable"],
  );
}

function assertAnUpgradedToolchainIsAlwaysObserved(): void {
  const root = GraphPaths.createTempDirectory("graph-toolchain-upgrade-");
  const log = path.join(root, "probe.log");
  const ask = asker(root, log, "dispatching-toolchain");

  TestValidator.equals("a repeated probe answers identically", ask(), ask());
  TestValidator.equals(
    "the probe runs every time it is asked",
    launches(log),
    2,
  );

  // The reason it runs every time. `rustc`, `python3`, `ruby`, `java`, and
  // `dotnet` are normally dispatcher shims — rustup, pyenv, rbenv, jenv, the
  // .NET muxer — that report a new version after an upgrade which leaves the
  // shim byte-identical. This repository already depends on that being true:
  // `global.json`, the file that picks a project's .NET SDK, is one of
  // `scip-dotnet`'s declared build inputs. An answer filed against the file
  // would be served forever, and the universe would keep naming a compiler
  // that is no longer installed.
  fs.writeFileSync(path.join(root, "toolchain-version"), "9.9.9");
  TestValidator.predicate(
    "an upgrade behind an unchanged shim is observed",
    ask().includes("9.9.9"),
  );
}

function assertResolutionRatherThanTheProbeDecidesAbsence(): void {
  const root = GraphPaths.createTempDirectory("graph-toolchain-absent-");
  const log = path.join(root, "probe.log");
  const binary = shim(root, "present-toolchain");
  // Named for what it measures. Absence is decided before the probe, so no
  // probe runs — but resolution itself consults `PATH` by launching `where.exe`
  // or `command -v`, so this is not a claim that nothing was launched at all.
  // That seam is why a lookup which fails to run still reports absence.
  TestValidator.equals(
    "a tool that does not resolve is unavailable without being probed",
    toolchainVersion({
      root,
      env: probeEnvironment(log, binary, "SAMCHON_GRAPH_FIXTURE_UNUSED"),
      command: "missing-toolchain",
      override: "SAMCHON_GRAPH_FIXTURE_TOOLCHAIN",
      args: ["--version"],
    }),
    "missing-toolchain=unavailable",
  );
  TestValidator.equals("deciding absence probes nothing", launches(log), 0);

  fs.writeFileSync(path.join(root, "toolchain-refuse"), "");
  TestValidator.equals(
    "an installed tool that has never answered is unreported",
    asker(root, log, "present-toolchain")(),
    "present-toolchain=unreported",
  );
}

function assertAFailedProbeIsTheSameFactEveryTime(): void {
  const root = GraphPaths.createTempDirectory("graph-toolchain-transient-");
  const log = path.join(root, "probe.log");
  const ask = asker(root, log, "flaky-toolchain");
  const answered = ask();

  // A launch can fail for reasons that have nothing to do with the project — a
  // timeout, an EAGAIN, a file lock. What matters for a build universe is not
  // which value the row takes but that it takes the *same* value for as long as
  // the condition holds: `unavailable` used to be the answer, and because
  // absence produced it too, a fingerprint could not tell a missing toolchain
  // from a launch that did not land.
  fs.writeFileSync(path.join(root, "toolchain-refuse"), "");
  const refusals = [ask(), ask(), ask()];
  TestValidator.equals(
    "a launch that keeps failing keeps giving the same row",
    refusals,
    [
      "flaky-toolchain=unreported",
      "flaky-toolchain=unreported",
      "flaky-toolchain=unreported",
    ],
  );
  TestValidator.equals(
    "and every one of them was a real launch",
    launches(log),
    4,
  );

  // So the universe moves once on the way out and once on the way back, rather
  // than on every refresh in between.
  fs.rmSync(path.join(root, "toolchain-refuse"));
  TestValidator.equals("a recovered toolchain answers again", ask(), answered);
}

function assertEveryProbedLineSurvivesOnOneLine(): void {
  const root = GraphPaths.createTempDirectory("graph-toolchain-lines-");
  const log = path.join(root, "probe.log");
  // `java --version`, `clang --version`, and `rustc -vV` all answer in several
  // lines whose tail carries the host triple and the runtime build. Keeping
  // only the first drops them; keeping the newlines puts a multi-line value in
  // a provenance field every other publisher fills with one line. The line
  // separator differs from the `; ` that callers use between whole rows, so a
  // reader can still tell where one tool's answer ends.
  TestValidator.equals(
    "a multi-line probe becomes one row without losing a line",
    asker(root, log, "verbose-toolchain")(),
    "verbose-toolchain=fake-toolchain 1.2.3 | Runtime Environment (build 1.2.3+7) | 64-Bit Server VM",
  );
}

function assertTopologyAsksOnlyTheProvidersWithoutASession(): void {
  const root = GraphPaths.createTempDirectory("graph-toolchain-topology-");
  let derivations = 0;
  const provider: IGraphProvider = {
    ...ProviderFixtures.provider({ name: "probing-provider" }),
    configuration: () => {
      derivations += 1;
      return ["toolchain=1.0.0"];
    },
  };
  const rows = (servedBy: ReadonlySet<string>) =>
    providerTopology.available(
      root,
      ["typescript"],
      { cwd: root },
      { PATH: "", Path: "" },
      [provider],
      servedBy,
    );

  // A provider that is serving already derives these once per refresh inside
  // its own session to decide whether its artifact is stale. Asking again here
  // would be a second answer to a settled question, paid on every resident
  // load — which is every request a long-lived server answers.
  TestValidator.equals(
    "a serving provider's configuration is not derived here",
    rows(new Set(["probing-provider"]))[0]?.configuration,
    undefined,
  );
  TestValidator.equals("nothing was derived for it", derivations, 0);

  // A candidate that resolved and did not serve has no session to ask, and its
  // build universe is the only evidence that the reason it fell back has been
  // repaired. Without this a developer who fixes the toolchain and edits no
  // file stays on the generic lane indefinitely.
  TestValidator.equals(
    "a candidate that did not serve carries its configuration",
    rows(new Set())[0]?.configuration,
    ["toolchain=1.0.0"],
  );
}

async function assertAServingProviderIsNotAskedTwice(): Promise<void> {
  const root = GraphPaths.createTempDirectory("graph-toolchain-resident-");
  const file = path.join(root, "a.ts");
  fs.writeFileSync(file, "export const value = 1;\n");

  let derivations = 0;
  const provider: IGraphProvider = {
    ...ProviderFixtures.provider({ name: "serving-provider" }),
    configuration: () => {
      derivations += 1;
      return ["toolchain=1.0.0"];
    },
  };
  const source = createResidentGraphSource(
    { cwd: root },
    {
      providers: [provider],
      buildLspGraph: async () => ({
        ...resultOf(root, file),
        providers: new Map([["typescript", provider]]),
      }),
    },
  );
  await source.load();
  const afterCold = derivations;
  await source.load();
  // Both numbers, because comparing the warm count to the cold one would hold
  // at zero and prove nothing. What is being claimed is that the topology
  // snapshot asks a serving provider for its configuration neither time: its
  // own session already derives those rows once per refresh, and asking here
  // would be a second answer to a settled question, paid on every request a
  // long-lived server answers.
  TestValidator.equals(
    "the resident topology never asks a serving provider for its configuration",
    [afterCold, derivations],
    [0, 0],
  );
  await source.close();
}

async function assertANonServingCandidateStillReportsItsRepair(): Promise<void> {
  const root = GraphPaths.createTempDirectory("graph-toolchain-fallback-");
  const file = path.join(root, "a.ts");
  fs.writeFileSync(file, "export const value = 1;\n");

  // The whole reason a non-serving candidate keeps its configuration in the
  // topology snapshot. This provider resolved and did not serve, so it has no
  // session deriving its build universe, and a developer who repairs the
  // toolchain without editing a file has nothing else that could notice.
  let setting = "toolchain=broken";
  const provider: IGraphProvider = {
    ...ProviderFixtures.provider({ name: "declining-provider" }),
    configuration: () => [setting],
  };
  let builds = 0;
  const source = createResidentGraphSource(
    { cwd: root },
    {
      providers: [provider],
      buildLspGraph: async () => {
        builds += 1;
        return { ...resultOf(root, file), providers: new Map() };
      },
    },
  );
  await source.load();
  await source.load();
  TestValidator.equals(
    "an unchanged fallback does not rebuild the resident state",
    builds,
    1,
  );
  setting = "toolchain=1.0.0";
  await source.load();
  TestValidator.equals(
    "a repaired fallback candidate rebuilds so it can serve",
    builds,
    2,
  );
  await source.close();
}

function assertALaunchThatNeverRanSaysNothing(): void {
  const root = GraphPaths.createTempDirectory("graph-toolchain-unasked-");
  const bin = path.join(root, ".samchon-graph", "bin");
  fs.mkdirSync(bin, { recursive: true });
  // A file the operating system cannot execute. `isSpawnableFile` accepts it —
  // it is a regular file with the executable bit — and `spawnSync` then fails to
  // start it, which is the shape of every transient launch failure: an EAGAIN
  // under load, a scanner holding the image, a timeout. The probe used to read
  // "the exit was not zero" and call that silence.
  const unlaunchable = path.join(
    bin,
    process.platform === "win32" ? "broken-toolchain.cmd" : "broken-toolchain",
  );
  fs.writeFileSync(unlaunchable, "  not a program ");
  fs.chmodSync(unlaunchable, 0o755);
  const row = toolchainVersion({
    root,
    env: { PATH: "", Path: "", PATHEXT: ".EXE;.CMD;.BAT" },
    command: "broken-toolchain",
    args: ["--version"],
  });
  // On Windows a `.cmd` is handed to the command processor, which runs and
  // fails rather than failing to start — that is a program which ran and said
  // nothing. On POSIX the exec itself fails. Both are honest; neither may be
  // `unavailable`, because the file is right there.
  TestValidator.predicate(
    "a launch that cannot start is never reported as an absent tool",
    row === "broken-toolchain=unasked" ||
      row === "broken-toolchain=unreported",
  );
}

async function assertAnUnaskedQuestionDoesNotMoveTheUniverse(): Promise<void> {
  const root = GraphPaths.createTempDirectory("graph-toolchain-universe-");
  const source = path.join(root, "a.ts");
  fs.writeFileSync(source, "export const value = 1;\n");
  const artifact = path.join(root, "index.json");

  let rows = ["tool=1.0.0"];
  const session = new BatchGraphSession({
    root,
    languages: ["typescript"],
    provider: "unasked-fixture",
    command: {
      command: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1], '{}')"],
    },
    artifactName: "index.json",
    indexArgs: (produced) => [produced],
    inputs: () => ["a.ts"],
    configuration: () => rows,
    load: () =>
      Promise.resolve(
        ProviderFixtures.snapshot({
          root,
          provider: "unasked-fixture",
          languages: ["typescript"],
        }),
      ),
  });
  try {
    const cold = await session.refresh();
    // The question could not be put this time. Nothing was established, so
    // nothing changed — the row that would have moved the universe is exactly
    // the one that says it learned nothing.
    rows = [`tool${toolchainVersion.UNASKED}`];
    const inconclusive = await session.refresh();
    TestValidator.equals(
      "a derivation that established nothing does not move the build universe",
      [cold.mode, inconclusive.mode, inconclusive.generation],
      ["initial", "unchanged", cold.generation],
    );

    // But it must not mask the project. An edited input is read from disk on
    // every refresh, so a source that moved still rebuilds while the toolchain
    // question stays unanswerable.
    fs.writeFileSync(source, "export const value = 2;\n");
    const edited = await session.refresh();
    TestValidator.equals(
      "an edited source still rebuilds while the question stays unanswerable",
      edited.mode,
      "rebuild",
    );

    // And a genuine change is believed as soon as it can be established.
    rows = ["tool=2.0.0"];
    const upgraded = await session.refresh();
    TestValidator.equals(
      "a toolchain change is believed once the question can be put again",
      upgraded.mode,
      "rebuild",
    );
  } finally {
    await session.close();
    fs.rmSync(artifact, { force: true });
  }
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

/** Ask one named toolchain for its version, through an observable shim. */
function asker(
  root: string,
  log: string,
  name: string,
): () => string {
  const binary = shim(root, name);
  const env = probeEnvironment(log, binary, "SAMCHON_GRAPH_FIXTURE_TOOLCHAIN");
  return () =>
    toolchainVersion({
      root,
      env,
      command: name,
      override: "SAMCHON_GRAPH_FIXTURE_TOOLCHAIN",
      args: ["--version"],
    });
}

function shim(root: string, name: string): string {
  const file = path.join(
    root,
    process.platform === "win32" ? `${name}.cmd` : name,
  );
  const fixture = GraphPaths.fakeToolchain;
  fs.writeFileSync(
    file,
    process.platform === "win32"
      ? ["@echo off", `"${process.execPath}" "${fixture}" %*`, ""].join("\r\n")
      : [
          "#!/bin/sh",
          `exec "${process.execPath}" "${fixture}" "$@"`,
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

function platformExecutable(directory: string, name: string): string {
  return path.join(
    directory,
    process.platform === "win32" ? `${name}.cmd` : name,
  );
}
