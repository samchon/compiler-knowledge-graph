// Shared plumbing for the benchmark harnesses (agent-ab.mjs, agent-ab-codex.mjs,
// preflight.mjs): manifest-pinned prompt resolution, commit-pinned checkouts,
// dependency installation, and the graph-arm preflight gate.
import crypto from "node:crypto";
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ordinal from "./ordinal.cjs";

const { compareOrdinal } = ordinal;

const here = path.dirname(fileURLToPath(import.meta.url));
export const benchmarkDir = path.resolve(here, "..");
export const repoRoot = path.resolve(benchmarkDir, "..", "..");
export const graphLauncher = path.join(repoRoot, "packages", "graph", "lib", "bin.js");
export const questionsDir = path.join(here, "questions");

// Language servers provisioned for the benchmark live under .work/tools/<name>
// (gitignored). Prepend each tool's bin (or root) to PATH so every child this
// process spawns — the preflight dump, codex, and the MCP servers codex spawns
// in turn — can resolve them without machine-global installs.
const toolsRoot = path.join(benchmarkDir, ".work", "tools");
if (fs.existsSync(toolsRoot)) {
  const dotnetRoot = path.join(toolsRoot, "dotnet");
  const dotnetHost = path.join(
    dotnetRoot,
    process.platform === "win32" ? "dotnet.exe" : "dotnet",
  );
  if (fs.existsSync(dotnetHost)) {
    // Framework-dependent dotnet tools resolve their runtime from DOTNET_ROOT,
    // not PATH alone. Keep csharp-ls on the isolated .NET 10 installation that
    // also supplies the fixture's MSBuild.
    process.env.DOTNET_ROOT = dotnetRoot;
    process.env.DOTNET_ROOT_X64 = dotnetRoot;
    process.env.DOTNET_HOST_PATH = dotnetHost;
  }
  const toolDirectories = fs
    .readdirSync(toolsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const root = path.join(toolsRoot, entry.name);
      const children = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((child) => child.isDirectory())
        .map((child) => path.join(root, child.name, "bin"));
      return [
        root,
        path.join(root, "bin"),
        path.join(root, "server", "bin"),
        ...children,
      ];
    });
  const extra = [...new Set(toolDirectories)].filter((dir) => fs.existsSync(dir));
  if (extra.length > 0) {
    process.env.PATH = `${extra.join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ""}`;
  }
  // jdtls and kotlin-language-server boot a JVM and honor JAVA_HOME; point it at
  // the provisioned JDK 21 (jdtls requires 21+) so they resolve the right java
  // regardless of the machine default.
  const jdk = fs
    .readdirSync(toolsRoot, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && /^jdk-2[1-9]/.test(entry.name));
  if (jdk !== undefined) {
    process.env.JAVA_HOME = path.join(toolsRoot, jdk.name);
    process.env.PATH = `${path.join(toolsRoot, jdk.name, "bin")}${path.delimiter}${process.env.PATH}`;
  }
}

// Runtimes installed machine-wide rather than under .work/tools (ruby-lsp ships
// with the Ruby install; csharp-ls under the dotnet tools dir). Prepend their
// bin dirs when present so the server binaries resolve from the harness.
for (const dir of [
  "C:\\Ruby33-x64\\bin",
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dotnet", "tools"),
]) {
  if (dir && fs.existsSync(dir)) {
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
  }
}

export function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// Resolve a benchmark prompt from questions/manifest.json by id or family
// (+repo), read the pinned .md, and REFUSE to run when the file no longer
// matches its pinned hash — a run must be able to prove which utterance it
// measured.
export function resolvePrompt({ promptId, family, repo }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(questionsDir, "manifest.json"), "utf8"));
  const prompts = manifest.prompts ?? [];
  const entry = promptId
    ? prompts.find((p) => p.id === promptId)
    : prompts.find((p) => p.family === family && (p.family === "common" || p.repo === repo));
  if (!entry) {
    throw new Error(
      promptId
        ? `unknown prompt id ${promptId}; manifest has ${prompts.map((p) => p.id).join(", ")}`
        : `no manifest prompt for family ${family}${repo ? ` repo ${repo}` : ""}`,
    );
  }
  // Normalize CRLF so git's line-ending conversion on a different host can
  // never flip the hash or the prompt bytes.
  const text = fs
    .readFileSync(path.join(questionsDir, entry.file), "utf8")
    .replace(/\r\n/g, "\n")
    .trim();
  const actual = sha256(text);
  if (actual !== entry.questionSha256) {
    throw new Error(
      `${entry.file} does not match its pinned SHA-256 (manifest ${entry.questionSha256}, actual ${actual}); ` +
        "regenerate with generate-manifest.mjs or restore the file",
    );
  }
  return { entry, text };
}

// Clone the corpus entry at its PINNED commit. Upstream default branches move;
// the measurement must not.
export function clonePinned(spec, corpusRoot) {
  const repoDir = path.join(corpusRoot, spec.name);
  if (fs.existsSync(repoDir)) {
    assertPinnedCheckout(spec, repoDir);
    return repoDir;
  }
  fs.mkdirSync(repoDir, { recursive: true });
  console.log(`Fetching ${spec.url}@${spec.commit.slice(0, 12)} -> ${repoDir} ...`);
  run("git", ["init", "--quiet"], { cwd: repoDir });
  run("git", ["remote", "add", "origin", spec.url], { cwd: repoDir });
  run("git", ["fetch", "--quiet", "--depth", "1", "origin", spec.commit], { cwd: repoDir });
  run("git", ["checkout", "--quiet", spec.commit], { cwd: repoDir });
  assertPinnedCheckout(spec, repoDir);
  return repoDir;
}

/**
 * Refuse a fixture whose commit or source snapshot differs from the corpus.
 * Dependency and language preparation may populate ignored paths, but an
 * arbitrary tracked or untracked source file must never pass on HEAD alone.
 */
export function assertPinnedCheckout(spec, repoDir) {
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    throw new Error(`${repoDir} is not a git checkout`);
  }
  const head = run("git", ["rev-parse", "HEAD"], { cwd: repoDir }).trim();
  if (head !== spec.commit) {
    throw new Error(
      `${repoDir} is at ${head || "no HEAD"}, expected pinned commit ${spec.commit}`,
    );
  }
  const dirty = run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repoDir },
  ).trim();
  if (dirty !== "") {
    throw new Error(
      `${repoDir} is not the clean pinned snapshot (${dirty.split("\n")[0]})`,
    );
  }
  return {
    commit: head,
    tree: run("git", ["rev-parse", "HEAD^{tree}"], { cwd: repoDir }).trim(),
  };
}

// Install JS/TS dependencies from the lockfile so tsserver resolves imports at
// full strength. Other ecosystems' servers fetch their own dependencies (gopls,
// rust-analyzer) or work from source; anything extra goes through `prepare`.
export function ensureInstalled(repoDir, { noInstall = false } = {}) {
  if (noInstall) return;
  if (!fs.existsSync(path.join(repoDir, "package.json"))) return;
  if (fs.existsSync(path.join(repoDir, "node_modules"))) return;
  const plan = fs.existsSync(path.join(repoDir, "pnpm-lock.yaml"))
    ? { label: "pnpm", command: "pnpm", args: ["install", "--frozen-lockfile", "--ignore-scripts"] }
    : fs.existsSync(path.join(repoDir, "package-lock.json"))
      ? { label: "npm", command: "npm", args: ["ci", "--ignore-scripts"] }
      : fs.existsSync(path.join(repoDir, "yarn.lock"))
        // `--ignore-platform` because a lockfile can pin a native package for
        // one operating system and yarn refuses the whole install over it.
        // excalidraw pins `@typescript/typescript-win32-x64`, so its fixture
        // prepared on Windows and failed on Linux CI with "The platform 'linux'
        // is incompatible with this module" — which is true and irrelevant: the
        // binary could not run here, nothing asks it to, and the TypeScript
        // sources being indexed are the same either way. Skipping an unusable
        // native package is not the same as skipping a dependency.
        ? { label: "yarn", command: "corepack", args: ["yarn", "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-platform"] }
        : { label: "npm", command: "npm", args: ["install", "--ignore-scripts", "--no-package-lock"] };
  console.log(`Installing dependencies in ${repoDir} (${plan.label})...`);
  run(plan.command, plan.args, { cwd: repoDir, shell: true, stdio: "inherit" });
}

// Per-corpus setup the generic `ensureInstalled` can't express: a shell command
// run once in the checkout before indexing. ruby-lsp needs the Gemfile bundle
// installed; csharp-ls (Roslyn's in-process MSBuildWorkspace) silently returns
// zero symbols for serilog's full 19-project solution. Its `prepare` keeps the
// product and main test projects (plus TestDummies through a project reference),
// which csharp-ls loads cleanly without the perf/AOT entries. A no-op when the
// entry has no `prepare`.
export function runPrepare(spec, repoDir) {
  if (!spec.prepare) return;
  // Anything the preparation writes has to be invisible to git, because the
  // pinned tree is asserted again immediately afterwards and an untracked file
  // fails that check exactly like a modified one. Declaring the paths is safer
  // than depending on the fixture repository's own .gitignore, which is a
  // different project's decision and can change under us.
  for (const entry of spec.prepareIgnores ?? [])
    ensureLocalIgnored(repoDir, entry);
  console.log(`Preparing ${spec.name}: ${spec.prepare}`);
  // Two kinds of preparation, and they fail differently. ruby-lsp cannot serve
  // without its bundle, so sinatra's failure is the lane's failure. A
  // compilation database only decides whether the strict provider can be
  // offered at all — without one the build takes the fallback it takes today —
  // so refusing to measure would trade a worse number for no number.
  if (spec.prepareOptional !== true) {
    run(spec.prepare, [], { cwd: repoDir, shell: true, stdio: "inherit" });
    return;
  }
  try {
    run(spec.prepare, [], { cwd: repoDir, shell: true, stdio: "inherit" });
  } catch (error) {
    console.log(
      `Preparation for ${spec.name} did not complete, measuring without it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Hide a generated path from git inside one checkout.
 *
 * `.git/info/exclude` rather than the tree's own `.gitignore`, because the
 * fixture is a pinned snapshot and editing a tracked file to make room for a
 * tool would be the very change the pin exists to forbid.
 */
export function ensureLocalIgnored(repoDir, entry) {
  const exclude = path.join(repoDir, ".git", "info", "exclude");
  if (!fs.existsSync(exclude)) return;
  const text = fs.readFileSync(exclude, "utf8");
  if (new RegExp(`^${entry.replace(/[.\\/]/g, "\\$&")}$`, "m").test(text))
    return;
  fs.appendFileSync(
    exclude,
    `${text.endsWith("\n") ? "" : "\n"}# generated by graph benchmark\n${entry}\n`,
  );
}

/**
 * Materialize one clean, pinned fixture before either benchmark arm starts.
 * Both agents therefore see the same resolved dependency state. Preparation
 * is allowed to write only ignored paths; the pinned source tree is checked
 * again afterwards.
 */
export function prepareFixture(spec, repoDir, options = {}) {
  const before = assertPinnedCheckout(spec, repoDir);
  ensureInstalled(repoDir, options);
  if (spec.language === "dart") ensureDartPubDeps(repoDir);
  runPrepare(spec, repoDir);
  const serverArgs = prepareExternalServerArgs(spec, repoDir);
  const after = assertPinnedCheckout(spec, repoDir);
  if (before.commit !== after.commit || before.tree !== after.tree) {
    throw new Error(`${spec.name} preparation changed its pinned source tree`);
  }
  return { provenance: after, serverArgs };
}

/** Check --no-setup input without allowing the graph arm to prepare it later. */
export function assertPreparedFixture(spec, repoDir) {
  const provenance = assertPinnedCheckout(spec, repoDir);
  if (
    fs.existsSync(path.join(repoDir, "package.json")) &&
    !fs.existsSync(path.join(repoDir, "node_modules"))
  ) {
    throw new Error(`${spec.name} has no prepared node_modules`);
  }
  if (spec.language === "dart") {
    const missing = findFiles(repoDir, "pubspec.yaml").filter(
      (dir) => {
        const pubspec = fs.readFileSync(path.join(dir, "pubspec.yaml"), "utf8");
        return (
          !pubspecRequiresFlutter(pubspec) &&
          !fs.existsSync(path.join(dir, ".dart_tool", "package_config.json"))
        );
      },
    );
    if (missing.length > 0) {
      throw new Error(`${spec.name} has ${missing.length} unresolved Dart package(s)`);
    }
  }
  if (
    spec.prepareMarker &&
    !fs.existsSync(path.resolve(repoDir, spec.prepareMarker))
  ) {
    throw new Error(`${spec.name} is missing preparation marker ${spec.prepareMarker}`);
  }
  return {
    provenance,
    serverArgs: serverArgsForPreparedFixture(spec, repoDir),
  };
}

function ensureDartPubDeps(root) {
  for (const pubspecDir of findFiles(root, "pubspec.yaml")) {
    const pubspec = fs.readFileSync(path.join(pubspecDir, "pubspec.yaml"), "utf8");
    if (pubspecRequiresFlutter(pubspec)) {
      console.log(`Skipping Flutter-only Dart package in ${pubspecDir}.`);
      continue;
    }
    if (
      fs.existsSync(
        path.join(pubspecDir, ".dart_tool", "package_config.json"),
      )
    )
      continue;
    console.log(`Resolving Dart dependencies in ${pubspecDir}...`);
    const lockfile = path.join(pubspecDir, "pubspec.lock");
    const hadLockfile = fs.existsSync(lockfile);
    run("dart", ["pub", "get"], { cwd: pubspecDir, stdio: "inherit" });
    if (!hadLockfile && fs.existsSync(lockfile)) fs.rmSync(lockfile);
  }
}

/** Whether a Dart package requires the separately provisioned Flutter SDK. */
export function pubspecRequiresFlutter(text) {
  return /^\s*sdk:\s*flutter\s*(?:#.*)?$/m.test(text);
}

function findFiles(root, name) {
  const ignored = new Set([
    ".dart_tool",
    ".git",
    "build",
    "node_modules",
    "vendor",
  ]);
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === name) found.push(dir);
    }
  }
  return found.sort(compareOrdinal);
}

function prepareExternalServerArgs(spec, repoDir) {
  if (!spec.dotnetSolution) return [];
  const solutionPath = externalSolutionPath(spec, repoDir);
  const externalRoot = path.dirname(solutionPath);
  fs.mkdirSync(externalRoot, { recursive: true });
  run(
    "dotnet",
    [
      "new",
      "sln",
      "--name",
      spec.dotnetSolution.name,
      "--format",
      "sln",
      "--output",
      externalRoot,
      "--force",
    ],
    { stdio: "inherit" },
  );
  run(
    "dotnet",
    [
      "sln",
      solutionPath,
      "add",
      ...spec.dotnetSolution.projects.map((project) =>
        path.resolve(repoDir, project),
      ),
    ],
    { stdio: "inherit" },
  );
  return serverArgsForPreparedFixture(spec, repoDir);
}

export function serverArgsForPreparedFixture(spec, repoDir) {
  if (!spec.dotnetSolution) return [];
  const solutionPath = externalSolutionPath(spec, repoDir);
  if (!fs.existsSync(solutionPath)) {
    throw new Error(`${spec.name} is missing external solution ${solutionPath}`);
  }
  return ["--solution", solutionPath];
}

/**
 * The external preparation state that belongs to one checkout, if any.
 *
 * Exposed as a path rather than copied or deleted here so a benchmark can keep
 * its own destructive-path boundary. Serilog's reduced solution must stay
 * outside the pinned Git tree, but it still belongs to exactly that fixture.
 */
export function preparedFixtureCompanion(spec, repoDir) {
  return spec.dotnetSolution
    ? path.dirname(externalSolutionPath(spec, repoDir))
    : undefined;
}

function externalSolutionPath(spec, repoDir) {
  return path.join(
    path.dirname(repoDir),
    ".samchon-graph-prepared",
    path.basename(repoDir),
    `${spec.dotnetSolution.name}.sln`,
  );
}

// The graph-arm gate: build the full dump of the pinned checkout and demand a
// real language-server graph. Without this, a host missing the language server
// would silently measure the static fallback and corrupt the comparison.
export function preflightGraph(spec, repoDir, prepared = { serverArgs: [] }) {
  // Some language servers ship inside the checkout itself (e.g. excalidraw's
  // ttscserver under node_modules/.bin) rather than machine-global or under
  // .work/tools. Prepend the repo-local bin so the preflight resolves them the
  // same way the measured run (agent-ab.mjs) does; otherwise TypeScript would
  // be mis-flagged NO-GO for a missing server that is actually present.
  //
  // No `--max-files` / timeout bounds: the graph is never capped, so the
  // preflight indexes the full tree exactly as the measured run does.
  const localBin = path.join(repoDir, "node_modules", ".bin");
  const out = run(
    process.execPath,
    [
      graphLauncher,
      "dump",
      "--cwd",
      repoDir,
      "--language",
      spec.language,
      "--mode",
      "lsp",
      ...prepared.serverArgs.flatMap((arg) => ["--server-arg", arg]),
    ],
    fs.existsSync(localBin)
      ? { env: { ...process.env, PATH: `${localBin}${path.delimiter}${process.env.PATH ?? ""}` } }
      : {},
  );
  const dump = JSON.parse(out);
  return analyzePreflightDump(spec, dump);
}

const STRUCTURAL_EDGE_KINDS = new Set(["contains", "exports", "imports"]);

/** Verify that an LSP dump contains a meaningful semantic graph for its corpus. */
export function analyzePreflightDump(spec, dump) {
  const edgeKinds = {};
  for (const edge of dump.edges ?? []) {
    edgeKinds[edge.kind] = (edgeKinds[edge.kind] ?? 0) + 1;
  }
  const semanticKinds = Object.entries(edgeKinds).filter(
    ([kind, count]) => !STRUCTURAL_EDGE_KINDS.has(kind) && count > 0,
  );
  const semanticEdges = semanticKinds.reduce((sum, [, count]) => sum + count, 0);
  const minimums = spec.preflight;
  if (!minimums) {
    throw new Error(`${spec.name} has no corpus-specific preflight minimums`);
  }
  const warnings = dump.warnings ?? [];
  const failures = [
    !["lsp", "hybrid"].includes(dump.indexer)
      ? `non-LSP indexer ${dump.indexer ?? "missing"}`
      : null,
    warnings.length > 0 ? `${warnings.length} fatal warning(s)` : null,
    dump.nodes.length < minimums.nodes
      ? `${dump.nodes.length}/${minimums.nodes} nodes`
      : null,
    dump.edges.length < minimums.edges
      ? `${dump.edges.length}/${minimums.edges} edges`
      : null,
    semanticEdges < minimums.semanticEdges
      ? `${semanticEdges}/${minimums.semanticEdges} semantic edges`
      : null,
    semanticKinds.length < minimums.semanticEdgeKinds
      ? `${semanticKinds.length}/${minimums.semanticEdgeKinds} semantic edge kinds`
      : null,
  ].filter(Boolean);
  return {
    indexer: dump.indexer,
    nodes: dump.nodes.length,
    edges: dump.edges.length,
    edgeKinds,
    semanticEdges,
    semanticEdgeKinds: semanticKinds.length,
    minimums,
    warnings,
    failures,
    ok: failures.length === 0,
  };
}

export function run(command, args, options = {}) {
  const result = cp.spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    // Large trees (flutter's Dart dump) can exceed a 64 MB stdout buffer and
    // die with ENOBUFS; give the preflight dump room to complete.
    maxBuffer: 512 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${(result.stderr ?? "").slice(0, 2000)}`,
    );
  }
  return result.stdout ?? "";
}

export function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) out[match[1]] = match[2];
    else if (arg.startsWith("--")) out[arg.slice(2)] = "true";
  }
  return out;
}

export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
