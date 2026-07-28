# `@samchon/graph` benchmark system

This is the `@ttsc/graph` benchmark architecture, generalized only at the
fixture boundary: thirteen language-server-backed repositories replace the
TypeScript-only fixture set. Prompts, A/B isolation, trace accounting, validity
gates, publication, cold-index timing, and SVG/PNG rendering follow the same
system.

## Layout

- `graph.mjs`: one-shot orchestrator across repos, tools, models, and prompt
  families; publishes each valid cell as it completes and resumes from reports.
- `graph/agent-ab.mjs`, `graph/agent-ab-codex.mjs`: isolated Claude Code and
  Codex A/B harnesses.
- `graph/run-suite.mjs`: fixed-baseline measure/improve loop.
- `graph/audit-codex-traces.mjs`: full trace and answer-behavior audit.
- `graph/index-time.mjs`: quiet-host cold readiness benchmark.
- `graph/publish.mjs`: lossless upsert into `results/graph.json`.
- `build/graph-benchmark-svg.cjs`, `build/svg-to-png.cjs`: the reference chart
  and 2x PNG generators ported from `ttsc`.
- `graph/corpus.mjs`, `graph/questions/manifest.json`: exact fixture commits and
  SHA-256-pinned dedicated/common utterances.

## Zero-spend verification

```bash
pnpm --filter @samchon/graph build
pnpm --filter @samchon/graph-benchmark test
pnpm --filter @samchon/graph-benchmark corpus
pnpm --filter @samchon/graph-benchmark preflight
```

`preflight` clones the pinned commits, installs required project dependencies,
runs per-language preparation, and demands a non-static language-server graph.
It never invokes an LLM.

## Paid agent benchmark

Paid runs are manual only. A baseline is measured once and reused; graph arms
are rerun while the product changes.

```bash
# One-time baseline, n=5
node tests/benchmark/graph/run-suite.mjs \
  --arm=baseline --runs=5 --harness=codex --model=gpt-5.4-mini

# Product iteration, n=1
node tests/benchmark/graph/run-suite.mjs \
  --arm=graph --runs=1 --harness=codex --model=gpt-5.4-mini

# Full publication matrix: publish the shared baseline once, then every tool.
node tests/benchmark/graph.mjs --all --arm=baseline --tools=baseline --prompt-families=all --models=gpt-5.4-mini --runs=1
node tests/benchmark/graph.mjs --all --arm=graph --tools=all --prompt-families=all --models=gpt-5.4-mini --runs=1

# A graph-only subset while iterating
node tests/benchmark/graph.mjs --project=gin,flask --arm=graph --tools=samchon-graph --runs=1
```

Every cell records the exact repo commit, language, prompt id/hash, harness,
model version, effort, retries, raw per-run token/tool/time counters, answer,
and trace location. Zero-token/capacity failures retry; a run that spent tokens
is retained and judged by the trace audit rather than silently discarded.

## Cold readiness and publication

```bash
node tests/benchmark/graph/index-time.mjs --all --tools=all
node tests/benchmark/graph/publish.mjs --from <suite-output-directory>
node tests/benchmark/build/graph-benchmark-svg.cjs --png
```

Each project measures its strict and strict-off cells sequentially on one quiet
host; the complete matrix uses an isolated runner per project so unrelated
languages do not compete for that host. Every published cold-index cell carries
its full fixture commit and its own host block; a stored cell whose revision no
longer matches `corpus.mjs` is not summarized or preserved by a later fold.
`results/graph.json` keeps the raw samples. The summary reports a strict-provider
time ratio only when both cells produced semantic indexes in the same
measurement on the same host; a completed static fallback or a cell retained
from another run remains visible as raw time and is explicitly non-comparable.
Medians and savings are derived by the renderer. The renderer writes grouped,
per-repository, and cold-time SVGs plus pixel-checked 2x PNG siblings under
`results/svg` and `results/png`.

See [`graph/README.md`](graph/README.md) for the reference runner's detailed
flags and validity semantics.
