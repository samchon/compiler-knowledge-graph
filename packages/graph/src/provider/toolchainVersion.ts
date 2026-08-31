import { spawnSync } from "node:child_process";

import { isSpawnableFile } from "../utils/isSpawnableFile";
import { spawnableCommand } from "../utils/spawnableCommand";
import { IGraphProvider } from "./IGraphProvider";
import { resolveProviderCommand } from "./resolveProviderCommand";

/**
 * Observe one toolchain as a single configuration row.
 *
 * A toolchain observation has four outcomes. Resolution completed and found
 * nothing (`unavailable`), the command completed without a usable version
 * (`unreported`), the command answered with a version, or the lookup/probe
 * observation did not complete conclusively (`unasked`). The first three are
 * conclusive configuration facts. The fourth says nothing about the tool and
 * stays typed as inconclusive evidence instead of pretending absence or
 * silence.
 *
 * Both process seams preserve that distinction.
 * {@link resolveProviderCommand} reports whether its `PATH` lookup completed,
 * and {@link probe} distinguishes normal completion from a `spawnSync` error,
 * signal, or timeout. A transient launch failure therefore cannot move a build
 * universe by changing an installed tool into an absent one.
 *
 * {@link toolchainVersion.reestablish} restores an unasked row only from the
 * last conclusive row with the same private identity. It does not restore a
 * sibling compiler that happens to share a display label, and it does not roll
 * back other rows that were freshly established in the same derivation. A
 * serving provider avoids the question entirely because its topology snapshot
 * no longer re-derives configuration; non-serving candidates are reestablished
 * row by row before the resident source compares their freshly probed topology.
 *
 * The probe runs every time, and deliberately. A version is not a property of
 * the file: `rustc`, `python3`, `ruby`, `java`, and `dotnet` are all normally
 * dispatcher shims — rustup, pyenv, rbenv, jenv, asdf, the .NET muxer — whose
 * answer is decided by the working directory and the environment, and which
 * report a new version after an in-place upgrade that leaves the shim
 * byte-identical. This repository already knows that: `global.json`, the file
 * that picks a project's .NET SDK, is one of `scip-dotnet`'s declared build
 * inputs.
 */
export function toolchainVersion(props: toolchainVersion.IProps): string {
  return toolchainVersion.observe(props).row;
}

export namespace toolchainVersion {
  /**
   * One visible configuration row together with whether its derivation
   * established a fact.
   *
   * The row deliberately remains a string for fingerprints and provenance.
   * Inconclusiveness is separate metadata: configuration values are public and
   * arbitrary, so a literal setting such as `PATH=unasked` must never be
   * mistaken for an internal probe outcome merely because its spelling
   * resembles one.
   */
  export interface IObservation {
    row: string;
    inconclusive: boolean;
    identity?: string;
  }

  /** Visible configuration rows plus the exact rows that established nothing. */
  export interface IDerivation {
    rows: readonly string[];
    inconclusive: readonly number[];
    /** Stable private identities aligned with {@link rows}. */
    identities: readonly (string | undefined)[];
  }

  export type Input = string | IObservation;

  /** Derive one toolchain row without discarding its evidence state. */
  export function observe(props: IProps): IObservation {
    const label = props.label ?? props.command;
    const identity = props.identity ?? label;
    const resolution =
      props.resolved === undefined
        ? attempt(props)
        : { command: props.resolved, asked: true };
    if (resolution.command === undefined) {
      return resolution.asked
        ? conclusive(`${label}=unavailable`, identity)
        : unasked(label, identity);
    }
    const observed = probe(resolution.command, props);
    if (observed.version !== undefined) {
      return conclusive(`${label}=${observed.version}`, identity);
    }
    return observed.completed
      ? conclusive(`${label}=unreported`, identity)
      : unasked(label, identity);
  }

  export interface IProps {
    root: string;
    env: NodeJS.ProcessEnv;

    /** The executable to probe, resolved through the provider command rules. */
    command: string;

    /** Environment variable naming an absolute development build, if any. */
    override?: string;

    /** The probe arguments, such as `--version` or `-vV`. */
    args: readonly string[];

    /** What the row is called, when that differs from the command's name. */
    label?: string;

    /**
     * Stable private identity used to match this tool across derivations.
     *
     * Distinct compiler paths can deliberately share one portable display
     * label. Their path-derived identities stay internal while preventing one
     * driver's failed probe from restoring a sibling driver's version.
     */
    identity?: string;

    /**
     * Probe exactly this file rather than resolving `command`.
     *
     * A project's own build description can name its compiler by absolute
     * path — `compile_commands.json` records the driver each translation unit
     * was compiled with — and that file is the answer, not whatever program of
     * the same basename happens to be on this machine's `PATH`.
     */
    executable?: string;

    /**
     * The invocation this row describes, when the caller already resolved it.
     *
     * Deciding whether a toolchain exists and reading its version are the same
     * lookup asked twice, and on Windows a lookup that misses the project's own
     * bin is a `where.exe` launch. Every extra launch is another chance for a
     * hiccup to report an installed tool as absent — which moves a build
     * universe that nothing about the project moved.
     */
    resolved?: IGraphProvider.ICommand;
  }

  /**
   * The program this row describes, or `undefined` when it is not installed.
   *
   * Separate from the row so a provider can make resolution a precondition:
   * a snapshot states which toolchain resolved its facts, and one that cannot
   * answer should decline rather than publish `unavailable` into the field a
   * consumer degrades against.
   */
  export function resolve(
    props: IProps,
  ): IGraphProvider.ICommand | undefined {
    return attempt(props).command;
  }

  /**
   * The program, and whether finding out was possible at all.
   *
   * A named file is decided by reading the filesystem, so the question always
   * gets put. A command may end in a `PATH` lookup, which is itself a process
   * launch and can fail to run — and a lookup that never ran says nothing about
   * whether the tool is installed.
   */
  export function attempt(props: IProps): resolveProviderCommand.IAttempt {
    if (props.executable !== undefined) {
      return isSpawnableFile(props.executable)
        ? {
            command: spawnableCommand(props.executable, [], props.env),
            asked: true,
          }
        : { asked: true };
    }
    return resolveProviderCommand.attempt(props.root, props.env, {
      command: props.command,
      ...(props.override === undefined ? {} : { override: props.override }),
    });
  }

  /** The visible value used when a toolchain question could not be put. */
  export const UNASKED = "=unasked";

  /** Mark a visible row as an ordinary, established configuration fact. */
  export function conclusive(
    row: string,
    identity: string = label(row),
  ): IObservation {
    return { row, inconclusive: false, identity };
  }

  /** Mark a toolchain question as one that could not be put. */
  export function unasked(
    label: string,
    identity: string = label,
  ): IObservation {
    return {
      row: `${label}${UNASKED}`,
      inconclusive: true,
      identity,
    };
  }

  /**
   * Preserve the evidence state of each row in one configuration derivation.
   *
   * Plain strings are intentionally conclusive. Public provider configuration
   * accepts arbitrary strings, and no spelling inside that public value space
   * is reserved for internal control flow.
   */
  export function derive(entries: readonly Input[]): IDerivation {
    const rows: string[] = [];
    const inconclusive: number[] = [];
    const identities: (string | undefined)[] = [];
    for (const entry of entries) {
      const observation =
        typeof entry === "string"
          ? {
              row: entry,
              inconclusive: false,
              identity: undefined,
            }
          : entry;
      if (observation.inconclusive) inconclusive.push(rows.length);
      rows.push(observation.row);
      identities.push(observation.identity);
    }
    return { rows, inconclusive, identities };
  }

  /** Treat legacy string-only configuration as fully established evidence. */
  export function normalize(
    value: readonly string[] | IDerivation,
  ): IDerivation {
    if (!isDerivation(value)) return derive(value);
    const inconclusive = [...value.inconclusive];
    const derivation: IDerivation = {
      rows: [...value.rows],
      inconclusive,
      identities: [...value.identities],
    };
    validate(derivation);
    inconclusive.sort((left, right) => left - right);
    return derivation;
  }

  /** Sort visible rows without detaching their evidence metadata. */
  export function sort(value: readonly string[] | IDerivation): IDerivation {
    const normalized = normalize(value);
    const unresolved = new Set(normalized.inconclusive);
    return derive(
      normalized.rows
        .map((row, index) =>
          observation(
            row,
            unresolved.has(index),
            normalized.identities[index],
          ),
        )
        .sort((left, right) => compareOrdinal(left.row, right.row)),
    );
  }

  /** Whether any row in this derivation failed to establish anything. */
  export function inconclusive(derivation: IDerivation): boolean {
    return derivation.inconclusive.length !== 0;
  }

  /** The visible rows whose derivations established nothing. */
  export function unresolved(derivation: IDerivation): readonly string[] {
    return derivation.inconclusive.map((index) => derivation.rows[index]!);
  }

  /**
   * This derivation, with each unasked row restored from the last one that
   * established something.
   *
   * Row by row, and that is the whole point. Substituting the entire previous
   * derivation whenever any single row went unasked was wrong in a way that is
   * worse than the bug it fixed: a configuration is several rows — an indexer,
   * `scip`, and every toolchain program — so one probe failing to launch also
   * discarded the rows that had just been derived successfully. A user who set
   * `GOFLAGS` and whose `go` probe happened to fail in the same refresh got the
   * old flags back, a universe that did not move, and an index built with
   * settings they had changed. On a host where that probe always fails to
   * start, the session would never notice a configuration change again.
   *
   * A tool observation carries a stable private identity independent of its
   * visible label. This matters for compilation databases: two distinct driver
   * paths can both publish `clang=...`, and a failed probe must restore only
   * the same driver. A row with no matching established identity stays unasked
   * rather than being invented.
   */
  export function reestablish(
    live: IDerivation,
    established: IDerivation | undefined,
  ): IDerivation {
    const current = normalize(live);
    if (established === undefined || !inconclusive(current)) return current;
    const previousEvidence = normalize(established);
    const priorUnresolved = new Set(previousEvidence.inconclusive);
    const prior = new Map<string, string[]>();
    previousEvidence.rows.forEach((row, index) => {
      const identity = previousEvidence.identities[index];
      if (identity === undefined || priorUnresolved.has(index)) return;
      const rows = prior.get(identity) ?? [];
      rows.push(row);
      prior.set(identity, rows);
    });
    const liveUnresolved = new Set(current.inconclusive);
    return derive(
      current.rows.map((row, index) => {
        const identity = current.identities[index];
        const previous =
          identity === undefined ? undefined : prior.get(identity)?.shift();
        if (!liveUnresolved.has(index)) {
          return observation(row, false, identity);
        }
        return previous === undefined
          ? observation(row, true, identity)
          : conclusive(previous, identity);
      }),
    );
  }

  function observation(
    row: string,
    inconclusive: boolean,
    identity: string | undefined,
  ): IObservation {
    return {
      row,
      inconclusive,
      ...(identity === undefined ? {} : { identity }),
    };
  }

  function isDerivation(
    value: readonly string[] | IDerivation,
  ): value is IDerivation {
    return !Array.isArray(value);
  }

  function validate(derivation: IDerivation): void {
    if (derivation.identities.length !== derivation.rows.length)
      throw new Error(
        "toolchain configuration identities must align with its rows",
      );
    const seen = new Set<number>();
    for (const index of derivation.inconclusive) {
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= derivation.rows.length
      )
        throw new Error(
          "toolchain inconclusive evidence must index an existing row",
        );
      if (seen.has(index))
        throw new Error(
          "toolchain inconclusive evidence must not contain duplicates",
        );
      const identity = derivation.identities[index];
      if (typeof identity !== "string" || identity.length === 0)
        throw new Error(
          "toolchain inconclusive evidence must carry a stable identity",
        );
      seen.add(index);
    }
  }

  function label(row: string): string {
    const at = row.indexOf("=");
    return at === -1 ? row : row.slice(0, at);
  }

  function compareOrdinal(left: string, right: string): number {
    // Two-way: sort outcomes are exhausted by caller fixtures, so the equal arm
    // cannot run, and an ignore directive over it would take the two reachable
    // arms out of the coverage gate with it -- which is how a reversed ordering
    // stops being a failing test.
    return left < right ? -1 : 1;
  }
  /* c8 ignore start -- declaration merging emits an unreachable namespace
   * creation arm after the function object already exists. */
}
/* c8 ignore stop */

/**
 * Run the probe and say which of three things happened.
 *
 * A program that completed and printed a version answered. One that completed
 * and printed nothing is silent. An observation that did not complete normally
 * — `spawnSync` sets `error`, or reports a null status for a signal or timeout —
 * said nothing about the toolchain at all. Reading only "the exit was not zero"
 * made that inconclusive state the same fact as a conclusive silent answer.
 */
function probe(
  resolved: IGraphProvider.ICommand,
  props: toolchainVersion.IProps,
): { completed: boolean; version?: string } {
  const spawnable = spawnableCommand.append(
    { ...resolved, args: [...resolved.args] },
    props.args,
  );
  const result = spawnSync(spawnable.command, spawnable.args, {
    cwd: props.root,
    env: props.env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    windowsVerbatimArguments: spawnable.windowsVerbatimArguments,
    windowsHide: true,
  });
  /* c8 ignore start -- an executed spawnSync with UTF-8 encoding returns a
   * string; the null arm exists only for Node's broader result type. */
  const output = oneLine(String(result.stdout ?? ""));
  /* c8 ignore stop */
  if (result.error !== undefined || result.status === null) {
    return { completed: false };
  }
  return result.status === 0 && output !== ""
    ? { completed: true, version: output }
    : { completed: true };
}

/**
 * Every line of the probe's answer, on one line.
 *
 * Joining rather than truncating. `java --version` and `clang --version` answer
 * in three lines and `rustc -vV` in seven, and the lines after the first carry
 * the host triple, the runtime build, and the LLVM version — facts that decide
 * what a compiled artifact means. Keeping only the first would drop them;
 * keeping the newlines puts a multi-line value in a published provenance field
 * that every other producer fills with one line.
 *
 * ` | ` rather than `; ` because callers join whole rows with `; `. One
 * separator for both would leave a reader unable to tell where one tool's
 * answer ends and the next begins.
 */
function oneLine(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" | ");
}
