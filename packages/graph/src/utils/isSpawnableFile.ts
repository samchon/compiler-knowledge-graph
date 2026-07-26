import fs from "node:fs";

/**
 * Whether this exact path is a file this process could launch.
 *
 * Three callers ask it — provider command resolution, the TypeScript provider's
 * own resolver, and a toolchain probe pointed at the absolute driver a
 * compilation database recorded — and each had a byte-identical copy. The
 * question is one question: a directory is not a program, and neither is a path
 * that is not there.
 *
 * `X_OK` is what makes it an answer rather than a guess on POSIX. On Windows it
 * degrades to existence, which is the same answer the spawn would give for the
 * suffixes Windows can launch. It is not the same answer for an extensionless
 * file, so a caller that may see one — `localCandidates` and
 * `node_modules/.bin` — decides that separately rather than asking here.
 */
export function isSpawnableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
