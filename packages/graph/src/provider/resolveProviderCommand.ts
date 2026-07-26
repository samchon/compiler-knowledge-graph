import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { spawnableCommand } from "../utils/spawnableCommand";
import { IGraphProvider } from "./IGraphProvider";

/** Resolve a sidecar/indexer project-locally before consulting PATH. */
export function resolveProviderCommand(
  root: string,
  env: NodeJS.ProcessEnv,
  props: resolveProviderCommand.IProps,
): IGraphProvider.ICommand | undefined {
  const override = env[props.override];
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

  const onPath = lookupOnPath(props.command, root, env);
  return onPath === undefined ? undefined : spawnable(onPath, props.args);
}

export namespace resolveProviderCommand {
  export interface IProps {
    command: string;
    override: string;
    args?: readonly string[];
  }
}

/**
 * Look one command up on `PATH`, reusing the answer while it still holds.
 *
 * The lookup itself is a process launch — `where.exe` on Windows, `command -v`
 * on POSIX — and provider resolution runs on every resident load, for every
 * candidate, once per tool that candidate requires. It is also the same
 * failure shape as a version probe: `resolveOnPath` reports "not installed"
 * from a non-zero exit, so a launch that failed for a reason unrelated to the
 * project made an installed tool disappear, and the resident answers a
 * provider disappearing by rebuilding every language.
 *
 * A hit is confirmed with a stat before it is reused, so a tool removed since
 * the lookup is still found to be gone. Only successes are remembered: caching
 * an absence would hide a tool installed while the server was running, which is
 * the one direction a developer actively expects to work.
 */
function lookupOnPath(
  command: string,
  root: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const key = [command, env.PATH ?? "", env.Path ?? ""].join(SEPARATOR);
  const cached = pathLookups.get(key);
  if (cached !== undefined) {
    if (isSpawnableFile(cached)) return cached;
    pathLookups.delete(key);
  }
  const found = resolveOnPath(command, root, env);
  if (found !== undefined) pathLookups.set(key, found);
  return found;
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

function localCandidates(root: string, command: string): string[] {
  const privateBin = path.join(root, ".samchon-graph", "bin");
  const packageBin = path.join(root, "node_modules", ".bin");
  /* c8 ignore start -- each CI operating system exercises its native arm. */
  return process.platform === "win32"
    ? [
        path.join(privateBin, `${command}.exe`),
        path.join(privateBin, `${command}.cmd`),
        path.join(privateBin, `${command}.bat`),
        path.join(packageBin, `${command}.exe`),
        path.join(packageBin, `${command}.cmd`),
        path.join(packageBin, `${command}.bat`),
      ]
    : [path.join(privateBin, command), path.join(packageBin, command)];
  /* c8 ignore stop */
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

/** A separator no command name or `PATH` value can contain. */
const SEPARATOR = String.fromCharCode(0);

const pathLookups = new Map<string, string>();

function spawnable(
  executable: string,
  args: readonly string[] = [],
): IGraphProvider.ICommand {
  /* c8 ignore start -- Windows exercises its command shim and POSIX its
   * directly executable file in the same cross-platform test. */
  return spawnableCommand(executable, args);
  /* c8 ignore stop */
}
