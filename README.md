# `@samchon/graph`

![Logo](https://raw.githubusercontent.com/samchon/graph/master/assets/og.jpg)

[![GitHub license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/samchon/graph/blob/master/LICENSE) [![NPM Version](https://img.shields.io/npm/v/@samchon/graph.svg)](https://www.npmjs.com/package/@samchon/graph) [![NPM Downloads](https://img.shields.io/npm/dm/@samchon/graph.svg)](https://www.npmjs.com/package/@samchon/graph) [![Build Status](https://github.com/samchon/graph/workflows/test/badge.svg)](https://github.com/samchon/graph/actions?query=workflow%3Atest)

`@samchon/graph` is an MCP server that gives AI agents a code graph instead of source files.

It indexes a codebase in 16 languages into a graph of declarations and the relationships each selected provider can defend, then answers an agent's code questions from that index through a single tool. Registered strict providers have compiler, analyzer, or semantic-index authority and may decline a build; the ordinary language server and separately packaged `@samchon/graph-sitter` remain explicit lower-authority fallbacks.

Coding agents normally answer a code question by grepping the repository and reading file after file into context, and that reading is most of the token bill. The graph removes the need for it, and its own answers stay small in turn: they carry names, signatures, relationships, and source spans, never file bodies.

Since neither side of that exchange grows with the repository, the cost falls by about the same proportion in every situation, on every codebase — for an agent that trusts the graph result enough to stop there. codex/gpt-5.4-mini does; see the [Benchmark](#benchmark) section below for a harness where a model doesn't, and reads on top of the graph call anyway. That even distribution is what separates this from [`codegraph`](https://github.com/colbymchenry/codegraph) and [`serena`](https://github.com/oraios/serena) when it holds, and it shows directly in the chart below:

![Agent token cost — onboarding, per repository](https://raw.githubusercontent.com/samchon/graph/master/assets/benchmark-codex-gpt-5.4-mini-common.svg)

## Setup

### MCP server

```bash
npm install -D @samchon/graph
```

```json
{
  "mcpServers": {
    "samchon-graph": {
      "command": "npx",
      "args": ["-y", "@samchon/graph"]
    }
  }
}
```

Start the client from the project root. The server builds one resident graph and answers every MCP call from memory. If no language server is installed, a built-in static indexer parses the source directly; every language indexes in about 1–2 seconds, even on large repositories.

### Language Server

A language server improves the graph with semantically resolved edges. Install the ones for your stack; nothing is provided automatically, and an installed editor such as VS Code does not expose a stdio language server:

| Language | Server | Install |
|---|---|---|
| TypeScript | `ttscserver` | `npm i -D ttsc@^0.23.0 typescript` |
| Python | `pyright-langserver` | `npm i -D pyright` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |
| C / C++ | `clangd` | LLVM release, or your package manager |
| Java | `jdtls` | Eclipse JDT LS (needs JDK 21+) |
| C# | `csharp-ls` | `dotnet tool install -g csharp-ls` |
| Kotlin | `kotlin-language-server` | fwcd/kotlin-language-server |
| Swift | `sourcekit-lsp` | ships with the Swift toolchain |
| Scala | `metals` | `cs install metals` |
| Zig | `zls` | zigtools/zls |
| Ruby | `ruby-lsp` | `gem install ruby-lsp` |
| PHP | `intelephense` | `npm i -D intelephense` |
| Lua | `lua-language-server` | LuaLS/lua-language-server |
| Dart | `dart` | ships with the Dart SDK |

Each server must be on `PATH`. If none is present for a file's language, that language falls back to the static indexer automatically.

<!-- provider-support:start -->
### Strict provider support

_Generated from [`docs/provider-support.json`](https://github.com/samchon/compiler-graph/blob/master/docs/provider-support.json); do not edit this block by hand._

Strict selection is per registered provider and may decline for missing tools, incompatible options, or incomplete build metadata. Authority grades differ. A provider's `facts` list means it can defend those edge families; it is not a universal-completeness claim. Strict dumps carry provider/tool provenance plus universe, input-manifest, and content digests. The MCP result reports operation coverage and uncertainty, but does not promise #63's future complete producer-owned per-generation coverage contract. Generic language-server and static fallbacks remain valid lower-authority results and are identified as such.

#### Capability

| Provider | Languages | Authority | Defensible facts | Evidence |
| --- | --- | --- | --- | --- |
| `ttscgraph` | `typescript` | `compiler` | `exports`, `calls`, `accesses`, `instantiates`, `type_ref`, `extends`, `implements`, `overrides`, `renders` | [upstream](https://github.com/samchon/ttsc) / [route #63](https://github.com/samchon/compiler-graph/issues/63) |
| `samchon-graph-go` | `go` | `compiler` | `contains`, `exports`, `imports`, `calls`, `accesses`, `instantiates`, `type_ref`, `implements`, `dispatches`, `tests`, `references` | [upstream](https://github.com/scip-code/scip-go) / [route #63](https://github.com/samchon/compiler-graph/issues/63) |
| `samchon-graph-lua` | `lua` | `analyzer` | `references` | [upstream](https://github.com/LuaLS/lua-language-server) / [route #83](https://github.com/samchon/compiler-graph/issues/83) |
| `samchon-rust-analyzer-hir` | `rust` | `analyzer` | `contains`, `exports`, `imports`, `calls`, `accesses`, `instantiates`, `type_ref`, `extends`, `implements`, `overrides`, `dispatches`, `decorates`, `tests`, `references` | [upstream](https://github.com/samchon/rust-analyzer) / [route #72](https://github.com/samchon/compiler-graph/issues/72) |
| `clangd-snapshot` | `c`, `cpp` | `compiler` | `contains`, `exports`, `imports`, `calls`, `accesses`, `instantiates`, `type_ref`, `extends`, `implements`, `overrides`, `dispatches`, `references` | [upstream](https://github.com/samchon/llvm-project) / [route #73](https://github.com/samchon/compiler-graph/issues/73) |
| `scip-java` | `java`, `kotlin` | `semantic-index` | `contains`, `references` | [upstream](https://github.com/scip-code/scip-java) / [route #74](https://github.com/samchon/compiler-graph/issues/74) / [route #76](https://github.com/samchon/compiler-graph/issues/76) |
| `scip-dotnet` | `csharp` | `semantic-index` | **none** | [upstream](https://github.com/sourcegraph/scip-dotnet) / [route #75](https://github.com/samchon/compiler-graph/issues/75) |
| `scip-python` | `python` | `semantic-index` | `references` | [upstream](https://github.com/sourcegraph/scip-python) / [route #80](https://github.com/samchon/compiler-graph/issues/80) |
| `scip-ruby` | `ruby` | `semantic-index` | **none** | [upstream](https://github.com/sourcegraph/scip-ruby) / [route #81](https://github.com/samchon/compiler-graph/issues/81) |
| `scip-dart` | `dart` | `semantic-index` | **none** | [upstream](https://pub.dev/packages/scip_dart) / [route #84](https://github.com/samchon/compiler-graph/issues/84) |
| `scip-php` | `php` | `semantic-index` | **none** | [upstream](https://github.com/davidrjenni/scip-php) / [route #82](https://github.com/samchon/compiler-graph/issues/82) |

#### Lifecycle

These are current implementation modes, not future route claims. Preparation and native/export/resident phases are stated separately because the [experiment catalog](https://github.com/samchon/compiler-graph/blob/master/tests/experiment/src/catalog.mjs) and [cold measurement artifact](https://github.com/samchon/compiler-graph/blob/master/tests/benchmark/results/graph.json) prove different boundaries; the artifact reports whole end-to-end cells, not isolated phase timings.

| Provider | Mode | Preparation | Native analysis | Export and merge | Reuse or resident state |
| --- | --- | --- | --- | --- | --- |
| `ttscgraph` | `resident-no-op-reuse; invalidated-closure shard deltas with a compatible producer` | A matching ttsc/TypeScript project and tsconfig/jsconfig/package inputs. | A compatible target-project ttsc checker owns one resident compiler process and its incremental semantic state. | Changed compiler-owned raw shards cross a versioned transaction; the client validates the complete manifest and adapts only upserts before atomic publication. | Unchanged requests reuse the exact snapshot; body edits reuse unaffected native and normalized shards, while build-universe changes reload safely. |
| `samchon-graph-go` | `unchanged-snapshot-reuse; full-rebuild-on-change` | Go workspace/module inputs, selected GOOS/GOARCH/cgo environment, embedded files and vendored inputs. | The shipped exporter runs one compiler-owned go/packages batch against the selected build universe. | A changed-input batch emits and validates one whole-workspace graph before snapshot publication. | Unchanged inputs reuse the validated snapshot; no resident go/packages checker survives changed builds. |
| `samchon-graph-lua` | `unchanged-snapshot-reuse; full-rebuild-on-change` | LuaLS workspace configuration and the shipped readable exporter. | LuaLS analyzes the workspace and the shipped exporter asks its semantic VM for declaration references. | A changed-input run publishes one references-only whole-workspace graph. | Unchanged inputs reuse the validated snapshot; the current exporter is not a resident incremental session. |
| `samchon-rust-analyzer-hir` | `resident-no-op-reuse; invalidated-closure shard deltas; validated restart checkpoints` | Cargo metadata/config, lock/toolchain inputs, target/features/cfg and build-script/proc-macro universe. | The pinned rust-analyzer fork owns one resident HIR database and exports declarations, semantic relationships, diagnostics, coverage and unresolved boundaries from that exact analysis revision. | Content-addressed source shards cross a versioned LSP transaction; the client verifies producer identity, universe, complete manifests, shard digests and graph invariants before atomic publication. | No-op requests reuse the resident snapshot; interface changes invalidate dependent shards, while a complete consumer checkpoint restores the same generation after process restart. |
| `clangd-snapshot` | `resident-no-op-reuse; complete changed-TU/configuration replacement; content-addressed deltas` | A valid compilation database plus every source, header, generated input, command, target and working-directory identity used by its translation units. | The pinned clangd fork runs every registered command, keeps headers scoped by translation unit and configuration, and captures complete Clang roles, relations, macros, includes, diagnostics and source digests from the same compiler pass. | Versioned native shards cross one optimistic atomic snapshot; the client verifies producer identity, complete manifests, native and common shard digests, coverage, unresolved boundaries and source identities before publication. | No-op requests reuse the exact resident graph; changed sources or compilation-database commands reindex their owning translation units while a failed batch preserves the last complete generation without publishing it as current. |
| `scip-java` | `unchanged-snapshot-reuse; full-rebuild-on-change` | Maven or Gradle project metadata, dependency/classpath state and Java/Kotlin compiler inputs. | scip-java drives the selected Maven or Gradle build and its Java/Kotlin producers as one batch. | The complete decoded artifact is merged as a contains/references graph before atomic publication. | Unchanged inputs reuse the validated snapshot; no javac, kotlinc or build session remains resident. |
| `scip-dotnet` | `unchanged-snapshot-reuse; full-rebuild-on-change` | Solution/project/TFM/NuGet/MSBuild inputs and a resolvable SDK. | scip-dotnet loads and analyzes the selected solution through one batch producer run. | The complete decoded artifact publishes declarations but no currently defensible edge family. | Unchanged inputs reuse the validated snapshot; no Roslyn workspace remains resident. |
| `scip-python` | `unchanged-snapshot-reuse; full-rebuild-on-change` | Python project/config/environment/import/stub inputs. | scip-python runs its bundled Pyright-based analysis once for the selected project environment. | The complete decoded artifact publishes a references-only project graph. | Unchanged inputs reuse the validated snapshot; no Pyright analysis session remains resident. |
| `scip-ruby` | `unchanged-snapshot-reuse; full-rebuild-on-change` | Gem/Bundler/Sorbet/RBI configuration inputs. | scip-ruby performs one full-project batch using the selected Ruby, Bundler and Sorbet inputs. | The complete decoded artifact publishes declarations but no currently defensible edge family. | Unchanged inputs reuse the validated snapshot; no Ruby or Sorbet index remains resident. |
| `scip-dart` | `unchanged-snapshot-reuse; full-rebuild-on-change` | pubspec/lock, analysis options and resolved package configuration. | scip_dart performs one full-project batch using the resolved Dart package universe. | The complete decoded artifact publishes declarations but no currently defensible edge family. | Unchanged inputs reuse the validated snapshot; this is not resident Analysis Server state. |
| `scip-php` | `unchanged-snapshot-reuse; full-rebuild-on-change` | Composer manifest/lock/autoload and PHP/PHPStan configuration inputs. | The project-local scip-php producer performs one full-project batch through Composer/PHP inputs. | The complete decoded artifact publishes declarations but no currently defensible edge family. | Unchanged inputs reuse the validated snapshot; no PHPStan or Composer analysis session remains resident. |

#### Installation and selection

The troubleshooting table names the ordinary language-server/static fallback for each row. Resolution metadata is shared with the shipped registry and checked in CI.

| Provider | Install | Install sources | Fixed commands | Project command sources | Overrides | Resolution order | Project preparation | Platforms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ttscgraph` | Install a ttsc release that supports graph snapshot protocol v1. `ttsc@0.23.0` provides the ordinary `ttscserver` fallback but predates this strict protocol. | [ttsc 0.23.0 legacy release](https://www.npmjs.com/package/ttsc/v/0.23.0), [native shard producer PR](https://github.com/samchon/ttsc/pull/1056) | `ttscgraph`, `ttscserver` | — | `TTSC_GRAPH_BINARY` | Absolute `TTSC_GRAPH_BINARY`, target-project `ttsc` package/binary, target-project `.bin`, then PATH/global compatibility fallback. | A matching ttsc/TypeScript project and tsconfig/jsconfig/package inputs. | `linux`, `macos`, `windows` |
| `samchon-graph-go` | Go 1.25+; the package ships the Go exporter source. Install corroboration with `go install github.com/scip-code/scip-go/cmd/scip-go@v0.2.7`. | [Go downloads](https://go.dev/dl/), [scip-go 0.2.7 source](https://github.com/scip-code/scip-go/tree/v0.2.7) | `samchon-graph-go`, `go`, `scip-go` | — | `SAMCHON_GRAPH_GO`, `SAMCHON_GRAPH_GO_TOOLCHAIN`, `SAMCHON_GRAPH_SCIP_GO` | Project/PATH `samchon-graph-go`, then the shipped source runner through Go; absolute environment overrides take precedence. | Go workspace/module inputs, selected GOOS/GOARCH/cgo environment, embedded files and vendored inputs. | `linux`, `macos`, `windows` |
| `samchon-graph-lua` | Install `lua-language-server`; the package ships `sidecars/lua/export.lua`. | [LuaLS releases](https://github.com/LuaLS/lua-language-server/releases) | `lua-language-server` | — | `SAMCHON_GRAPH_LUA`, `SAMCHON_GRAPH_LUA_EXPORTER` | Absolute `SAMCHON_GRAPH_LUA`, then project/PATH LuaLS; the shipped exporter may be replaced by `SAMCHON_GRAPH_LUA_EXPORTER`. | LuaLS workspace configuration and the shipped readable exporter. | `linux`, `macos`, `windows` |
| `samchon-rust-analyzer-hir` | Build the `samchon/rust-analyzer` graph-snapshot fork at commit `2850ecba80311bebd4cdaa9fedc5321533b5b1e7`; point `SAMCHON_GRAPH_RUST_ANALYZER_HIR` at that binary or install it as `samchon-rust-analyzer`. | [native HIR graph producer PR](https://github.com/samchon/rust-analyzer/pull/1), [rust-analyzer build instructions](https://rust-analyzer.github.io/book/contributing.html) | `samchon-rust-analyzer`, `rust-analyzer` | — | `SAMCHON_GRAPH_RUST_ANALYZER_HIR` | Absolute `SAMCHON_GRAPH_RUST_ANALYZER_HIR`, then project/PATH `samchon-rust-analyzer`, then a project/PATH `rust-analyzer` only when its version reports the pinned producer commit. | Cargo metadata/config, lock/toolchain inputs, target/features/cfg and build-script/proc-macro universe. | `linux`, `macos`, `windows` |
| `clangd-snapshot` | Build the `samchon/llvm-project` graph-snapshot fork at commit `ae904413566b54aca08e46ebee1769c110601e6b`; point `SAMCHON_GRAPH_CLANGD_SNAPSHOT` at `clangd` or install it as `samchon-clangd`, and provide a compilation database. | [native Clang graph producer PR](https://github.com/samchon/llvm-project/pull/1), [LLVM build instructions](https://llvm.org/docs/CMake.html) | `samchon-clangd`, `clangd` | `compile_commands.json`, `build/compile_commands.json` | `SAMCHON_GRAPH_CLANGD_SNAPSHOT` | Absolute `SAMCHON_GRAPH_CLANGD_SNAPSHOT`, then project/PATH `samchon-clangd`, then a project/PATH `clangd` only when its version reports the pinned producer commit. | A valid compilation database plus every source, header, generated input, command, target and working-directory identity used by its translation units. | `linux`, `macos`, `windows` |
| `scip-java` | Install `scip-java` 0.13.1, the `scip` decoder and a compatible JDK; Kotlin experiments pin a compatible source build. | [scip-java 0.13.1 release](https://github.com/scip-code/scip-java/releases/tag/v0.13.1), [SCIP releases](https://github.com/sourcegraph/scip/releases) | `scip-java`, `scip`, `java` | — | `SAMCHON_GRAPH_SCIP_JAVA`, `SAMCHON_GRAPH_SCIP`, `SAMCHON_GRAPH_JAVA_TOOLCHAIN` | Project-local producer/decoder/JDK precede PATH; absolute environment overrides select each tool. | Maven or Gradle project metadata, dependency/classpath state and Java/Kotlin compiler inputs. | `linux`, `macos`, `windows` |
| `scip-dotnet` | `dotnet tool install --global scip-dotnet`; install the `scip` decoder and matching .NET SDK. | [scip-dotnet on NuGet](https://www.nuget.org/packages/scip-dotnet), [SCIP releases](https://github.com/sourcegraph/scip/releases) | `scip-dotnet`, `scip`, `dotnet` | — | `SAMCHON_GRAPH_SCIP_DOTNET`, `SAMCHON_GRAPH_SCIP`, `SAMCHON_GRAPH_DOTNET_TOOLCHAIN` | Project-local producer/decoder/toolchain precede PATH; absolute environment overrides select each tool. | Solution/project/TFM/NuGet/MSBuild inputs and a resolvable SDK. | `linux`, `macos`, `windows` |
| `scip-python` | `npm install -g @sourcegraph/scip-python@0.6.6`; install the `scip` decoder and select Python. | [scip-python 0.6.6 on npm](https://www.npmjs.com/package/@sourcegraph/scip-python/v/0.6.6), [SCIP releases](https://github.com/sourcegraph/scip/releases) | `scip-python`, `scip`, `python3`, `python`, `py` | — | `SAMCHON_GRAPH_SCIP_PYTHON`, `SAMCHON_GRAPH_SCIP`, `SAMCHON_GRAPH_PYTHON_TOOLCHAIN` | Project-local producer/decoder/interpreter precede PATH; Python aliases are tried in order and absolute overrides select each tool. | Python project/config/environment/import/stub inputs. | `linux`, `macos`, `windows` |
| `scip-ruby` | Install the pinned `scip-ruby` 0.4.7 release binary, the `scip` decoder and matching Ruby/Bundler. | [scip-ruby 0.4.7 release](https://github.com/sourcegraph/scip-ruby/releases/tag/scip-ruby-v0.4.7), [SCIP releases](https://github.com/sourcegraph/scip/releases) | `scip-ruby`, `scip`, `ruby` | — | `SAMCHON_GRAPH_SCIP_RUBY`, `SAMCHON_GRAPH_SCIP`, `SAMCHON_GRAPH_RUBY_TOOLCHAIN` | Project-local producer/decoder/Ruby precede PATH; absolute environment overrides select each tool. | Gem/Bundler/Sorbet/RBI configuration inputs. | `linux`, `macos`, `windows-when-installed` |
| `scip-dart` | `dart pub global activate scip_dart 1.6.2`; install the `scip` decoder and Dart SDK. | [scip_dart 1.6.2](https://pub.dev/packages/scip_dart/versions/1.6.2), [SCIP releases](https://github.com/sourcegraph/scip/releases) | `scip_dart`, `scip`, `dart` | — | `SAMCHON_GRAPH_SCIP_DART`, `SAMCHON_GRAPH_SCIP`, `SAMCHON_GRAPH_DART_TOOLCHAIN` | Project-local producer/decoder/Dart precede PATH; absolute environment overrides select each tool. | pubspec/lock, analysis options and resolved package configuration. | `linux`, `macos`, `windows` |
| `scip-php` | Install the project-local scip-php dependency with Composer, expose `vendor/bin/scip-php`, and install the `scip` decoder. | [scip-php source](https://github.com/davidrjenni/scip-php), [SCIP releases](https://github.com/sourcegraph/scip/releases) | `scip-php`, `scip`, `php` | — | `SAMCHON_GRAPH_SCIP_PHP`, `SAMCHON_GRAPH_SCIP`, `SAMCHON_GRAPH_PHP_TOOLCHAIN` | Project `vendor/bin` precedes PATH; absolute producer/decoder/PHP overrides select each tool. | Composer manifest/lock/autoload and PHP/PHPStan configuration inputs. | `linux`, `macos`, `windows` |

#### Verified cold index cells

These are exact same-run cold end-to-end strict/strict-disabled pairs from [`tests/benchmark/results/graph.json`](https://github.com/samchon/compiler-graph/blob/master/tests/benchmark/results/graph.json), produced by [the pinned workflow run](https://github.com/samchon/compiler-graph/actions/runs/30448033020). They do not prove warm or semantic-incremental behavior. A zero-fact strict provider is not called semantically complete. Ruby and Dart report only that both whole cells exceeded the 1,800-second guard; that limit is not an isolated producer duration.

| Project | Strict provider | Strict cell | Strict-disabled cell |
| --- | --- | --- | --- |
| `excalidraw` | `ttscgraph` | 5,340.296 ms | 2,977.720 ms |
| `gin` | `samchon-graph-go` | 38,097.048 ms | 687.107 ms |
| `lualine` | `samchon-graph-lua` | 18,889.245 ms | 27,848.007 ms |
| `tokio` | `rust-analyzer-scip` (prior fallback evidence; `samchon-rust-analyzer-hir` not yet measured) | 55,238.180 ms | 229,860.996 ms |
| `redis` | `scip-clang` (prior fallback evidence; `clangd-snapshot` not yet measured) | 22,794.688 ms | 262,905.796 ms |
| `leveldb` | `scip-clang` (prior fallback evidence; `clangd-snapshot` not yet measured) | 8,352.928 ms | 26,451.952 ms |
| `gson` | `scip-java` | 88,653.499 ms | 231,398.489 ms |
| `koin` | `scip-java` | 211,263.800 ms | 967,711.761 ms |
| `serilog` | `scip-dotnet` | 20,498.324 ms | 25,085.071 ms |
| `flask` | `scip-python` | 10,628.897 ms | 748.454 ms |
| `sinatra` | `scip-ruby` | did not finish before 1,800 s | did not finish before 1,800 s |
| `darthttp` | `scip-dart` | did not finish before 1,800 s | did not finish before 1,800 s |
| `slim` | `scip-php` | 3,771.828 ms | 9,611.108 ms |

#### Troubleshooting

A strict result's provenance name must equal the provider below. If it is absent, use the commands and overrides in the installation table, then follow the explicit decline reason; the fallback is still usable but does not inherit strict authority.

| Languages | Expected provenance | Common boundary | Common decline | Fallback |
| --- | --- | --- | --- | --- |
| `typescript` | `ttscgraph` | No compatible ttsc release is published yet. Version 0.23.0 returns a legacy complete dump and therefore falls back honestly until the native shard producer ships. | A missing target-project ttsc binary, legacy full-dump producer, incompatible request cap, malformed transaction or unsupported schema declines the strict provider. | `ttscserver`, then `@samchon/graph-sitter`. |
| `go` | `samchon-graph-go` | Current changed-input export is a full rebuild and does not retain a resident `go/packages` checker session. | A missing Go 1.25+ toolchain, missing pinned scip-go corroborator or invalid workspace/module load declines the strict provider. | `gopls`, then `@samchon/graph-sitter`. |
| `lua` | `samchon-graph-lua` | The current exporter calls `vm.getRefs` per declaration and proves references only; #83 replaces it with an occurrence-oriented resident traversal. | A missing LuaLS binary/exporter, invalid workspace result or bounded request declines the strict provider. | Generic LuaLS, then `@samchon/graph-sitter`. |
| `rust` | `samchon-rust-analyzer-hir` | The producer is currently available from the draft fork PR rather than a rust-analyzer release, and Rust has no `renders` relationship family. | A missing pinned producer, incompatible commit/schema, malformed transaction, invalid checkpoint, unsupported bounded option or failed Cargo workspace load declines this route. | Stock `rust-analyzer-scip`, then generic rust-analyzer, then `@samchon/graph-sitter`. |
| `c`, `cpp` | `clangd-snapshot` | Calls, instantiation, exports, implements and dispatch are explicitly partial; C/C++ have no decorates, renders or tests family, and the producer is currently a draft fork rather than an LLVM release. | A missing pinned producer, missing or invalid compilation database, incompatible schema/commit, incomplete indexing batch, source/configuration movement or compiler error declines this route. | `scip-clang`, then stock `clangd`, then `@samchon/graph-sitter`. |
| `java`, `kotlin` | `scip-java` | The released Gradle path disables configuration cache and runs `clean scipCompileAll`; it is navigation fallback for #74/#76, not compiler-owned calls or accesses. | A missing producer/decoder/JDK, unsupported Maven or Gradle project, or invalid dependency/build configuration declines the strict provider. | `jdtls` or `kotlin-language-server`, then `@samchon/graph-sitter`. |
| `csharp` | `scip-dotnet` | The artifact proves declarations but no graph edge family and can log MSBuildWorkspace failures after publishing. | A missing producer/decoder/.NET SDK, absent solution/project input or invalid MSBuild load declines the strict provider. | `csharp-ls`, then `@samchon/graph-sitter`. |
| `python` | `scip-python` | The bundled historical Pyright core proves references only and can recover from malformed pyproject configuration with defaults. | A missing producer/decoder/Python interpreter, absent project input or unusable Python environment declines the strict provider. | `pyright-langserver`, then `@samchon/graph-sitter`. |
| `ruby` | `scip-ruby` | The current artifact proves no graph edge family; it does not expose structural coverage, Sorbet sigils or typed unresolved sites. | A missing producer/decoder/Ruby runtime, unusable Bundler environment or invalid project configuration declines the strict provider. | `ruby-lsp`, then `@samchon/graph-sitter`. |
| `dart` | `scip-dart` | The current artifact proves no graph edge family and is not resident Analysis Server state. | A missing producer/decoder/Dart SDK, absent package configuration or failed pub resolution declines the strict provider. | Dart Analysis Server, then `@samchon/graph-sitter`. |
| `php` | `scip-php` | The current raw parser/Composer artifact proves no graph edge family and has no diagnostic or role grounding. | A missing project-local producer/decoder/PHP runtime, absent Composer autoload or invalid project configuration declines the strict provider. | `intelephense`, then `@samchon/graph-sitter`. |

#### Ordinary-only strict status

These languages are indexed through their ordinary server and static fallback today. They have no registered strict provider or strict timing claim.

| Language | Ordinary server | Why no strict provider | Route |
| --- | --- | --- | --- |
| `scala` | `metals` | No registered strict provider; scip-java no longer supports Scala. | [tracked route](https://github.com/samchon/compiler-graph/issues/77) |
| `swift` | `sourcekit-lsp` | No packaged IndexStoreDB/SourceKit-LSP snapshot producer is registered. | [tracked route](https://github.com/samchon/compiler-graph/issues/78) |
| `zig` | `zls` | No analyzer or compiler Sema snapshot producer is registered. | [tracked route](https://github.com/samchon/compiler-graph/issues/79) |
<!-- provider-support:end -->

### Repository topology

The same `inspect_code_graph` tool has a `topology` request for workspaces, packages, source roots, targets, tasks, entrypoints, project dependencies, and file joins. These facts use a sibling provider plane: repository nodes never masquerade as code symbols, and a file join is returned only when the topology model can be fenced against one stable code generation.

The first adapter slice is deliberately read-only:

| Ecosystem | Model and policy |
|---|---|
| pnpm | Runs `pnpm list -r --json --depth 0` and reads versioned package/workspace/lock manifests. Package scripts are listed as tasks, never executed. |
| Cargo | Runs `cargo metadata --format-version 1 --locked --offline`; it neither updates the lockfile nor accesses the network. |
| Gradle | Uses the Tooling API and may evaluate project configuration, but runs no task. It is disabled until `SAMCHON_GRAPH_ALLOW_GRADLE_MODEL=1`; provide `SAMCHON_GRAPH_GRADLE_TOOLING_CLASSPATH` or `GRADLE_HOME`. |
| CMake | Reads existing File API codemodel-v2 and cmakeFiles-v1 replies. It never writes a query or configures the project; set `SAMCHON_GRAPH_CMAKE_REPLY` when the reply is outside a conventional build directory. |

Every topology result carries provider/tool provenance, per-relation `complete`/`partial`/`unsupported` coverage, its resident generation, and explicit join compatibility. Gradle configuration failures and missing or stale CMake replies become unavailable coverage; they do not fall back to guessed build facts.

Before the generic lane runs, indexing asks a registry of strict providers which languages they own. A provider states what its facts are grounded in — a compiler, a whole-project analyzer, or a precomputed semantic index — and which edge families it can prove; a snapshot that publishes outside those is rejected rather than merged. Whatever no provider claims falls through to the language server, and then to the static indexer. Every decline is one sentence naming the provider and the authority the build gave up, so a fallback is never mistaken for the strict result it replaced.

The dump carries one `provenance` row per contributing provider: its authority, the fact families it proves, the producing tool and versions, a fingerprint of the inputs that decided the file set, and digests over the manifest and the published facts. It is absent when no strict provider served the build. What a provider *did* to compute a generation is deliberately not recorded there because that belongs to one refresh rather than to the facts.

JavaScript is intentionally not indexed. In an arbitrary repository, `.js`/`.jsx`/`.mjs`/`.cjs` files are as often build output or vendored bundles as handwritten source, and the graph cannot tell which without project-specific provenance.

## Benchmark

Each repository is measured with headless agent runs per arm (`baseline` with no MCP, `@samchon/graph`, `codegraph`, `codebase-memory`, `serena`) on two prompt families, across two agent CLIs (`codex` and Claude Code). The corpus pins 13 repositories, one per language represented in codegraph's own evaluation suite and runnable with a full language-server index on the benchmark host.

### Onboarding

Every repository is asked the same onboarding question. Every arm that mounts a
tool receives the same tool-neutral nudge; the baseline receives only the same
checkout-grounding rule used by the reference harness.

> I'm new to this codebase and need a real code-based tour before my first behavior change.
>
> Find the central runtime flow, trace it from the public API to the code that does the work, and show the nearby code paths and tests I should read next.

<details>
<summary><code>codex</code> · <code>gpt-5.4-mini</code> — median token reduction 96% (codegraph 66%, serena 11%)</summary>

![Agent token cost — onboarding, per repository](https://raw.githubusercontent.com/samchon/graph/master/assets/benchmark-codex-gpt-5.4-mini-common.svg)

</details>

### Dedicated

`codegraph`'s own per-repository questions, verbatim:

| Project | Language | Prompt |
|---|---|---|
| [excalidraw](https://github.com/excalidraw/excalidraw) | TypeScript | How does Excalidraw render and update canvas elements? |
| [gin](https://github.com/gin-gonic/gin) | Go | How does gin route requests through its middleware chain? |
| [flask](https://github.com/pallets/flask) | Python | How does Flask dispatch a request to a view function? |
| [tokio](https://github.com/tokio-rs/tokio) | Rust | How does tokio schedule and run async tasks on its runtime? |
| [gson](https://github.com/google/gson) | Java | How does Gson serialize an object to JSON? |
| [redis](https://github.com/redis/redis) | C | How does Redis parse and dispatch a client command? |
| [leveldb](https://github.com/google/leveldb) | C++ | How does LevelDB read and write a key through its storage engine? |
| [sinatra](https://github.com/sinatra/sinatra) | Ruby | How does Sinatra match a request to a route handler? |
| [slim](https://github.com/slimphp/Slim) | PHP | How does Slim handle a request through its middleware? |
| [serilog](https://github.com/serilog/serilog) | C# | How does Serilog route a log event to its sinks? |
| [koin](https://github.com/InsertKoinIO/koin) | Kotlin | How does Koin resolve and inject dependencies? |
| [lualine](https://github.com/nvim-lualine/lualine.nvim) | Lua | How does lualine assemble and render its statusline sections and components? |
| [darthttp](https://github.com/dart-lang/http) | Dart | How does the http package send a request and produce a response? |

<details>
<summary><code>codex</code> · <code>gpt-5.4-mini</code> — median token reduction 78% (codegraph 52%, serena 5%)</summary>

![Agent token cost — dedicated question, per repository](https://raw.githubusercontent.com/samchon/graph/master/assets/benchmark-codex-gpt-5.4-mini-dedicated.svg)

</details>

### Indexing time

The exact current same-run cold strict/strict-disabled measurements are generated from the pinned result artifact in [Verified cold index cells](#verified-cold-index-cells). They make no warm, resident, or semantic-completeness claim; lifecycle modes are listed separately from measured cold time.

### Reproduction

Running the suite spends real API credits, so it is never wired into CI:

```bash
git clone https://github.com/samchon/graph
cd graph
pnpm install
pnpm --filter @samchon/graph-benchmark test        # hashes + trace audit + deterministic SVG/PNG
pnpm --filter @samchon/graph-benchmark corpus      # 13 repos / 13 languages, commit-pinned
pnpm --filter @samchon/graph-benchmark preflight   # zero-spend go/no-go
pnpm --filter @samchon/graph-benchmark suite -- --arm=baseline --runs=5 --harness=codex
pnpm --filter @samchon/graph-benchmark suite -- --arm=graph --runs=1 --harness=codex
pnpm --filter @samchon/graph-benchmark orchestrate -- --all --arm=baseline --tools=baseline --prompt-families=all --models=gpt-5.4-mini --runs=1
pnpm --filter @samchon/graph-benchmark orchestrate -- --all --arm=graph --tools=all --prompt-families=all --models=gpt-5.4-mini --runs=1
pnpm --filter @samchon/graph-benchmark audit -- --report=<report.json>
pnpm --filter @samchon/graph-benchmark publish -- --from=<suite-output-directory>
pnpm --filter @samchon/graph-benchmark render:png  # reference SVG + exact 2x PNG
```

## How it works

```typescript
/**
 * ## Code Graph MCP
 *
 * `inspect_code_graph` returns an index-built __LANG__ graph contract for the
 * current on-disk source snapshot.
 *
 * Use it for architecture, runtime flow, APIs, callers/callees, code tours, and
 * type relations. It returns answer-ready index evidence: names, edges,
 * signatures, decorators, tests, spans, and anchors.
 *
 * Every returned fact — each name, edge, signature, and span — is checked
 * against the index for the snapshot that call synchronized, so trust it
 * without re-checking against files. Where an operation ranks a shortlist
 * against your question (`lookup`, `entrypoints`, `tour`), the facts stay
 * checked but the selection is heuristic: judge whether its coverage answers
 * you, and a follow-up request or a read of a cited span is fair when it does
 * not.
 *
 * ## Requests
 *
 * A request is a union: pick the single type below that best fits the question,
 * and submit exactly that one.
 *
 * - `tour`: architecture, runtime flow, orientation, or a code tour. One call is
 *   the whole answer; do not split it. Name the machinery you expect it to be
 *   made of in its `reinterpretations`, or send none.
 * - `entrypoints`: find where execution starts when entry points are unknown.
 * - `lookup`: locate a named symbol.
 * - `trace`: follow calls or data flow forward or backward from a symbol, or —
 *   with `to` — the path between two symbols when both ends are known, which is
 *   the one call that answers "how does A reach B".
 * - `details`: signatures, members, and relations of named symbols — including
 *   the classes that implement an interface, which is the one call that answers
 *   "what actually implements this".
 * - `overview`: project layers and folder structure.
 * - `topology`: workspace, package, target, task, source-root, entrypoint, and
 *   project-dependency orientation from declared or owning-tool models.
 * - `escape`: the answer is outside the graph (source body text, files outside
 *   the indexed languages, exact search).
 *
 * ## Chain of Thought
 *
 * Fill these fields in order before the call; each one narrows the reasoning
 * toward the single request you submit.
 *
 * - `question`: the code question, in the user's own words.
 * - `draft`: `{ reason, type }` — why the smallest request that could answer it,
 *   then that request's `type`.
 * - `review`: fix a broad, stale, or duplicate draft. If the graph already
 *   answered, or the evidence is outside it, escape.
 * - `request`: the final choice. Each branch documents its own fields; fill them
 *   from what the branch says, not from what another branch wanted.
 *
 * ## What to trust
 *
 * Before source edits, every returned fact has been checked against the index
 * named by `audit`. Never use extra graph calls, repository search, or file
 * reads to doubt, fact-check, re-derive, re-narrate, or re-confirm a returned
 * node, span, edge, signature, decorator, test, reference, step, or anchor. The
 * server checked each one against the current index for the snapshot the call
 * synced to.
 *
 * Selection is separate. `lookup`, `entrypoints`, and `tour` match your
 * question and return a scored, ranked, per-file-capped, limited shortlist;
 * their facts stay checked, but whether the shortlist covers what you asked is
 * yours to judge, and their `audit` says that instead of claiming completeness.
 * A follow-up request or a read of a cited span for missed coverage is
 * legitimate — re-confirming a fact the graph already checked is not.
 *
 * ## Stop
 *
 * Let the result's `next` set the pace, and do not re-confirm what the graph
 * already checked.
 *
 * - A span is a citation, not a cue to open the file to re-check a fact.
 * - Follow the result's `next`: `answer` means stop and answer from it, `inspect`
 *   means make exactly the one request it names, `outside` means escape,
 *   `clarify` means restate the request.
 * - For a ranked shortlist (`lookup`, `entrypoints`, `tour`), `next` and
 *   `truncated` say whether coverage is settled; when it is not, one more
 *   request is the right move — not a file read to re-verify facts already
 *   given.
 */
export interface ISamchonGraphApplication {
  /**
   * Answer a __LANG__ question from the repository's program index.
   *
   * The graph returns proved facts with coverage and uncertainty. Submit one
   * request:
   *
   * - `tour`: architecture, runtime flow, nearby paths, and tests
   * - `trace`: what a symbol calls, what calls it, or the path from A to B
   * - `details`: signatures, members, and what implements an interface
   * - `lookup`: where a named symbol is declared
   * - `entrypoints`: where execution starts, when the entry is unknown
   * - `overview`: the project's layers and folder structure
   * - `topology`: repository workspaces, packages, roots, targets, tasks, and
   *   dependencies
   *
   * Every fact in a result is checked against the index before return, so no
   * fact needs verifying; for the ranked operations (`lookup`, `entrypoints`,
   * `tour`), judge whether the shortlist covers your question. Read source only
   * for a body or span text.
   *
   * @param props Reasoning plus one graph request
   * @returns Matching `result` union member
   */
  inspect_code_graph(
    props: ISamchonGraphApplication.IProps,
  ): Promise<ISamchonGraphApplication.IOutput>;
}

export namespace ISamchonGraphApplication {
  /** Draft, review, then submit exactly one graph request or escape. */
  export interface IProps {
    /**
     * The code question, in the user's own words.
     *
     * Cut a long message down to the sentences that state the ask, but keep
     * their terms: the graph ranks against these words, so a rewrite ranks a
     * different answer.
     */
    question: string;

    /** The smallest request that could answer, and why. */
    draft: IDraft;

    /**
     * Correct the draft. Escape if the graph already answered, or the next
     * evidence is outside the graph.
     */
    review: string;

    /** Final graph request chosen after review, or a no-op escape. */
    request:
      | ISamchonGraphEntrypoints.IRequest
      | ISamchonGraphLookup.IRequest
      | ISamchonGraphTrace.IRequest
      | ISamchonGraphDetails.IRequest
      | ISamchonGraphOverview.IRequest
      | ISamchonGraphTour.IRequest
      | ISamchonGraphTopology.IRequest
      | ISamchonGraphEscape.IRequest;
  }

  /** First-pass plan; `reason` precedes `type` so it is written first. */
  export interface IDraft {
    /** Why this is the smallest useful next step. */
    reason: string;

    /** The request type being considered. */
    type: IProps["request"]["type"];
  }

  /** The selected request's output. `result.type` mirrors `request.type`. */
  export interface IOutput {
    /**
     * What the server checked this result against before returning it, in its
     * own words. The audit names the LSP, static, or hybrid index that built the
     * current snapshot.
     *
     * The audit is operation-aware. For the walks from a named handle (`trace`,
     * `overview`) it reports the structure held for the named handles, bounded
     * where `truncated` says. For `details` it reports the two halves of a
     * resolved symbol: its own shape returned whole unless the caller explicitly
     * capped members, and its fan-out returned as a slice with `trace` for the
     * rest. For ranked operations (`lookup`,
     * `entrypoints`, `tour`) it additionally says that selection was matched,
     * scored, ranked, and limited against the question, so the facts are checked
     * but shortlist coverage is yours to judge.
     */
    audit: string;

    /**
     * Strict producer, authority, compiler and build-universe identity for the
     * synchronized graph. Absent for `escape`, for `topology` whose facts come
     * from the repository plane and carry their own provenance, and for a
     * legacy or fallback-only dump with no strict producer.
     */
    provenance?: ISamchonGraphDump.IProvenance[];

    /**
     * Machine-readable completeness for the relationship families relevant to
     * this operation. Absent for `escape` and for `topology`, which reports
     * its own relation coverage inside the result.
     */
    coverage?: ISamchonGraphCoverageSummary;

    /**
     * Bounded structured uncertainty for the same operation-scoped families.
     * Absent for `escape` and for `topology`, whose plane publishes none.
     */
    unresolved?: ISamchonGraphUnresolvedSummary;

    /** What to do with `result`: answer, inspect one named request, or escape. */
    next: ISamchonGraphNext;

    /** Result branch matching the submitted `request.type`. */
    result:
      | ISamchonGraphEntrypoints
      | ISamchonGraphLookup
      | ISamchonGraphTrace
      | ISamchonGraphDetails
      | ISamchonGraphOverview
      | ISamchonGraphTour
      | ISamchonGraphTopology
      | ISamchonGraphEscape;
  }
}
```

> [`packages/graph/src/structures/ISamchonGraphApplication.ts`](https://github.com/samchon/graph/blob/master/packages/graph/src/structures/ISamchonGraphApplication.ts)

### Chain of thought

`question`, `draft`, and `review` are required fields, so the model writes its reasoning into the call itself: state the question, draft the smallest request, then review the draft. A prompt line can be ignored; a required field cannot.

The review is allowed to overturn the draft, and that matters more than the planning. When an agent like Claude Code enters the tool with a question the graph cannot answer, `review` replaces the drafted request on the spot, and `escape` backs out entirely. A wrong entry costs one small call instead of a derailed session.

`question` is asked once, and the tour ranks against it. Its JSDoc says so, because by the time the string arrives it is whatever the model chose to write, and the schema is the only text the model reads before it fills the field: *"Cut a long message down to the sentences that state the ask, but keep their terms: the graph ranks against these words, so a rewrite ranks a different answer."*

### Precision over restriction

Nothing is forbidden. The tool description says when the graph applies and when to stop. Grep and file reads stay available, and the agent still uses them when they are the right move.

What keeps the agent on the graph is precision. Answers carry names, signatures, edges, and spans resolved by a language server, so the agent accepts them as final instead of re-verifying with its own reads. And since no file body is ever included, a large repository cannot inflate the response.

### Comparison

[`serena`](https://github.com/oraios/serena) and [`codegraph`](https://github.com/colbymchenry/codegraph) fight the agent instead:

- dozens of tools around one graph, so the agent often picks the wrong entry point
- 100–150 lines of injected instructions, spent mostly on forbidding grep and file reads
- source snippets inlined into answers, which reintroduces the reading cost a graph exists to remove
- loosely structured answers the agent does not trust, so it goes back to reading the files to verify them
- no way to back out, so a wrong entry keeps paying tool calls instead of escaping

Here the same policy fits in one typed contract, enforced by schema instead of pleaded for in prose.

## Sponsors

[![Sponsors](https://raw.githubusercontent.com/samchon/sponsor-images/refs/heads/master/public/circle.svg)](https://github.com/sponsors/samchon)

Thanks for your support.

Your [donation](https://github.com/sponsors/samchon) encourages `@samchon/graph` development.

## References

- Motivation: real-world use of [`codegraph`](https://github.com/colbymchenry/codegraph) that raised token cost instead of lowering it and visibly degraded agent reasoning.
- Predecessor: [`@ttsc/graph`](https://github.com/samchon/ttsc), the TypeScript-only original that this project generalizes; its [launch post](https://ttsc.dev/blog/i-made-ts-compiler-graph-mcp/) analyzes why earlier graph tools did not reduce the token bill.
- Function calling harness: [part 1 — validation feedback](https://dev.to/samchon/qwen-meetup-function-calling-harness-from-675-to-100-3830) and [part 2 — CoT compliance](https://dev.to/samchon/function-calling-harness-2-cot-compliance-from-991-to-100-4f0h), the typia technique the contract is built on.
- Compared against: [`codegraph`](https://github.com/colbymchenry/codegraph) and [`serena`](https://github.com/oraios/serena).
- Protocol: the [Model Context Protocol](https://modelcontextprotocol.io) and the [Language Server Protocol](https://microsoft.github.io/language-server-protocol/).
- Validation & MCP surface: [`typia`](https://github.com/samchon/typia) and [`@typia/mcp`](https://github.com/samchon/typia).
