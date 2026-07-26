import { spawnSync } from "node:child_process";

import { isSpawnableFile } from "../utils/isSpawnableFile";
import { spawnableCommand } from "../utils/spawnableCommand";
import { IGraphProvider } from "./IGraphProvider";
import { resolveProviderCommand } from "./resolveProviderCommand";

/**
 * The version of one toolchain, as a single configuration row.
 *
 * Three providers derived this separately, and each one collapsed two different
 * states into one word: a tool that is not installed and a tool whose probe
 * happened not to answer both came back `unavailable`. A build universe
 * computed from that value rebuilt itself over a spawn failure, and the
 * resident source went further and discarded its whole index.
 *
 * Three states replace the one word, and each is a constant for as long as it
 * holds. Absence is decided by {@link resolveProviderCommand} rather than by
 * the probe, so `unavailable` means the tool was not found. A probe that
 * answers is the version. A probe that resolves and does not answer is
 * `unreported`, because that is a third fact.
 *
 * Two seams remain, and they are the same seam twice. Resolution consults
 * `PATH` by launching `where.exe` or `command -v`, so a lookup that fails to
 * run reports absence; and {@link probe} reads a non-zero exit, which a launch
 * that failed to start also produces, so it reports silence. Either one moves a
 * row that nothing about the project moved. Both predate this design and both
 * need the same repair — `spawnSync` distinguishes "ran and answered" from
 * "could not run", and neither call site asks it.
 *
 * Being constants is what makes them safe to fingerprint. The row a failing
 * probe produces does not depend on *why* it failed or on how many times it
 * has, so a build universe computed from it moves once when a toolchain stops
 * answering and once when it starts again. The old `unavailable` was a constant
 * too; what it cost was the conflation above, not extra movement.
 *
 * A remembered answer used to stand in for a failed probe, so that a single
 * blip moved nothing at all. It is gone. It bought one rebuild per outage in
 * exchange for a value that depended on process history: the same code answered
 * differently depending on what else had run, which is how it passed in
 * isolation and failed on all three platforms in the full suite. The defect it
 * was reaching for — a failed probe discarding the whole resident index — is
 * fixed for a serving provider, in the topology snapshot that no longer
 * re-derives its configuration at all.
 *
 * Not for a candidate that is not serving. `providerTopology.available` still
 * derives those rows fresh, the resident source fingerprints them, and a
 * difference calls `replaceLanguages` — so a probe that fails to launch in a
 * provider nothing is currently using still rebuilds every language. That is
 * the same defect in the half of the path this repair did not reach, and it is
 * filed rather than claimed as done.
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
  const label = props.label ?? props.command;
  const attempt =
    props.resolved === undefined
      ? toolchainVersion.attempt(props)
      : { command: props.resolved, asked: true };
  if (attempt.command === undefined) {
    return attempt.asked
      ? `${label}=unavailable`
      : `${label}${toolchainVersion.UNASKED}`;
  }
  const observed = probe(attempt.command, props);
  if (observed.version !== undefined) return `${label}=${observed.version}`;
  return observed.ran
    ? `${label}=unreported`
    : `${label}${toolchainVersion.UNASKED}`;
}

export namespace toolchainVersion {
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

  /**
   * The suffix a row carries when its question could not be put.
   *
   * Exported so a reader names the state instead of sniffing a string. A build
   * universe has to know that a derivation established nothing, and it should
   * learn that from a contract rather than from row grammar.
   */
  export const UNASKED = "=unasked";

  /** Whether any row in this derivation failed to establish anything. */
  export function inconclusive(rows: readonly string[]): boolean {
    return rows.some((row) => row.endsWith(UNASKED));
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
   * A row's identity is its label — everything before the first `=` — because
   * the value can contain one, as `GOFLAGS=-tags=x` does. A row with no prior
   * stays unasked rather than being invented.
   */
  export function reestablish(
    rows: readonly string[],
    established: readonly string[] | undefined,
  ): readonly string[] {
    if (established === undefined || !inconclusive(rows)) return rows;
    const prior = new Map(established.map((row) => [label(row), row]));
    return rows.map((row) =>
      row.endsWith(UNASKED) ? (prior.get(label(row)) ?? row) : row,
    );
  }

  function label(row: string): string {
    const at = row.indexOf("=");
    return at === -1 ? row : row.slice(0, at);
  }
  /* c8 ignore start -- declaration merging emits an unreachable namespace
   * creation arm after the function object already exists. */
}
/* c8 ignore stop */

/**
 * Run the probe and say which of three things happened.
 *
 * A program that ran and printed a version answered. One that ran and printed
 * nothing is silent. One that never started — `spawnSync` sets `error`, or
 * reports a null status for a signal or the timeout — said nothing about the
 * toolchain at all, and reading only "the exit was not zero" made those last
 * two the same fact.
 */
function probe(
  resolved: IGraphProvider.ICommand,
  props: toolchainVersion.IProps,
): { ran: boolean; version?: string } {
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
    return { ran: false };
  }
  return result.status === 0 && output !== ""
    ? { ran: true, version: output }
    : { ran: true };
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
