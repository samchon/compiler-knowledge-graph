import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";

import { BoundedMap } from "../utils/boundedMap";
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
 * Three facts replace the one word. Absence is decided by
 * {@link resolveProviderCommand}, which reads the filesystem and launches
 * nothing, so `unavailable` means only that. A probe that answers is the
 * version. A probe that does not answer falls back to the last version this
 * exact toolchain gave, and says `unreported` only when there is no such
 * answer — so a failed launch leaves the universe where it was instead of
 * moving it.
 *
 * The probe itself runs every time, and deliberately. A version is not a
 * property of the file: `rustc`, `python3`, `ruby`, `java`, and `dotnet` are
 * all normally dispatcher shims — rustup, pyenv, rbenv, jenv, asdf, the .NET
 * muxer — whose answer is decided by the working directory and the environment,
 * and which report a new version after an in-place upgrade that leaves the
 * shim byte-identical. This repository already knows that: `global.json`, the
 * file that picks a project's .NET SDK, is one of `scip-dotnet`'s declared
 * build inputs. Caching an answer against the file would serve one project's
 * toolchain to another and would never notice an upgrade at all.
 */
export function toolchainVersion(props: toolchainVersion.IProps): string {
  const label = props.label ?? props.command;
  const resolved = toolchainVersion.resolve(props);
  if (resolved === undefined) return `${label}=unavailable`;
  const key = answerKey(resolved, props);
  const observed = probe(resolved, props);
  if (observed !== undefined) {
    answers.set(key, { version: observed, failures: 0 });
    return `${label}=${observed}`;
  }
  const remembered = answers.get(key);
  // Bounded, because a fallback with no bound is the previous commit's defect
  // wearing different clothes: a dispatcher whose selected runtime was
  // uninstalled resolves, fails every probe, and would go on naming the version
  // it gave before it broke for the life of the process. A handful of
  // consecutive failures is a blip; past that the honest answer is that this
  // toolchain is no longer reporting.
  if (remembered === undefined || remembered.failures >= MAX_FALLBACKS) {
    return `${label}=unreported`;
  }
  answers.set(key, {
    version: remembered.version,
    failures: remembered.failures + 1,
  });
  return `${label}=${remembered.version}`;
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
  /* c8 ignore next -- an executed spawnSync with UTF-8 encoding returns a
   * string; the null arm exists only for Node's broader result type. */
  const output = oneLine(String(result.stdout ?? ""));
  return result.status === 0 && output !== "" ? output : undefined;
}

/**
 * Where this toolchain's last answer is filed.
 *
 * Everything the probe's answer depends on: the program, the directory it runs
 * in, the environment it inherits, and what it was asked. Over-specific on
 * purpose, and the whole environment rather than a guessed list of
 * version-selecting variables. Getting this too narrow hands one project's
 * toolchain version to another, which is wrong; getting it too wide loses a
 * fallback, and a lost fallback is `unreported`, which is the honest answer for
 * a question that has not been asked in this form before.
 *
 * The identity reads `executable`, not `command`, because a Windows `.cmd`
 * provider is spawned as `cmd.exe` with the real program quoted inside an
 * argument, and every shim on the machine would otherwise share one entry.
 */
function answerKey(
  resolved: IGraphProvider.ICommand,
  props: toolchainVersion.IProps,
): string {
  const executable = resolved.executable ?? resolved.command;
  const environment = createHash("sha256");
  for (const name of Object.keys(props.env).sort(compareOrdinal)) {
    environment.update(name, "utf8");
    environment.update(SEPARATOR, "utf8");
    environment.update(props.env[name] ?? "", "utf8");
    environment.update(SEPARATOR, "utf8");
  }
  return [
    executable,
    fileIdentity(executable),
    props.root,
    environment.digest("hex"),
    ...resolved.args,
    ...props.args,
  ].join(SEPARATOR);
}

function fileIdentity(executable: string): string {
  try {
    const stat = fs.statSync(executable);
    return `${String(stat.size)}:${String(stat.mtimeMs)}`;
    /* c8 ignore next 3 -- a PATH-resolved executable removed between lookup
     * and this stat still gets a key; the probe that follows reports the real
     * failure and nothing is filed under it. */
  } catch {
    return "unstatable";
  }
}

/**
 * File one answer, under a bound.
 *
 * A resident server that outlives many toolchain upgrades would otherwise
 * accumulate one permanent entry per replaced binary. The bound is generous
 * relative to the number of distinct toolchains any project has and small
 * enough that the map cannot become a leak; the oldest entry is dropped
 * because the newest answers are the ones a fallback would want.
 */
interface IAnswer {
  version: string;

  /** Consecutive launches that did not answer since this version was learned. */
  failures: number;
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

function compareOrdinal(left: string, right: string): number {
  /* c8 ignore next 2 -- environment names are distinct object keys. */
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSpawnableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A separator no path, argument, environment value, or digest can contain. */
const SEPARATOR = String.fromCharCode(0);

const answers = new BoundedMap<IAnswer>(256);

/** Consecutive failures a remembered version covers before it stops standing in. */
const MAX_FALLBACKS = 3;

