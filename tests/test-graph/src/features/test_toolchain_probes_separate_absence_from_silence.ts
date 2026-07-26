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
  assertAFailedProbeRepeatsTheLastAnswer();
  assertEveryProbedLineSurvivesOnOneLine();
  assertTopologyAsksOnlyTheProvidersWithoutASession();
  await assertAServingProviderIsNotAskedTwice();
  await assertANonServingCandidateStillReportsItsRepair();
};

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
  TestValidator.equals("deciding absence launches nothing", launches(log), 0);

  fs.writeFileSync(path.join(root, "toolchain-refuse"), "");
  TestValidator.equals(
    "an installed tool that has never answered is unreported",
    asker(root, log, "present-toolchain")(),
    "present-toolchain=unreported",
  );
}

function assertAFailedProbeRepeatsTheLastAnswer(): void {
  const root = GraphPaths.createTempDirectory("graph-toolchain-transient-");
  const log = path.join(root, "probe.log");
  const ask = asker(root, log, "flaky-toolchain");
  const answered = ask();

  // A launch can fail for reasons that have nothing to do with the project — a
  // timeout, an EAGAIN, a file lock. The row it produced used to be
  // `unavailable`, which moved the build universe and rebuilt an artifact that
  // was never stale. The tool is still installed and its version did not
  // change, so the last answer it gave is what the row should still say. The
  // switch is a file rather than an environment variable precisely so the probe
  // inherits the same environment it did when it succeeded.
  fs.writeFileSync(path.join(root, "toolchain-refuse"), "");
  TestValidator.equals(
    "a launch that fails repeats the last version this toolchain gave",
    ask(),
    answered,
  );
  TestValidator.equals(
    "the failing launch was really attempted",
    launches(log),
    2,
  );

  // Bounded, and every attempt is a real launch. A fallback with no bound is
  // the defect it replaced wearing different clothes: a dispatcher whose
  // selected runtime was uninstalled resolves, fails forever, and would go on
  // naming the version it gave before it broke. Past a handful of consecutive
  // failures the honest answer is that this toolchain is no longer reporting.
  const refusals = [ask(), ask(), ask()];
  TestValidator.equals(
    "the fallback is bounded and then gives way",
    refusals,
    [answered, answered, "flaky-toolchain=unreported"],
  );
  TestValidator.equals(
    "every refusal was re-launched rather than frozen",
    launches(log),
    5,
  );

  // And a tool that starts answering again is believed immediately.
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
  TestValidator.equals(
    "the resident stops asking a provider that serves the build",
    derivations,
    afterCold,
  );
  TestValidator.equals(
    "and never asked it from the topology snapshot either",
    afterCold,
    0,
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
