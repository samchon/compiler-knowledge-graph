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
    strictProvider: "rust-analyzer-scip",
    strictAuthority: "semantic-index",
    strictTool: "rust-analyzer",
    requiredCapabilities: ["universe", "diskDigests"],
    semanticEdges: ["contains", "references"],
    crossFileEdge: "references",
    lifecycle: {
      sourceFile: "src/lib.rs",
      editSuffix: "\n// samchon-graph lifecycle edit\n",
      createFile: "examples/samchon_graph_experiment.rs",
      renamedFile: "examples/samchon_graph_experiment_renamed.rs",
      createText:
        'const samchonGraphExperiment: &str = "strict-lifecycle";\n\nfn main() { println!("{samchonGraphExperiment}"); }\n',
      createdSymbol: "samchonGraphExperiment",
      buildFile: "Cargo.toml",
      // Stock rust-analyzer's SCIP command recovers from malformed Rust and
      // emits no diagnostics. A malformed Cargo manifest is the real strict
      // failure boundary that the semantic-index authority can prove.
      failureFile: "Cargo.toml",
      failureSuffix: "\n[malformed",
      failurePolicy: "reject",
    },
  },
  {
    language: "cpp",
    repository: "https://github.com/fmtlib/fmt.git",
    commit: "bcaa44d05579c75a83571821faee7acf6a9a0d55",
    // Uncapped: scip-clang publishes a whole-workspace artifact and refuses a
    // file cap, so a capped row is one it declines to serve.
    //
    // The compilation database is what scip-clang consumes and what a CMake
    // project has to be configured to produce; nothing is compiled by this.
    prepare: "cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
    strictProvider: "scip-clang",
    strictAuthority: "semantic-index",
    strictTool: "scip-clang",
    requiredCapabilities: ["universe", "diskDigests"],
    // Declarations only. scip-clang 0.4.0 writes range/symbol/roles on
    // occurrences, no enclosing_range or enclosing_symbol, and no
    // is_type_definition relationship. The common SCIP adapter therefore has
    // no grounded origin or typed relationship for an edge.
    semanticEdges: [],
    semanticLimitation:
      "scip-clang 0.4.0 emits no occurrence enclosing_range, SymbolInformation.enclosing_symbol, or type-definition relationship, so its semantic declarations carry no provable graph edge family",
    // scip-clang 0.4.0's own CLI states both halves of this: `--deterministic`
    // is documented as "Does not support deterministic work scheduling yet",
    // and `--print-statistics-path` warns that "non-determinism may affect the
    // number of files skipped by individual indexing jobs". The driver gives
    // each well-behaved header to one translation unit, and which one wins
    // depends on the schedule — so the file set moves, and the manifest with it.
    //
    // Two ways of buying it back were tried and withdrawn. `--jobs=1` removed
    // the variance by serializing the compiler and cost 39x on the redis
    // corpus, which is not a trade a strict provider can make: the point of the
    // lane is to be faster than the fallback. `--deterministic` alone then held
    // this lane above forty-three minutes where it had run in under eleven, and
    // its generations still did not reproduce. The limitation is declared
    // instead.
    regenerationLimitation:
      "scip-clang 0.4.0 does not schedule its indexing jobs deterministically, so regenerating an unchanged project can skip a different set of headers; both the source manifest and the fact set can therefore move, because the manifest lists the files the producer reported",
    lifecycle: {
      sourceFile: "src/format.cc",
      editSuffix: "\n// samchon-graph lifecycle edit\n",
      createFile: "samchon_graph_experiment.cc",
      renamedFile: "samchon_graph_experiment_renamed.cc",
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
      // A compilation database that will not parse makes scip-clang decline
      // before publication. The resident records that reason and serves its
      // documented fallback until the database is repaired.
      failurePolicy: "fallback",
      failureLimitation:
        "a malformed compilation database makes scip-clang decline without provenance, so the resident publishes an explicitly warned generic/static fallback until the project input is repaired",
    },
    minNodes: 1,
    minEdges: 0,
  },
  {
    language: "c",
    repository: "https://github.com/libuv/libuv.git",
    commit: "9d51562c10be60bc1126a3d71803b1038f4fbb7e",
    // Uncapped: scip-clang publishes a whole-workspace artifact and refuses a
    // file cap, so a capped row is one it declines to serve.
    //
    // The compilation database is what scip-clang consumes and what a CMake
    // project has to be configured to produce; nothing is compiled by this.
    prepare: "cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
    strictProvider: "scip-clang",
    strictAuthority: "semantic-index",
    strictTool: "scip-clang",
    requiredCapabilities: ["universe", "diskDigests"],
    // The same pinned producer contract as the C++ row: semantic declarations
    // are real, but none of the common adapter's edge-grounding fields exists.
    semanticEdges: [],
    semanticLimitation:
      "scip-clang 0.4.0 emits no occurrence enclosing_range, SymbolInformation.enclosing_symbol, or type-definition relationship, so its semantic declarations carry no provable graph edge family",
    // The C and C++ slices share one producer, so they share its scheduling
    // boundary as well; see the C++ row for the upstream wording.
    regenerationLimitation:
      "scip-clang 0.4.0 does not schedule its indexing jobs deterministically, so regenerating an unchanged project can skip a different set of headers; both the source manifest and the fact set can therefore move, because the manifest lists the files the producer reported",
    lifecycle: {
      sourceFile: "src/uv-common.c",
      editSuffix: "\n// samchon-graph lifecycle edit\n",
      createFile: "samchon_graph_experiment.c",
      renamedFile: "samchon_graph_experiment_renamed.c",
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
      // The C and C++ slices share the same strict selection boundary.
      failurePolicy: "fallback",
      failureLimitation:
        "a malformed compilation database makes scip-clang decline without provenance, so the resident publishes an explicitly warned generic/static fallback until the project input is repaired",
    },
    minNodes: 1,
    minEdges: 0,
  },
  {
    language: "java",
    // Conformance repeats a full compiler build for every lifecycle transition.
    // Use scip-java's own pinned Maven fixture for that contract; Gson remains
    // the separate large-corpus timing proof.
    repository: "https://github.com/scip-code/scip-java.git",
    commit: "a609ba1adaf630292df5a73ec4ba06c170caba93",
    projectRoot: "scip-java/src/test/resources/fixtures/maven/basic",
    strictProvider: "scip-java",
    strictAuthority: "semantic-index",
    strictTool: "scip-java",
    requiredCapabilities: ["universe", "diskDigests"],
    semanticEdges: ["references"],
    crossFileEdge: "references",
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
      createdEdge: {
        kind: "references",
        from: "samchonGraphExperiment",
        to: "Example",
        crossFile: true,
      },
      buildFile: "pom.xml",
      failureFile: "pom.xml",
      failureSuffix: "\n<not-closed",
      failurePolicy: "reject",
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
    strictProvider: "scip-java",
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
      // still lands and the provider still publishes. This corpus selects
      // LuaJIT and a workspace library, so the default settings change the
      // published generation rather than leaving it untouched.
      failurePolicy: "published",
      failureLimitation:
        "lua-language-server recovers from a malformed .luarc.json with default settings and publishes a changed generation, so a broken Lua workspace configuration is not a fail-closed boundary for this producer",
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
