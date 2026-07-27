import { spawnSync } from "node:child_process";
import path from "node:path";

import { isSpawnableFile } from "../utils/isSpawnableFile";
import { spawnableCommand } from "../utils/spawnableCommand";
import { IGraphProvider } from "./IGraphProvider";

/** Resolve a sidecar/indexer project-locally before consulting PATH. */
export function resolveProviderCommand(
  root: string,
  env: NodeJS.ProcessEnv,
  props: resolveProviderCommand.IProps,
): IGraphProvider.ICommand | undefined {
  return resolveProviderCommand.attempt(root, env, props).command;
}

export namespace resolveProviderCommand {
  export interface IProps {
    command: string;

    /** Environment variable naming an absolute build, when one may pick it. */
    override?: string;
    args?: readonly string[];
  }

  /**
   * What a resolution found, and whether it managed to look.
   *
   * `command` absent with `asked` true means the search ran and the tool is not
   * there. `asked` false means the `PATH` lookup — itself a process launch —
   * could not be run, so nothing was learned. Collapsing the two makes a
   * transient launch failure indistinguishable from an uninstalled tool, and a
   * build universe computed from that difference rebuilds an artifact nothing
   * about the project changed.
   */
  export interface IAttempt {
    command?: IGraphProvider.ICommand;
    asked: boolean;
  }

  export function attempt(
    root: string,
    env: NodeJS.ProcessEnv,
    props: IProps,
  ): IAttempt {
    return resolveAttempt(root, env, props);
  }
  /* c8 ignore start -- declaration merging emits an unreachable namespace
   * creation arm after the function object already exists. */
}
/* c8 ignore stop */

function resolveAttempt(
  root: string,
  env: NodeJS.ProcessEnv,
  props: resolveProviderCommand.IProps,
): resolveProviderCommand.IAttempt {
  // Absent for a command the project itself named. A compilation database can
  // record several distinct drivers, and one absolute override would redirect
  // every one of them to the same binary — an answer about a program none of
  // those translation units was compiled with.
  const override =
    props.override === undefined ? undefined : env[props.override];
  if (
    override !== undefined &&
    path.isAbsolute(override) &&
    isSpawnableFile(override)
  ) {
    return { command: spawnable(override, props.args), asked: true };
  }

  for (const candidate of localCandidates(root, props.command)) {
    if (isSpawnableFile(candidate)) {
      return { command: spawnable(candidate, props.args), asked: true };
    }
  }

  // Deliberately not memoized. A lookup is a process launch, so reusing one
  // looks like an easy saving — but the answer depends on the working directory
  // (`where.exe` searches it before `PATH`) and on `PATH` order, and a memo
  // keyed by name would keep returning a lower-precedence binary after the
  // project installed the one it pins. Confirming a remembered path still
  // exists proves it is *an* answer, never that it is still *the* answer.
  const onPath = resolveOnPath(props.command, root, env);
  if (!onPath.asked) return { asked: false };
  return onPath.found === undefined
    ? { asked: true }
    : { command: spawnable(onPath.found, props.args), asked: true };
}

/**
 * Ask `PATH` where a command lives, and say whether the asking worked.
 *
 * The lookup is itself a process launch — `where.exe` on Windows, `command -v`
 * under a shell on POSIX. A non-zero exit means the search ran and found
 * nothing; a spawn that could not start, or one killed by a signal or a
 * timeout, means nothing was learned at all. `spawnSync` reports the first as a
 * status and the second as `error` or a null status, and reading only "not
 * zero" turned a transient launch failure into the claim that a tool is not
 * installed.
 */
function resolveOnPath(
  command: string,
  root: string,
  env: NodeJS.ProcessEnv,
): { found?: string; asked: boolean } {
  /* c8 ignore start -- each CI operating system exercises its native lookup. */
  const lookup =
    process.platform === "win32"
      ? spawnableCommand.windowsSystem("where.exe", env)
      : "/bin/sh";
  const args =
    process.platform === "win32"
      ? [command]
      : ["-c", 'command -v "$1"', "samchon-graph", command];
  /* c8 ignore stop */
  const result = spawnSync(lookup, args, {
    cwd: root,
    encoding: "utf8",
    env,
    windowsHide: true,
  });
  // Nothing was learned: the process could not be started, or was killed by a
  // signal or the timeout. Either is a fact about this machine at this instant,
  // not about whether the tool is installed.
  if (result.error !== undefined || result.status === null) {
    return { asked: false };
  }
  if (result.status !== 0) return { asked: true };
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  /* c8 ignore start -- Windows prefers native binaries before command shims;
   * POSIX has one executable identity. */
  if (process.platform === "win32") {
    const native = lines.filter((line) => /\.exe$/i.test(line));
    const shim = lines.filter((line) => /\.(?:cmd|bat)$/i.test(line));
    return { found: [...native, ...shim, ...lines][0], asked: true };
  }
  /* c8 ignore stop */
  /* c8 ignore start -- this is the POSIX half of the Windows-native branch
   * above and is exercised on POSIX CI only. */
  return { found: lines[0], asked: true };
}
/* c8 ignore stop */

/**
 * Where a project keeps a tool of its own, in the spellings the platform uses.
 *
 * Windows appends its executable suffixes — except when the name already
 * carries one. A command can arrive with a suffix attached, because a Windows
 * compilation database records its driver as `cl.exe`, and appending again
 * looks for `cl.exe.exe` and never finds the file that is there.
 *
 * The bare name is a candidate *only* in that case, and deliberately. An
 * extensionless file in `node_modules/.bin` is npm's POSIX `sh` shim;
 * {@link spawnableCommand} wraps `.cmd` and `.bat` in the command processor
 * and hands anything else straight to `CreateProcess`, which cannot run a
 * shell script. Offering the bare name for every command would resolve such a
 * shim on a tree installed under WSL or a Linux container, and the caller would
 * proceed with an indexer that cannot start rather than falling through to
 * `PATH` and finding one that can.
 *
 * On POSIX the name as written is the only spelling there is.
 */
function localCandidates(root: string, command: string): string[] {
  const privateBin = path.join(root, ".samchon-graph", "bin");
  const packageBin = path.join(root, "node_modules", ".bin");
  // Composer's `node_modules/.bin`. Looking only in npm's directory made this
  // function project-local for one ecosystem and PATH-only for another, and a
  // PHP indexer is installed into the project by design — scip-php's own
  // instructions are `composer require --dev` followed by `vendor/bin/scip-php`,
  // and it reads the project's autoloader, so a global copy is the unusual
  // arrangement rather than the expected one.
  const composerBin = path.join(root, "vendor", "bin");
  // One exit, deliberately. A platform arm that returns early leaves the rest
  // of the function — including its closing brace — unreachable on the other
  // platforms, and an ignore that stops before the brace does not cover it.
  /* c8 ignore start -- each CI operating system exercises its native arm. */
  const spellings =
    process.platform !== "win32"
      ? [command]
      : /\.(?:exe|cmd|bat)$/i.test(command)
        ? [command]
        : [`${command}.exe`, `${command}.cmd`, `${command}.bat`];
  /* c8 ignore stop */
  const candidates: string[] = [];
  for (const bin of [privateBin, packageBin, composerBin]) {
    for (const spelling of spellings) candidates.push(path.join(bin, spelling));
  }
  return candidates;
}

function spawnable(
  executable: string,
  args: readonly string[] = [],
): IGraphProvider.ICommand {
  /* c8 ignore start -- Windows exercises its command shim and POSIX its
   * directly executable file in the same cross-platform test. */
  return spawnableCommand(executable, args);
  /* c8 ignore stop */
}
