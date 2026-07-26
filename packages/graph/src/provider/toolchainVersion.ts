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
 * fixed where it belongs, in the topology snapshot that no longer re-derives a
 * serving provider's configuration at all.
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
  const resolved = props.resolved ?? toolchainVersion.resolve(props);
  if (resolved === undefined) return `${label}=unavailable`;
  const observed = probe(resolved, props);
  return observed === undefined
    ? `${label}=unreported`
    : `${label}=${observed}`;
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
    if (props.executable !== undefined) {
      return isSpawnableFile(props.executable)
        ? spawnableCommand(props.executable, [], props.env)
        : undefined;
    }
    return resolveProviderCommand(props.root, props.env, {
      command: props.command,
      ...(props.override === undefined ? {} : { override: props.override }),
    });
  }
  /* c8 ignore start -- declaration merging emits an unreachable namespace
   * creation arm after the function object already exists. */
}
/* c8 ignore stop */

function probe(
  resolved: IGraphProvider.ICommand,
  props: toolchainVersion.IProps,
): string | undefined {
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
  return result.status === 0 && output !== "" ? output : undefined;
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
