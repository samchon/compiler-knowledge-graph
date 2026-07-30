# `@samchon/graph`

![Logo](https://raw.githubusercontent.com/samchon/graph/master/assets/og.jpg)

[![GitHub license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/samchon/graph/blob/master/LICENSE) [![NPM Version](https://img.shields.io/npm/v/@samchon/graph.svg)](https://www.npmjs.com/package/@samchon/graph) [![NPM Downloads](https://img.shields.io/npm/dm/@samchon/graph.svg)](https://www.npmjs.com/package/@samchon/graph) [![Build Status](https://github.com/samchon/graph/workflows/test/badge.svg)](https://github.com/samchon/graph/actions?query=workflow%3Atest)

`@samchon/graph` is an MCP server that gives AI agents a code graph instead of source files.

It indexes a codebase in 16 languages into a graph of declarations and their relationships, and answers an agent's code questions from that index through a single tool. A compiler-owned provider supplies semantic edges where one is available, then the language server, and finally the separately packaged `@samchon/graph-sitter` best-effort fallback.

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
| TypeScript | `ttscgraph` / `ttscserver` | `npm i -D ttsc@^0.20.1 typescript` |
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

Before the generic lane runs, indexing asks a registry of strict providers which languages they own. A provider states what its facts are grounded in — a compiler, a whole-project analyzer, or a precomputed semantic index — and which edge families it can prove; a snapshot that publishes outside those is rejected rather than merged. Whatever no provider claims falls through to the language server, and then to the static indexer. Every decline is one sentence naming the provider and the authority the build gave up, so a fallback is never mistaken for the strict result it replaced.

The dump carries one `provenance` row per contributing provider: its authority, the fact families it proves, the producing tool and versions, a fingerprint of the inputs that decided the file set, and digests over the manifest and the published facts. Absent when no strict provider served the build. What a provider *did* to compute a generation is deliberately not recorded there — that belongs to one refresh rather than to the facts, and writing it down would make two dumps of the same unedited checkout differ.

TypeScript's provider is the compiler-owned `ttscgraph` snapshot. The binary is resolved from the target project's `ttsc` installation; `TTSC_GRAPH_BINARY` can point to an exact absolute binary for development or release verification. If the binary is unavailable, its schema/provenance cannot be trusted, or the requested build is deliberately capped, indexing states the reason and falls back to `ttscserver`, then to the static indexer when no server is available. `ttscgraph` schema 6 is the complete portable contract: paths are relative to the producer's project (including `../` siblings), virtual libraries use `bundled:///`, and declarations may carry compiler-bounded signatures. Older producers are refused and indexing falls back honestly to `ttscserver`.

Go's compiler-owned provider is shipped with this package and runs through Go 1.25 or newer. Its navigation corroboration is pinned to `scip-go` 0.2.7; install that exact producer with `go install github.com/scip-code/scip-go/cmd/scip-go@v0.2.7`. A project-local or `PATH` `samchon-graph-go` binary takes precedence over the bundled source runner, `SAMCHON_GRAPH_GO` can select an absolute development build, and `SAMCHON_GRAPH_SCIP_GO` can select an absolute `scip-go` binary. Without the required Go toolchain or pinned indexer, indexing reports the strict-provider decline and retains the generic `gopls` fallback.

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

| Project | Language | First index |
|---|---|---|
| [slim](https://github.com/slimphp/Slim) | PHP | 5s |
| [excalidraw](https://github.com/excalidraw/excalidraw) | TypeScript | 5s |
| [gin](https://github.com/gin-gonic/gin) | Go | 15s |
| [leveldb](https://github.com/google/leveldb) | C++ | 16s |
| [darthttp](https://github.com/dart-lang/http) | Dart | 23s |
| [lualine](https://github.com/nvim-lualine/lualine.nvim) | Lua | 25s |
| [flask](https://github.com/pallets/flask) | Python | 55s |
| [gson](https://github.com/google/gson) | Java | 2m22s |
| [sinatra](https://github.com/sinatra/sinatra) | Ruby | 2m35s |
| [redis](https://github.com/redis/redis) | C | 2m50s |
| [tokio](https://github.com/tokio-rs/tokio) | Rust | 3m |
| [koin](https://github.com/InsertKoinIO/koin) | Kotlin | 19m25s |
| [serilog](https://github.com/serilog/serilog) | C# | not recorded |

One-time cost per repository. The server re-scans only changed files after that (see [How it works](#how-it-works)); later calls are free.

kotlin-language-server, jdtls, and csharp-ls are particularly slow: each resolves the whole project before answering anything.

TypeScript and Go already close that gap through compiler-owned snapshots. The remaining languages use their listed language servers until their compiler-owned bulk providers land.

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
   * Answer a __LANG__ question from this repository's own program index.
   *
   * The graph returns proved indexed facts plus structured coverage and
   * uncertainty. Submit exactly one request:
   *
   * - `tour`: architecture, the runtime flow from the public API to the code that
   *   does the work, nearby paths, and the tests to read — a whole orientation
   *   in one call
   * - `trace`: what a symbol calls, what calls it, or the path from A to B
   * - `details`: signatures, members, and what implements an interface
   * - `lookup`: where a named symbol is declared
   * - `entrypoints`: where execution starts, when the entry is unknown
   * - `overview`: the project's layers and folder structure
   *
   * Every fact in a result is checked against the index before return, so no
   * fact needs verifying; for the ranked operations (`lookup`, `entrypoints`,
   * `tour`), judge whether the shortlist covers your question. Read a file for
   * what the graph does not carry: a body or the text inside a span.
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
     * synchronized graph. Absent only for `escape` or a legacy/fallback-only
     * dump with no strict producer.
     */
    provenance?: ISamchonGraphDump.IProvenance[];

    /**
     * Machine-readable completeness for the relationship families relevant to
     * this operation. Absent only for `escape`.
     */
    coverage?: ISamchonGraphCoverageSummary;

    /**
     * Bounded structured uncertainty for the same operation-scoped families.
     * Absent only for `escape`.
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
