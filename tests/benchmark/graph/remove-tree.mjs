import fs from "node:fs";
import path from "node:path";

/**
 * Remove a disposable benchmark tree, including read-only ecosystem caches.
 *
 * Go deliberately makes downloaded module directories read-only. A recursive
 * remove on POSIX therefore fails with EACCES at the first nested directory;
 * retrying the same operation cannot change that result. Make only the
 * assignment-owned target writable after a permission failure, without
 * following symlinks, then retry with the ordinary transient-race budget.
 */
export function removeTree(target) {
  try {
    remove(target);
  } catch (error) {
    if (!isPermissionFailure(error)) throw error;
    makeTreeWritable(target);
    remove(target);
  }
}

function remove(target) {
  fs.rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

function makeTreeWritable(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.chmodSync(target, stat.mode | 0o700);
    for (const entry of fs.readdirSync(target)) {
      makeTreeWritable(path.join(target, entry));
    }
    return;
  }
  fs.chmodSync(target, stat.mode | 0o600);
}

function isPermissionFailure(error) {
  return error?.code === "EACCES" || error?.code === "EPERM";
}
