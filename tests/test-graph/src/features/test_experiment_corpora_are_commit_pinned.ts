import { TestValidator } from "@nestia/e2e";
import { LANGUAGE_SPECS } from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";

/** Real-language experiments always check out one reviewable corpus revision. */
export const test_experiment_corpora_are_commit_pinned = () => {
  const catalog = experimentSource("catalog.mjs");
  const helpers = experimentSource("process.mjs");
  const lifecycle = experimentSource("strict-lifecycle.mjs");
  const runner = experimentSource("run-language.mjs");
  const setup = experimentSource("setup-language.mjs");

  const repositories = [...catalog.matchAll(/repository:\s*"[^"]+"/g)];
  const commits = [...catalog.matchAll(/commit:\s*"([0-9a-f]{40})"/g)];
  TestValidator.equals(
    "every real-language corpus has one exact Git commit",
    commits.length,
    repositories.length,
  );
  TestValidator.equals(
    "every strict corpus declares an isolated lifecycle fixture",
    [...catalog.matchAll(/strictProvider:\s*"[^"]+"/g)].length,
    [...catalog.matchAll(/lifecycle:\s*\{/g)].length,
  );
  const python = region(catalog, 'language: "python"', 'language: "ruby"');
  const java = region(catalog, 'language: "java"', 'language: "csharp"');
  const csharp = region(catalog, 'language: "csharp"', 'language: "kotlin"');
  const kotlin = region(catalog, 'language: "kotlin"', 'language: "swift"');
  const swift = region(catalog, 'language: "swift"', 'language: "scala"');
  const scala = region(catalog, 'language: "scala"', 'language: "zig"');
  const zig = region(catalog, 'language: "zig"', 'language: "python"');
  const cpp = region(catalog, 'language: "cpp"', 'language: "c"');
  const c = region(catalog, 'language: "c"', 'language: "java"');
  const ruby = region(catalog, 'language: "ruby"', 'language: "php"');
  const php = region(catalog, 'language: "php"', 'language: "lua"');
  const lua = region(catalog, 'language: "lua"', 'language: "dart"');
  const dart = region(catalog, 'language: "dart"', "\n];");
  const javaSetup = region(setup, 'case "java"', 'case "csharp"');
  const kotlinSetup = region(setup, 'case "kotlin"', 'case "swift"');
  TestValidator.equals(
    "every registered strict-provider language has a lifecycle row",
    [...catalog.matchAll(/strictProvider:\s*"[^"]+"/g)].length,
    13,
  );
  TestValidator.predicate(
    "the remaining SCIP providers use isolated upstream lifecycle projects",
    [java, kotlin, ruby, php, dart].every(
      (row) =>
        row.includes("projectRoot:") &&
        row.includes('strictAuthority: "semantic-index"') &&
        row.includes("lifecycle: {"),
    ) &&
      helpers.includes('experiment.projectRoot ?? "."') &&
      helpers.includes("projectRoot escapes its pinned corpus") &&
      helpers.includes("fs.cpSync(source, root"),
  );
  TestValidator.predicate(
    "an unavailable compiler identity requires an explicit row limitation",
    kotlin.includes("compilerLimitation:") &&
      runner.includes("experiment.compilerLimitation.trim()") &&
      runner.includes('typeof provenance.producer.compiler === "string"') &&
      runner.includes("provenance.producer.compiler.trim()") &&
      runner.includes("unavailable|unreported|unasked") &&
      runner.includes("compilerLimitation: experiment.compilerLimitation"),
  );
  TestValidator.predicate(
    "every setup path installs, persists, and records one verified Gradle",
    setup.includes('const version = "9.4.1"') &&
      setup.includes("services.gradle.org/distributions/gradle-") &&
      setup.includes(
        "2ab2958f2a1e51120c326cad6f385153bb11ee93b3c216c5fccebfdfbb7ec6cb",
      ) &&
      setup.includes('path.join(binRoot, "gradle")') &&
      setup.includes("await installGradle()"),
  );
  TestValidator.predicate(
    "Kotlin uses one checksum-pinned 2.3.20 producer and fixture generation",
    kotlin.includes("e940c1889767a81347387067a375320dc6f5d83e") &&
      kotlin.includes("built with Kotlin 2.3.20") &&
      setup.includes("const SCIP_JAVA_KOTLIN_COMMIT") &&
      setup.includes('"e940c1889767a81347387067a375320dc6f5d83e"') &&
      setup.includes('const SCIP_JAVA_KOTLIN_VERSION = "2.3.20"') &&
      setup.includes(
        "985eb03ef165864dbae3db4453d4566e699f78761bace3e4614bf67d38ce76cf",
      ) &&
      setup.includes(
        "`${SCIP_JAVA_KOTLIN_COMMIT}+kotlin-${SCIP_JAVA_KOTLIN_VERSION}`",
      ) &&
      setup.includes('":scip-java:installDist"') &&
      javaSetup.includes("await installScipJava()") &&
      !javaSetup.includes("installScipJavaKotlinSnapshot") &&
      kotlinSetup.includes("await installScipJavaKotlinSnapshot(gradle)") &&
      !kotlinSetup.includes("await installScipJava();") &&
      setup.includes('run(link, ["--version"])'),
  );
  TestValidator.predicate(
    "a local start process reactivates the complete environment from setup",
    helpers.includes("export const activateProvisionedTools") &&
      helpers.includes('"environment.json"') &&
      helpers.includes("provisioned.paths") &&
      helpers.includes("provisioned.environment") &&
      setup.includes("recordProvisionedEnvironment") &&
      setup.includes("resetProvisionedEnvironment();") &&
      setup.includes('recordProvisionedEnvironment("JAVA_HOME", javaHome)') &&
      runner.includes("activateProvisionedTools();"),
  );
  TestValidator.predicate(
    "a Java public lifecycle type stays valid through rename",
    java.includes("renamedText:") &&
      java.includes("class SamchonGraphExperimentRenamed") &&
      lifecycle.includes("fixture.renamedText !== undefined") &&
      lifecycle.includes("fs.writeFileSync(renamedFile, fixture.renamedText)"),
  );
  TestValidator.predicate(
    "a PHP lifecycle rename preserves its PSR-4 class/file contract",
    php.includes("renamedText:") &&
      php.includes("final class SamchonGraphExperimentRenamed") &&
      php.includes('renamedSymbol: "SamchonGraphExperimentRenamed"') &&
      lifecycle.includes("fixture.renamedSymbol ?? fixture.createdSymbol"),
  );
  TestValidator.predicate(
    "isolated lifecycle edges can prove a pinned corpus relationship claim",
    [java, kotlin].every(
      (row) =>
        row.includes('kind: "references"') &&
        row.includes("crossFile: true"),
    ) &&
      lifecycle.includes("fixture.createdEdge.crossFile !== true") &&
      runner.includes("const lifecycleCreatedEdge") &&
      runner.includes("lifecycleCreatedEdge?.kind !== kind"),
  );
  TestValidator.predicate(
    "the dynamic SCIP smoke proves a versioned Python lifecycle, not an edge count",
    python.includes('strictProvider: "scip-python"') &&
      python.includes('strictAuthority: "semantic-index"') &&
      python.includes('semanticEdges: ["references"]') &&
      !python.includes("minEdges"),
  );
  // A family the producer cannot emit at all is different from one this corpus
  // happens not to contain, and only the first is a limitation worth publishing.
  // `contains` is the first for scip-python, so the row has to say so.
  TestValidator.predicate(
    "a family the pinned producer cannot emit is published as a limitation",
    declares(python, "semanticLimitation") &&
      python.includes("enclosing_symbol") &&
      runner.includes("semanticLimitation: experiment.semanticLimitation"),
  );
  TestValidator.predicate(
    "every producer with no grounded edge family states that limitation explicitly",
    [csharp, cpp, c].every(
      (row) =>
        row.includes("semanticEdges: []") &&
        !row.includes("crossFileEdge:") &&
        declares(row, "semanticLimitation"),
    ) &&
      runner.includes("experiment.semanticEdges.length === 0") &&
      runner.includes("crossFileEdge !== undefined") &&
      runner.includes("semanticLimitation.trim() ==="),
  );
  // scip-python 0.6.6 recovers from a malformed `pyproject.toml` and emits no
  // SCIP diagnostics, so a row claiming either boundary would assert behaviour
  // the pinned producer does not have. A tolerated row earns its place only by
  // proving the exact upstream claim instead — the producer ignored the input,
  // so the build universe moved and the published facts did not — and by saying
  // what it gave up rather than leaving a reader to infer it from a green lane.
  TestValidator.predicate(
    "a failure boundary the producer does not have is published as a limitation",
    python.includes('failurePolicy: "tolerated"') &&
      declares(python, "failureLimitation") &&
      lifecycle.includes('fixture.failurePolicy === "tolerated"') &&
      lifecycle.includes('fixture.failureLimitation === ""') &&
      lifecycle.includes("provenance.universe === prior.universe") &&
      lifecycle.includes("provenance.content !== prior.content") &&
      lifecycle.includes("diagnosticCount !== previousDiagnostics"),
  );
  TestValidator.predicate(
    "a degraded publication is distinct from an input the producer ignored",
    lua.includes('failurePolicy: "published"') &&
      declares(lua, "failureLimitation") &&
      lifecycle.includes('fixture.failurePolicy === "published"') &&
      lifecycle.includes('status: "published-with-limitation"') &&
      lifecycle.includes("publicationChanges("),
  );
  TestValidator.predicate(
    "a malformed compilation database proves strict decline and warned fallback",
    [cpp, c].every(
      (row) =>
        row.includes('failurePolicy: "fallback"') &&
        declares(row, "failureLimitation"),
    ) &&
      lifecycle.includes('fixture.failurePolicy === "fallback"') &&
      lifecycle.includes('status: "fallback-with-limitation"') &&
      lifecycle.includes("row.provider === experiment.strictProvider") &&
      lifecycle.includes("warning.includes(experiment.strictProvider)") &&
      !lifecycle.includes("JSON.stringify(fallback)") &&
      lifecycle.includes('? ["initial", ...CHANGED_MODES]'),
  );

  // Regenerating an unchanged project must reproduce it, and that assertion is
  // the lifecycle's strongest. Exactly one registered producer cannot meet it:
  // scip-clang 0.4.0 documents `--deterministic` as not scheduling work
  // deterministically, and warns separately that non-determinism changes how
  // many files each indexing job skips. The exemption is therefore a declared,
  // explained property of those two rows rather than a relaxed default, and the
  // manifest half of the assertion stays unconditional for everyone.
  TestValidator.predicate(
    "an unreproducible producer is declared rather than serialized",
    [cpp, c].every((row) => declares(row, "regenerationLimitation")) &&
      // Counted over the whole catalog, not checked against a list of the rows
      // that happen not to declare it. The exemption drops the lifecycle's
      // strongest assertion for whichever row carries it, so a third one
      // appearing has to be a reviewed edit here rather than eight words in a
      // catalog nobody re-reads.
      [...catalog.matchAll(/regenerationLimitation:/g)].length === 2 &&
      runner.includes("experiment.regenerationLimitation !== undefined") &&
      runner.includes("regenerationLimitation.trim() === \"\"") &&
      runner.includes(
        "regenerationLimitation: experiment.regenerationLimitation",
      ) &&
      lifecycle.includes(
        "coldProvenance.manifest !== retryProvenance.manifest",
      ) &&
      lifecycle.includes("!reproduced && limitation === undefined") &&
      lifecycle.includes('name: "regeneration"'),
  );
  // Sixteen product languages, thirteen strict rows. The other three are
  // decisions with evidence behind them, not lanes nobody reached, and a
  // bounded generic row that passes on node counts cannot tell a reader which
  // it is. So the absence of a strict provider is itself a declaration.
  TestValidator.predicate(
    "every language without a strict provider states what blocks one",
    [swift, scala, zig].every((row) =>
      declares(row, "feasibilityBlocked"),
    ) &&
      runner.includes('typeof experiment.feasibilityBlocked !== "string"') &&
      runner.includes("feasibilityBlocked: experiment.feasibilityBlocked"),
  );
  // Bounded to the array, then split on the row objects themselves rather than
  // on a field inside one. Two things follow: a helper added below the array
  // cannot be counted as part of the last row, and a comment written above
  // `language:` — which this catalog already does — stays with the row it
  // explains instead of being attributed to the row before it.
  const catalogArray = region(
    catalog,
    "export const LANGUAGE_EXPERIMENTS = [",
    "\n];",
  );
  const catalogRows = catalogArray.split(/^ {2}\{$/m).slice(1);
  const named = (row: string): string =>
    /language: "([^"]+)"/.exec(row)?.[1] ?? "unnamed";
  // Three shapes, because each refuses what the others cannot see.
  //
  // The first answers to the product rather than to this file. An empty row
  // list compared against an empty expectation is an assertion that passes by
  // checking nothing — the trap `region` is documented against, which
  // reindenting the array would spring — and a right-hand side derived from the
  // same source cannot notice it. Every advertised language owes an experiment
  // row, so the language registry is the outside authority that can.
  TestValidator.equals(
    "the catalog covers every advertised language",
    catalogRows.length,
    LANGUAGE_SPECS.length,
  );
  // The second is independent of the row split without leaving the array. The
  // whole file would also count a declaration quoted in a comment above it or a
  // helper below it, and report that as a row-split failure it is not.
  TestValidator.equals(
    "the row split still finds every declaring row",
    catalogRows.length,
    [...catalogArray.matchAll(/strictProvider:\s*"[^"]+"/g)].length +
      [...catalogArray.matchAll(/feasibilityBlocked:\s*"[^"]+"/g)].length,
  );
  // The third refuses a row declaring both or neither, which the counts above
  // let cancel out — moving one declaration from a blocked row onto a strict
  // row leaves every total unchanged and only this map objects. It names the
  // language so a failure points at the row rather than at an index, and uses
  // `declares` rather than presence so an empty declaration cannot satisfy
  // either half.
  TestValidator.equals(
    "every catalog row declares exactly one of a provider and a blocker",
    catalogRows.map(
      (row) =>
        `${named(row)}: ${String(
          Number(declares(row, "strictProvider")) +
            Number(declares(row, "feasibilityBlocked")),
        )}`,
    ),
    catalogRows.map((row) => `${named(row)}: 1`),
  );

  TestValidator.predicate(
    "the clone helper fetches and detaches the pinned revision",
    helpers.includes('["fetch", "--depth=1", "origin", experiment.commit]') &&
      helpers.includes('["checkout", "--detach", experiment.commit]'),
  );
  TestValidator.predicate(
    "strict edits happen only in a copied external workspace",
    lifecycle.includes('isolateCorpus(experiment, pinnedRoot, "lifecycle")') &&
      lifecycle.includes("path.join(lifecycleRoot, fixture.sourceFile)"),
  );

  // A package manager run inside the clone writes locks, caches, and build
  // state, and the result still reports the pristine commit it no longer has.
  // Both lanes therefore prepare a copy, and the clone is re-proved afterwards.
  TestValidator.predicate(
    "every lane prepares a copy and re-proves the pinned clone afterwards",
    runner.includes('isolateCorpus(experiment, pinned, "prepared")') &&
      runner.includes("assertPinnedCorpus(experiment, pinned)") &&
      !runner.includes("shell(experiment.prepare, { cwd: pinned })") &&
      helpers.includes('["status", "--porcelain", "--ignored"]'),
  );
  // A default would let a row inherit a claim it never made, which is how a row
  // came to require a cross-file `calls` edge from a provider registered to
  // prove none.
  TestValidator.predicate(
    "a strict row states its own authority, tool, capabilities, and families",
    [
      "strictAuthority",
      "strictTool",
      "requiredCapabilities",
      "semanticEdges",
    ].every((field) => runner.includes(`"${field}",`)) &&
      runner.includes("a strict row must state its expected") &&
      !runner.includes('experiment.strictAuthority ?? "compiler"') &&
      !runner.includes("experiment.strictTool ?? experiment.strictProvider"),
  );
  TestValidator.predicate(
    "the runner proves declared families are present and undeclared ones absent",
    runner.includes("provenance.facts.includes(kind)") &&
      runner.includes("provenance.facts.includes(crossFileEdge)") &&
      runner.includes("tools: toolManifest(experiment.language)"),
  );

  // A digest over the root archive proves nothing while installation still
  // resolves that archive's dependency ranges against whatever the registry
  // serves that hour. Extracting the verified bytes is what makes the toolchain
  // the same one the next run gets, and running it once is what proves the
  // extraction was enough.
  const installPython = region(
    setup,
    "const installScipPython",
    "const findFile",
  );
  const installDecoder = region(
    setup,
    "const installScip = async",
    "const installScipRuby",
  );
  TestValidator.predicate(
    "the SCIP decoder understands typed ranges and is digest-pinned",
    installDecoder.includes("scip-v0.9.0-linux-amd64.tar.gz") &&
      installDecoder.includes(
        "fc2e7273e110be9f35924da1066000183791e8bfdb0391355de6eaaa070fec75",
      ) &&
      installDecoder.includes("verifySha256(") &&
      installDecoder.includes("typed-range oneof"),
  );
  TestValidator.predicate(
    "the Python indexer and decoder are exact campaign-owned tools",
    installPython.includes("scip-python-0.6.6.tgz") &&
      installPython.includes(
        "qoKL1Rggg0o5newAFbCFAKlS0AjWxG5MA+mC28BtgxOv0DhO4zdL8u7151FxEppDpXMVvm7+yXSjXotoVH9cMQ==",
      ) &&
      installPython.includes('run("tar"') &&
      installPython.includes('run(link, ["--version"])') &&
      !installPython.includes('run("npm"') &&
      setup.includes("await installScipPython();") &&
      setup.includes("await installScip();") &&
      !setup.includes("npm install -g pyright"),
  );
};

function experimentSource(file: string): string {
  return fs.readFileSync(
    path.join(GraphPaths.repositoryRoot, "tests", "experiment", "src", file),
    "utf8",
  );
}

/**
 * Whether a catalog row states a field as a quoted, non-blank explanation.
 *
 * Each of these fields buys an exemption from an assertion, so the check has to
 * be that something was actually said. A pattern permitting an optional quote
 * before one non-comma character accepts `field: ""` — the space after the
 * colon satisfies it — which certifies exactly the declaration it exists to
 * refuse.
 */
function declares(row: string, field: string): boolean {
  const match = new RegExp(`${field}:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "u").exec(
    row,
  );
  return match !== null && match[1]!.trim() !== "";
}

/**
 * A slice that fails loudly instead of silently widening.
 *
 * `String.slice` treats a missing marker's `-1` as an offset from the end, so a
 * renamed function would leave every assertion below reading the whole file and
 * still passing — the scoping the caller asked for, gone with no failure.
 */
function region(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `@samchon/graph-test: the experiment region between ${from} and ${to} moved`,
    );
  }
  return source.slice(start, end);
}
