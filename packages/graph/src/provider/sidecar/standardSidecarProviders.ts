import { IGraphProvider } from "../IGraphProvider";

/**
 * Empty, and that is the finished state rather than an unfinished one.
 *
 * This list held five entries that each named a `samchon-graph-<language>`
 * program and claimed all thirteen fact families. No such program was ever
 * written for any of them, so every build in those languages resolved nothing
 * and fell through — while the registry went on advertising a producer that
 * could prove everything. A claim with no producer behind it is worse than an
 * absent entry, because absence is legible and a claim is not.
 *
 * Three of the five left by being replaced. dart and php named a program that
 * did not exist while a real indexer already did — `scip_dart` on pub.dev,
 * `scip-php` on Packagist — so those were not unfinished work but the wrong
 * architecture, and both now sit in `standardScipProviders`. lua had no upstream
 * indexer at all, which made the name honest, and it left anyway: the language
 * server's `--doc` export accepts a replacement exporter and hands it the `vm`
 * analysis engine, so the producer became a script inside the server rather than
 * a program beside it, in `provider/lua`.
 *
 * The last two leave by being withdrawn, because for each the honest answer is
 * not a program yet.
 *
 * **swift.** The channel is settled: `swift build` emits an index store during
 * an ordinary debug build, and its records carry `RelChild`, so an occurrence
 * arrives already naming the declaration that encloses it — the one thing lua's
 * exporter could not answer. But the store's on-disk format is toolchain
 * internal, versioned `v5` with no third-party stability claim, and described
 * conceptually rather than as a binary specification. Reading it means linking
 * IndexStoreDB, so the producer must be a compiled Swift program. That is
 * well-defined work nobody has started, and swift is not in the benchmark
 * corpus, so nothing here can yet be measured either.
 *
 * **zig.** There is a channel, and it is stranger. ZLS has no batch mode, but
 * `zig build-obj -femit-docs` emits `sources.tar` beside a `main.wasm` that is
 * itself the analyzer — since the autodoc redesign the compiler stopped emitting
 * machine-readable analysis and the work moved into that module, which the docs
 * page drives from JavaScript. Node can drive it the same way. Walking
 * `find_module_root` into `namespace_members` reaches every declaration with a
 * name, a qualified name, a file path and a parent.
 *
 * Nothing exposes a reference or a callee, and not by oversight: the analysis
 * runs over ZIR, which is untyped and sits before semantic analysis. So a zig
 * provider could claim `contains` and little else, while the ZLS lane it would
 * displace does answer references. Selection is per language rather than per
 * fact family, so registering it would trade coverage for strictness — the
 * opposite of every other entry in this registry. #158 states both readings; it
 * is a decision, not an implementation task.
 *
 * When either producer exists, it arrives as its own entry with the fact list it
 * can actually prove, the way the go sidecar and the lua provider did.
 */
export const standardSidecarProviders: readonly IGraphProvider[] = [];
