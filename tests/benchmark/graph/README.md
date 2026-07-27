# Graph agent benchmark reference

The implementation in this directory is a direct port of `ttsc`'s
`experimental/benchmark/graph`. Product names and the multi-language fixture
adapter are the only intended differences.

## Reproducibility contract

1. `corpus.mjs` pins every repository to a full 40-character commit.
2. `questions/manifest.json` contains a dedicated and common prompt for every
   corpus entry, pins each normalized prompt by SHA-256, and repeats the fixture
   language and commit.
3. The harness refuses a prompt hash mismatch and records prompt provenance on
   every report.
4. Language tools stay under the benchmark's isolated `.work/tools` tree. The
   launcher discovers packaged root, `bin`, `server/bin`, and one-level nested
   `bin` layouts without depending on user-global `PATH` entries.
5. Dart dependency preparation runs only for packages the provisioned Dart SDK
   can resolve. A `pubspec.yaml` that declares `sdk: flutter` is left for a
   separately provisioned Flutter SDK and is not misreported as a Dart failure.
6. A paid graph cell starts only after the package launcher exists. The measured
   MCP process starts the full, uncapped LSP index inside the cell.
7. Baseline and graph arms receive the same user utterance. Tool guidance comes
   from MCP instructions; `prompt.mjs` only supplies the reference grounding and
   tool-discovery nudge used by both upstream harnesses.
8. Minimal per-arm MCP/Codex configuration prevents user-global instructions or
   unrelated MCP servers from leaking into a cell.
9. Raw traces and answers remain available for `audit-codex-traces.mjs`; only
   zero-token infrastructure failures are retried away.

## Main commands

```bash
node tests/benchmark/graph.mjs --list
node tests/benchmark/graph.mjs --setup-only --all
node tests/benchmark/graph.mjs --all --arm=baseline --tools=baseline --prompt-families=all --models=gpt-5.4-mini --runs=1
node tests/benchmark/graph.mjs --all --arm=graph --tools=all --prompt-families=all --models=gpt-5.4-mini --runs=1

node tests/benchmark/graph/run-suite.mjs --arm=baseline --runs=5 --harness=codex
node tests/benchmark/graph/run-suite.mjs --arm=graph --runs=1 --harness=codex

node tests/benchmark/graph/audit-codex-traces.mjs --report=<report.json>
node tests/benchmark/graph/index-time.mjs --all --tools=all
node tests/benchmark/graph/publish.mjs --from=<output-directory>
```

Common selectors include `--project=a,b`, `--prompt-family=dedicated|common`,
`--tools=samchon-graph,codegraph,codebase-memory,serena`, `--models=<ids>`,
`--runs=N`, `--max-run-retries=N`, `--no-setup`, and `--no-website`.

## Acceptance

A publishable sweep has all requested cells, non-empty raw samples, exact model
versions, the pinned question hash and commit, traces that pass the audit, no
unexplained source-file fallback in the graph arm, and cold-index cells measured
sequentially on one documented quiet host. Each cold-index report and cell binds
the full fixture commit; the fold, summary, and SVG/PNG renderer reject or omit
revisionless and stale measurements instead of joining them to the current
corpus. After publication, run the reference SVG generator with `--png`; its
tests assert deterministic SVG/PNG bytes and exact 2x raster dimensions.
