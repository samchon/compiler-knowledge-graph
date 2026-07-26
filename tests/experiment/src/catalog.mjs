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
    maxFiles: 120,
    minNodes: 1,
    minEdges: 1,
  },
  {
    language: "c",
    repository: "https://github.com/libuv/libuv.git",
    commit: "9d51562c10be60bc1126a3d71803b1038f4fbb7e",
    maxFiles: 120,
    minNodes: 1,
    minEdges: 1,
  },
  {
    language: "java",
    repository: "https://github.com/google/gson.git",
    commit: "165ca7d78ad99416b0b06495183c238ab7bb77bf",
    maxFiles: 120,
    minNodes: 1,
    minEdges: 0,
  },
  {
    // serilog has a root .sln, which csharp-ls needs to load a project context;
    // the dotnet/samples monorepo has none and yields zero symbols.
    language: "csharp",
    repository: "https://github.com/serilog/serilog.git",
    commit: "07d39cfb2928076ecd902a61d295f90d74fe1fa5",
    maxFiles: 120,
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
    repository: "https://github.com/Kotlin/kotlin-koans.git",
    commit: "5935a3cab5293bd7967b1bf1f4d2ae713f9e0e9e",
    maxFiles: 120,
    minNodes: 1,
    minEdges: 1,
  },
  {
    language: "swift",
    repository: "https://github.com/apple/swift-argument-parser.git",
    commit: "2f77f2fccb6e84fecff338c37b199e33e7dfd119",
    maxFiles: 120,
    minNodes: 1,
    minEdges: 1,
  },
  {
    language: "scala",
    repository: "https://github.com/scala/scala3-example-project.git",
    commit: "a327177a2bc8ef9c499726d038e56694d6f7cddb",
    maxFiles: 120,
    minNodes: 1,
    minEdges: 1,
  },
  {
    language: "zig",
    repository: "https://github.com/Hejsil/zig-clap.git",
    commit: "e91d66b1abba2024cd2e816426f14d233d3dad9a",
    maxFiles: 120,
    minNodes: 1,
    minEdges: 0,
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
      // and published with exit code 0. The bundle constructs no SCIP
      // `Diagnostic` either, so neither `reject` nor `diagnostic` describes
      // this producer; claiming one would pin the harness to a fiction.
      failurePolicy: "tolerated",
      failureLimitation:
        "scip-python 0.6.6 recovers from a malformed pyproject.toml and publishes an index; a broken Python build configuration is not a fail-closed boundary for this producer",
    },
  },
  {
    language: "ruby",
    repository: "https://github.com/sinatra/sinatra.git",
    commit: "cb22afd7902b566b6eaba6c4ea89739494a65d12",
    maxFiles: 120,
    minNodes: 1,
    minEdges: 0,
    // ruby-lsp composes a bundle from the project's Gemfile; the dependencies
    // must be installed or the server exits at launch. Vendor the bundle —
    // an unprivileged install into the system gem path is denied.
    prepare: "bundle config set --local path vendor/bundle && bundle install",
  },
  {
    language: "php",
    repository: "https://github.com/slimphp/Slim.git",
    commit: "80900fb39cafce3ae53b18a2c4f642a122f03095",
    maxFiles: 120,
    minNodes: 1,
    minEdges: 0,
  },
  {
    language: "lua",
    repository: "https://github.com/nvim-lualine/lualine.nvim.git",
    commit: "221ce6b2d999187044529f49da6554a92f740a96",
    maxFiles: 120,
    minNodes: 1,
    minEdges: 0,
  },
  {
    language: "dart",
    repository: "https://github.com/dart-lang/http.git",
    commit: "49ddf11a1879e5eca84cef6ee0d7df07f6af2302",
    maxFiles: 120,
    minNodes: 1,
    minEdges: 0,
  },
];

export const findExperiment = (language) => {
  const found = LANGUAGE_EXPERIMENTS.find((experiment) => experiment.language === language);
  if (found === undefined) throw new Error(`Unknown experiment language: ${language}`);
  return found;
};
