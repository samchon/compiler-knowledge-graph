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
    return spawnable(override, props.args);
  }

  for (const candidate of localCandidates(root, props.command)) {
    if (isSpawnableFile(candidate)) return spawnable(candidate, props.args);
  }

  // Deliberately not memoized. A lookup is a process launch, so reusing one
  // looks like an easy saving — but the answer depends on the working directory
  // (`where.exe` searches it before `PATH`) and on `PATH` order, and a memo
  // keyed by name would keep returning a lower-precedence binary after the
  // project installed the one it pins. Confirming a remembered path still
  // exists proves it is *an* answer, never that it is still *the* answer.
  const onPath = resolveOnPath(props.command, root, env);
  return onPath === undefined ? undefined : spawnable(onPath, props.args);
}

export namespace resolveProviderCommand {
  export interface IProps {
    command: string;

    /** Environment variable naming an absolute build, when one may select it. */
    override?: string;
    args?: readonly string[];
  }
}

function resolveOnPath(
  command: string,
  root: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  /* c8 ignore start -- each CI operating system exercises its native lookup. */
  const lookup =
    process.platform === "win32"
      ? spawnableCommand.windowsSystem("where.exe", env)
      : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  const shell = process.platform !== "win32";
  /* c8 ignore stop */
  const result = spawnSync(lookup, args, {
    cwd: root,
    encoding: "utf8",
    env,
    shell,
    windowsHide: true,
  });
  if (result.status !== 0) return undefined;
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  /* c8 ignore start -- Windows prefers native binaries before command shims;
   * POSIX has one executable identity. */
  if (process.platform === "win32") {
    const native = lines.filter((line) => /\.exe$/i.test(line));
    const shim = lines.filter((line) => /\.(?:cmd|bat)$/i.test(line));
    return [...native, ...shim, ...lines][0];
  }
  /* c8 ignore stop */
  /* c8 ignore start -- this is the POSIX half of the Windows-native branch
   * above and is exercised on POSIX CI only. */
  return lines[0];
}
/* c8 ignore stop */

/**
 * Where a project keeps a tool of its own, in the spellings the platform uses.
 *
 * The suffixed name is tried first *and* the name as written, because a command
 * can now arrive already carrying one: a Windows compilation database records
 * its driver as `cl.exe`, and appending again would look for `cl.exe.exe`. On
 * POSIX the name as written is the only spelling there is.
 */
function localCandidates(root: string, command: string): string[] {
  const privateBin = path.join(root, ".samchon-graph", "bin");
  const packageBin = path.join(root, "node_modules", ".bin");
  /* c8 ignore start -- each CI operating system exercises its native arm. */
  return process.platform === "win32"
    ? [privateBin, packageBin].flatMap((bin) => [
        path.join(bin, `${command}.exe`),
        path.join(bin, `${command}.cmd`),
        path.join(bin, `${command}.bat`),
        path.join(bin, command),
      ])
    : [path.join(privateBin, command), path.join(packageBin, command)];
  /* c8 ignore stop */
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
