import fs from "node:fs";

/**
 * Whether this exact path is a file this process could launch.
 *
 * Two callers ask it — provider command resolution, and a toolchain probe
 * pointed at the absolute driver a compilation database recorded — and they had
 * byte-identical copies. The question is one question: a directory is not a
 * program, and neither is a path that is not there.
 *
 * `X_OK` is what makes it an answer rather than a guess on POSIX. On Windows it
 * degrades to existence, which is the same answer the spawn would give.
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
