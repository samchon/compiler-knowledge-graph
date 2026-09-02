import fs from "node:fs";
import path from "node:path";

import { run } from "./process.mjs";

/** Prove that an extracted source archive is the exact pinned Git tree. */
export const verifyGitTree = (source, expected) => {
  const repository = path.join(source, ".git");
  fs.rmSync(repository, { force: true, recursive: true });
  try {
    run("git", ["init", "--quiet"], { cwd: source });
    run("git", ["config", "core.autocrlf", "false"], { cwd: source });
    run("git", ["add", "--all", "--force"], { cwd: source });
    const actual = String(
      run("git", ["write-tree"], { cwd: source, stdio: "pipe" }).stdout,
    ).trim();
    if (actual !== expected) {
      throw new Error(
        `${source} has Git tree ${actual}, expected ${expected}`,
      );
    }
  } finally {
    fs.rmSync(repository, { force: true, recursive: true });
  }
};
