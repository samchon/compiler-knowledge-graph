import path from "node:path";

// Cross-language benchmark corpus. The `dedicated` questions live in
// questions/<name>.md, taken verbatim from codegraph's evaluation suite
// (.claude/skills/agent-eval/corpus.json) and pinned by SHA-256 in
// questions/manifest.json (regenerate with graph/generate-manifest.mjs). The
// shared `common` onboarding question (questions/common.md) is asked against
// every repo.
//
// Coverage standard is codegraph's own: every supported language that appears
// in its suite is here, one repo each — 13 of the 16 registered languages.
// Scala and Zig are deliberately absent: codegraph has no dedicated utterance
// for them, and inventing one would break prompt provenance. Swift
// (Alamofire) is absent too: this host has no Swift toolchain, sourcekit-lsp
// ships only with the multi-GB Swift-for-Windows install, and an Apple-centric
// SwiftPM build is not guaranteed to index cleanly here.
//
// Each entry pins the exact `commit` measured (recorded 2026-07-08 from each
// repo's HEAD) so runs stay reproducible while upstreams move. The graph is
// never capped: no file limit, no reference limit, and no LSP timeout — a slow
// but correct language-server index is always waited out in full rather than
// truncated. `prepare` runs a one-off shell command in the checkout before
// indexing when a server needs it.
export const CORPUS = [
  {
    // A fork of excalidraw/excalidraw with `ttsc` (and its native TS7
    // runtime, @typescript/typescript-win32-x64) pinned as devDependencies
    // (github.com/samchon/ttsc-benchmark-excalidraw) so ttscserver resolves
    // and runs from the repo's own node_modules instead of depending on a
    // global install — otherwise a fresh clone falls back to the static
    // indexer, or ttscserver crashes outright without the native binary.
    name: "excalidraw",
    language: "typescript",
    url: "https://github.com/samchon/ttsc-benchmark-excalidraw.git",
    commit: "98a2730b197873d43fddbe3fad6f0812df84b451",
    preflight: preflightMinimums(1_000, 5_000, 3_000, 4),
  },
  {
    name: "gin",
    language: "go",
    url: "https://github.com/samchon/graph-benchmark-gin.git",
    commit: "34dac209ffb6ef85cc78c5d217bbb7ad001d68fd",
    preflight: preflightMinimums(500, 1_500, 800, 3),
  },
  {
    name: "flask",
    language: "python",
    url: "https://github.com/samchon/graph-benchmark-flask.git",
    commit: "36e4a824f340fdee7ed50937ba8e7f6bc7d17f81",
    preflight: preflightMinimums(500, 1_500, 800, 3),
  },
  {
    name: "tokio",
    language: "rust",
    url: "https://github.com/samchon/graph-benchmark-tokio.git",
    commit: "c4c6265a0746a79d4a2f3852f726aa0101f29fd3",
    preflight: preflightMinimums(3_000, 10_000, 5_000, 4),
  },
  {
    name: "gson",
    language: "java",
    url: "https://github.com/samchon/graph-benchmark-gson.git",
    // Pinned past a `.mvn/maven.config` selecting gson's own
    // `disable-error-prone` profile. scip-java runs the project's real Maven
    // build with a SemanticDB plugin attached, and under it javac rejects
    // gson's Error Prone compiler arguments outright — `invalid flag:
    // -XepExcludedPaths:...` — so the lane never reached its strict provider.
    //
    // Nothing was removed to fix it: that profile is gson's, activated on JDK
    // below 21, and the benchmark provisions 21 so it never fired. Selecting it
    // explicitly asks for a configuration the project already supports.
    // SemanticDB then introduces warnings under the project's independent
    // fail-on-warning setting, so the fork disables that failure through the
    // Maven compiler plugin's public user property. Maven reads both choices
    // from `.mvn/maven.config` unprompted, so no indexer learns a
    // project-specific flag.
    commit: "9ce132cb4f302d4ffa4fa4b0d93918da72188e90",
    preflight: preflightMinimums(1_000, 5_000, 3_000, 4),
  },
  {
    name: "redis",
    language: "c",
    url: "https://github.com/samchon/graph-benchmark-redis.git",
    commit: "6bf6224c3dad518329ddc893ef9c5d58dcbabdeb",
    preflight: preflightMinimums(3_000, 10_000, 5_000, 4),
    // A Makefile emits no compilation database, and scip-clang declines without
    // one. bear records the compiler invocations as the build runs, which means
    // an actual build rather than leveldb's configure — minutes of job time, but
    // none of the measured cell, since only the dump invocation is timed.
    //
    // The build's own outputs are covered by redis's .gitignore; the database it
    // produces is not, so it is declared here rather than assumed.
    prepare: "bear -- make -j$(nproc)",
    prepareIgnores: ["compile_commands.json", ".cache/"],
    prepareOptional: true,
  },
  {
    // codegraph's cpp pick (nlohmann/json) is a single-header library — it
    // yields ~27 nodes / 0 edges, a degenerate graph target. Substitute
    // leveldb, a real multi-file C++ project, and note the deviation: the
    // question is repo-appropriate rather than codegraph-verbatim.
    name: "leveldb",
    language: "cpp",
    url: "https://github.com/samchon/graph-benchmark-leveldb.git",
    commit: "7ee830d02b623e8ffe0b95d59a74db1e58da04c5",
    preflight: preflightMinimums(500, 1_500, 800, 3),
    // scip-clang consumes a compilation database and declines without one, so
    // this lane could only ever reach the fallback. CMake writes one during
    // configure — nothing is compiled — and `build/compile_commands.json` is
    // already a path the provider looks in, so no provider change is involved.
    //
    // Tests and benchmarks off because they `add_subdirectory` into
    // `third_party/googletest` and `third_party/benchmark`, which are git
    // submodules the corpus clone does not fetch — configure died there and,
    // being optional, said so only in the log. What is wanted here is leveldb's
    // own translation units, which those options do not touch.
    //
    // Optional: without it the lane measures what it measures today rather than
    // not measuring at all.
    prepare:
      "cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DLEVELDB_BUILD_TESTS=OFF -DLEVELDB_BUILD_BENCHMARKS=OFF",
    prepareIgnores: ["build/", ".cache/"],
    prepareOptional: true,
  },
  {
    name: "sinatra",
    language: "ruby",
    url: "https://github.com/samchon/graph-benchmark-sinatra.git",
    commit: "5236d3459b8b9015e5ce21ddd0c6beb0db4081d4",
    preflight: preflightMinimums(500, 1_500, 800, 3),
    // ruby-lsp composes a bundle from the project's Gemfile; install it into a
    // vendored path first.
    prepare: "bundle config set --local path vendor/bundle && bundle install",
    prepareMarker: "vendor/bundle",
  },
  {
    name: "slim",
    language: "php",
    url: "https://github.com/samchon/graph-benchmark-slim.git",
    commit: "101e24a694c395d7bd403cca51cbc53dfe78aa8b",
    preflight: preflightMinimums(1_000, 3_000, 1_500, 3),
    // scip-php goes inside the project it indexes — `composer require --dev`
    // then `vendor/bin/scip-php` — because it resolves symbols through the
    // project's own autoloader. A global copy computes its vendor directory
    // somewhere the tool does not look and refuses to start.
    //
    // The dependency is therefore carried by the pinned fork rather than added
    // here: composer.json is tracked, so adding it at measurement time would
    // dirty the very tree this harness asserts. What remains is installing it,
    // which writes only `vendor/` — already ignored by this project.
    //
    // Optional because scip-php pins nikic/php-parser ^4 while some of slim's
    // own dev tooling reaches for ^5; if composer cannot satisfy both, the lane
    // measures what it measures today instead of not measuring.
    prepare: "composer install --no-interaction",
    prepareIgnores: ["vendor/"],
    prepareOptional: true,
  },
  {
    name: "serilog",
    language: "csharp",
    url: "https://github.com/samchon/graph-benchmark-serilog.git",
    commit: "6d9fc0b84e004418f2677b5961b9c8970349d0be",
    preflight: preflightMinimums(1_000, 5_000, 3_000, 4),
    // csharp-ls loads a project via Roslyn's in-process MSBuildWorkspace. The
    // full Serilog.sln (19 project/TFM entries including perf and AOT apps)
    // makes csharp-ls return zero document symbols, so the arm silently drops
    // to the static fallback with an empty language-server graph, even
    // though raw Roslyn opens the same solution fine. Build a benchmark-only
    // solution outside the checkout and pass it with csharp-ls --solution. The
    // product and main test projects (plus the latter's TestDummies project
    // reference) preserve the test anchors the common prompt asks for without
    // rewriting the tracked Serilog.sln seen by either benchmark arm.
    dotnetSolution: {
      name: "Serilog.Benchmark",
      projects: [
        "src/Serilog/Serilog.csproj",
        "test/Serilog.Tests/Serilog.Tests.csproj",
      ],
    },
  },
  {
    name: "koin",
    language: "kotlin",
    url: "https://github.com/samchon/graph-benchmark-koin.git",
    // Koin already declares its complete Google and Maven Central repository
    // set in settings and has no project-level repositories. The pinned fork
    // makes that centralized boundary explicit: otherwise scip-java's
    // defensive project-level Maven Central/Local injection takes precedence,
    // hides Google Maven, and makes released AndroidX dependencies look absent.
    commit: "9fbbdfb319bceeec4b13838bbe34cde48f2f3b05",
    preflight: preflightMinimums(1_000, 3_000, 1_500, 3),
    // koin keeps no build file at its checkout root — every module lives under
    // `projects/`, which is where its own build and its contributors work. An
    // indexer run at the root finds nothing to build and declines, which is
    // exactly what scip-java reported: "No build tool detected in workspace".
    //
    // The clone stays the git root, so the pinned tree and the cleanup are
    // unchanged; only the directory each tool is pointed at moves, and it moves
    // for every tool so the comparison stays one.
    indexRoot: "projects",
    // kotlin-language-server boots a JVM and imports the build via a Gradle
    // sync (kotlinLSPProjectDeps) before answering `initialize` at all; cold,
    // this took over ten minutes on a clean Gradle cache. With no timeout, that
    // cold start plus the Gradle sync is simply waited out. A warm Gradle cache
    // makes repeat runs fast. (JAVA_HOME is pointed at the provisioned JDK 21 by
    // lib.mjs.)
  },
  {
    name: "lualine",
    language: "lua",
    url: "https://github.com/samchon/graph-benchmark-lualine.git",
    commit: "fa111072655a5c669f466aa36c7dbd34e4f7012c",
    preflight: preflightMinimums(500, 1_500, 800, 3),
  },
  {
    // flutter's 6.5k-file monorepo made the Dart analysis server emit a
    // pathological ~500MB reference graph; dart-lang/http is a real,
    // focused multi-package HTTP library that indexes cleanly.
    name: "darthttp",
    language: "dart",
    url: "https://github.com/samchon/graph-benchmark-darthttp.git",
    commit: "5d94ef52582867e077bf41c3fa20fb8b1d1d834e",
    preflight: preflightMinimums(500, 1_500, 800, 3),
  },
];

function preflightMinimums(
  nodes,
  edges,
  semanticEdges,
  semanticEdgeKinds,
) {
  return { nodes, edges, semanticEdges, semanticEdgeKinds };
}

export const findCorpus = (name) => {
  const found = CORPUS.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`Unknown benchmark repo: ${name}`);
  return found;
};

/** Canonical fixture shape consumed by graph.mjs, run-suite, and index-time. */
export const PROJECTS = Object.fromEntries(
  CORPUS.map((entry) => [
    entry.name,
    {
      ...entry,
      repoName: entry.name,
      sourceRepo: entry.url,
      sourceBranch: entry.commit,
      fixtureBranch: entry.commit,
    },
  ]),
);

export function resolveWorkDir(repoRoot) {
  return (
    process.env.SAMCHON_GRAPH_BENCH_WORK ??
    path.resolve(repoRoot, "..", "graph-benchmark-work")
  );
}

export function projectDir(workDir, spec) {
  return path.join(
    workDir,
    `${spec.repoName ?? spec.name}@${spec.commit.slice(0, 12)}`,
  );
}
