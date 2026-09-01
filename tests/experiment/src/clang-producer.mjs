import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..", "..", "..");
const workRoot = path.join(repositoryRoot, "tests", "experiment", ".work");

/**
 * The complete owner of the native Clang producer cache.
 *
 * Workflows hash this file and the adapter pin, so changing the repository,
 * revision, build dependencies, configure flags, build target, installed
 * layout, or version admission changes the cache key. Language catalog rows
 * import the same constants, while setup executes the recipe below.
 */
export const CLANG_PRODUCER_REPOSITORY =
  "https://github.com/samchon/llvm-project.git";
export const CLANG_PRODUCER_COMMIT =
  "e33d8f51552a523b5696691738f1ef95f8e3a730";
export const CLANG_PRODUCER_BUILD_PACKAGES = Object.freeze([
  "clang",
  "cmake",
  "ninja-build",
]);
export const CLANG_PRODUCER_CACHE_INPUTS = Object.freeze([
  "packages/graph/src/provider/cpp/CPP_CLANG_PRODUCER_COMMIT.ts",
  "tests/experiment/src/clang-producer.mjs",
]);

const adapterPinFile = path.join(
  repositoryRoot,
  "packages",
  "graph",
  "src",
  "provider",
  "cpp",
  "CPP_CLANG_PRODUCER_COMMIT.ts",
);

/** Refuse a cache generation whose experiment and adapter pins diverge. */
export function assertClangProducerAdapterPin(
  source = fs.readFileSync(adapterPinFile, "utf8"),
) {
  const match =
    /CPP_CLANG_PRODUCER_COMMIT\s*=\s*"([0-9a-f]{40})"/u.exec(source);
  if (match?.[1] !== CLANG_PRODUCER_COMMIT) {
    throw new Error(
      `native Clang owner pins ${CLANG_PRODUCER_COMMIT}, but the adapter pins ${match?.[1] ?? "no exact commit"}`,
    );
  }
  return match[1];
}

/** The decision used by both the standalone cache owner and lane setup. */
export function clangProducerProvisionDecision({ installed, allowBuild }) {
  if (installed) return "reuse";
  if (allowBuild) return "build";
  throw new Error(
    "the pinned Clang producer cache is absent or invalid; only the workflow producer job may build it",
  );
}

/** Install or verify the one pinned native Clang producer. */
export function installClangGraphProducer({
  language,
  toolsRoot,
  binRoot,
  producerRepository,
  producerCommit,
  record,
  allowBuild = true,
  prepareBuild = () => undefined,
}) {
  if (
    producerRepository !== CLANG_PRODUCER_REPOSITORY ||
    producerCommit !== CLANG_PRODUCER_COMMIT
  ) {
    throw new Error(
      `${language}: native Clang catalog pins ${String(producerRepository)}@${String(producerCommit)}, ` +
        `expected ${CLANG_PRODUCER_REPOSITORY}@${CLANG_PRODUCER_COMMIT}`,
    );
  }
  assertClangProducerAdapterPin();

  const installed = installedClangGraphProducer({ toolsRoot, binRoot });
  const decision = clangProducerProvisionDecision({ installed, allowBuild });
  if (decision === "reuse") {
    recordClangTools(record);
    return decision;
  }
  prepareBuild();

  // The producer is a pinned commit, so its binary is a pure function of that
  // commit and this recipe. A restored cache remains untrusted input: the same
  // complete resource-tree and version checks used for a fresh build admit it.
  const source = path.join(toolsRoot, "samchon-clangd-source");
  const build = path.join(source, "build");
  fs.rmSync(source, { force: true, recursive: true });
  ensureDir(source);
  run("git", ["init", "--quiet"], { cwd: source });
  run("git", ["remote", "add", "origin", CLANG_PRODUCER_REPOSITORY], {
    cwd: source,
  });
  run(
    "git",
    ["fetch", "--depth=1", "origin", CLANG_PRODUCER_COMMIT],
    { cwd: source },
  );
  run("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: source });
  const revision = String(
    run("git", ["rev-parse", "HEAD"], {
      cwd: source,
      stdio: "pipe",
    }).stdout,
  ).trim();
  if (revision !== CLANG_PRODUCER_COMMIT) {
    throw new Error(
      `${language}: checked out native Clang ${revision}, expected ${CLANG_PRODUCER_COMMIT}`,
    );
  }
  run("cmake", [
    "-S",
    path.join(source, "llvm"),
    "-B",
    build,
    "-G",
    "Ninja",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_C_COMPILER=clang",
    "-DCMAKE_CXX_COMPILER=clang++",
    "-DLLVM_ENABLE_PROJECTS=clang;clang-tools-extra",
    "-DLLVM_TARGETS_TO_BUILD=Native",
    "-DLLVM_ENABLE_ASSERTIONS=ON",
    "-DLLVM_INCLUDE_TESTS=OFF",
    "-DCLANG_INCLUDE_TESTS=OFF",
    "-DLLVM_INCLUDE_BENCHMARKS=OFF",
    "-DLLVM_INCLUDE_EXAMPLES=OFF",
    `-DLLVM_FORCE_VC_REVISION=${CLANG_PRODUCER_COMMIT}`,
    `-DLLVM_FORCE_VC_REPOSITORY=${CLANG_PRODUCER_REPOSITORY}`,
  ]);

  // Hosted runners with the same advertised shape have varied from 56 to 107
  // minutes for this build. Use the machine rather than inventing a faster
  // fixed count, while bounding compile concurrency by two GiB of total memory
  // per job. This is a machine-class bound, not an out-of-memory guard.
  const jobs = Math.max(
    1,
    Math.min(
      os.availableParallelism(),
      Math.floor(os.totalmem() / (2 * 1024 * 1024 * 1024)),
    ),
  );
  console.log(
    `${language}: building the pinned Clang producer with ${String(jobs)} jobs ` +
      `(cores ${String(os.availableParallelism())}, ` +
      `memory ${String(Math.round(os.totalmem() / (1024 * 1024 * 1024)))} GiB)`,
  );
  run("cmake", [
    "--build",
    build,
    "--parallel",
    String(jobs),
    "--target",
    "clangd",
  ]);

  const binary = path.join(build, "bin", "clangd");
  assertVersion(language, binary);
  const builtResources = path.join(build, "lib", "clang");
  const resourceVersions = fs
    .readdirSync(builtResources, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs
          .statSync(path.join(builtResources, entry.name, "include"), {
            throwIfNoEntry: false,
          })
          ?.isDirectory(),
    )
    .map((entry) => entry.name);
  if (resourceVersions.length !== 1) {
    throw new Error(
      `${language}: native Clang produced ${resourceVersions.length} resource-header trees`,
    );
  }
  const installedResources = path.join(toolsRoot, "lib", "clang");
  fs.rmSync(installedResources, { force: true, recursive: true });
  ensureDir(path.dirname(installedResources));
  fs.cpSync(builtResources, installedResources, { recursive: true });
  const installedStddef = path.join(
    installedResources,
    resourceVersions[0],
    "include",
    "stddef.h",
  );
  if (!fs.statSync(installedStddef, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      `${language}: native Clang resource headers were not installed at ${installedStddef}`,
    );
  }
  for (const command of ["samchon-clangd", "clangd"]) {
    const link = path.join(binRoot, command);
    fs.rmSync(link, { force: true });
    fs.linkSync(binary, link);
  }
  assertVersion(language, path.join(binRoot, "samchon-clangd"));
  recordClangTools(record);
  fs.rmSync(source, { force: true, recursive: true });
  return decision;
}

function installedClangGraphProducer({ toolsRoot, binRoot }) {
  try {
    const installed = path.join(binRoot, "samchon-clangd");
    const alias = path.join(binRoot, "clangd");
    if (
      !fs.statSync(installed, { throwIfNoEntry: false })?.isFile() ||
      !fs.statSync(alias, { throwIfNoEntry: false })?.isFile()
    ) {
      return false;
    }
    const resources = path.join(toolsRoot, "lib", "clang");
    const versions = fs
      .readdirSync(resources, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          fs
            .statSync(path.join(resources, entry.name, "include", "stddef.h"), {
              throwIfNoEntry: false,
            })
            ?.isFile(),
      );
    if (versions.length !== 1) return false;
    for (const binary of [installed, alias]) assertVersion("cache", binary);
    return true;
  } catch {
    return false;
  }
}

function assertVersion(language, binary) {
  const version = String(run(binary, ["--version"], { stdio: "pipe" }).stdout);
  if (!version.includes(CLANG_PRODUCER_COMMIT)) {
    throw new Error(
      `${language}: native Clang version omits ${CLANG_PRODUCER_COMMIT}:\n${version}`,
    );
  }
}

function recordClangTools(record) {
  record({
    tool: "samchon-clangd",
    version: CLANG_PRODUCER_COMMIT,
    source: `${CLANG_PRODUCER_REPOSITORY}@${CLANG_PRODUCER_COMMIT}`,
    digest: `git:${CLANG_PRODUCER_COMMIT}`,
  });
  record({
    tool: "clangd",
    version: CLANG_PRODUCER_COMMIT,
    source: "alias of samchon-clangd",
    digest: `git:${CLANG_PRODUCER_COMMIT}`,
  });
}

async function main() {
  const language = "cpp";
  const toolsRoot = path.join(workRoot, "tools");
  const binRoot = path.join(toolsRoot, "bin");
  ensureDir(binRoot);
  installClangGraphProducer({
    language,
    toolsRoot,
    binRoot,
    producerRepository: CLANG_PRODUCER_REPOSITORY,
    producerCommit: CLANG_PRODUCER_COMMIT,
    record: () => undefined,
    allowBuild:
      process.env.SAMCHON_GRAPH_CLANG_PRODUCER_ALLOW_BUILD !== "0",
    prepareBuild: () => {
      shell("sudo apt-get update");
      shell(
        `sudo apt-get install -y ${CLANG_PRODUCER_BUILD_PACKAGES.join(" ")}`,
      );
    },
  });
}

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    shell: options.shell ?? false,
    stdio: options.stdio ?? "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${String(result.status)}`,
    );
  }
  return result;
}

function shell(command) {
  return run(command, [], { shell: true });
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
