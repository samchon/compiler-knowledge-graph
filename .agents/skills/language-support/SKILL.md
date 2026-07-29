---
name: language-support
description: Defines how @samchon/graph keeps its supported-language registry, LSP configuration, static fallback, CLI and MCP names, deterministic fixtures, real-server experiments, workflows, and documentation synchronized. Use before adding or changing a language, extension, language-server command, language-specific preparation, parser rule, or support claim; do not use for language-agnostic ranking or MCP operation changes.
---

# Language Support

## Support Contract

A supported language has two product lanes:

- The LSP lane resolves semantic symbols, references, inheritance, diagnostics, and live refresh through an installed language server.
- The separately packaged graph-sitter lane returns a best-effort syntax graph when the server is absent or fails. `auto` may therefore produce an `lsp`, `hybrid`, or `static` dump without losing the languages that fell back; this lane must not be described as compiler-resolved truth.

Support is not established by adding an extension to one array. Keep every owning surface synchronized and prove both lanes separately.

JavaScript remains intentionally unsupported. Do not add `.js`, `.jsx`, `.mjs`, or `.cjs` merely because the TypeScript parser can recognize them; the product lacks repository-independent provenance for distinguishing source from generated and vendored JavaScript.

## Ownership Map

| Concern | Owner |
| --- | --- |
| Public language union | `packages/graph/src/typings/GraphLanguage.ts` |
| Extensions, default server, arguments, comment syntax | `packages/graph/src/indexer/LANGUAGE_SPECS.ts` |
| Extension lookup and discovery | `packages/graph/src/indexer/{allExtensions,languageOf,discoverLanguages}.ts` |
| LSP document language id | `packages/graph/src/indexer/languageIdOf.ts` |
| Static project discovery and graph merge adapter | `packages/graph/src/indexer/staticGraphParts.ts` |
| Best-effort declarations, packages, imports, calls, inheritance | `packages/graph-sitter/src/indexer/staticGraphParts.ts` and its helpers |
| MCP display name | `packages/graph/src/mcp/languageDisplayNameOf.ts` |
| CLI acceptance | `packages/graph/src/parseGraphArgs.ts`, derived from `LANGUAGE_SPECS` |
| Deterministic corpus | `tests/test-graph/src/internal/GraphFixtures.ts` and language feature tests |
| Real-server fixture and gates | `tests/experiment/src/catalog.mjs` |
| Server installation | `tests/experiment/src/setup-language.mjs` |
| Real-server execution | `tests/experiment/src/run-language.mjs` |
| CI matrix | `.github/workflows/experiment.yml` |
| User claim and installation instructions | `README.md` |

Read the nearby implementation before deciding which helper owns a syntax family. The graph-sitter parser intentionally shares some patterns and separates others by language semantics; extend its existing table or branch instead of adding a second syntax registry.

Use the paths in this ownership map as the planning and implementation surface. Canonical semantic source is `packages/graph/src`, best-effort syntax source is `packages/graph-sitter/src`, deterministic tests are under `tests/test-graph`, and real-server experiments are under `tests/experiment`; do not substitute generic `src`, `test`, or `experiments` paths from another repository's conventions.

## Add Or Change A Language

1. Define the language in `GraphLanguage` and `LANGUAGE_SPECS`, including every supported source extension, the exact stdio server command and arguments, and line-comment syntax.
2. Add or update the MCP display name and any language-id mapping whose protocol identifier differs from the public name.
3. Extend the static fallback for the language's declarations, ownership, imports, inheritance, calls, package/module forms, decorators or annotations, exports, and file resolution as applicable. Avoid claiming semantic precision the static parser does not have.
4. Add a minimal but representative `GraphFixtures.languageFixtures` entry. Keep `test_language_registry_lists_advertised_targets` and `test_static_fallback_indexes_every_advertised_language` as the mechanical completeness gates.
5. Add the real-server repository, thresholds, preparation, and setup recipe under `tests/experiment`. Every catalog row states either a `strictProvider` with its authority, capabilities, fact families, failure policy, and lifecycle fixture, or a `feasibilityBlocked` sentence naming what prevents a strict producer; the runner refuses a row that states neither, so a language cannot join the bounded generic lane by omission. Add the language to `.github/workflows/experiment.yml`; install toolchain components only in the language's selected job.
6. Update the root README's support and installation tables. Do not edit `packages/graph/README.md`, which the build regenerates.
7. Change the benchmark corpus only when the benchmark's own selection contract calls for that language. Product support and benchmark membership are different sets; follow the benchmark skill before modifying prompts, pinned commits, or result cells.

## LSP Integrity

- Resolve installed commands through the existing platform-aware path. Windows npm `.cmd` and `.bat` shims require the `cmd.exe` wrapper; do not regress direct POSIX executables.
- C and C++ share `clangd` and one compilation database. Preserve the single preparation step and the `--compile-commands-dir` handoff.
- Dart may require `pub get`; other servers may require a restored project, SDK selection, or repository preparation. Keep those prerequisites explicit in the experiment fixture instead of hiding them in general indexing.
- A server returning no symbols, failing to initialize, or disappearing mid-scan must close its process and fall back without leaking the session.
- Reference failures may degrade edges without discarding valid symbols. A real-server experiment's `minEdges` should be raised only after that server has empirically produced stable relationships.
- Resident sessions must reconcile changed, created, and deleted files and replace diagnostics per document. One-shot callers must close every session.

## Validation

This repository has no `pnpm lint` or `pnpm typecheck` scripts. Do not invent generic validation commands. Use the package-local analysis command and the repository's actual gates:

```bash
pnpm --dir packages/graph-sitter exec ttsc check -p tsconfig.json
pnpm --dir packages/graph exec ttsc check -p tsconfig.json
pnpm test
pnpm coverage
```

Run the registry and static completeness tests for every language-surface change:

```bash
pnpm --filter @samchon/graph-test start -- --include=language_registry_lists_advertised_targets
pnpm --filter @samchon/graph-test start -- --include=static_fallback_indexes_every_advertised_language
```

Run the narrow fake-LSP regression that covers the changed protocol or lifecycle branch, then the real server when available:

```bash
pnpm --filter @samchon/graph-experiment run setup -- --language <language>
pnpm --filter @samchon/graph-experiment start -- --language <language>
```

The experiment `setup` recipes may invoke `sudo`, install global npm/gem/Go/.NET tools, run `rustup`, or download toolchains. Do not run setup merely as routine local validation; use an already prepared environment, the explicit experiment workflow, or separate user authorization for those system changes.

Finish shared parser or LSP changes with `pnpm test` and `pnpm coverage`. A new language is not complete until the deterministic static lane, real-server experiment definition, CI matrix, and README claim agree, even if the local machine cannot install the server.
