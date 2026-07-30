import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import path from "node:path";

import { createResidentGraphSource } from "../../../../packages/graph/src/indexer/createResidentGraphSource";
import type { IIndexerResult } from "../../../../packages/graph/src/indexer/IIndexerResult";
import type { IGraphProvider } from "../../../../packages/graph/src/provider/IGraphProvider";
import { BatchGraphSession } from "../../../../packages/graph/src/provider/BatchGraphSession";
import { goGraphProvider } from "../../../../packages/graph/src/provider/go/goGraphProvider";
import { luaGraphProvider } from "../../../../packages/graph/src/provider/lua/luaGraphProvider";
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
  assertOnlyAKnownRowCanBeRestored();
  assertDuplicateCompilerLabelsKeepDistinctIdentities();
  assertGoPathCanLiterallyEqualUnasked();
  assertPublicConfigurationKeepsEvidenceInternal();
  assertTypedEvidenceIsCanonical();
  assertATopologyRestoresPerProviderRow();
  assertTopologyAsksOnlyTheProvidersWithoutASession();
  assertTopologySortsRowsWithTheirEvidence();
  assertAStaleOverrideFallsThroughToTheAliases();
  assertALaunchThatNeverRanSaysNothing();
  assertAProbeThatCouldNotStartIsNotSilence();
  assertALookupThatCouldNotRunIsNotAnAbsentTool();
  await assertLiteralUnaskedSettingsAreNotControlState();
  await assertAnUnaskedQuestionDoesNotMoveTheUniverse();
  await assertAServingProviderIsNotAskedTwice();
  await assertANonServingCandidateStillReportsItsRepair();
  await assertResidentTopologyKeepsFreshPrivateIdentity();
};

function assertDuplicateCompilerLabelsKeepDistinctIdentities(): void {
  const root = GraphPaths.createTempDirectory(
    "graph-toolchain-duplicate-drivers-",
  );
  const firstBin = path.join(root, "toolchains", "first");
  const secondBin = path.join(root, "toolchains", "second");
  fs.mkdirSync(firstBin, { recursive: true });
  fs.mkdirSync(secondBin, { recursive: true });
  const first = shim(firstBin, "clang");
  const second = shim(secondBin, "clang");
  fs.writeFileSync(
    path.join(root, "compile_commands.json"),
    JSON.stringify([
      { directory: root, file: "a.c", arguments: [first, "-c", "a.c"] },
      { directory: root, file: "b.c", arguments: [second, "-c", "b.c"] },
    ]),
  );
  const indexer = shim(root, "scip-clang");
  const decoder = shim(root, "scip");
  const clang = standardScipProviders.find(
    (provider) => provider.name === "scip-clang",
  )!;
  const reported = clang.configurationDerivation?.(root, {
    PATH: "",
    Path: "",
    PATHEXT: ".EXE;.CMD;.BAT",
    SystemRoot: process.env.SystemRoot,
    SAMCHON_GRAPH_SCIP_CLANG: indexer,
    SAMCHON_GRAPH_SCIP: decoder,
  });
  const derivation =
    reported === undefined
      ? undefined
      : toolchainVersion.normalize(reported);
  const identities =
    derivation?.rows.flatMap((row, index) =>
      row.startsWith("clang=")
        ? [derivation.identities[index]]
        : [],
    ) ?? [];
  TestValidator.predicate(
    "same-label compilation drivers keep distinct private identities",
    identities.length === 2 &&
      identities.every(
        (identity): identity is string =>
          identity !== undefined,
      ) &&
      new Set(identities).size === 2,
  );
}

function assertGoPathCanLiterallyEqualUnasked(): void {
  const root = GraphPaths.createTempDirectory(
    "graph-toolchain-go-literal-unasked-",
  );
  const go = shim(root, "go");
  const scipGo = shim(root, "scip-go");
  const env = {
    PATH: "unasked",
    Path: "unasked",
    PATHEXT: ".EXE;.CMD;.BAT",
    SystemRoot: process.env.SystemRoot,
    SAMCHON_GRAPH_GO_TOOLCHAIN: go,
    SAMCHON_GRAPH_SCIP_GO: scipGo,
  };
  const visible = goGraphProvider.configuration?.(root, env);
  const derivation =
    goGraphProvider.configurationDerivation?.(root, env);
  TestValidator.predicate(
    "Go PATH=unasked is visible configuration, not probe control state",
    visible !== undefined &&
      derivation !== undefined &&
      JSON.stringify(visible) === JSON.stringify(derivation.rows) &&
      derivation.rows.includes("PATH=unasked") &&
      derivation.inconclusive.length === 0,
  );
}

function assertPublicConfigurationKeepsEvidenceInternal(): void {
  const root = GraphPaths.createTempDirectory(
    "graph-toolchain-public-evidence-",
  );
  const server = shim(root, "lua-language-server");
  const env = {
    PATH: "",
    Path: "",
    PATHEXT: ".EXE;.CMD;.BAT",
    SystemRoot: process.env.SystemRoot,
    SAMCHON_GRAPH_LUA: server,
  };
  const visible = luaGraphProvider.configuration?.(root, env);
  const evidence =
    luaGraphProvider.configurationDerivation?.(root, env);
  TestValidator.predicate(
    "public configuration remains rows while internal evidence stays parallel",
    visible !== undefined &&
      evidence !== undefined &&
      visible.length === 2 &&
      JSON.stringify(visible) === JSON.stringify(evidence.rows) &&
      visible[1]?.startsWith("lua-exporter=") === true &&
      evidence.identities.length === visible.length &&
      evidence.inconclusive.length === 0,
  );
}

function assertTypedEvidenceIsCanonical(): void {
  const invalid: [string, toolchainVersion.IDerivation][] = [
    [
      "private identities align with visible rows",
      { rows: ["tool=1"], inconclusive: [], identities: [] },
    ],
    [
      "inconclusive evidence indexes an existing row",
      { rows: ["tool=unasked"], inconclusive: [1], identities: ["tool"] },
    ],
    [
      "inconclusive indexes are safe integers",
      {
        rows: ["tool=unasked"],
        inconclusive: [0.5],
        identities: ["tool"],
      },
    ],
    [
      "inconclusive indexes do not repeat",
      {
        rows: ["a=unasked", "b=unasked"],
        inconclusive: [0, 0],
        identities: ["a", "b"],
      },
    ],
    [
      "inconclusive evidence has a private identity",
      {
        rows: ["tool=unasked"],
        inconclusive: [0],
        identities: [undefined],
      },
    ],
    [
      "inconclusive identities are nonempty",
      { rows: ["tool=unasked"], inconclusive: [0], identities: [""] },
    ],
  ];
  for (const [label, derivation] of invalid)
    TestValidator.error(label, () => toolchainVersion.normalize(derivation));

  const unordered = {
    rows: ["a=unasked", "b=unasked"],
    inconclusive: [1, 0],
    identities: ["a", "b"],
  };
  TestValidator.equals(
    "unique inconclusive indexes normalize into canonical order",
    toolchainVersion.normalize(unordered),
    {
      rows: ["a=unasked", "b=unasked"],
      inconclusive: [0, 1],
      identities: ["a", "b"],
    },
  );
  TestValidator.equals(
    "normalizing typed evidence does not mutate the provider's indexes",
    unordered.inconclusive,
    [1, 0],
  );
  TestValidator.equals(
    "public string rows remain valid without private identities",
    toolchainVersion.normalize(["SETTING=unasked"]),
    {
      rows: ["SETTING=unasked"],
      inconclusive: [],
      identities: [undefined],
    },
  );
}

function assertAStaleOverrideFallsThroughToTheAliases(): void {
  const root = GraphPaths.createTempDirectory("graph-toolchain-alias-");
  const bin = path.join(root, ".samchon-graph", "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ["scip-python", "scip", "python"]) shim(bin, name);
  const python = standardScipProviders.find(
    (provider) => provider.name === "scip-python",
  )!;
  const environment = {
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
  };
  const rows = python.configuration?.(root, environment);
  const derivation =
    python.configurationDerivation?.(root, environment);
  TestValidator.equals(
    "a stale override falls through and the row names what answered",
    rows?.filter((row) => !row.startsWith("scip")),
    [
      "python=fake-toolchain 1.2.3 | Runtime Environment (build 1.2.3+7) | 64-Bit Server VM",
    ],
  );
  TestValidator.predicate(
    "SCIP public configuration preserves the parallel evidence derivation",
    rows !== undefined &&
      derivation !== undefined &&
      JSON.stringify(rows) === JSON.stringify(derivation.rows) &&
      derivation.inconclusive.length === 0,
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
  TestValidator.equals(
    "the resolution helper exposes the same absent precondition",
    toolchainVersion.resolve({
      root,
      env: probeEnvironment(
        log,
        binary,
        "SAMCHON_GRAPH_FIXTURE_UNUSED",
      ),
      command: "missing-toolchain",
      args: ["--version"],
    }),
    undefined,
  );

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

/**
 * Restoring a row is per label, and only for a label that has a prior.
 *
 * The session test drives this through real refreshes, which cannot reach two
 * of its cases: a row that has never been established once, and a row that
 * carries no `=` at all. Both are reachable in the field — a provider that adds
 * a configuration row between refreshes produces the first, and any row that is
 * a bare token rather than a pair produces the second — and neither should be
 * answered by inventing a value.
 */
function assertOnlyAKnownRowCanBeRestored(): void {
  TestValidator.equals(
    "a row that has never been established stays unasked",
    toolchainVersion.reestablish(
      toolchainVersion.derive([
        "tool=1.0.0",
        toolchainVersion.unasked("newcomer"),
        "bare-token",
      ]),
      toolchainVersion.derive([
        toolchainVersion.conclusive("tool=1.0.0"),
        "bare-token",
      ]),
    ).rows,
    ["tool=1.0.0", "newcomer=unasked", "bare-token"],
  );
  TestValidator.equals(
    "every unasked row with a prior is restored, and only those",
    toolchainVersion.reestablish(
      toolchainVersion.derive([
        toolchainVersion.unasked("held"),
        "moved=2.0.0",
        toolchainVersion.unasked("unknown"),
      ]),
      toolchainVersion.derive([
        toolchainVersion.conclusive("held=1.0.0"),
        toolchainVersion.conclusive("moved=1.0.0"),
      ]),
    ).rows,
    ["held=1.0.0", "moved=2.0.0", "unknown=unasked"],
  );
  TestValidator.equals(
    "a value containing the separator is restored whole",
    toolchainVersion.reestablish(
      toolchainVersion.derive([
        toolchainVersion.unasked("GOFLAGS"),
      ]),
      toolchainVersion.derive([
        toolchainVersion.conclusive(
          "GOFLAGS=-tags=integration",
        ),
      ]),
    ).rows,
    ["GOFLAGS=-tags=integration"],
  );
  TestValidator.equals(
    "a derivation with nothing unasked is returned untouched",
    toolchainVersion.reestablish(
      toolchainVersion.derive(["tool=2.0.0"]),
      toolchainVersion.derive([
        toolchainVersion.conclusive("tool=1.0.0"),
      ]),
    ).rows,
    ["tool=2.0.0"],
  );
  TestValidator.equals(
    "a public setting that literally ends in unasked remains its own value",
    toolchainVersion.reestablish(
      toolchainVersion.derive(["PATH=unasked"]),
      toolchainVersion.derive(["PATH=old"]),
    ).rows,
    ["PATH=unasked"],
  );
  TestValidator.equals(
    "duplicate labels restore by private driver identity",
    toolchainVersion.reestablish(
      toolchainVersion.derive([
        toolchainVersion.unasked(
          "clang",
          "driver:/usr/bin/clang",
        ),
        toolchainVersion.conclusive(
          "clang=18",
          "driver:/opt/clang",
        ),
      ]),
      toolchainVersion.derive([
        toolchainVersion.conclusive(
          "clang=17",
          "driver:/usr/bin/clang",
        ),
        toolchainVersion.conclusive(
          "clang=18",
          "driver:/opt/clang",
        ),
      ]),
    ).rows,
    ["clang=17", "clang=18"],
  );
  TestValidator.equals(
    "an inconclusive prior row cannot establish a later answer",
    toolchainVersion.reestablish(
      toolchainVersion.derive([
        toolchainVersion.unasked("tool"),
      ]),
      toolchainVersion.derive([
        toolchainVersion.unasked("tool"),
      ]),
    ).inconclusive,
    [0],
  );
  TestValidator.equals(
    "repeated stable identities restore in their established order",
    toolchainVersion.reestablish(
      toolchainVersion.derive([
        toolchainVersion.unasked("tool", "shared"),
        toolchainVersion.unasked("tool", "shared"),
      ]),
      toolchainVersion.derive([
        toolchainVersion.conclusive("tool=first", "shared"),
        toolchainVersion.conclusive("tool=second", "shared"),
      ]),
    ).rows,
    ["tool=first", "tool=second"],
  );
  TestValidator.equals(
    "a bare tool observation uses its whole row as private identity",
    toolchainVersion.conclusive("bare-tool").identity,
    "bare-tool",
  );
  TestValidator.equals(
    "public string configuration normalizes to empty private identities",
    toolchainVersion.normalize(["SETTING=legacy"]).identities,
    [undefined],
  );
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

function assertTopologySortsRowsWithTheirEvidence(): void {
  const root = GraphPaths.createTempDirectory(
    "graph-toolchain-topology-evidence-",
  );
  const provider: IGraphProvider = {
    ...ProviderFixtures.provider({ name: "evidence-provider" }),
    configurationDerivation: () =>
      toolchainVersion.derive([
        toolchainVersion.unasked("tool"),
        "SETTING=unasked",
      ]),
  };
  const rows = providerTopology.available(
    root,
    ["typescript"],
    { cwd: root },
    { PATH: "", Path: "" },
    [provider],
  );
  TestValidator.equals(
    "topology sorting keeps the explicit unasked marker on its own row",
    [
      rows[0]?.configuration,
      rows[0]?.configurationInconclusive,
      rows[0]?.configurationIdentities,
    ],
    [
      ["SETTING=unasked", "tool=unasked"],
      [1],
      [undefined, "tool"],
    ],
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

async function assertResidentTopologyKeepsFreshPrivateIdentity(): Promise<void> {
  const root = GraphPaths.createTempDirectory(
    "graph-toolchain-resident-identity-",
  );
  const file = path.join(root, "a.ts");
  fs.writeFileSync(file, "export const value = 1;\n");

  let identity = "tool:first";
  let unasked = false;
  const provider: IGraphProvider = {
    ...ProviderFixtures.provider({ name: "identity-provider" }),
    configurationDerivation: () =>
      toolchainVersion.derive([
        unasked
          ? toolchainVersion.unasked("tool", identity)
          : toolchainVersion.conclusive("tool=1.0.0", identity),
      ]),
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
  try {
    await source.load();
    identity = "tool:second";
    await source.load();
    unasked = true;
    await source.load();
    TestValidator.equals(
      "equal visible topology keeps fresh identity for the next failed probe",
      builds,
      1,
    );
  } finally {
    await source.close();
  }
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
  fs.writeFileSync(unlaunchable, "\0\0not a program\0");
  fs.chmodSync(unlaunchable, 0o755);
  const row = toolchainVersion({
    root,
    env: { PATH: "", Path: "", PATHEXT: ".EXE;.CMD;.BAT" },
    command: "broken-toolchain",
    args: ["--version"],
  });
  // Which of the two it is depends on the platform, and this assertion is
  // deliberately not the one that pins `unasked`. On Windows a `.cmd` goes to
  // the command processor, which runs and fails rather than failing to start.
  // On Linux glibc's `execvp` implements the POSIX ENOEXEC fallback and hands
  // the file to `/bin/sh`, which also runs. Only Darwin's `posix_spawn` returns
  // ENOEXEC to the caller. So this file proves `unasked` on exactly one of three
  // platforms, and a predicate accepting both would have passed before the state
  // existed — which is why the two assertions below do the pinning instead.
  //
  // What it does prove everywhere is the thing that was wrong: a file sitting
  // right there is never reported as an absent tool.
  TestValidator.predicate(
    "a launch that cannot start is never reported as an absent tool",
    row === "broken-toolchain=unasked" ||
      row === "broken-toolchain=unreported",
  );
}

/**
 * The one launch failure every platform agrees on: the working directory is
 * gone.
 *
 * `spawnSync` chdirs in the child before it execs, so a missing `cwd` fails
 * ahead of the program — `error` set, status null, on Windows and POSIX alike,
 * with a shell and without one. That makes it the only way to pin these two
 * states deterministically across the matrix, and it is not a contrivance: a
 * project directory deleted or unmounted under a long-lived session is exactly
 * the transient this distinction was built for.
 */
function assertAProbeThatCouldNotStartIsNotSilence(): void {
  const root = path.join(
    GraphPaths.createTempDirectory("graph-toolchain-vanished-"),
    "removed",
  );
  // `resolved` given, so resolution is settled and only the probe can fail. A
  // real program, on a working directory that is not there.
  TestValidator.equals(
    "a probe that never started is unasked, not unreported",
    toolchainVersion({
      root,
      env: process.env,
      command: "node",
      resolved: { command: process.execPath, args: [] },
      args: ["--version"],
    }),
    "node=unasked",
  );
}

function assertALookupThatCouldNotRunIsNotAnAbsentTool(): void {
  const root = path.join(
    GraphPaths.createTempDirectory("graph-toolchain-vanished-lookup-"),
    "removed",
  );
  // No `resolved` this time, so the row goes through the `PATH` lookup — itself
  // a launch, of `where.exe` or a shell. It cannot start either, and the tool it
  // was asked about is one that certainly exists on this machine. Reporting
  // `unavailable` here would be a claim about the world drawn from a failure to
  // ask a question.
  TestValidator.equals(
    "a lookup that never ran is unasked, not unavailable",
    toolchainVersion({
      root,
      env: process.env,
      command: "node",
      args: ["--version"],
    }),
    "node=unasked",
  );
}

/**
 * Public configuration strings have no reserved values.
 *
 * Environment and provider settings are arbitrary strings. A literal value
 * ending in `=unasked` must therefore be fingerprinted like any other setting,
 * both before the session has history and after a prior value exists.
 */
async function assertLiteralUnaskedSettingsAreNotControlState(): Promise<void> {
  const root = GraphPaths.createTempDirectory(
    "graph-toolchain-literal-unasked-",
  );
  fs.writeFileSync(path.join(root, "a.ts"), "export const value = 1;\n");
  let rows = ["SETTING=unasked"];
  const session = new BatchGraphSession({
    root,
    languages: ["typescript"],
    provider: "literal-unasked-fixture",
    command: {
      command: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], '{}')",
      ],
    },
    artifactName: "index.json",
    indexArgs: (produced) => [produced],
    inputs: () => ["a.ts"],
    configuration: () => rows,
    load: () =>
      Promise.resolve(
        ProviderFixtures.snapshot({
          root,
          provider: "literal-unasked-fixture",
          languages: ["typescript"],
        }),
      ),
  });
  try {
    const initial = await session.refresh();
    rows = ["SETTING=old"];
    const old = await session.refresh();
    rows = ["SETTING=unasked"];
    const literal = await session.refresh();
    TestValidator.equals(
      "a literal unasked setting is established initially and after a change",
      [initial.mode, old.mode, literal.mode, literal.generation],
      ["initial", "rebuild", "rebuild", 3],
    );
  } finally {
    await session.close();
  }
}

async function assertAnUnaskedQuestionDoesNotMoveTheUniverse(): Promise<void> {
  const root = GraphPaths.createTempDirectory("graph-toolchain-universe-");
  const source = path.join(root, "a.ts");
  fs.writeFileSync(source, "export const value = 1;\n");
  const artifact = path.join(root, "index.json");

  let rows: readonly string[] | toolchainVersion.IDerivation =
    toolchainVersion.derive([
      toolchainVersion.conclusive("tool=1.0.0"),
    ]);
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
    rows = toolchainVersion.derive([
      toolchainVersion.unasked("tool"),
      "SETTING=initial",
    ]);
    let initialMessage = "";
    try {
      await session.refresh();
    } catch (error) {
      initialMessage = error instanceof Error ? error.message : String(error);
    }
    TestValidator.predicate(
      "an initial unasked row cannot become a strict build universe",
      initialMessage.includes("inconclusive configuration rows") &&
        initialMessage.includes("tool=unasked") &&
        session.current === undefined &&
        session.generation === 0,
    );

    rows = toolchainVersion.derive([
      toolchainVersion.conclusive("tool=1.0.0"),
    ]);
    const cold = await session.refresh();
    // The question could not be put this time. Nothing was established, so
    // nothing changed — the row that would have moved the universe is exactly
    // the one that says it learned nothing.
    rows = toolchainVersion.derive([
      toolchainVersion.unasked("tool"),
    ]);
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
    rows = toolchainVersion.derive([
      toolchainVersion.conclusive("tool=2.0.0"),
    ]);
    const upgraded = await session.refresh();
    TestValidator.equals(
      "a toolchain change is believed once the question can be put again",
      upgraded.mode,
      "rebuild",
    );

    // The case that made substituting the whole derivation wrong. A real
    // configuration is several rows, and one probe failing to launch says
    // nothing about the others. Here a setting genuinely changed in the same
    // refresh that lost the toolchain probe: standing in the previous rows
    // wholesale would restore the old setting too, report `unchanged`, and go
    // on serving an index built with flags the project no longer uses.
    rows = toolchainVersion.derive([
      toolchainVersion.conclusive("tool=2.0.0"),
      "SETTING=old",
    ]);
    await session.refresh();
    rows = toolchainVersion.derive([
      toolchainVersion.unasked("tool"),
      "SETTING=new",
    ]);
    const partial = await session.refresh();
    TestValidator.equals(
      "an established change is kept even when a sibling row went unasked",
      partial.mode,
      "rebuild",
    );

    // And the unasked row itself is still held to its last known value rather
    // than moving the universe on its own.
    rows = toolchainVersion.derive([
      toolchainVersion.unasked("tool"),
      "SETTING=new",
    ]);
    const quiet = await session.refresh();
    TestValidator.equals(
      "the unasked row alone still does not move the universe",
      [quiet.mode, quiet.generation],
      ["unchanged", partial.generation],
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

/**
 * The topology restores unasked rows the same way a session does.
 *
 * A candidate that is not serving still has its toolchain probed on every
 * refresh, and the resident source treats any change in the serialized topology
 * as structural — so a probe that failed to launch inside a provider nothing was
 * using reindexed every language in the project. Matching is per provider, and
 * within a provider per row, for the reason the session-level repair had to be:
 * substituting a whole derivation because one entry went unasked throws away the
 * entries that did establish something.
 */
function assertATopologyRestoresPerProviderRow(): void {
  const row = (
    provider: string,
    configuration?: string[],
    configurationInconclusive?: number[],
    configurationIdentities?: (string | undefined)[],
  ): providerTopology.IRow => ({
    provider,
    languages: ["lua"],
    command: provider,
    args: [],
    windowsVerbatimArguments: false,
    windowsDoubleEscapeArguments: false,
    ...(configuration === undefined ? {} : { configuration }),
    ...(configurationInconclusive === undefined
      ? {}
      : { configurationInconclusive }),
    ...(configurationIdentities === undefined
      ? {}
      : { configurationIdentities }),
  });

  TestValidator.equals(
    "with nothing established the live rows stand",
    providerTopology.reestablish([row("a", ["tool=1.0.0"])], undefined),
    [row("a", ["tool=1.0.0"])],
  );

  TestValidator.equals(
    "an unasked row is restored while a changed sibling is kept",
    providerTopology.reestablish(
      [
        row(
          "a",
          ["tool=unasked", "SETTING=new"],
          [0],
          ["tool", undefined],
        ),
      ],
      [
        row(
          "a",
          ["tool=1.0.0", "SETTING=old"],
          undefined,
          ["tool", undefined],
        ),
      ],
    ),
    [
      row(
        "a",
        ["SETTING=new", "tool=1.0.0"],
        undefined,
        [undefined, "tool"],
      ),
    ],
  );

  TestValidator.equals(
    "a provider with no prior entry is left alone",
    providerTopology.reestablish(
      [row("fresh", ["tool=unasked"], [0], ["tool"])],
      [
        row(
          "other",
          ["tool=1.0.0"],
          undefined,
          ["tool"],
        ),
      ],
    ),
    [row("fresh", ["tool=unasked"], [0], ["tool"])],
  );

  TestValidator.equals(
    "a new unasked row keeps its evidence beside known provider history",
    providerTopology.reestablish(
      [
        row(
          "a",
          ["newcomer=unasked"],
          [0],
          ["newcomer"],
        ),
      ],
      [
        row(
          "a",
          ["tool=1.0.0"],
          undefined,
          ["tool"],
        ),
      ],
    ),
    [
      row(
        "a",
        ["newcomer=unasked"],
        [0],
        ["newcomer"],
      ),
    ],
  );

  TestValidator.equals(
    "a literal unasked setting is not restored from topology history",
    providerTopology.reestablish(
      [row("a", ["SETTING=unasked"])],
      [row("a", ["SETTING=old"])],
    ),
    [row("a", ["SETTING=unasked"])],
  );

  TestValidator.equals(
    "topology restores and re-sorts duplicate compiler labels by identity",
    providerTopology.reestablish(
      [
        row(
          "clang",
          ["clang=18", "clang=unasked"],
          [1],
          [
            "driver:/opt/clang",
            "driver:/usr/bin/clang",
          ],
        ),
      ],
      [
        row(
          "clang",
          ["clang=17", "clang=18"],
          undefined,
          [
            "driver:/usr/bin/clang",
            "driver:/opt/clang",
          ],
        ),
      ],
    ),
    [
      row(
        "clang",
        ["clang=17", "clang=18"],
        undefined,
        [
          "driver:/usr/bin/clang",
          "driver:/opt/clang",
        ],
      ),
    ],
  );

  TestValidator.equals(
    "internal evidence is not added to serialized topology",
    providerTopology.serialize([
      row("a", ["tool=unasked"], [0], ["tool"]),
    ]),
    providerTopology.serialize([row("a", ["tool=unasked"])]),
  );

  TestValidator.equals(
    "a candidate that publishes no configuration is untouched",
    providerTopology.reestablish([row("bare")], [row("bare", ["tool=1.0.0"])]),
    [row("bare")],
  );
}
