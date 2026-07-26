import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const experimentRoot = path.join(repositoryRoot, "tests", "experiment");
export const workRoot = path.join(experimentRoot, ".work");
export const resultsRoot = path.join(experimentRoot, "results");

export const parseArgs = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `pnpm run <script> -- --flag value` forwards the bare `--` separator to
    // the script; skip it so it is not mistaken for a flag that swallows the
    // next token.
    if (arg === "--") continue;
    if (arg.startsWith("--") === false) continue;
    const eq = arg.indexOf("=");
    if (eq >= 0) out[arg.slice(2, eq)] = arg.slice(eq + 1);
    else out[arg.slice(2)] = argv[++i] ?? "true";
  }
  return out;
};

export const run = (command, args = [], options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    shell: options.shell ?? false,
    stdio: options.stdio ?? "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result;
};

export const shell = (command, options = {}) =>
  run(command, [], { ...options, shell: true });

export const ensureDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
};

export const appendGithubPath = (dir) => {
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
  if (process.env.GITHUB_PATH !== undefined) {
    fs.appendFileSync(process.env.GITHUB_PATH, `${dir}${os.EOL}`);
  }
};

export const localBin = (name) => {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const candidates = [
    path.join(experimentRoot, "node_modules", ".bin", `${name}${suffix}`),
    path.join(repositoryRoot, "node_modules", ".bin", `${name}${suffix}`),
  ];
  const found = candidates.find((file) => fs.existsSync(file));
  if (found === undefined) throw new Error(`Unable to find local bin: ${name}`);
  return found;
};

const manifestFile = (language) =>
  path.join(workRoot, "tools", `manifest-${language}.json`);

/**
 * Append one resolved tool to this language's setup manifest.
 *
 * A result that reports which corpus it read but not which build of which
 * indexer read it cannot be reproduced or compared across runs. `digest` is
 * `"unpinned"` when the install came from a mutable channel, so the gap is
 * published rather than left for a reader to assume closed.
 */
export const recordTool = (language, tool) => {
  const file = manifestFile(language);
  ensureDir(path.dirname(file));
  const tools = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : [];
  fs.writeFileSync(file, `${JSON.stringify([...tools, tool], null, 2)}\n`);
};

/** Start one language's manifest empty so a rerun never inherits a stale row. */
export const resetToolManifest = (language) => {
  fs.rmSync(manifestFile(language), { force: true });
};

/** Every tool this language's setup resolved, or nothing when it ran none. */
export const toolManifest = (language) => {
  const file = manifestFile(language);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8"));
};

/**
 * Copy one pinned clone into a workspace that preparation is allowed to change.
 *
 * A package manager run inside the clone itself writes locks, caches, generated
 * files, and build state, and the result still reports the pristine commit it no
 * longer has. Both lanes therefore prepare a copy: the clone exists only to
 * carry the commit, and `.git` is left behind so nothing can rewrite it.
 */
export const isolateCorpus = (experiment, pinnedRoot, label) => {
  const root = path.join(workRoot, label, experiment.language);
  fs.rmSync(root, { force: true, recursive: true });
  ensureDir(path.dirname(root));
  fs.cpSync(pinnedRoot, root, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".git",
  });
  return root;
};

/** Prove the pinned clone is still exactly the revision the result names. */
export const assertPinnedCorpus = (experiment, pinnedRoot) => {
  const read = (args) =>
    String(run("git", args, { cwd: pinnedRoot, stdio: "pipe" }).stdout);
  const head = read(["rev-parse", "HEAD"]).trim();
  if (head !== experiment.commit) {
    throw new Error(
      `${experiment.language}: the corpus clone is at ${head}, not the pinned ${experiment.commit}`,
    );
  }
  // `--ignored` as well, because build output a run leaves behind is exactly
  // what a `.gitignore` hides from an ordinary status.
  const dirty = read(["status", "--porcelain", "--ignored"]).trim();
  if (dirty !== "") {
    throw new Error(
      `${experiment.language}: this run modified the pinned corpus clone:\n${dirty}`,
    );
  }
};

export const cloneRepository = (experiment, options = {}) => {
  ensureDir(workRoot);
  const dir = path.join(workRoot, experiment.language);
  if (options.refresh === true && fs.existsSync(dir)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
  if (fs.existsSync(dir) && !fs.existsSync(path.join(dir, ".git"))) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
  if (fs.existsSync(dir) && experiment.commit !== undefined) {
    const current = String(
      run("git", ["rev-parse", "HEAD"], {
        cwd: dir,
        stdio: "pipe",
      }).stdout,
    ).trim();
    if (current !== experiment.commit) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  }
  if (fs.existsSync(dir) === false) {
    const args = ["clone", "--depth=1"];
    if (experiment.ref !== undefined) args.push("--branch", experiment.ref);
    args.push(experiment.repository, dir);
    run("git", args);
    if (experiment.commit !== undefined) {
      run("git", ["fetch", "--depth=1", "origin", experiment.commit], {
        cwd: dir,
      });
      run("git", ["checkout", "--detach", experiment.commit], { cwd: dir });
    }
  }
  return dir;
};
