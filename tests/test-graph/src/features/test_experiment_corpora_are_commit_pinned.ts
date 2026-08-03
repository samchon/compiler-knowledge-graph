import { TestValidator } from "@nestia/e2e";
import {
  CPP_CLANG_PRODUCER_COMMIT,
  LANGUAGE_SPECS,
  RUST_GRAPH_PRODUCER_COMMIT,
} from "@samchon/graph";
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
  const typescript = region(
    catalog,
    'language: "typescript"',
    'language: "go"',
  );
  const python = region(catalog, 'language: "python"', 'language: "ruby"');
  const java = region(catalog, 'language: "java"', 'language: "csharp"');
  const csharp = region(catalog, 'language: "csharp"', 'language: "kotlin"');
  const kotlin = region(catalog, 'language: "kotlin"', 'language: "swift"');
  const rust = region(catalog, 'language: "rust"', 'language: "cpp"');
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
  const rustSetup = region(setup, 'case "rust"', 'case "cpp"');
  const cppSetup = region(setup, 'case "cpp"', 'case "java"');
  TestValidator.equals(
    "every registered strict-provider language has a lifecycle row",
    [...catalog.matchAll(/strictProvider:\s*"[^"]+"/g)].length,
    13,
  );
  TestValidator.predicate(
    "Rust builds and records the exact native HIR producer declared by the catalog",
    rust.includes('producerRepository: "https://github.com/samchon/rust-analyzer.git"') &&
      rust.includes(`producerCommit: "${RUST_GRAPH_PRODUCER_COMMIT}"`) &&
      rustSetup.includes("--default-toolchain 1.95.0") &&
      rustSetup.includes('"rust-src"') &&
      rustSetup.includes('["fetch", "--depth=1", "origin", experiment.producerCommit]') &&
      rustSetup.includes('["build", "--locked", "--release", "-p", "rust-analyzer"]') &&
      rustSetup.includes('for (const command of ["samchon-rust-analyzer", "rust-analyzer"])') &&
      rustSetup.includes("fs.linkSync(producerBinary, link)") &&
      !rustSetup.includes("rustup component add rust-analyzer"),
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
    csharp.includes("semanticEdges: []") &&
      !csharp.includes("crossFileEdge:") &&
      declares(csharp, "semanticLimitation") &&
      runner.includes("experiment.semanticEdges.length === 0") &&
      runner.includes("crossFileEdge !== undefined") &&
      runner.includes("semanticLimitation.trim() ==="),
  );
  TestValidator.predicate(
    "the native C and C++ producer grounds cross-file graph families",
    [cpp, c].every(
      (row) =>
        row.includes('strictProvider: "clangd-snapshot"') &&
        row.includes(
          'producerRepository: "https://github.com/samchon/llvm-project.git"',
        ) &&
        row.includes(`producerCommit: "${CPP_CLANG_PRODUCER_COMMIT}"`) &&
        row.includes('crossFileEdge: "references"') &&
        row.includes('"contains"') &&
        row.includes('"references"') &&
        !row.includes('"implements"') &&
        !row.includes('"dispatches"') &&
        !row.includes("semanticEdges: []"),
    ) &&
      !c.includes('"instantiates"') &&
      !c.includes('"extends"') &&
      !c.includes('"overrides"'),
  );
  TestValidator.predicate(
    "C and C++ build and record the exact campaign-owned native producer",
    cppSetup.includes('apt(["clang", "cmake", "ninja-build", "bear"])') &&
      cppSetup.includes("installClangGraphProducer()") &&
      setup.includes(
        '["fetch", "--depth=1", "origin", experiment.producerCommit]',
      ) &&
      setup.includes('["checkout", "--detach", "FETCH_HEAD"]') &&
      setup.includes('["rev-parse", "HEAD"]') &&
      setup.includes('"-DLLVM_ENABLE_PROJECTS=clang;clang-tools-extra"') &&
      setup.includes('"--target",') &&
      setup.includes('"clangd",') &&
      setup.includes('for (const command of ["samchon-clangd", "clangd"])') &&
      setup.includes("fs.linkSync(binary, link)") &&
      setup.includes('path.join(build, "lib", "clang")') &&
      setup.includes("fs.cpSync(builtResources, installedResources") &&
      setup.includes('"include",') &&
      setup.includes('"stddef.h",') &&
      setup.includes("version.includes(experiment.producerCommit)") &&
      setup.includes("installedVersion.includes(experiment.producerCommit)") &&
      setup.includes('tool: "samchon-clangd"') &&
      !cppSetup.includes('apt(["clangd"'),
  );
  // A fixed parallelism here already cost two whole CI lanes: the build ran on
  // half a four-vCPU runner and was killed at the job timeout with 694 of
  // 3,125 steps left. The workflow refuses to widen that timeout for one
  // language, so the size of this build is the thing that has to stay correct,
  // and a literal is exactly how it silently stops being correct again. Pin
  // both halves: sized by the machine, and bounded by its memory rather than
  // by its core count alone, since the run that failed stopped before `clangd`
  // was linked and therefore proved nothing about the memory peak.
  TestValidator.predicate(
    "the native Clang build is sized by the machine and bounded by its memory",
    setup.includes("os.availableParallelism()") &&
      setup.includes("os.totalmem()") &&
      setup.includes('"--parallel",') &&
      setup.includes("String(jobs),") &&
      !/"--parallel",\s*\n\s*"\d+"/u.test(setup),
  );
  // scip-python 0.6.6 recovers from a malformed `pyproject.toml`, falls back to
  // Pyright defaults and emits no SCIP diagnostics. On the pinned Click
  // fixture, the source and semantic fact planes stay unchanged. The aggregate
  // content digest is not evidence to the contrary because its legacy coverage
  // target is the already-moved universe.
  TestValidator.predicate(
    "Python's malformed configuration is a tolerated unchanged publication",
    python.includes('failurePolicy: "tolerated"') &&
      declares(python, "failureLimitation") &&
      python.includes("falling back to Pyright defaults") &&
      lifecycle.includes('fixture.failurePolicy === "tolerated"') &&
      lifecycle.includes("provenance.universe === prior.universe") &&
      lifecycle.includes("publicationChanges(") &&
      lifecycle.includes("changed.length !== 0") &&
      lifecycle.includes("normalizedPublicationPlane(") &&
      !lifecycle.includes("provenance.content !== prior.content"),
  );
  TestValidator.predicate(
    "a degraded publication is distinct from an unchanged tolerated one",
    [csharp, lua].every(
      (row) =>
        row.includes('failurePolicy: "published"') &&
        declares(row, "failureLimitation"),
    ) &&
      python.includes('failurePolicy: "tolerated"') &&
      lifecycle.includes('status: "tolerated"') &&
      lifecycle.includes('fixture.failurePolicy === "published"') &&
      lifecycle.includes('status: "published-with-limitation"') &&
      lifecycle.includes("publicationChanges("),
  );
  TestValidator.predicate(
    "a regeneration failure names its first differing fact",
    lifecycle.includes("firstGenerationDifference(cold, retried)") &&
      lifecycle.includes("first difference:") &&
      lifecycle.includes("normalized dump fact planes are equal"),
  );
  TestValidator.predicate(
    "a malformed compilation database rejects the native generation",
    [cpp, c].every((row) => row.includes('failurePolicy: "reject"')) &&
      lifecycle.includes('fixture.failurePolicy === "reject"') &&
      lifecycle.includes('status: "rejected"'),
  );

  // Native C/C++ shards and manifests are canonical independently of
  // background scheduling, so these rows keep the strongest reproduction
  // assertion and carry no producer-specific exemption.
  TestValidator.predicate(
    "native C and C++ regeneration stays reproducible",
    [cpp, c].every((row) => !declares(row, "regenerationLimitation")) &&
      // Counted over the whole catalog so any future reproduction exemption
      // requires a reviewed contract change here.
      [...catalog.matchAll(/regenerationLimitation:/g)].length === 0 &&
      runner.includes("experiment.regenerationLimitation !== undefined") &&
      runner.includes("regenerationLimitation.trim() === \"\"") &&
      runner.includes(
        "regenerationLimitation: experiment.regenerationLimitation",
      ) &&
      lifecycle.includes("const reproduced = reproducedManifest &&") &&
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
  //
  // Which languages, not how many. A count alone lets one row be renamed to
  // duplicate another: the registry still advertises the language that
  // disappeared, and nothing objects until its real-server lane spends its
  // budget looking up an experiment that is no longer there. Sorted, because
  // the order these are written in is presentation and pinning it would fail a
  // harmless reorder.
  TestValidator.equals(
    "the catalog covers every advertised language",
    [...catalogRows.map(named)].sort(),
    [...LANGUAGE_SPECS.map((spec) => spec.language)].sort(),
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
    "the TypeScript published-release boundary launches before fallback selection",
    typescript.includes("strictReleaseBoundary: {") &&
      typescript.includes('version: "0.23.0"') &&
      typescript.includes('warning: "legacy full dump"') &&
      typescript.includes("reason:") &&
      runner.includes(
        "const strictDeclared = experiment.strictProvider !== undefined",
      ) &&
      runner.includes(
        "const releaseBoundary = experiment.strictReleaseBoundary",
      ) &&
      runner.includes(
        "const strict = strictDeclared && releaseBoundary === undefined",
      ) &&
      runner.includes("...(releaseBoundary === undefined") &&
      runner.includes(
        "? { lspReferenceLimit: experiment.referenceLimit ?? 250 }",
      ) &&
      runner.includes("releaseBoundary !== undefined &&") &&
      runner.includes("declaredProvenance !== undefined") &&
      runner.includes("warning.includes(releaseBoundary.warning)") &&
      setup.includes("experiment.strictReleaseBoundary?.version"),
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
