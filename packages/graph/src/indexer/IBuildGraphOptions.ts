import { GraphLanguage } from "../typings";

export interface IBuildGraphOptions {
  cwd?: string;
  mode?: "auto" | "lsp" | "static";

  /**
   * Whether strict providers may serve. Defaults to true.
   *
   * Standing them down is a measurement instrument, not a fallback: it is the
   * only way to index a project without its strict provider that does not work
   * by tripping a refusal, and a refusal is a different thing to measure.
   */
  strict?: boolean;
  languages?: GraphLanguage[];
  server?: string;
  serverArgs?: string[];
  initializationOptions?: unknown;
  /**
   * Maximum number of source files to index. Undefined indexes every file.
   */
  maxFiles?: number;
  /**
   * Maximum number of symbols whose references are collected. Undefined
   * collects references for every symbol.
   */
  lspReferenceLimit?: number;
  /**
   * Per-request LSP deadline in milliseconds. Undefined waits without a
   * deadline; experiment callers may opt into a finite budget.
   */
  lspTimeoutMs?: number;
  /**
   * Maximum UTF-8 byte length of one inbound LSP JSON-RPC payload. The client
   * rejects a larger declared frame before buffering its body and terminates
   * the owned server process. Defaults to 256 MiB.
   */
  lspMaxMessageBytes?: number;
  /**
   * How many `textDocument/references` requests to keep in flight at once.
   * Reference collection dominates indexing time on large repositories, and the
   * requests are independent, so they are issued concurrently up to this bound.
   * This is a concurrency lane count, not a cap on how many symbols are
   * resolved; every symbol is collected unless `lspReferenceLimit` is set.
   */
  lspConcurrency?: number;
  /**
   * Maximum time to wait for initial indexing progress to settle. Undefined
   * keeps waiting while the server reports progress.
   */
  lspReadyTimeoutMs?: number;
  /**
   * How long the server must stay silent on lifecycle-less `$/progress`
   * reports before its initial indexing is treated as settled. A work-done
   * `begin` is always awaited through its matching `end` unless
   * `lspReadyTimeoutMs` supplies an overall ceiling.
   */
  lspReadyQuietMs?: number;
  /**
   * Deadline for the first reference request that warms a server's lazy index.
   * Undefined waits without a deadline.
   */
  lspWarmupTimeoutMs?: number;
  /**
   * Keep each language's LSP connection open after the build instead of
   * closing it. The caller becomes responsible for the returned sessions:
   * refresh them via `refreshLanguageSession` and close them when done, or
   * they leak. Only the resident MCP server path sets this; the one-shot
   * `dump` CLI command never does.
   */
  keepAlive?: boolean;
  /**
   * Abort an in-flight compiler-owned snapshot or generic LSP build.
   *
   * Resident graph sources use this to make shutdown reach an owned provider
   * immediately instead of waiting behind its serialized refresh. Generic LSP
   * initialization, indexing readiness, and graph requests all consume it; an
   * aborted build closes the unpublished language-server session before it
   * rejects.
   */
  signal?: AbortSignal;
  /**
   * Command (and any leading arguments) used to bootstrap a missing
   * `compile_commands.json` for cpp/c projects that configure CMake.
   * Defaults to `["cmake"]`; overridable so tests can substitute a fake
   * binary instead of depending on a real cmake install.
   */
  cmakeCommand?: string[];
  /**
   * Command (and any leading arguments) used to run `pub get` for dart
   * packages missing a resolved `.dart_tool/package_config.json`. Defaults
   * to `["dart"]`; overridable so tests can substitute a fake binary instead
   * of depending on a real dart install or network access.
   */
  pubCommand?: string[];
}
