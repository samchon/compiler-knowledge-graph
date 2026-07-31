import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { isSpawnableFile } from "../../utils/isSpawnableFile";
import { spawnableCommand } from "../../utils/spawnableCommand";
import { ttscGraphResolution } from "./ttscGraphResolution";

const [TTSC_GRAPH_COMMAND, TTSC_SERVER_COMMAND] =
  ttscGraphResolution.commands;
const [TTSC_GRAPH_OVERRIDE] =
  ttscGraphResolution.environmentOverrides;

interface ITtscGraphCommand {
  command: string;
  args: string[];
}

/** Resolve the native `ttscgraph` binary without adding a runtime dependency. */
export function resolveTtscGraphCommand(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): ITtscGraphCommand | undefined {
  const override = env[TTSC_GRAPH_OVERRIDE];
  if (
    override !== undefined &&
    path.isAbsolute(override) &&
    isSpawnableFile(override)
  ) {
    return spawnable(override);
  }

  // Match @ttsc/graph's canonical precedence: the target project's `ttsc`
  // installation owns the compatible platform binary. A stale global command
  // must never shadow it merely because it appears first on PATH.
  const projectPackage = resolveProjectTtscPackage(root);
  if (projectPackage !== undefined) {
    const binary = platformBinaryOf(projectPackage);
    if (binary !== undefined) return spawnable(binary);
  }

  // A package-manager shim can still reveal the project installation when its
  // package metadata is not directly resolvable (for example, an unusual
  // linked layout). Search only the target project's .bin at this stage.
  const projectServer = resolveExecutable(
    TTSC_SERVER_COMMAND,
    root,
    env,
    false,
  );
  if (projectServer !== undefined) {
    const beside = graphBesideServer(projectServer);
    if (beside !== undefined) return beside;
  }

  // Only after project-owned candidates fail may PATH/global installations be
  // used as a compatibility fallback.
  const onPath = resolveExecutable(TTSC_GRAPH_COMMAND, root, env, true);
  if (onPath !== undefined) return spawnable(onPath);

  const globalServer = resolveExecutable(
    TTSC_SERVER_COMMAND,
    root,
    env,
    true,
  );
  if (globalServer !== undefined && globalServer !== projectServer) {
    return graphBesideServer(globalServer);
  }
  return undefined;
}

function resolveProjectTtscPackage(root: string): string | undefined {
  try {
    return createRequire(
      path.join(path.resolve(root), "__samchon_graph_resolver__.cjs"),
    ).resolve("ttsc/package.json");
  } catch {
    return undefined;
  }
}

function platformBinaryOf(ttscPackage: string): string | undefined {
  const packageName = `@ttsc/${process.platform}-${process.arch}`;
  /* c8 ignore next -- only one platform's binary name runs per OS */
  const executable = process.platform === "win32" ? "ttscgraph.exe" : "ttscgraph";
  try {
    const resolver = createRequire(ttscPackage);
    const binary = resolver.resolve(`${packageName}/bin/${executable}`);
    // Windows has no execute bit, so a resolved regular file is always spawnable
    // there and the falsy arm — a non-executable platform binary, reached and
    // rejected on POSIX — never runs, so the per-OS gate cannot count it there.
    /* c8 ignore next -- falsy arm is a POSIX-only rejection; unreachable on Windows */
    return isSpawnableFile(binary) ? binary : undefined;
  } catch {
    return undefined;
  }
}

function graphBesideServer(server: string): ITtscGraphCommand | undefined {
  const sibling = path.join(
    path.dirname(server),
    /* c8 ignore next -- only one platform's binary name runs per OS */
    process.platform === "win32" ? "ttscgraph.exe" : "ttscgraph",
  );
  if (isSpawnableFile(sibling)) return spawnable(sibling);
  for (const candidate of ttscPackagesBeside(server)) {
    if (!fs.existsSync(candidate)) continue;
    const binary = platformBinaryOf(candidate);
    if (binary !== undefined) return spawnable(binary);
  }
  return undefined;
}

function resolveExecutable(
  command: string,
  root: string,
  env: NodeJS.ProcessEnv,
  includeGlobal: boolean,
): string | undefined {
  // Invoke `where.exe` by absolute path: the project-only lookup restricts PATH
  // to the project bin, and libuv resolves a bare command name against that same
  // restricted PATH, so a bare "where.exe" would fail to launch. POSIX `command`
  // is a shell builtin resolved by the shell itself.
  /* c8 ignore next 5 -- only one platform's lookup command runs per OS */
  const lookup =
    process.platform === "win32"
      ? spawnableCommand.windowsSystem("where.exe", env)
      : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  const projectBin = path.join(root, "node_modules", ".bin");
  const inheritedPath = includeGlobal ? env.PATH ?? "" : "";
  const result = spawnSync(lookup, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...env,
      PATH:
        inheritedPath === ""
          ? projectBin
          : `${projectBin}${path.delimiter}${inheritedPath}`,
    },
    shell: process.platform !== "win32",
    windowsHide: true,
  });
  if (result.status !== 0) return undefined;
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  // `where` lists every shim: npm emits an extensionless sh script first, then
  // the .cmd Windows can actually run. Rank Windows-executable extensions ahead
  // of the rest (branchlessly, so every platform runs the same lines) and take
  // the winner. POSIX `command -v` prints a single path that matches neither
  // filter, so this reduces to `lines[0]` there.
  const executable = lines.filter((line) => /\.exe$/i.test(line));
  const commandShim = lines.filter((line) => /\.(?:cmd|bat)$/i.test(line));
  return [...executable, ...commandShim, ...lines][0];
}

function spawnable(executable: string): ITtscGraphCommand {
  return spawnableCommand(executable);
}

function ttscPackagesBeside(server: string): string[] {
  const directory = path.dirname(server);
  const candidates = [
    path.resolve(directory, "..", "ttsc", "package.json"),
    path.resolve(directory, "node_modules", "ttsc", "package.json"),
  ];
  try {
    const real = fs.realpathSync(server);
    for (let current = path.dirname(real); ; current = path.dirname(current)) {
      candidates.push(path.join(current, "package.json"));
      if (path.dirname(current) === current) break;
    }
    /* c8 ignore start -- realpath fails only on an OS canonicalization error */
  } catch {
    // `fs.realpathSync` throws only when the OS cannot canonicalize a `server`
    // the executable lookup already found present — a broken or looping symlink,
    // a permission or not-a-directory error, or a TOCTOU removal. None can be
    // produced deterministically and portably from a hermetic fixture, yet
    // dropping the guard would turn that rare failure into a crash of the whole
    // resolver, so resolution degrades to the deterministic candidates above.
  }
  /* c8 ignore stop */
  return candidates;
}
