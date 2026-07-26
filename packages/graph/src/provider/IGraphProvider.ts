import { IBuildGraphOptions } from "../indexer/IBuildGraphOptions";
import {
  GraphEdgeKind,
  GraphLanguage,
  GraphProviderAuthority,
} from "../typings";
import { IBulkGraphSession } from "./IBulkGraphSession";

/**
 * One registered strict provider: which languages it owns, how it is found on
 * a given project, and how a session is opened against it.
 *
 * The indexer used to decide this inline. `buildLspGraph` asked
 * `language === "typescript"`, resolved `ttscgraph`, and constructed a
 * `TtscGraphClient` in the middle of its language loop. Adding a second
 * provider that way adds a second branch, and a fifteenth adds a fifteenth:
 * the loop becomes the registry, except that nothing can enumerate it, no test
 * can ask it what it supports, and the audit prose that calls every semantic
 * fact a "language server" fact has no way to learn that a compiler produced
 * this one.
 *
 * So a provider states its own terms. It says which languages it owns, what
 * its facts are grounded in, whether it can honour the caller's options at
 * all, where its executable lives, and what preparation the project needs
 * before it will answer. The indexer's job shrinks to asking, in order, and
 * reporting what it was told.
 */
export interface IGraphProvider {
  /**
   * Stable registry identity, such as `ttscgraph` or `scip-go`.
   *
   * It is published in dump provenance and named in fallback warnings, so it
   * is the provider's contract with a reader rather than a display string.
   */
  readonly name: string;

  /**
   * Every language this provider owns as one atomic slice. Never empty.
   *
   * A set rather than a single language because one compilation universe can
   * span more than one of them and the graph must not pretend otherwise: a
   * Clang provider that indexes a project's C and C++ translation units
   * resolves cross-slice edges that neither language owns alone, and
   * publishing them as two independently produced slices would claim an
   * atomicity that never existed.
   */
  readonly languages: readonly GraphLanguage[];

  /**
   * What this provider's facts are grounded in.
   *
   * A consumer degrades against this rather than against the provider's name,
   * and the result audit reports it, because "the compiler resolved this" and
   * "an index built from a navigation skeleton reports this" are different
   * claims that a reader is entitled to tell apart.
   */
  readonly authority: GraphProviderAuthority;

  /**
   * The edge families this provider may publish.
   *
   * A provider must not claim a family its payload cannot prove, and the
   * coordinator holds it to exactly this list: a snapshot carrying an edge of
   * an unclaimed family is rejected rather than quietly accepted. That is the
   * difference between a provider that cannot prove calls and one that proves
   * a symbol has none — a distinction no reader can recover from an empty
   * array.
   */
  readonly facts: readonly GraphEdgeKind[];

  /**
   * Why this provider cannot serve a build with these options, or `undefined`
   * when it can.
   *
   * Refusing is a statement, not a silence. A provider that cannot honour a
   * bounded index says so, and the indexer records that sentence as the reason
   * the language fell through — the failure this replaces was a condition
   * folded into the call site with no `else`, which turned every capped run
   * into a fallback success indistinguishable from the compiler-owned result
   * it silently replaced.
   */
  refuse(options: IBuildGraphOptions): string | undefined;

  /**
   * Resolve this provider's executable for `root`, or `undefined` when it is
   * not installed for this project.
   *
   * A project-local tool always wins over a global one when the project
   * declares it; a resolver that consults PATH first would let a stale global
   * install shadow the version the project pinned.
   */
  resolve(
    root: string,
    env: NodeJS.ProcessEnv,
  ): IGraphProvider.ICommand | undefined;

  /**
   * Build inputs outside this provider's own source extensions whose change
   * invalidates its snapshot, as project-relative file names.
   *
   * The project transaction takes the union across every participating
   * provider, because a changed `CMakeLists.txt` or `go.mod` can move a file
   * set that no `.cpp` or `.go` edit touched, and a freshness check that
   * watched only source extensions would call that project unchanged.
   */
  readonly buildInputs?:
    | readonly string[]
    | ((root: string) => readonly string[]);

  /** Non-file effective settings used to detect resident authority changes. */
  readonly configuration?: (
    root: string,
    env: NodeJS.ProcessEnv,
  ) => readonly string[];

  /**
   * Bring the project to the state this provider needs before it can answer —
   * a generated compilation database, a resolved package config.
   *
   * Throwing declines the candidate with that reason rather than failing the
   * build: an unprepared project is a fallback condition, not a crash.
   */
  prepare?(root: string, options: IBuildGraphOptions): void;

  /** Open a strict session for the languages this candidate owns. */
  open(props: IGraphProvider.IOpenProps): IBulkGraphSession;
}

export namespace IGraphProvider {
  /** A resolved executable and the arguments that precede the provider's own. */
  export interface ICommand {
    command: string;
    args: readonly string[];
    /** Arguments are already quoted for cmd.exe and must reach it verbatim. */
    windowsVerbatimArguments?: boolean;
    /** npm command shims reparse forwarded arguments through a second cmd. */
    windowsDoubleEscapeArguments?: boolean;
  }

  /** Everything a session needs that only the coordinator knows. */
  export interface IOpenProps {
    /** Absolute project root the session indexes. */
    root: string;

    /** The resolved executable for this project. */
    command: ICommand;

    /** The languages this candidate owns — never empty, never overlapping. */
    languages: readonly GraphLanguage[];

    /** The caller's build options, already proved acceptable by {@link refuse}. */
    options: IBuildGraphOptions;
  }
}
