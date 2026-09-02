import {
  CLANG_PRODUCER_COMMIT,
  CLANG_PRODUCER_REPOSITORY,
} from "./clang-producer.mjs";

// `minEdges` gates the relationship edges an experiment must produce. It is set
// to 1 for languages whose reference edges are empirically confirmed against a
// real server (see the LSP experiment CI matrix) so a regression back to the
// "symbols but no edges" failure is caught. Languages still awaiting a first
// real-server measurement keep 0; the runner always records the observed count,
// so the CI artifact reports the true number and the gate can be tightened once
// a language is confirmed.
export const LANGUAGE_EXPERIMENTS = [
  {
    language: "typescript",
    repository: "https://github.com/nestjs/typescript-starter.git",
    commit: "c4d9330f5513eda0fb5df594f6b34a11fde1a934",
    strictProvider: "ttscgraph",
    strictAuthority: "compiler",
    strictTool: "ttscgraph",
    // The pinned starter has no construction expression. The lifecycle below
    // creates one and checks the real ttscgraph generation that contains it.
    semanticEdges: ["calls", "type_ref"],
    crossFileEdge: "calls",
    requiredCapabilities: [
      "universe",
      "sourceDigests",
      "diskDigests",
      "diagnostics",
    ],
    minNodes: 1,
    minEdges: 1,
    prepare: "npm ci --ignore-scripts",
    lifecycle: {
      sourceFile: "src/app.service.ts",
      editSuffix: "\n// samchon-graph lifecycle edit\n",
      createFile: "src/samchon_graph_experiment.ts",
      renamedFile: "src/samchon_graph_experiment_renamed.ts",
      createText:
        "export class SamchonGraphExperiment {}\n\nexport function samchonGraphExperiment() {\n  return new SamchonGraphExperiment();\n}\n",
      createdSymbol: "samchonGraphExperiment",
      createdEdge: {
        kind: "instantiates",
        from: "samchonGraphExperiment",
        to: "SamchonGraphExperiment",
      },
      buildFile: "tsconfig.json",
      failureSuffix: "\nexport const = ;\n",
      failurePolicy: "diagnostic",
    },
  },
  {
    language: "go",
    repository: "https://github.com/gorilla/mux.git",
    commit: "db9d1d0073d27a0a2d9a8c1bc52aa0af4374d265",
    strictProvider: "samchon-graph-go",
    strictAuthority: "compiler",
    strictTool: "samchon-graph-go",
    crossFileEdge: "calls",
    requiredCapabilities: ["universe", "sourceDigests", "fullRebuild"],
    semanticEdges: [
      "imports",
      "calls",
      "instantiates",
      "implements",
      "tests",
    ],
    lifecycle: {
      sourceFile: "mux.go",
      editSuffix: "\n// samchon-graph lifecycle edit\n",
      createFile: "samchon_graph_experiment.go",
      renamedFile: "samchon_graph_experiment_renamed.go",
      createText:
        "package mux\n\nconst samchonGraphExperiment = \"strict-lifecycle\"\n",
      createdSymbol: "samchonGraphExperiment",
      buildFile: "go.mod",
      failureSuffix: "\nfunc samchonGraphBroken(\n",
      failurePolicy: "reject",
    },
  },
  {
    language: "rust",
    repository: "https://github.com/tokio-rs/mini-redis.git",
    commit: "3d93b42bc363220f85af4fc9e1bebd35b588a4a3",
    strictProvider: "samchon-rust-analyzer-hir",
    strictAuthority: "analyzer",
    strictTool: "samchon-rust-analyzer",
    producerRepository: "https://github.com/samchon/rust-analyzer.git",
    producerCommit: "9923b2c14b0b2a9bed6e8534c70b027e03a1d721",
    nativeBaseline: "samchon-rust-analyzer prime-caches .",
    requiredCapabilities: [
      "coverage",
      "diagnostics",
      "diskDigests",
      "incremental",
      "sourceDigests",
      "universe",
      "unresolved",
      "validatedConsumerCheckpoint",
    ],
    semanticEdges: [
      "contains",
      "exports",
      "imports",
      "calls",
      "accesses",
      "instantiates",
      "type_ref",
      "extends",
      "implements",
      "overrides",
      "decorates",
      "tests",
      "references",
    ],
    crossFileEdge: "references",
    lifecycle: {
      sourceFile: "src/server.rs",
      editSuffix: "\n// samchon-graph lifecycle edit\n",
      createFile: "examples/samchon_graph_experiment.rs",
      renamedFile: "examples/samchon_graph_experiment_renamed.rs",
      createText:
        'const samchonGraphExperiment: &str = "strict-lifecycle";\n\ntrait SamchonGraphParent {}\ntrait SamchonGraphChild: SamchonGraphParent {}\n\nfn main() { println!("{samchonGraphExperiment}"); }\n',
      createdSymbol: "samchonGraphExperiment",
      createdEdge: {
        kind: "extends",
        from: "SamchonGraphChild",
        to: "SamchonGraphParent",
      },
      buildFile: "Cargo.toml",
      // A malformed Cargo manifest invalidates the producer's build universe,
      // so the HIR snapshot must reject rather than mix an old database with
      // new workspace inputs.
      failureFile: "Cargo.toml",
      failureSuffix: "\n[malformed",
      failurePolicy: "reject",
      performance: {
        noopSamples: 20,
        editSamples: 20,
        noopP95MaxMs: 250,
        editP95MaxMs: 2_000,
        editFind: "broadcast::channel(1)",
        editReplacements: ["broadcast::channel(2)", "broadcast::channel(3)"],
      },
    },
  },
  {
    language: "cpp",
    repository: "https://github.com/samchon/graph-benchmark-leveldb.git",
    commit: "7ee830d02b623e8ffe0b95d59a74db1e58da04c5",
    // Uncapped: the native snapshot publishes a whole-compilation-database
    // generation and refuses a file cap.
    //
    // The compilation database enumerates every native clangd graph view and
    // is what a CMake project has to be configured to produce; preparation
    // itself compiles nothing.
    prepare:
      "cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DLEVELDB_BUILD_TESTS=OFF -DLEVELDB_BUILD_BENCHMARKS=OFF",
    strictProvider: "clangd-snapshot",
    strictAuthority: "compiler",
    strictTool: "samchon-clangd",
    producerRepository: CLANG_PRODUCER_REPOSITORY,
    producerCommit: CLANG_PRODUCER_COMMIT,
    nativeBaseline: {
      kind: "clang-background-index",
      command: "samchon-clangd",
    },
    // A whole-compilation-database producer is not ready when it starts; it
    // is ready when clangd has background-indexed every translation unit the
    // database registers. The 180-second default expired on libuv with 62 of
    // them still indexing, the routing layer fell back as it should, and the
    // row lost the strict provenance it exists to prove.
    //
    // How long readiness actually takes has never been observed: no C or C++
    // row has ever reached it. The only datum is a lower bound — 180 seconds
    // was not enough, with 62 units left — and the rate it implies puts the
    // remainder near two more minutes. Ten is that with room, not a measured
    // requirement.
    //
    // These are per-refresh ceilings, and the strict lifecycle issues nine
    // refreshes, so they do not bound the row: nine cold waits would exceed
    // the job timeout on their own and be killed by it without a diagnosis.
    // What makes that remote rather than likely is that only the first
    // refresh indexes from nothing; the rest are incremental against a warm
    // database. The numbers are chosen so one cold index fits comfortably and
    // a producer that never becomes ready still fails its row rather than
    // hanging it — not so that every pathological path stays inside the job.
    // Readiness now covers more than indexing. The pinned producer publishes
    // each completed body to disk while it is in hand, so a snapshot can name
    // it instead of carrying it through the pipe -- and one libuv unit is 98
    // MiB of it. That work used to happen when a page was requested, after
    // this window had closed; it now happens inside it.
    //
    // Ten minutes was sized for a window covering indexing alone, and at two
    // workers it left forty of libuv's 242 units unfinished once publishing
    // joined them. Twenty is the same window sized for what it now contains.
    // It is a ceiling on the wait, not a target -- the walk after it is what
    // publishing exists to make cheap, and that is the number worth watching.
    readyTimeoutMs: 1_200_000,
    timeoutMs: 300_000,
    requiredCapabilities: [
      "coverage",
      "diagnostics",
      "diskDigests",
      "incremental",
      "sourceDigests",
      "universe",
      "unresolved",
    ],
    // Native Clang occurrences and relations retain their enclosing symbols,
    // exact ranges and TU/configuration identity in one compiler pass.
    semanticEdges: [
      "contains",
      "exports",
      "imports",
      "calls",
      "accesses",
      "type_ref",
      "references",
    ],
    crossFileEdge: "references",
    representativeEdges: [
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
    semanticLimitation:
      "The native Clang lane retains exact TU/configuration facts, while calls, instantiation, exports, implements and dispatch stay explicitly partial and C/C++ have no decorates, renders or tests family.",
    // Background jobs may finish in any order, but the native shard set,
    // manifest and generation digest are canonical and publish only after all
    // registered configurations agree on one complete source state.
    lifecycle: {
      sourceFile: "db/db_impl.cc",
      editSuffix: "\n// samchon-graph lifecycle edit\n",
      createFile: "db/samchon_graph_experiment.cc",
      renamedFile: "db/samchon_graph_experiment_renamed.cc",
      createText:
        "int samchonGraphExperiment(void) { return 0; }\n",
      createdSymbol: "samchonGraphExperiment",
      // The database itself, because that is what this producer reads. Breaking
      // CMakeLists would leave an already-generated database untouched and test
      // nothing.
      buildFile: "build/compile_commands.json",
      compilationDatabase: "build/compile_commands.json",
      failureFile: "build/compile_commands.json",
      failureSuffix: "\n[ not json",
      // A malformed compilation database invalidates the native universe, so
      // the strict resident rejects publication until it is repaired.
      failurePolicy: "reject",
      noopPerformance: {
        samples: 20,
        p95MaxMs: 250,
      },
    },
    minNodes: 1,
    minEdges: 1,
  },
  {
    language: "c",
    repository: "https://github.com/samchon/graph-benchmark-redis.git",
    commit: "6bf6224c3dad518329ddc893ef9c5d58dcbabdeb",
    // Uncapped: the native snapshot publishes a whole-compilation-database
    // generation and refuses a file cap.
    //
    // The compilation database enumerates every native clangd graph view and
    // is what a CMake project has to be configured to produce; preparation
    // itself compiles nothing.
    prepare: "bear -- make -j2",
    strictProvider: "clangd-snapshot",
    strictAuthority: "compiler",
    strictTool: "samchon-clangd",
    producerRepository: CLANG_PRODUCER_REPOSITORY,
    producerCommit: CLANG_PRODUCER_COMMIT,
    nativeBaseline: {
      kind: "clang-background-index",
      command: "samchon-clangd",
    },
    // A whole-compilation-database producer is not ready when it starts; it
    // is ready when clangd has background-indexed every translation unit the
    // database registers. The 180-second default expired on libuv with 62 of
    // them still indexing, the routing layer fell back as it should, and the
    // row lost the strict provenance it exists to prove.
    //
    // How long readiness actually takes has never been observed: no C or C++
    // row has ever reached it. The only datum is a lower bound — 180 seconds
    // was not enough, with 62 units left — and the rate it implies puts the
    // remainder near two more minutes. Ten is that with room, not a measured
    // requirement.
    //
    // These are per-refresh ceilings, and the strict lifecycle issues nine
    // refreshes, so they do not bound the row: nine cold waits would exceed
    // the job timeout on their own and be killed by it without a diagnosis.
    // What makes that remote rather than likely is that only the first
    // refresh indexes from nothing; the rest are incremental against a warm
    // database. The numbers are chosen so one cold index fits comfortably and
    // a producer that never becomes ready still fails its row rather than
    // hanging it — not so that every pathological path stays inside the job.
    // Readiness now covers more than indexing. The pinned producer publishes
    // each completed body to disk while it is in hand, so a snapshot can name
    // it instead of carrying it through the pipe -- and one libuv unit is 98
    // MiB of it. That work used to happen when a page was requested, after
    // this window had closed; it now happens inside it.
    //
    // Ten minutes was sized for a window covering indexing alone, and at two
    // workers it left forty of libuv's 242 units unfinished once publishing
    // joined them. Twenty is the same window sized for what it now contains.
    // It is a ceiling on the wait, not a target -- the walk after it is what
    // publishing exists to make cheap, and that is the number worth watching.
    readyTimeoutMs: 1_200_000,
    timeoutMs: 300_000,
    requiredCapabilities: [
      "coverage",
      "diagnostics",
      "diskDigests",
      "incremental",
      "sourceDigests",
      "universe",
      "unresolved",
    ],
    // The same pinned producer contract as the C++ row retains semantic
    // enclosing symbols, exact ranges and TU/configuration identity.
    semanticEdges: [
      "contains",
      "exports",
      "imports",
      "calls",
      "accesses",
      "type_ref",
      "references",
    ],
    crossFileEdge: "references",
    representativeEdges: [
      { kind: "calls", from: "processCommand", to: "lookupCommand" },
      { kind: "calls", from: "processCommand", to: "call" },
      { kind: "accesses", from: "processCommand", to: "server" },
      { kind: "type_ref", from: "processCommand", to: "client" },
    ],
    semanticLimitation:
      "The native Clang lane retains exact TU/configuration facts, while calls, instantiation, exports, implements and dispatch stay explicitly partial and C/C++ have no decorates, renders or tests family.",
    // C and C++ share the same atomic, canonical generation boundary.
    lifecycle: {
      sourceFile: "src/server.c",
      editSuffix: "\n// samchon-graph lifecycle edit\n",
      createFile: "src/samchon_graph_experiment.c",
      renamedFile: "src/samchon_graph_experiment_renamed.c",
      createText:
        "int samchonGraphExperiment(void) { return 0; }\n",
      createdSymbol: "samchonGraphExperiment",
      // The database itself, because that is what this producer reads. Breaking
      // CMakeLists would leave an already-generated database untouched and test
      // nothing.
      buildFile: "compile_commands.json",
      compilationDatabase: "compile_commands.json",
      failureFile: "compile_commands.json",
      failureSuffix: "\n[ not json",
      // The C and C++ slices share the same strict rejection boundary.
      failurePolicy: "reject",
      noopPerformance: {
        samples: 20,
        p95MaxMs: 250,
      },
    },
    minNodes: 1,
    minEdges: 1,
  },
  {
    language: "java",
    // Conformance repeats a full compiler build for every lifecycle transition.
    // Use scip-java's own pinned Maven fixture for that contract; Gson remains
    // the separate large-corpus timing proof.
    repository: "https://github.com/samchon/scip-java.git",
    commit: "fefb1bfb2e3fac90cd90f64fc07cc57fb533b49a",
    projectRoot: "scip-java/src/test/resources/fixtures/maven/basic",
    // The producer and the corpus are one checkout on purpose. The fixture is
    // the producer's own Maven project, so a pin that named a different
    // revision for each would measure a plugin against a build it was never
    // tested with.
    producerRepository: "https://github.com/samchon/scip-java.git",
    producerCommit: "fefb1bfb2e3fac90cd90f64fc07cc57fb533b49a",
    jdtProducerRepository: "https://github.com/samchon/eclipse.jdt.ls.git",
    jdtProducerCommit: "0d55a6c13d14e0d0466eeb021920349b3d0c6d35",
    jdtProducerTree: "18937e87ae9b42098100b398fde8cfb87f4c9b7c",
    nativeBaseline: {
      kind: "shell",
      command: "mvn -q test-compile",
      warmup: true,
      clean: ["target"],
    },
    strictProvider: "javac-graph",
    strictAuthority: "compiler",
    // The launcher and the producer are two names. `scip-java` is the command
    // this lane runs; the thing inside it that wrote the graph is the javac
    // plugin, and the artifact identifies itself by that. Asserting the
    // launcher's name here would go green for any future launcher that shipped
    // a different writer under the same command.
    strictTool: "scip-java-javac-graph",
    requiredCapabilities: [
      "coverage",
      "diskDigests",
      "incremental",
      "sourceDigests",
      "universe",
      "unresolved",
    ],
    // The pinned fixture is two empty classes, so containment is the only
    // family its cold generation can truthfully carry. The lifecycle below
    // creates the one cross-file relationship this row proves, and the runner
    // counts that transition rather than pre-editing the pinned baseline.
    semanticEdges: ["contains", "instantiates"],
    crossFileEdge: "instantiates",
    lifecycle: {
      sourceFile: "src/main/java/com/Example.java",
      editSuffix: "\n// samchon-graph lifecycle edit\n",
      createFile: "src/main/java/com/SamchonGraphExperiment.java",
      renamedFile:
        "src/main/java/com/SamchonGraphExperimentRenamed.java",
      createText:
        "package com;\n\npublic final class SamchonGraphExperiment {\n    public static Example samchonGraphExperiment() {\n        return new Example();\n    }\n}\n",
      renamedText:
        "package com;\n\npublic final class SamchonGraphExperimentRenamed {\n    public static Example samchonGraphExperiment() {\n        return new Example();\n    }\n}\n",
      createdSymbol: "samchonGraphExperiment",
      // `new Example()` resolves to two facts javac owns: a call of the
      // constructor and an instantiation of the class. The class is the
      // endpoint declared in another file, so it is the one that proves the
      // route crosses a compilation unit.
      createdEdge: {
        kind: "instantiates",
        from: "samchonGraphExperiment",
        to: "Example",
        crossFile: true,
      },
      buildFile: "pom.xml",
      failureFile: "pom.xml",
      failureSuffix: "\n<not-closed",
      failurePolicy: "reject",
      // On a reproduction failure, expose the exact normalized compiler input
      // that moved rather than only the public target-universe digest.
      regenerationEvidenceRoot: "target/scip-targetroot",
    },
    minNodes: 1,
    minEdges: 0,
  },
  {
    // serilog has a root .sln, which csharp-ls needs to load a project context;
    // the dotnet/samples monorepo has none and yields zero symbols.
    language: "csharp",
    repository: "https://github.com/serilog/serilog.git",
    commit: "07d39cfb2928076ecd902a61d295f90d74fe1fa5",
    // Uncapped, because scip-dotnet refuses a cap: a SCIP indexer publishes a
    // whole-workspace artifact and has no bounded mode, so a capped row is a row
    // it declines to serve.
    strictProvider: "scip-dotnet",
    strictAuthority: "semantic-index",
    strictTool: "scip-dotnet",
    requiredCapabilities: ["universe", "diskDigests"],
    // Declarations, but no edge family. scip-dotnet 0.2.14 writes occurrence
    // ranges without enclosing_range, SymbolInformation without
    // enclosing_symbol, and no type-definition relationship. The common
    // adapter can therefore publish compiler-resolved declarations but cannot
    // ground a reference origin or either of its other common SCIP families.
    semanticEdges: [],
    semanticLimitation:
      "scip-dotnet 0.2.14 emits no occurrence enclosing_range, SymbolInformation.enclosing_symbol, or type-definition relationship, so its semantic declarations carry no provable graph edge family",
    lifecycle: {
      sourceFile: "src/Serilog/Log.cs",
      editSuffix: "\n// samchon-graph lifecycle edit\n",
      createFile: "src/Serilog/SamchonGraphExperiment.cs",
      renamedFile: "src/Serilog/SamchonGraphExperimentRenamed.cs",
      createText:
        "namespace Serilog;\n\ninternal static class SamchonGraphExperiment\n{\n    internal static string Run() => \"strict-lifecycle\";\n}\n",
      createdSymbol: "SamchonGraphExperiment",
      buildFile: "src/Serilog/Serilog.csproj",
      failureFile: "src/Serilog/Serilog.csproj",
      failureSuffix: "\n<NotClosed>",
      // scip-dotnet 0.2.14 writes the index before it reads and logs
      // MSBuildWorkspace failures, then returns zero. The malformed project is
      // therefore not a fail-closed boundary for this producer.
      failurePolicy: "published",
      failureLimitation:
        "scip-dotnet 0.2.14 logs MSBuildWorkspace failures only after writing the index and exits successfully, so a malformed C# project file publishes a degraded generation instead of rejecting it",
    },
    minNodes: 1,
    minEdges: 0,
    // The upstream solution's perf/AOT entries make csharp-ls return no symbols.
    // Keep the product and main test projects so experiments retain both the
    // runtime graph and its test anchors without loading those broken entries.
    prepare:
      "dotnet new sln -n Serilog --format sln --force && dotnet sln Serilog.sln add src/Serilog/Serilog.csproj test/Serilog.Tests/Serilog.Tests.csproj",
  },
  {
    language: "kotlin",
    // The producer's exact Kotlin 2.3.20 fixture keeps ten clean lifecycle
    // builds bounded and exercises the same compiler minor as Koin. Language
    // setup builds the producer from this same commit and supplies one verified
    // Gradle distribution because the fixture intentionally carries no wrapper.
    repository: "https://github.com/scip-code/scip-java.git",
    commit: "e940c1889767a81347387067a375320dc6f5d83e",
    projectRoot:
      "scip-java/src/test/resources/fixtures/gradle/kotlin2",
    strictProvider: "scip-kotlinc",
    strictAuthority: "semantic-index",
    strictTool: "scip-java",
    requiredCapabilities: ["universe", "diskDigests"],
    semanticEdges: ["references"],
    crossFileEdge: "references",
    // This source snapshot and its setup manifest pin the plugin build to Kotlin
    // 2.3.20. scip-java still does not publish the compiler revision selected by
    // the indexed build itself, so the empty runtime field remains explicit.
    compilerLimitation:
      "scip-java e940c1889767a81347387067a375320dc6f5d83e is built with Kotlin 2.3.20 but does not expose the compiler revision selected by the indexed Gradle build, so runtime compiler provenance cannot name it without guessing",
    lifecycle: {
      sourceFile: "src/main/kotlin/foo/Example.kt",
      editSuffix: "\n// samchon-graph lifecycle edit\n",
      createFile: "src/main/kotlin/foo/SamchonGraphExperiment.kt",
      renamedFile:
        "src/main/kotlin/foo/SamchonGraphExperimentRenamed.kt",
      createText:
        "package foo\n\nfun samchonGraphExperiment(): Example = Example\n",
      createdSymbol: "samchonGraphExperiment",
      createdEdge: {
        kind: "references",
        from: "samchonGraphExperiment",
        to: "Example",
        crossFile: true,
      },
      buildFile: "build.gradle",
      failureFile: "build.gradle",
      failureSuffix: "\n}\n",
      failurePolicy: "reject",
    },
    minNodes: 1,
    minEdges: 0,
  },
  {
    language: "swift",
    repository: "https://github.com/apple/swift-argument-parser.git",
    commit: "2f77f2fccb6e84fecff338c37b199e33e7dfd119",
    maxFiles: 120,
    minNodes: 1,
    minEdges: 1,
    feasibilityBlocked:
      "swift build emits an index store during an ordinary debug build and its records carry RelChild, but the on-disk format is toolchain-internal, versioned v5, with no third-party stability claim and no binary specification; reading it requires a compiled Swift program linking IndexStoreDB, which does not exist yet",
  },
  {
    language: "scala",
    repository: "https://github.com/scala/scala3-example-project.git",
    commit: "a327177a2bc8ef9c499726d038e56694d6f7cddb",
    maxFiles: 120,
    minNodes: 1,
    minEdges: 1,
    feasibilityBlocked:
      "scip-java is a Java and Kotlin indexer by its own README, supported-language table, and source tree, so registering it for Scala made an installed scip-java displace the real Scala language server with a producer that cannot index the language; a SemanticDB or TASTy channel through BSP is unwritten work",
  },
  {
    language: "zig",
    repository: "https://github.com/Hejsil/zig-clap.git",
    commit: "e91d66b1abba2024cd2e816426f14d233d3dad9a",
    maxFiles: 120,
    minNodes: 1,
    minEdges: 0,
    feasibilityBlocked:
      "zig build-obj -femit-docs emits a main.wasm analyzer whose namespace walk reaches every declaration but exposes no reference or callee, because the analysis runs over pre-semantic ZIR; a provider built on it could claim containment while displacing the ZLS lane that does answer references, so registering it would trade coverage for strictness",
  },
  {
    language: "python",
    repository: "https://github.com/pallets/click.git",
    commit: "cfa01eeb7894a408af70b29d28c0b24f8680f9fb",
    strictProvider: "scip-python",
    strictAuthority: "semantic-index",
    strictTool: "scip-python",
    requiredCapabilities: ["universe", "diskDigests"],
    // The common adapter derives `contains` from SCIP `enclosing_symbol`, and
    // scip-python 0.6.6 never populates it: all ten `SymbolInformation`
    // construction sites in the pinned bundle pass `symbol`, `documentation`,
    // and `relationships` only, and the field appears nowhere but the generated
    // protobuf accessors. Expecting the family here would assert a fact the
    // producer cannot emit, so the row claims what it proves and states the gap.
    semanticEdges: ["references"],
    semanticLimitation:
      "scip-python 0.6.6 emits no SymbolInformation.enclosing_symbol, so symbol containment cannot be proven from its index and `contains` is omitted rather than inferred",
    crossFileEdge: "references",
    lifecycle: {
      sourceFile: "src/click/core.py",
      editSuffix: "\n# samchon-graph lifecycle edit\n",
      createFile: "src/click/samchon_graph_experiment.py",
      renamedFile: "src/click/samchon_graph_experiment_renamed.py",
      createText:
        'def samchonGraphExperiment() -> str:\n    return "strict-lifecycle"\n',
      createdSymbol: "samchonGraphExperiment",
      buildFile: "pyproject.toml",
      failureFile: "pyproject.toml",
      failureSuffix: "\n[malformed",
      // scip-python 0.6.6 reads `pyproject.toml` through Pyright's
      // `_attemptParseFile`, which retries the parse six times, logs
      // `Config file "..." could not be parsed`, and returns `undefined`.
      // Configuration then falls through to defaults and the index is written
      // and published with exit code 0. On the pinned Click fixture the
      // normalized source and fact planes remain unchanged; only the declared
      // configuration coordinate moves. This is tolerated upstream behavior,
      // not rejection, a diagnostic, or proof of a changed analyzed program.
      failurePolicy: "tolerated",
      failureLimitation:
        "scip-python 0.6.6 recovers from a malformed pyproject.toml by falling back to Pyright defaults and exits successfully; on the pinned Click fixture its normalized source and fact planes remain unchanged, so a broken Python build configuration is neither rejected nor diagnosed",
    },
  },
  {
    language: "ruby",
    // scip-ruby is Sorbet-based; its own pinned configuration fixture is the
    // smallest real project that proves source transitions and the producer's
    // fail-closed config parser. Sinatra remains the timing corpus.
    repository: "https://github.com/sourcegraph/scip-ruby.git",
    commit: "319524058d87cfe5992cfb9eec12ec70fc91213d",
    projectRoot: "test/cli/config-file",
    strictProvider: "scip-ruby",
    strictAuthority: "semantic-index",
    strictTool: "scip-ruby",
    requiredCapabilities: ["universe", "diskDigests"],
    semanticEdges: [],
    semanticLimitation:
      "scip-ruby 0.4.7 emits no occurrence enclosing_range, SymbolInformation.enclosing_symbol, or type-definition relationship, so its semantic declarations carry no provable graph edge family",
    lifecycle: {
      sourceFile: "config-file.rb",
      editSuffix: "\n# samchon-graph lifecycle edit\n",
      createFile: "samchon_graph_experiment.rb",
      renamedFile: "samchon_graph_experiment_renamed.rb",
      createText: "class SamchonGraphExperiment\nend\n",
      createdSymbol: "SamchonGraphExperiment",
      buildFile: "sorbet/config",
      failureFile: "sorbet/config",
      failureSuffix: "\n--definitely-not-a-sorbet-option\n",
      failurePolicy: "reject",
    },
    minNodes: 1,
    minEdges: 0,
  },
  {
    language: "php",
    // The pinned upstream project carries its lockfile and the exact cwd/vendor
    // fix used by the benchmark fixture. Composer does not expose a root
    // package's own binary in vendor/bin, so preparation links that tracked
    // binary at the project-local location the provider contract resolves.
    repository: "https://github.com/davidrjenni/scip-php.git",
    commit: "71a5b117ec4c5dd2af302e363410e604e5df309e",
    projectRoot: ".",
    prepare:
      "composer install --no-interaction --no-progress && ln -sf ../../bin/scip-php vendor/bin/scip-php",
    strictProvider: "scip-php",
    strictAuthority: "semantic-index",
    strictTool: "scip-php",
    requiredCapabilities: ["universe", "diskDigests"],
    semanticEdges: [],
    semanticLimitation:
      "scip-php at 71a5b117 emits no occurrence enclosing_range, SymbolInformation.enclosing_symbol, or type-definition relationship, so its semantic declarations carry no provable graph edge family",
    lifecycle: {
      sourceFile: "src/Indexer.php",
      editSuffix: "\n// samchon-graph lifecycle edit\n",
      createFile: "src/SamchonGraphExperiment.php",
      renamedFile: "src/SamchonGraphExperimentRenamed.php",
      createText:
        "<?php\n\ndeclare(strict_types=1);\n\nnamespace ScipPhp;\n\nfinal class SamchonGraphExperiment {}\n",
      createdSymbol: "SamchonGraphExperiment",
      renamedText:
        "<?php\n\ndeclare(strict_types=1);\n\nnamespace ScipPhp;\n\nfinal class SamchonGraphExperimentRenamed {}\n",
      renamedSymbol: "SamchonGraphExperimentRenamed",
      buildFile: "composer.json",
      failureFile: "composer.json",
      failureSuffix: "\n{ not json",
      failurePolicy: "reject",
    },
    minNodes: 1,
    minEdges: 0,
  },
  {
    language: "lua",
    // The benchmark fork, because it carries the `.luarc.json` the provider
    // declares as a build input and upstream does not. A strict row has to be
    // able to move a build configuration, and there was none here to move.
    repository: "https://github.com/samchon/graph-benchmark-lualine.git",
    commit: "fa111072655a5c669f466aa36c7dbd34e4f7012c",
    // No `maxFiles`: `samchon-graph-lua` refuses a cap outright. It exports the
    // whole workspace in one pass and has no bounded mode, so honouring a limit
    // would mean indexing everything and then deleting facts — which costs what
    // the cap was meant to save and leaves missing edges indistinguishable from
    // absent ones. Every capped row in this catalog is a row no strict provider
    // can serve, which is why the four that declare one all run uncapped.
    strictProvider: "samchon-graph-lua",
    strictAuthority: "analyzer",
    strictTool: "lua-language-server",
    requiredCapabilities: ["universe", "diskDigests"],
    // `references` and nothing else. `vm.getRefs` answers "where else does this
    // symbol appear", and the exporter cannot tell a call from a read or an
    // assignment, so declaring `calls` would be inference dressed as a fact.
    semanticEdges: ["references"],
    semanticLimitation:
      "lua-language-server's vm.getRefs reports occurrences without distinguishing a call from a read or an assignment, so samchon-graph-lua proves references and no narrower family",
    crossFileEdge: "references",
    lifecycle: {
      sourceFile: "lua/lualine/config.lua",
      editSuffix: "\n-- samchon-graph lifecycle edit\n",
      createFile: "lua/lualine/samchon_graph_experiment.lua",
      renamedFile: "lua/lualine/samchon_graph_experiment_renamed.lua",
      createText:
        'local M = {}\n\nfunction M.samchonGraphExperiment()\n  return "strict-lifecycle"\nend\n\nreturn M\n',
      createdSymbol: "samchonGraphExperiment",
      // The build input the fork now carries. Before it, this project declared
      // no file the provider watches, so a moving build configuration was
      // untestable rather than merely untested.
      buildFile: ".luarc.json",
      failureFile: ".luarc.json",
      failureSuffix: "\n{ not json",
      // lua-language-server reads a malformed `.luarc.json`, logs it, and
      // carries on with defaults rather than refusing to start — so the export
      // still lands and the provider still publishes.
      //
      // This row used to claim the defaults changed that publication, on the
      // reading that the corpus selects LuaJIT and a workspace library. The
      // claim was wrong and it went red proving it: at 3.19.0, the release
      // every green run of this lane used, the malformed configuration leaves
      // every fact plane and the source manifest byte-identical and moves only
      // the build universe. Tolerated is what that is.
      failurePolicy: "tolerated",
      failureLimitation:
        "lua-language-server 3.19.0 recovers from a malformed .luarc.json with default settings and exits successfully; on the pinned lualine fixture its normalized source and fact planes remain unchanged, so a broken Lua workspace configuration is neither rejected nor diagnosed",
    },
    minNodes: 1,
    minEdges: 0,
  },
  {
    language: "dart",
    // scip_dart's own Dart-3 snapshot is a real resolved package small enough
    // for repeated whole-project analysis. dart-lang/http remains the timing
    // corpus whose generic per-symbol lane exposed #151.
    repository: "https://github.com/Workiva/scip-dart.git",
    commit: "44d7f8af1f6b2e40e21cea5438d0651080994f8d",
    projectRoot: "snapshots/input/dart3-features",
    prepare: "dart pub get",
    strictProvider: "scip-dart",
    strictAuthority: "semantic-index",
    strictTool: "scip-dart",
    requiredCapabilities: ["universe", "diskDigests"],
    semanticEdges: [],
    semanticLimitation:
      "scip_dart 1.6.2 emits no occurrence enclosing_range, SymbolInformation.enclosing_symbol, or type-definition relationship, so its semantic declarations carry no provable graph edge family",
    lifecycle: {
      sourceFile: "lib/main.dart",
      editSuffix: "\n// samchon-graph lifecycle edit\n",
      createFile: "lib/samchon_graph_experiment.dart",
      renamedFile: "lib/samchon_graph_experiment_renamed.dart",
      createText: "class SamchonGraphExperiment {}\n",
      createdSymbol: "SamchonGraphExperiment",
      buildFile: "pubspec.yaml",
      failureFile: "pubspec.yaml",
      failureSuffix: "\ninvalid: [\n",
      failurePolicy: "reject",
    },
    minNodes: 1,
    minEdges: 0,
  },
];

export const findExperiment = (language) => {
  const found = LANGUAGE_EXPERIMENTS.find((experiment) => experiment.language === language);
  if (found === undefined) throw new Error(`Unknown experiment language: ${language}`);
  return found;
};
