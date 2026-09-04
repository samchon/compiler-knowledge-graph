import { TestValidator } from "@nestia/e2e";
import {
  CPP_CLANG_PRODUCER_COMMIT,
  JDT_GRAPH_PRODUCER_COMMIT,
  LANGUAGE_SPECS,
  RUST_GRAPH_PRODUCER_COMMIT,
} from "@samchon/graph";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  measureLifecycleNoopPerformance,
  nearestRankP95,
} from "../../../experiment/src/lifecycle-performance.mjs";
import { findExperiment } from "../../../experiment/src/catalog.mjs";
import { verifyGitTree } from "../../../experiment/src/git-tree.mjs";
import { captureKotlinBuildReport } from "../../../experiment/src/kotlin-build-report.mjs";
import {
  RUST_GRAPH_PRODUCER_SLOW_TEST,
  RUST_GRAPH_PRODUCER_UNIT_TEST,
  verifyRustGraphProducer,
} from "../../../experiment/src/rust-producer.mjs";
import {
  measureClangBackgroundIndex,
} from "../../../experiment/src/clang-background-baseline.mjs";
import { hasRepresentativeEdge } from "../../../experiment/src/representative-edges.mjs";
import { GraphPaths } from "../internal/GraphPaths";

/** Real-language experiments always check out one reviewable corpus revision. */
export const test_experiment_corpora_are_commit_pinned = async () => {
  verifyGitTreeFixture();
  verifyKotlinBuildReportFixture();
  const catalog = experimentSource("catalog.mjs");
  const helpers = experimentSource("process.mjs");
  const lifecycle = experimentSource("strict-lifecycle.mjs");
  const lifecyclePerformance = experimentSource("lifecycle-performance.mjs");
  const runner = experimentSource("run-language.mjs");
  const setup = experimentSource("setup-language.mjs");
  const gitTree = experimentSource("git-tree.mjs");
  const javaAgreement = experimentSource("java-producer-agreement.mjs");
  const clangProducer = experimentSource("clang-producer.mjs");
  const evidenceSummary = experimentSource("evidence-summary.mjs");

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
  const luaSetup = region(setup, 'case "lua"', 'case "dart"');
  const javaSetup = region(setup, 'case "java"', 'case "csharp"');
  const csharpSetup = region(setup, 'case "csharp"', 'case "kotlin"');
  const kotlinSetup = region(setup, 'case "kotlin"', 'case "swift"');
  const swiftSetup = region(setup, 'case "swift"', 'case "scala"');
  const scalaSetup = region(setup, 'case "scala"', 'case "zig"');
  const rustSetup = region(setup, 'case "rust"', 'case "cpp"');
  const cppSetup = region(setup, 'case "cpp"', 'case "java"');
  TestValidator.equals(
    "every registered strict-provider language has a lifecycle row",
    [...catalog.matchAll(/strictProvider:\s*"[^"]+"/g)].length,
    15,
  );
  TestValidator.predicate(
    "Rust builds and records the exact native HIR producer declared by the catalog",
    rust.includes('producerRepository: "https://github.com/samchon/rust-analyzer.git"') &&
      rust.includes(`producerCommit: "${RUST_GRAPH_PRODUCER_COMMIT}"`) &&
      rustSetup.includes("--default-toolchain 1.95.0") &&
      rustSetup.includes('"rust-src"') &&
      rustSetup.includes('["fetch", "--depth=1", "origin", experiment.producerCommit]') &&
      rustSetup.includes("verifyRustGraphProducer({ cargo, producerRoot, run })") &&
      rustSetup.indexOf("verifyRustGraphProducer({ cargo, producerRoot, run })") <
        rustSetup.indexOf('["build", "--locked", "--release", "-p", "rust-analyzer"]') &&
      rustSetup.includes('["build", "--locked", "--release", "-p", "rust-analyzer"]') &&
      rustSetup.includes('for (const command of ["samchon-rust-analyzer", "rust-analyzer"])') &&
      rustSetup.includes("fs.linkSync(producerBinary, link)") &&
      !rustSetup.includes("rustup component add rust-analyzer"),
  );
  TestValidator.predicate(
    "Rust separately measures its native baseline and resident p95 targets",
    rust.includes(
      'nativeBaseline: "samchon-rust-analyzer prime-caches ."',
    ) &&
      rust.includes("noopSamples: 20") &&
      rust.includes("editSamples: 20") &&
      rust.includes("noopP95MaxMs: 250") &&
      rust.includes("editP95MaxMs: 2_000") &&
      rust.includes('editFind: "broadcast::channel(1)"') &&
      rust.includes('"broadcast::channel(2)"') &&
      rust.includes('"broadcast::channel(3)"') &&
      lifecycle.includes('name: "native-baseline"') &&
      lifecycle.includes("measureLifecyclePerformance({") &&
      lifecyclePerformance.includes('name: "performance"') &&
      lifecyclePerformance.includes("performance no-op") &&
      lifecyclePerformance.includes("performance edit"),
  );
  TestValidator.equals(
    "nearest-rank p95 keeps singleton and exact twenty-sample boundaries",
    [nearestRankP95([7]), nearestRankP95(Array.from({ length: 20 }, (_, i) => i + 1))],
    [7, 19],
  );
  TestValidator.error("nearest-rank p95 rejects an empty sample", () =>
    nearestRankP95([]),
  );
  TestValidator.predicate(
    "C and C++ measure twenty exact resident no-ops below 250 ms",
    [c, cpp].every(
      (row) =>
        row.includes('kind: "clang-background-index"') &&
        row.includes('command: "samchon-clangd"') &&
        row.includes("noopPerformance: {") &&
        row.includes("samples: 20") &&
        row.includes("p95MaxMs: 250"),
    ) && lifecycle.includes("measureLifecycleNoopPerformance({"),
  );
  const cExperiment = findExperiment("c") as {
    repository: string;
    commit: string;
    representativeEdges: Array<{ kind: string; from: string; to: string }>;
  };
  const cppExperiment = findExperiment("cpp") as typeof cExperiment;
  TestValidator.equals(
    "Redis and LevelDB smokes pin exact representative semantic edges",
    [
      [
        cExperiment.repository,
        cExperiment.commit,
        cExperiment.representativeEdges,
      ],
      [
        cppExperiment.repository,
        cppExperiment.commit,
        cppExperiment.representativeEdges,
      ],
      [
        runner.includes("representativeEdges"),
        runner.includes("hasRepresentativeEdge(dump, claim)"),
        hasRepresentativeEdge(
          {
            nodes: [
              { id: "from", qualifiedName: "leveldb::DBImpl::Get" },
              { id: "to", qualifiedName: "leveldb::MemTable::Get" },
            ],
            edges: [{ from: "from", to: "to", kind: "calls" }],
          },
          {
            from: "wrong::leveldb::DBImpl::Get",
            to: "leveldb::MemTable::Get",
            kind: "calls",
          },
        ),
      ],
    ],
    [
      [
        "https://github.com/samchon/graph-benchmark-redis.git",
        "6bf6224c3dad518329ddc893ef9c5d58dcbabdeb",
        [
          { kind: "calls", from: "processCommand", to: "lookupCommand" },
          { kind: "calls", from: "processCommand", to: "call" },
          { kind: "accesses", from: "processCommand", to: "server" },
          { kind: "type_ref", from: "processCommand", to: "client" },
        ],
      ],
      [
        "https://github.com/samchon/graph-benchmark-leveldb.git",
        "7ee830d02b623e8ffe0b95d59a74db1e58da04c5",
        [
          {
            kind: "calls",
            from: "leveldb::DBImpl::Get",
            to: "leveldb::MemTable::Get",
          },
          {
            kind: "accesses",
            from: "leveldb::DBImpl::Get",
            to: "leveldb::DBImpl::mutex_",
          },
          {
            kind: "type_ref",
            from: "leveldb::DBImpl::Get",
            to: "leveldb::Slice",
          },
          { kind: "extends", from: "leveldb::DBImpl", to: "leveldb::DB" },
        ],
      ],
      [true, true, false],
    ],
  );
  const residentDump = {};
  let noopSample = 0;
  const noopPerformance = await measureLifecycleNoopPerformance({
    language: "cpp",
    samples: 20,
    p95MaxMs: 250,
    currentDump: residentDump,
    currentIdentity: "resident",
    load: () => ({
      dump: residentDump,
      mode: "unchanged",
      identity: "resident",
      elapsedMs: ++noopSample,
    }),
  });
  TestValidator.equals(
    "no-op performance publishes every sample and nearest-rank p95",
    noopPerformance,
    {
      name: "noop-performance",
      status: "passed",
      samples: Array.from({ length: 20 }, (_, index) => index + 1),
      p95Ms: 19,
      p95MaxMs: 250,
    },
  );
  let boundaryError = "";
  try {
    await measureLifecycleNoopPerformance({
      language: "cpp",
      samples: 1,
      p95MaxMs: 5,
      currentDump: residentDump,
      currentIdentity: "resident",
      load: () => ({
        dump: residentDump,
        mode: "unchanged",
        identity: "resident",
        elapsedMs: 5,
      }),
    });
  } catch (error) {
    boundaryError = error instanceof Error ? error.message : String(error);
  }
  TestValidator.equals(
    "no-op performance treats the strict ceiling as a miss",
    boundaryError,
    "cpp: lifecycle no-op performance missed its target: p95 5/5 ms",
  );
  let progressListener: ((params: {
    token: string;
    value: { kind: string };
  }) => void) | undefined;
  const baselineCalls: unknown[] = [];
  const clock = [100, 175];
  const baselineRoot = path.resolve("baseline-fixture");
  const baselineCompilationDatabase = path.join(
    baselineRoot,
    "build",
    "compile_commands.json",
  );
  const baselineSource = path.join(baselineRoot, "db", "db_impl.cc");
  const baselineElapsed = await measureClangBackgroundIndex({
    command: "samchon-clangd",
    compilationDatabase: baselineCompilationDatabase,
    cwd: baselineRoot,
    language: "cpp",
    sourceFile: baselineSource,
    timeoutMs: 1_000,
    now: () => clock.shift()!,
    readSource: () => "int baseline();\n",
    createClient: (command, args) => ({
      onNotification: (method, listener) => {
        baselineCalls.push(["notification", method]);
        progressListener = listener;
      },
      request: async (method, params) => {
        baselineCalls.push(["request", method, params]);
        return {};
      },
      notify: (method, params) => {
        baselineCalls.push(["notify", method, params]);
        if (method !== "textDocument/didOpen") return;
        progressListener?.({
          token: "backgroundIndexProgress",
          value: { kind: "begin" },
        });
        progressListener?.({
          token: "backgroundIndexProgress",
          value: { kind: "end" },
        });
      },
      close: async () => {
        baselineCalls.push(["close", command, args]);
      },
    }),
  });
  TestValidator.equals(
    "native clang baseline waits for standard background-index progress",
    [baselineElapsed, baselineCalls[0], baselineCalls.at(-1)],
    [
      75,
      ["notification", "$/progress"],
      [
        "close",
        "samchon-clangd",
        [
          "--background-index",
          `--compile-commands-dir=${path.join(baselineRoot, "build")}`,
        ],
      ],
    ],
  );
  TestValidator.predicate(
    "native clang baseline opens a real compilation-database source",
    baselineCalls.some(
      (entry) =>
        Array.isArray(entry) &&
        entry[0] === "notify" &&
        entry[1] === "textDocument/didOpen",
    ),
  );
  let initializationError = "";
  try {
    await measureClangBackgroundIndex({
      command: "samchon-clangd",
      compilationDatabase: baselineCompilationDatabase,
      cwd: baselineRoot,
      language: "cpp",
      sourceFile: baselineSource,
      timeoutMs: 10,
      readSource: () => "int baseline();\n",
      createClient: () => ({
        onNotification: () => undefined,
        request: async () => {
          throw new Error("fixture initialize failure");
        },
        notify: () => undefined,
        close: async () => undefined,
      }),
    });
  } catch (error) {
    initializationError = error instanceof Error ? error.message : String(error);
  }
  TestValidator.equals(
    "native clang baseline preserves initialize failures without a stray timeout rejection",
    initializationError,
    "fixture initialize failure",
  );
  const cargoCalls: Array<{
    command: string;
    args: string[];
    options: {
      cwd: string;
      stdio: string;
      check: boolean;
      env?: Record<string, string>;
    };
  }> = [];
  verifyRustGraphProducer({
    cargo: "cargo",
    producerRoot: "producer",
    run: (command, args, options) => {
      cargoCalls.push({ command, args, options });
      return {
        status: 0,
        stdout:
          "running 1 test\ntest fixture ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n",
        stderr: "",
      };
    },
    emit: () => undefined,
  });
  TestValidator.equals(
    "Rust producer verification runs exact unit and slow fixtures",
    cargoCalls,
    [
      {
        command: "cargo",
        args: [
          "test",
          "--locked",
          "--release",
          "-p",
          "ide",
          "--lib",
          RUST_GRAPH_PRODUCER_UNIT_TEST,
          "--",
          "--exact",
        ],
        options: { cwd: "producer", stdio: "pipe", check: false },
      },
      {
        command: "cargo",
        args: [
          "test",
          "--locked",
          "--release",
          "-p",
          "rust-analyzer",
          "--test",
          "slow-tests",
          RUST_GRAPH_PRODUCER_SLOW_TEST,
          "--",
          "--exact",
        ],
        options: {
          cwd: "producer",
          stdio: "pipe",
          check: false,
          env: { RUN_SLOW_TESTS: "1" },
        },
      },
    ],
  );
  let zeroTestError = "";
  try {
    verifyRustGraphProducer({
      cargo: "cargo",
      producerRoot: "producer",
      run: () => ({
        status: 0,
        stdout:
          "running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out\n",
        stderr: "",
      }),
      emit: () => undefined,
    });
  } catch (error) {
    zeroTestError = error instanceof Error ? error.message : String(error);
  }
  TestValidator.equals(
    "Rust producer verification rejects Cargo's successful zero-test result exactly",
    zeroTestError,
    "Rust HIR unit fixture did not run exactly one passing test at the pinned producer commit",
  );
  const emittedFailure: string[] = [];
  let producerFailure = "";
  try {
    verifyRustGraphProducer({
      cargo: "cargo",
      producerRoot: "producer",
      run: (_command, _args, options) => {
        TestValidator.equals("failed Rust fixture stays captured", options, {
          cwd: "producer",
          stdio: "pipe",
          check: false,
        });
        return {
          status: 101,
          stdout: "actionable producer stdout\n",
          stderr: "actionable producer stderr\n",
        };
      },
      emit: (stdout, stderr) => emittedFailure.push(stdout, stderr),
    });
  } catch (error) {
    producerFailure = error instanceof Error ? error.message : String(error);
  }
  TestValidator.equals(
    "failed Rust producer fixtures emit both streams before rejection",
    emittedFailure,
    ["actionable producer stdout\n", "actionable producer stderr\n"],
  );
  TestValidator.equals(
    "failed Rust producer fixture retains its exact exit code",
    producerFailure,
    "Rust HIR unit fixture failed at the pinned producer commit: exited with code 101",
  );
  for (const failure of [
    {
      result: { status: null, signal: null, error: new Error("spawn ENOENT") },
      detail: "could not start: spawn ENOENT",
    },
    {
      result: { status: null, signal: "SIGKILL" },
      detail: "terminated by signal SIGKILL",
    },
  ]) {
    let message = "";
    try {
      verifyRustGraphProducer({
        cargo: "cargo",
        producerRoot: "producer",
        run: () => ({ ...failure.result, stdout: "", stderr: "" }),
        emit: () => undefined,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    TestValidator.equals(
      `Rust producer failure preserves ${failure.detail}`,
      message,
      `Rust HIR unit fixture failed at the pinned producer commit: ${failure.detail}`,
    );
  }
  TestValidator.predicate(
    "the remaining SCIP providers use isolated upstream lifecycle projects",
    [ruby, php, dart].every(
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
    "compiler identity and an explicit limitation remain mutually exclusive",
    !kotlin.includes("compilerLimitation:") &&
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
    "Kotlin pins a Koin-scale fixture and its resident K2 producer independently",
    kotlin.includes("cca45c63d1088888f445304e13f9fbc310f62078") &&
      kotlin.includes("3a1565d0647d89a28880fa40ecbef0966a1a328c") &&
      kotlin.includes("3b5c24126b0670c9c9bd9369df71fcd112b34b67") &&
      kotlin.includes('strictProvider: "kotlinc-graph"') &&
      kotlin.includes('strictAuthority: "compiler"') &&
      kotlin.includes('strictTool: "scip-kotlinc-k2-graph"') &&
      kotlin.includes("strictMinimums: true") &&
      kotlin.includes('nativeBaseline: "gradle compileKotlin"') &&
      kotlin.includes("kotlinBuildReportRoot:") &&
      kotlin.includes("moduleName.set") &&
      kotlin.includes("minNodes: 1_000") &&
      kotlin.includes("minEdges: 1_000") &&
      kotlin.includes("noopP95MaxMs: 250") &&
      kotlin.includes("editP95MaxMs: 2000") &&
      !setup.includes("const SCIP_JAVA_KOTLIN_COMMIT") &&
      !setup.includes("const SCIP_JAVA_KOTLIN_TREE") &&
      setup.includes('const SCIP_JAVA_KOTLIN_VERSION = "2.3.20"') &&
      setup.includes(
        "`${experiment.producerCommit}+kotlin-${SCIP_JAVA_KOTLIN_VERSION}`",
      ) &&
      setup.includes('":scip-java:installDist"') &&
      // Two rows build the same launcher from two revisions, so the builder is
      // shared and the pin is the argument. The Java row builds the fork whose
      // `index` writes a graph at all; a released binary installed beside it
      // would only be shadowed under the same name and then recorded as though
      // a run had used it.
      !javaSetup.includes("installScipJavaKotlinSnapshot") &&
      javaSetup.includes("await installJavacGraphProducer(await installGradle())") &&
      !setup.includes("installScipJava = ") &&
      kotlinSetup.includes("await installScipJavaKotlinSnapshot(gradle)") &&
      setup.includes("const installScipJavaSource = async (gradle, pin)") &&
      setup.includes('run(link, ["index", "--help"]') &&
      setup.includes('run(link, ["kotlin-graph-server", "--help"]') &&
      setup.includes(
        'recordProvisionedEnvironment("SAMCHON_GRAPH_KOTLINC_GRAPH", link)',
      ) &&
      setup.includes('run(link, ["--version"])'),
  );
  TestValidator.predicate(
    "Kotlin lifecycle rows publish compiler invalidation evidence",
    lifecycle.includes("captureKotlinBuildReport(") &&
      lifecycle.includes("kotlinBuildReport:"),
  );
  TestValidator.predicate(
    "Scala pins both compiler lines and builds its BSP producer from shipped source",
    scala.includes(
      'repository: "https://github.com/samchon/graph-benchmark-scala.git"',
    ) &&
      scala.includes("b11f22758c902bffa29513c9fcda07863a2ad996") &&
      scala.includes('strictProvider: "scalac-graph"') &&
      scala.includes('strictAuthority: "compiler"') &&
      scala.includes('strictTool: "samchon-scala-graph"') &&
      scala.includes('prepare: "sbt bspConfig"') &&
      scala.includes("env -u SAMCHON_GRAPH_SCALA2_PLUGIN") &&
      scala.includes("noopP95MaxMs: 500") &&
      scala.includes("editP95MaxMs: 15_000") &&
      scala.includes("minNodes: 30") &&
      scala.includes("minEdges: 150") &&
      scalaSetup.includes('apt(["openjdk-21-jdk", "maven"])') &&
      scalaSetup.includes('path.join(repositoryRoot, "sidecars", "scala", "pom.xml")') &&
      scalaSetup.includes('`scala-graph-plugin_2.13.18-${version}.jar`') &&
      scalaSetup.includes('`scala-graph-plugin_3.9.0-${version}.jar`') &&
      scalaSetup.includes('path.join(binRoot, "samchon-scala-graph")') &&
      scalaSetup.includes("f92a2095ac75008764fe3b2b793ffe624c4fbef5bfd9b0022e4bc2daf668c651") &&
      scalaSetup.includes("SAMCHON_GRAPH_SCALA_GRAPH: producer") &&
      scalaSetup.includes("SAMCHON_GRAPH_SCALA2_PLUGIN: scala2Plugin") &&
      scalaSetup.includes("SAMCHON_GRAPH_SCALA3_PLUGIN: scala3Plugin") &&
      scalaSetup.includes("SAMCHON_GRAPH_SCALA_PLUGIN_VERSION: version"),
  );
  TestValidator.predicate(
    "Swift builds the pinned IndexStoreDB sidecar and measures native SwiftPM",
    swift.includes(
      'repository: "https://github.com/apple/swift-argument-parser.git"',
    ) &&
      swift.includes("2f77f2fccb6e84fecff338c37b199e33e7dfd119") &&
      swift.includes(
        '"swift build --enable-index-store --build-tests -Xswiftc -index-include-locals"',
      ) &&
      swift.includes('strictProvider: "swift-indexstore"') &&
      swift.includes('strictAuthority: "compiler"') &&
      swift.includes('strictTool: "samchon-swift-graph"') &&
      swift.includes('createdSymbol: "samchonGraphExperiment"') &&
      swift.includes('to: "mapEmpty"') &&
      swift.includes("noopP95MaxMs: 250") &&
      swift.includes("editP95MaxMs: 20_000") &&
      swiftSetup.includes('path.join(repositoryRoot, "sidecars", "swift")') &&
      swiftSetup.includes('"--configuration",') &&
      swiftSetup.includes('"release",') &&
      swiftSetup.includes('process.platform === "linux"') &&
      swiftSetup.includes('path.join(swiftRoot, "lib", "swift", "Block")') &&
      swiftSetup.includes('path.join(sidecarBin, "samchon-swift-graph")') &&
      swiftSetup.includes(
        'recordProvisionedEnvironment("SAMCHON_GRAPH_SWIFT_GRAPH", producer)',
      ) &&
      swiftSetup.includes(
        "indexstore-db-54212fce1aecb199070808bdb265e7f17e396015",
      ),
  );
  TestValidator.predicate(
    "Java pins both producers, verifies their breadth and proves agreement",
    java.includes('kind: "shell"') &&
      java.includes('command: "mvn -q test-compile"') &&
      java.includes("warmup: true") &&
      java.includes('clean: ["target"]') &&
      java.includes(
        `jdtProducerCommit: "${JDT_GRAPH_PRODUCER_COMMIT}"`,
      ) &&
      java.includes(
        'producerTree: "8cb3dd9b84fbbbb8dba22827b9d8e7dd21c3f46e"',
      ) &&
      /jdtProducerTree:\s*"[0-9a-f]{40}"/u.test(java) &&
      !java.includes("regenerationLimitation:") &&
      setup.includes("if (pin.verify !== undefined) pin.verify({ gradle, source })") &&
      setup.includes("org.scip_code.scip_java.javac.JavaGraphShardTest") &&
      setup.includes("org.scip_code.scip_java.gradle.GraphGenerationStoreTest") &&
      setup.includes("tests.GradleGraphLifecycleTest") &&
      setup.includes("tests.MavenGraphLifecycleTest") &&
      setup.includes("tests.MavenGraphPluginTest") &&
      setup.includes("tests.GraphAggregateRunnerTest") &&
      setup.includes("tests.GradleBuildToolTest") &&
      setup.includes("const installJdtGraphProducer = async") &&
      setup.includes("verifyGitTree(source, pin.tree)") &&
      setup.includes("digest: `git-tree:${pin.tree}`") &&
      setup.includes("verifyGitTree(source, experiment.jdtProducerTree)") &&
      gitTree.includes('["add", "--all", "--force"]') &&
      gitTree.includes('["write-tree"]') &&
      setup.includes('run(maven, ["clean", "install", "-U", "-DskipTests=true"]') &&
      setup.includes("GraphSnapshotCommandTest") &&
      setup.includes("UnresolvedTypesQuickFixTest#testTypeInSealedTypeDeclaration") &&
      setup.includes("FileEventHandlerTest") &&
      setup.includes("CleanUpsTest") &&
      setup.includes('path.join(binRoot, "samchon-jdtls")') &&
      setup.includes(
        'recordProvisionedEnvironment("SAMCHON_GRAPH_JDT_WORKSPACE", dedicated)',
      ) &&
      runner.includes("runJavaProducerAgreement(experiment, cwd)") &&
      javaAgreement.includes("const javac = await buildGraphDump(options)") &&
      javaAgreement.includes("delete process.env[JAVAC_OVERRIDE]") &&
      javaAgreement.includes("const jdt = await buildGraphDump(options)") &&
      /declaration\(\s*"constructor"/u.test(javaAgreement) &&
      javaAgreement.includes('declaration("method"') &&
      javaAgreement.includes('declarationsFor("GradleMainAgreement", ":compileJava")') &&
      javaAgreement.includes('declarationsFor("GradleTestAgreement", ":compileTestJava")') &&
      javaAgreement.includes('":module:compileJava"') &&
      javaAgreement.includes('["wrapper", "--gradle-version", "9.4.1", "--no-daemon"]'),
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
  // A pinned fixture of two empty classes carries no relationship at all, so
  // the row's cross-file claim is proved by the transition that creates one.
  // The created edge therefore has to be the family the row declares, not
  // merely some family: an edge kind that no longer matched would leave the
  // claim asserted and never exercised.
  TestValidator.predicate(
    "isolated lifecycle edges can prove a pinned corpus relationship claim",
    [
      [java, "instantiates"],
      [kotlin, "calls"],
    ].every(
      ([row, kind]) =>
        row!.includes(`crossFileEdge: "${kind}"`) &&
        row!.includes(`kind: "${kind}"`) &&
        row!.includes("crossFile: true"),
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
    "the C# experiment proves the resident compiler route and its edit bounds",
    csharp.includes('strictProvider: "roslyn-workspace"') &&
      csharp.includes('strictAuthority: "compiler"') &&
      csharp.includes('strictTool: "samchon-roslyn"') &&
      csharp.includes('crossFileEdge: "accesses"') &&
      csharp.includes("noopP95MaxMs: 250") &&
      csharp.includes("editP95MaxMs: 2000") &&
      csharp.includes('failurePolicy: "reject"') &&
      csharpSetup.includes('"publish"') &&
      csharpSetup.includes("SAMCHON_GRAPH_ROSLYN_WORKSPACE") &&
      runner.includes("experiment.semanticEdges.length === 0") &&
      runner.includes("crossFileEdge !== undefined") &&
      runner.includes("semanticLimitation.trim() ==="),
  );
  TestValidator.predicate(
    "the native C and C++ producer grounds cross-file graph families",
    [cpp, c].every(
      (row) =>
        row.includes('strictProvider: "clangd-snapshot"') &&
        row.includes("producerRepository: CLANG_PRODUCER_REPOSITORY") &&
        row.includes("producerCommit: CLANG_PRODUCER_COMMIT") &&
        row.includes('crossFileEdge: "references"') &&
        row.includes('"contains"') &&
        row.includes('"references"') &&
        !row.includes('"implements"') &&
        !row.includes('"dispatches"') &&
        !row.includes("semanticEdges: []"),
    ) &&
      !c.includes('"instantiates"') &&
      !c.includes('"extends"') &&
      !c.includes('"overrides"') &&
      clangProducer.includes(
        '"https://github.com/samchon/llvm-project.git"',
      ) &&
      clangProducer.includes(`"${CPP_CLANG_PRODUCER_COMMIT}"`) &&
      clangProducer.includes("assertClangProducerAdapterPin()") &&
      setup.includes("installClangGraphProducer({"),
  );
  TestValidator.predicate(
    "C and C++ build and record the exact campaign-owned native producer",
    cppSetup.includes("CLANG_PRODUCER_BUILD_PACKAGES") &&
      cppSetup.includes("installClangGraphProducer({") &&
      clangProducer.includes(
        '["fetch", "--depth=1", "origin", CLANG_PRODUCER_COMMIT]',
      ) &&
      clangProducer.includes('["checkout", "--detach", "FETCH_HEAD"]') &&
      clangProducer.includes('["rev-parse", "HEAD"]') &&
      clangProducer.includes(
        '"-DLLVM_ENABLE_PROJECTS=clang;clang-tools-extra"',
      ) &&
      clangProducer.includes('"--target",') &&
      clangProducer.includes('"clangd",') &&
      clangProducer.includes(
        'for (const command of ["samchon-clangd", "clangd"])',
      ) &&
      clangProducer.includes("fs.linkSync(binary, link)") &&
      clangProducer.includes('path.join(build, "lib", "clang")') &&
      clangProducer.includes(
        "fs.cpSync(builtResources, installedResources",
      ) &&
      clangProducer.includes('"include",') &&
      clangProducer.includes('"stddef.h",') &&
      clangProducer.includes("version.includes(CLANG_PRODUCER_COMMIT)") &&
      clangProducer.includes('tool: "samchon-clangd"') &&
      !cppSetup.includes('apt(["clangd"'),
  );
  // A fixed parallelism here already cost CI lanes, and the size of this build
  // is the thing that has to stay correct, so pin the decision rather than its
  // vocabulary. Naming `os.availableParallelism()` and `os.totalmem()` proves
  // nothing on its own: a comment saying why they were abandoned contains both
  // names, and a `const jobs = 2` under it would satisfy every such check.
  // Comments are therefore stripped before anything is matched, and the
  // binding is asserted end to end: the expression that computes the count,
  // the argument that hands that same count to the build, and the log that
  // makes it visible in a run.
  //
  // The configure call is inside this region too, and `-DLLVM_PARALLEL_*_JOBS`
  // caps concurrency from there without touching `--build` at all. Watching
  // only the build argv would leave that door open, so the region must set no
  // such flag; if one is ever needed it has to be derived from `jobs` and this
  // line has to change with it.
  //
  // This is a tripwire, not a proof. It refuses the regressions that have
  // actually happened here and the nearest spellings of them; it cannot
  // enumerate every way to reintroduce a constant.
  const clangBuild = withoutLineComments(
    region(
      clangProducer,
      "export function installClangGraphProducer",
      "function installedClangGraphProducer",
    ),
  );
  TestValidator.equals(
    "the native Clang build is sized by the machine and bounded by its memory",
    [
      /const jobs = Math\.max\(\s*1,\s*Math\.min\(\s*os\.availableParallelism\(\),\s*Math\.floor\(os\.totalmem\(\) \/ \(2 \* 1024 \* 1024 \* 1024\)\),\s*\),\s*\);/u.test(
        clangBuild,
      ),
      /"--parallel",\s*String\(jobs\),/u.test(clangBuild),
      /"--parallel",\s*(?:"|`|'|\d)/u.test(clangBuild),
      /LLVM_PARALLEL_[A-Z_]*JOBS/u.test(clangBuild),
      /console\.log\([\s\S]*?String\(jobs\)/u.test(clangBuild),
    ],
    [true, true, false, false, true],
  );
  // A restored producer is untrusted input, and the whole point of restoring
  // it is to skip the build that would otherwise have proved what it is. So
  // reuse is admitted by the same evidence a fresh build must produce: both
  // installed names report the pinned commit, and the resource headers the
  // adapter resolves relative to the binary are present exactly once. Anything
  // short of that — a missing file, an unreadable tree, an unexpected version,
  // any thrown error — falls back to building, because reuse is an
  // optimisation and may only be taken on complete evidence.
  //
  // Bounded to the predicate's own body. An unbounded `[\s\S]*?` would let a
  // deleted check pass by matching the identical text in the build path below
  // it, so the region is what makes a deletion visible.
  const restoredProducer = withoutLineComments(
    region(
      clangProducer,
      "function installedClangGraphProducer",
      "function assertVersion",
    ),
  );
  TestValidator.equals(
    "a restored native Clang producer is re-proved against the pin before reuse",
    [
      /const installed = installedClangGraphProducer\(\{\s*toolsRoot,\s*binRoot,\s*platform,\s*\}\);/u.test(
        clangProducer,
      ),
      cppSetup.includes("installClangGraphProducer({"),
      restoredProducer.includes(
        'for (const binary of [installed, alias]) assertVersion("cache", binary)',
      ),
      restoredProducer.includes('"stddef.h"'),
      restoredProducer.includes("versions.length !== 1"),
      /\} catch \{\s*\n\s*return false;/u.test(restoredProducer),
    ],
    [true, true, true, true, true, true],
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
  // Lua moved from `published` to `tolerated` on evidence rather than on
  // preference. The row claimed a malformed `.luarc.json` changed the
  // published generation because the corpus selects LuaJIT and a workspace
  // library; at 3.19.0 — the release every green run of that lane used — every
  // fact plane and the source manifest come back byte-identical and only the
  // build universe moves. The claim, not the check, was what had to change.
  TestValidator.predicate(
    "the lifecycle keeps degraded and tolerated publication policies distinct",
    [lua, python].every(
        (row) =>
          row.includes('failurePolicy: "tolerated"') &&
          declares(row, "failureLimitation"),
      ) &&
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
      // Counted over the whole catalog so a future exemption requires a
      // reviewed contract change here. The pinned Java producer now hashes
      // plugin bytes and tags only its transient scratch path, so it returns to
      // the same strongest assertion as C/C++.
      [...catalog.matchAll(/regenerationLimitation:/g)].length === 0 &&
      !declares(java, "regenerationLimitation") &&
      runner.includes("experiment.regenerationLimitation !== undefined") &&
      runner.includes("regenerationLimitation.trim() === \"\"") &&
      runner.includes(
        "regenerationLimitation: experiment.regenerationLimitation",
      ) &&
      lifecycle.includes("const reproduced = reproducedManifest &&") &&
      lifecycle.includes("!reproduced && limitation === undefined") &&
      lifecycle.includes('name: "regeneration"'),
  );
  // Sixteen product languages, fifteen strict rows. The remaining one is a
  // decision with evidence behind it, not a lane nobody reached, and a
  // bounded generic row that passes on node counts cannot tell a reader which
  // it is. So the absence of a strict provider is itself a declaration.
  TestValidator.predicate(
    "every language without a strict provider states what blocks one",
    declares(zig, "feasibilityBlocked") &&
      !declares(swift, "feasibilityBlocked") &&
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

  // A strict row's verdict is a claim about one producer build, and lua's used
  // to take whichever LuaLS release was latest that hour. That was proposed as
  // the reason its lane went red and turned out not to be — the lane fails on
  // 3.19.0, the release every green run used — so the pin removes a variable
  // rather than fixing a defect. It is still the shape a strict row needs: one
  // that cannot say which build it measured cannot be debugged. The remaining
  // `latestAsset` downloads are generic fallback servers, whose rows assert
  // counts rather than a producer's exact publication behaviour.
  TestValidator.equals(
    "every strict producer is provisioned from an exact pinned artifact",
    [
      /const version = "3\.19\.0";/u.test(luaSetup),
      /verifySha256\(\s*archive,\s*"[0-9a-f]{64}",\s*\)/u.test(luaSetup),
      luaSetup.includes("latestAsset("),
      [...setup.matchAll(/latestAsset\(\s*"([^"]+)"/gu)]
        .map((match) => match[1]!)
        .sort()
        .join(","),
    ],
    [true, true, false, "fwcd/kotlin-language-server,zigtools/zls"],
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
  // Two producers on one lane prove nothing about either. Every corpus copy
  // lives under `tests/experiment/.work`, so Node's upward lookup reaches this
  // package's own `ttsc` before PATH is consulted, and a separately installed
  // release is simply not the binary the lane measures. Provisioning the
  // lockfile-resolved release is what makes the recorded version the one that
  // answered — and its digest real, because the platform binary is an
  // exact-versioned optional dependency rather than a mutable global install.
  TestValidator.predicate(
    "the TypeScript lane provisions the exact producer its corpus resolves",
    !catalog.includes("strictReleaseBoundary") &&
      !runner.includes("releaseBoundary") &&
      typescript.includes('strictTool: "ttscgraph"') &&
      setup.includes(
        'const ttscPackage = createRequire(import.meta.url).resolve(',
      ) &&
      setup.includes('"ttsc/package.json",') &&
      setup.includes(
        "const platformPackage = `@ttsc/${process.platform}-${process.arch}`",
      ) &&
      setup.includes("createRequire(ttscPackage).resolve(") &&
      setup.includes('digest: createHash("sha256")') &&
      !setup.includes("npm install -g @ttsc/") &&
      runner.includes(
        "const strict = experiment.strictProvider !== undefined",
      ) &&
      runner.includes(
        "lspReferenceLimit: experiment.referenceLimit ?? 250,",
      ),
  );
  TestValidator.predicate(
    "the runner proves declared families are present and undeclared ones absent",
    runner.includes("provenance.facts.includes(kind)") &&
      runner.includes("provenance.facts.includes(crossFileEdge)") &&
      runner.includes("tools: toolManifest(experiment.language)"),
  );
  TestValidator.predicate(
    "real-provider artifacts compact complete coverage and stable unresolved reasons",
    runner.includes("coverageSummary: summarizeCoverage(dump, provenance?.provider)") &&
      runner.includes(
        "unresolvedSummary: summarizeUnresolved(dump, provenance?.provider)",
      ) &&
      evidenceSummary.includes("GRAPH_EDGE_KINDS.map") &&
      evidenceSummary.includes('row.state === "complete"') &&
      evidenceSummary.includes('row.state === "partial"') &&
      evidenceSummary.includes('row.state === "unsupported"') &&
      evidenceSummary.includes('"identity-unstable"') &&
      evidenceSummary.includes('"provider-gap"') &&
      !evidenceSummary.includes("site.evidence") &&
      !evidenceSummary.includes("site.candidates"),
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

/** Exercise both the accepting and rejecting cleanup paths of the tree pin. */
function verifyGitTreeFixture(): void {
  const source = fs.mkdtempSync(
    path.join(os.tmpdir(), "samchon-graph-git-tree-"),
  );
  const repository = path.join(source, ".git");
  try {
    fs.writeFileSync(path.join(source, "fixture.txt"), "graph snapshot\n");
    verifyGitTree(source, "40c24dc91a696208881f6616618948ca18f05a92");
    TestValidator.equals(
      "successful Git tree verification removes its temporary repository",
      fs.existsSync(repository),
      false,
    );
    TestValidator.error("a mismatched Git tree is rejected", () =>
      verifyGitTree(source, "0000000000000000000000000000000000000000"),
    );
    TestValidator.equals(
      "failed Git tree verification removes its temporary repository",
      fs.existsSync(repository),
      false,
    );
  } finally {
    fs.rmSync(source, { force: true, recursive: true });
  }
}

/** Exercise latest-report selection and path-free invalidation evidence. */
function verifyKotlinBuildReportFixture(): void {
  const root = GraphPaths.createTempDirectory(
    "samchon-graph-kotlin-build-report-",
  );
  const reports = path.join(root, "reports");
  fs.mkdirSync(reports);
  const older = path.join(reports, "older.json");
  const latest = path.join(reports, "latest.json");
  fs.writeFileSync(older, JSON.stringify({ buildOperationRecord: [] }));
  fs.writeFileSync(
    latest,
    JSON.stringify({
      buildOperationRecord: [
        {
          path: ":compileKotlin",
          didWork: true,
          totalTimeMs: 12,
          changedFiles: {
            modifiedFiles: [
              path.join(root, "src", "Main.kt"),
              path.resolve(root, "..", "Secret.kt"),
            ],
            removedFiles: [path.join(root, "src", "Old.kt")],
          },
          buildMetrics: {
            buildAttributes: {
              myAttributes: {
                CLASSPATH_SNAPSHOT_NOT_FOUND: 1,
                UNUSED: 0,
              },
            },
          },
          icLogLines: [
            "Non-incremental compilation will be performed: CLASSPATH_SNAPSHOT_NOT_FOUND",
            "Classpath changes info passed from Gradle task: ToBeComputedByIncrementalCompiler",
            "Finished executing kotlin compiler using DAEMON strategy",
          ],
        },
        {
          path: ":compileTestKotlin",
          didWork: true,
          icLogLines: ["Incremental compilation completed"],
        },
      ],
    }),
  );
  fs.utimesSync(older, new Date(1), new Date(1));
  fs.utimesSync(latest, new Date(2), new Date(2));

  TestValidator.equals(
    "Kotlin build reports retain exact compiler invalidation decisions",
    captureKotlinBuildReport(root, "reports"),
    {
      tasks: [
        {
          task: ":compileKotlin",
          didWork: true,
          elapsedMs: 12,
          incremental: false,
          invalidation:
            "Non-incremental compilation will be performed: CLASSPATH_SNAPSHOT_NOT_FOUND",
          classpath:
            "Classpath changes info passed from Gradle task: ToBeComputedByIncrementalCompiler",
          changedFiles: {
            modified: ["<outside-project>", "src/Main.kt"],
            removed: ["src/Old.kt"],
          },
          buildAttributes: ["CLASSPATH_SNAPSHOT_NOT_FOUND"],
          daemon: true,
        },
        {
          task: ":compileTestKotlin",
          didWork: true,
          incremental: true,
          daemon: false,
        },
      ],
    },
  );
  TestValidator.error("a Kotlin report root cannot escape its project", () =>
    captureKotlinBuildReport(root, "../outside"),
  );
}

/**
 * One source region with its line comments removed.
 *
 * These files explain themselves at length, and every identifier an assertion
 * looks for is also written in the prose around the code that uses it. Without
 * this, `includes` and even a careful regex are satisfied by a comment
 * describing the very thing that was deleted — which is how the first version
 * of the parallelism pin passed against a hard-coded job count.
 */
function withoutLineComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*\/\//u.test(line))
    .join("\n");
}

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
