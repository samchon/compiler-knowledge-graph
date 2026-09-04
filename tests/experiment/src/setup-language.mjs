import fs from "node:fs";
import { createHash } from "node:crypto";
import https from "node:https";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { findExperiment } from "./catalog.mjs";
import {
  CLANG_PRODUCER_BUILD_PACKAGES,
  installClangGraphProducer,
} from "./clang-producer.mjs";
import { verifyGitTree } from "./git-tree.mjs";
import {
  appendGithubPath,
  ensureDir,
  parseArgs,
  recordProvisionedEnvironment,
  recordTool,
  repositoryRoot,
  resetProvisionedEnvironment,
  run,
  shell,
  resetToolManifest,
  workRoot,
} from "./process.mjs";
import { verifyRustGraphProducer } from "./rust-producer.mjs";

const args = parseArgs(process.argv.slice(2));
const experiment = findExperiment(args.language);
const toolsRoot = path.join(workRoot, "tools");
const binRoot = path.join(toolsRoot, "bin");
ensureDir(binRoot);
resetProvisionedEnvironment();
appendGithubPath(binRoot);
resetToolManifest(experiment.language);

// Every tool this lane resolves is recorded so the published result names the
// build that produced it. `digest: "unpinned"` is a truthful entry, not a
// placeholder: a mutable channel is what the reader has to know about.
const record = (tool) => recordTool(experiment.language, tool);

const apt = (packages) => {
  shell("sudo apt-get update");
  shell(`sudo apt-get install -y ${packages.join(" ")}`);
};

// GitHub release download URLs (and coursier/eclipse mirrors) answer with a 302
// to a CDN host, so follow redirects instead of treating them as failures.
const openStream = (url, redirects = 0, headers = {}) =>
  new Promise((resolve, reject) => {
    const request = https
      .get(url, { headers: { "User-Agent": "samchon-graph-experiment", ...headers } }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirects >= 5) {
            reject(new Error(`Too many redirects for ${url}`));
            return;
          }
          resolve(openStream(new URL(response.headers.location, url).toString(), redirects + 1, headers));
          return;
        }
        if (status !== 200) {
          reject(Object.assign(new Error(`${url} returned ${status}`), { status }));
          response.resume();
          return;
        }
        resolve(response);
      })
      .on("error", reject);
    // A socket that opens and then goes silent settles nothing — no status, no
    // error, no end — and would hang the lane until the job timeout. This is an
    // idle bound, not a duration cap: an archive that keeps making progress
    // never trips it, while a stall gets the same bounded retry as a refusal.
    request.setTimeout(STALL_TIMEOUT_MS, () => {
      request.destroy(
        new Error(`${url} stalled for ${STALL_TIMEOUT_MS / 1000}s`),
      );
    });
  });

// One transient 5xx or dropped socket from a release CDN or mirror currently
// fails the whole language lane and with it the experiment matrix, so retry the
// complete download a bounded number of times with backoff. A 4xx answer is
// authoritative — the asset is missing or the request is wrong — and fails fast.
const RETRY_DELAYS_MS = [2000, 5000, 15000];
const STALL_TIMEOUT_MS = 60000;

const withRetries = async (operation) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const transient = error.status === undefined || error.status >= 500;
      if (transient === false || attempt >= RETRY_DELAYS_MS.length) throw error;
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(`${error.message} — retrying in ${delay / 1000}s.`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

const downloadJson = async (url, headers = {}) =>
  await withRetries(async () => {
    const response = await openStream(url, 0, headers);
    const chunks = [];
    return await new Promise((resolve, reject) => {
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        // A `JSON.parse` throw inside this listener would escape the promise
        // as an uncaught exception — one malformed 200 body would crash the
        // lane instead of getting the retry every other bad answer gets.
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
      response.on("error", reject);
    });
  });

const downloadFile = async (url, file) =>
  await withRetries(async () => {
    const response = await openStream(url);
    await new Promise((resolve, reject) => {
      const write = fs.createWriteStream(file);
      // A failed attempt still releases its half: the write stream on a dead
      // response, and the response on a dead write — otherwise a retried
      // download keeps the failed file open and a dead file keeps downloading.
      response.on("error", (error) => {
        write.destroy();
        reject(error);
      });
      response.pipe(write);
      write.on("finish", () => write.close(resolve));
      write.on("error", (error) => {
        response.destroy();
        reject(error);
      });
    });
  });

const verifySha256 = (file, expected) => {
  const actual = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actual !== expected) {
    throw new Error(`${file} has SHA-256 ${actual}, expected ${expected}`);
  }
};

const verifySha512 = (file, expected) => {
  const actual = createHash("sha512")
    .update(fs.readFileSync(file))
    .digest("base64");
  if (actual !== expected) {
    throw new Error(`${file} has an unexpected SHA-512 digest`);
  }
};

// Unauthenticated requests to api.github.com share a 60/hour rate limit across
// the whole runner IP pool; a GITHUB_TOKEN raises that to 5000/hour and is
// never sent past api.github.com since this call never redirects elsewhere.
const latestAsset = async (repository, pattern) => {
  const headers = process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {};
  const release = await downloadJson(`https://api.github.com/repos/${repository}/releases/latest`, headers);
  const asset = release.assets.find((item) => pattern.test(item.name));
  if (asset === undefined) throw new Error(`No release asset matching ${pattern} in ${repository}`);
  return asset.browser_download_url;
};

const installKotlinLanguageServer = async () => {
  apt(["openjdk-17-jdk", "unzip"]);
  const url = await latestAsset("fwcd/kotlin-language-server", /server.*\.zip$/);
  const archive = path.join(toolsRoot, "kotlin-language-server.zip");
  const target = path.join(toolsRoot, "kotlin-language-server");
  await downloadFile(url, archive);
  fs.rmSync(target, { force: true, recursive: true });
  ensureDir(target);
  run("unzip", ["-q", archive, "-d", target]);
  record({
    tool: "kotlin-language-server",
    version: "unpinned",
    source: url,
    digest: "unpinned",
  });
  const launcher = path.join(target, "server", "bin", "kotlin-language-server");
  const link = path.join(binRoot, "kotlin-language-server");
  fs.rmSync(link, { force: true });
  fs.symlinkSync(launcher, link);
};

const installGradle = async () => {
  const version = "9.4.1";
  const url = `https://services.gradle.org/distributions/gradle-${version}-bin.zip`;
  const archive = path.join(toolsRoot, `gradle-${version}-bin.zip`);
  const target = path.join(toolsRoot, `gradle-${version}`);
  await downloadFile(url, archive);
  verifySha256(
    archive,
    "2ab2958f2a1e51120c326cad6f385153bb11ee93b3c216c5fccebfdfbb7ec6cb",
  );
  fs.rmSync(target, { force: true, recursive: true });
  run("unzip", ["-q", archive, "-d", toolsRoot]);
  const executable = path.join(target, "bin", "gradle");
  if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Gradle ${version} was not extracted at ${executable}`);
  }
  fs.chmodSync(executable, 0o755);
  const link = path.join(binRoot, "gradle");
  fs.rmSync(link, { force: true });
  fs.symlinkSync(executable, link);
  const output = String(
    run(link, ["--version"], { stdio: "pipe" }).stdout,
  );
  if (!output.includes(`Gradle ${version}`)) {
    throw new Error(`Expected Gradle ${version}, received:\n${output}`);
  }
  console.log(output.trim());
  record({
    tool: "gradle",
    version,
    source: url,
    digest:
      "sha256:2ab2958f2a1e51120c326cad6f385153bb11ee93b3c216c5fccebfdfbb7ec6cb",
  });
  return executable;
};

const installZls = async () => {
  const url = await latestAsset("zigtools/zls", /x86_64.*linux.*\.tar\.xz$/);
  const archive = path.join(toolsRoot, "zls.tar.xz");
  const target = path.join(toolsRoot, "zls");
  await downloadFile(url, archive);
  fs.rmSync(target, { force: true, recursive: true });
  ensureDir(target);
  // Recent zls tarballs extract the `zls` binary at the archive root, so no
  // `--strip-components`; locate the binary wherever it lands.
  run("tar", ["-xf", archive, "-C", target]);
  record({ tool: "zls", version: "unpinned", source: url, digest: "unpinned" });
  const binary = findFile(target, "zls");
  if (binary === undefined) throw new Error("zls binary not found after extraction");
  fs.chmodSync(binary, 0o755);
  const link = path.join(binRoot, "zls");
  fs.rmSync(link, { force: true });
  fs.symlinkSync(binary, link);
};

const installScip = async () => {
  // scip-java v0.13.1 emits the typed-range oneof introduced by SCIP v0.9.
  // An older decoder silently discards those unknown protobuf fields before
  // printing JSON, making valid occurrences appear to have no source range.
  const archive = path.join(toolsRoot, "scip-v0.9.0-linux-amd64.tar.gz");
  const target = path.join(toolsRoot, "scip-v0.9.0");
  await downloadFile(
    "https://github.com/scip-code/scip/releases/download/v0.9.0/scip-linux-amd64.tar.gz",
    archive,
  );
  verifySha256(
    archive,
    "fc2e7273e110be9f35924da1066000183791e8bfdb0391355de6eaaa070fec75",
  );
  record({
    tool: "scip",
    version: "v0.9.0",
    source:
      "https://github.com/scip-code/scip/releases/download/v0.9.0/scip-linux-amd64.tar.gz",
    digest:
      "sha256:fc2e7273e110be9f35924da1066000183791e8bfdb0391355de6eaaa070fec75",
  });
  fs.rmSync(target, { force: true, recursive: true });
  ensureDir(target);
  run("tar", ["-xzf", archive, "-C", target]);
  const binary = findFile(target, "scip");
  if (binary === undefined) {
    throw new Error("scip binary not found after extraction");
  }
  fs.chmodSync(binary, 0o755);
  const link = path.join(binRoot, "scip");
  fs.rmSync(link, { force: true });
  fs.symlinkSync(binary, link);
};

// The strict Ruby producer, which `GRAPH_PROVIDERS` has registered since the
// registry existed and which no runner has ever installed. Until now every Ruby
// build fell through to the generic language-server lane, where a
// `textDocument/references` per symbol against a server with no persistent
// cross-file index made sinatra exceed an hour twice — at a thirty minute cap
// and again at sixty.
//
// The standalone binary rather than the gem, because it is the one artifact
// GitHub publishes a digest for, and this setup pins what it installs. Upstream
// ships x86_64 Linux and arm64 Darwin only: there is no Windows build, which
// matters for the product beyond this runner and is recorded rather than
// discovered later.
// Every SCIP producer upstream publishes as a single self-contained executable
// installs the same way, so the shape is written once. The digest is taken from
// the release API rather than computed here: GitHub reports it per asset, which
// pins the bytes without this setup having to fetch them twice.
const installPinnedBinary = async ({ tool, version, url, digest }) => {
  const binary = path.join(toolsRoot, `${tool}-${version}`);
  await downloadFile(url, binary);
  verifySha256(binary, digest);
  record({ tool, version, source: url, digest: `sha256:${digest}` });
  fs.chmodSync(binary, 0o755);
  const link = path.join(binRoot, tool);
  fs.rmSync(link, { force: true });
  fs.symlinkSync(binary, link);
};

const installScipRuby = () =>
  installPinnedBinary({
    tool: "scip-ruby",
    version: "v0.4.7",
    url: "https://github.com/sourcegraph/scip-ruby/releases/download/scip-ruby-v0.4.7/scip-ruby-x86_64-linux",
    digest:
      "a068c7c3b2042b9eac563ce77ce35dcaca666b418530b1db9f932a3dbc7175dd",
  });

// The Kotlin graph producer is a K2 compiler plugin injected into ordinary
// Kotlin/JVM Gradle compile tasks. Its compiler minor must match the project,
// so the experiment pins the exact fork revision and verifies both its
// artifact option and resident Tooling API protocol before indexing Koin.
const SCIP_JAVA_KOTLIN_VERSION = "2.3.20";

/**
 * Build one exact `scip-java` source revision and install its launcher.
 *
 * Two rows need this and they need different revisions: Kotlin needs the
 * upstream commit that completed the 2.3.20 plugin port, and Java needs the
 * fork whose `index` command writes a graph artifact at all. The revision, its
 * Git tree and the version string a run records are therefore arguments rather
 * than constants. GitHub may repackage a generated source archive without
 * changing its contents, so the immutable extracted tree is the security and
 * reproducibility boundary: one builder, two pins, and no local patch on either.
 */
const installScipJavaSource = async (gradle, pin) => {
  const url = `https://codeload.github.com/${pin.repository}/tar.gz/${pin.commit}`;
  const archive = path.join(toolsRoot, `scip-java-${pin.commit}.tar.gz`);
  const source = path.join(toolsRoot, `scip-java-${pin.commit}`);
  await downloadFile(url, archive);
  fs.rmSync(source, { force: true, recursive: true });
  ensureDir(source);
  run(
    "tar",
    ["-xzf", archive, "--strip-components=1", "-C", source],
  );
  verifyGitTree(source, pin.tree);
  if (pin.verify !== undefined) pin.verify({ gradle, source });
  run(gradle, ["--no-daemon", ":scip-java:installDist"], { cwd: source });
  const launcher = path.join(
    source,
    "scip-java",
    "build",
    "install",
    "scip-java",
    "bin",
    "scip-java",
  );
  if (!fs.statSync(launcher, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`scip-java snapshot launcher not found at ${launcher}`);
  }
  fs.chmodSync(launcher, 0o755);
  const link = path.join(binRoot, "scip-java");
  fs.rmSync(link, { force: true });
  fs.symlinkSync(launcher, link);
  run(link, ["--version"]);
  record({
    tool: "scip-java",
    version: pin.version,
    source: url,
    digest: `git-tree:${pin.tree}`,
  });
  return link;
};

const installScipJavaKotlinSnapshot = async (gradle) => {
  if (
    typeof experiment.producerRepository !== "string" ||
    typeof experiment.producerCommit !== "string" ||
    typeof experiment.producerTree !== "string"
  ) {
    throw new Error(
      "kotlin: the compiler graph setup requires an exact producer repository, commit, and tree",
    );
  }
  const repository = experiment.producerRepository
    .replace(/^https:\/\/github\.com\//u, "")
    .replace(/\.git$/u, "");
  const link = await installScipJavaSource(gradle, {
    repository,
    commit: experiment.producerCommit,
    tree: experiment.producerTree,
    version: `${experiment.producerCommit}+kotlin-${SCIP_JAVA_KOTLIN_VERSION}`,
  });
  const indexHelp = String(
    run(link, ["index", "--help"], { stdio: "pipe" }).stdout,
  );
  const serverHelp = String(
    run(link, ["kotlin-graph-server", "--help"], {
      stdio: "pipe",
    }).stdout,
  );
  if (!indexHelp.includes("--kotlin-graph-output")) {
    throw new Error(
      `kotlin: the installed scip-java does not publish --kotlin-graph-output:\n${indexHelp}`,
    );
  }
  if (
    !serverHelp.includes(
      "Serve compiler-owned Kotlin graph generations over NDJSON.",
    )
  ) {
    throw new Error(
      `kotlin: the installed scip-java does not publish the resident graph protocol:\n${serverHelp}`,
    );
  }
  process.env.SAMCHON_GRAPH_KOTLINC_GRAPH = link;
  recordProvisionedEnvironment("SAMCHON_GRAPH_KOTLINC_GRAPH", link);
};

/**
 * The javac graph producer, built from the exact fork revision the consumer
 * pins.
 *
 * No released `scip-java` carries `--graph-output`, and the strict route
 * declines a launcher that does not publish it — so a released install here
 * would prove the decline rather than the route. The catalog names the exact
 * revision so the corpus fixture and the plugin indexing it come from one
 * checkout, and the launcher is then asked, as a condition of installation,
 * to show the option this row exists to exercise.
 */
const installJavacGraphProducer = async (gradle) => {
  if (
    typeof experiment.producerRepository !== "string" ||
    typeof experiment.producerCommit !== "string" ||
    typeof experiment.producerTree !== "string"
  ) {
    throw new Error(
      "java: the javac graph setup requires an exact producer repository, commit, and tree",
    );
  }
  const repository = experiment.producerRepository
    .replace(/^https:\/\/github\.com\//u, "")
    .replace(/\.git$/u, "");
  const link = await installScipJavaSource(gradle, {
    repository,
    commit: experiment.producerCommit,
    tree: experiment.producerTree,
    version: experiment.producerCommit,
    verify: ({ gradle: verifiedGradle, source }) => {
      run(
        verifiedGradle,
        [
          ":scip-javac:test",
          "--tests",
          "org.scip_code.scip_java.javac.JavaGraphShardTest",
          "--no-daemon",
          "--no-configuration-cache",
        ],
        { cwd: source },
      );
      run(
        verifiedGradle,
        [
          ":scip-gradle-plugin:test",
          "--tests",
          "org.scip_code.scip_java.gradle.GraphGenerationStoreTest",
          "--no-daemon",
          "--no-configuration-cache",
        ],
        { cwd: source },
      );
      run(
        verifiedGradle,
        [
          ":scip-java:test",
          "--tests",
          "tests.GradleGraphLifecycleTest",
          "--tests",
          "tests.MavenGraphLifecycleTest",
          "--tests",
          "tests.MavenGraphPluginTest",
          "--tests",
          "tests.GraphAggregateRunnerTest",
          "--tests",
          "tests.GradleBuildToolTest",
          "--no-daemon",
          "--no-configuration-cache",
          "-Pkotlin.compiler.execution.strategy=in-process",
          "-Pkotlin.incremental=false",
        ],
        { cwd: source },
      );
    },
  });
  const help = String(
    run(link, ["index", "--help"], { stdio: "pipe" }).stdout,
  );
  if (!help.includes("--graph-output")) {
    throw new Error(
      `java: the installed scip-java does not publish --graph-output:
${help}`,
    );
  }
  process.env.SAMCHON_GRAPH_JAVAC_GRAPH = link;
  recordProvisionedEnvironment("SAMCHON_GRAPH_JAVAC_GRAPH", link);
};

/** Build and install the exact JDT workspace graph producer revision. */
const installJdtGraphProducer = async () => {
  for (const field of [
    "jdtProducerRepository",
    "jdtProducerCommit",
    "jdtProducerTree",
  ]) {
    if (typeof experiment[field] !== "string" || experiment[field] === "") {
      throw new Error(`java: the JDT graph setup requires an exact ${field}`);
    }
  }
  const repository = experiment.jdtProducerRepository
    .replace(/^https:\/\/github\.com\//u, "")
    .replace(/\.git$/u, "");
  const url = `https://codeload.github.com/${repository}/tar.gz/${experiment.jdtProducerCommit}`;
  const archive = path.join(
    toolsRoot,
    `eclipse-jdt-ls-${experiment.jdtProducerCommit}.tar.gz`,
  );
  const source = path.join(
    toolsRoot,
    `eclipse-jdt-ls-${experiment.jdtProducerCommit}`,
  );
  await downloadFile(url, archive);
  fs.rmSync(source, { force: true, recursive: true });
  ensureDir(source);
  run("tar", ["-xzf", archive, "--strip-components=1", "-C", source]);
  verifyGitTree(source, experiment.jdtProducerTree);
  const maven = path.join(source, "mvnw");
  if (!fs.statSync(maven, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`java: the pinned JDT Maven wrapper is missing at ${maven}`);
  }
  fs.chmodSync(maven, 0o755);
  run(maven, ["clean", "install", "-U", "-DskipTests=true"], {
    cwd: source,
  });
  run(
    maven,
    [
      "verify",
      "-pl",
      "org.eclipse.jdt.ls.tests",
      "-am",
      "-Dtest=GraphSnapshotCommandTest,UnresolvedTypesQuickFixTest#testTypeInSealedTypeDeclaration,FileEventHandlerTest,CleanUpsTest",
    ],
    { cwd: source },
  );
  const launcher = path.join(
    source,
    "org.eclipse.jdt.ls.product",
    "target",
    "repository",
    "bin",
    "jdtls",
  );
  if (!fs.statSync(launcher, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`java: the pinned JDT launcher is missing at ${launcher}`);
  }
  fs.chmodSync(launcher, 0o755);
  const dedicated = path.join(binRoot, "samchon-jdtls");
  const generic = path.join(binRoot, "jdtls");
  for (const link of [dedicated, generic]) {
    fs.rmSync(link, { force: true });
    fs.symlinkSync(launcher, link);
  }
  process.env.SAMCHON_GRAPH_JDT_WORKSPACE = dedicated;
  recordProvisionedEnvironment("SAMCHON_GRAPH_JDT_WORKSPACE", dedicated);
  record({
    tool: "eclipse-jdtls-graph-snapshot",
    version: experiment.jdtProducerCommit,
    source: url,
    digest: `git-tree:${experiment.jdtProducerTree}`,
  });
};

// Needs a compilation database, which is why the provider carries
// `--compdb-path` and the corpus fixtures for redis and leveldb have to produce
// `compile_commands.json` before this can say anything.
const installScipClang = () =>
  installPinnedBinary({
    tool: "scip-clang",
    version: "v0.4.0",
    url: "https://github.com/sourcegraph/scip-clang/releases/download/v0.4.0/scip-clang-x86_64-linux",
    digest:
      "06fd18c576f979a726c651594644ec4a35db4f471f2160b3f72eb89fa6001784",
  });

// The published tarball is a webpack bundle whose only runtime `require`s are
// Node built-ins, so extracting the integrity-verified archive installs exactly
// the bytes the digest covers. `npm install` would instead resolve the package's
// eight caret-ranged dependencies against the live registry on every setup —
// a closure no digest pins and that this tool never loads.
const installScipPython = async () => {
  const archive = path.join(toolsRoot, "scip-python-0.6.6.tgz");
  const target = path.join(toolsRoot, "scip-python-0.6.6");
  await downloadFile(
    "https://registry.npmjs.org/@sourcegraph/scip-python/-/scip-python-0.6.6.tgz",
    archive,
  );
  verifySha512(
    archive,
    "qoKL1Rggg0o5newAFbCFAKlS0AjWxG5MA+mC28BtgxOv0DhO4zdL8u7151FxEppDpXMVvm7+yXSjXotoVH9cMQ==",
  );
  record({
    tool: "scip-python",
    version: "0.6.6",
    source:
      "https://registry.npmjs.org/@sourcegraph/scip-python/-/scip-python-0.6.6.tgz",
    digest:
      "sha512:qoKL1Rggg0o5newAFbCFAKlS0AjWxG5MA+mC28BtgxOv0DhO4zdL8u7151FxEppDpXMVvm7+yXSjXotoVH9cMQ==",
  });
  fs.rmSync(target, { force: true, recursive: true });
  ensureDir(target);
  run("tar", ["-xzf", archive, "-C", target, "--strip-components", "1"]);
  const launcher = path.join(target, "index.js");
  if (!fs.existsSync(launcher)) {
    throw new Error("scip-python launcher not found after extraction");
  }
  fs.chmodSync(launcher, 0o755);
  const link = path.join(binRoot, "scip-python");
  fs.rmSync(link, { force: true });
  fs.symlinkSync(launcher, link);
  // Extracting rather than installing rests on the bundle needing nothing but
  // Node built-ins. Run it once here, where a missing module is one clear
  // failure, instead of leaving it to surface as an unavailable provider that
  // silently degrades the configuration fingerprint.
  run(link, ["--version"]);
};

const findFile = (dir, name) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(abs, name);
      if (nested !== undefined) return nested;
    } else if (entry.name === name) {
      return abs;
    }
  }
  return undefined;
};

switch (experiment.language) {
  case "typescript": {
    // This case used to be `break;` — the flagship language provisioned
    // nothing, so excalidraw came back `indexer=static` and its 172,012 lines
    // in 2.8 s read as the compiler-owned provider being fast when the
    // best-effort syntax reader had produced it.
    //
    // The producer is the release this workspace's lockfile already resolves,
    // not a separately installed one. `resolveTtscGraphCommand` prefers the
    // indexed project's own `ttsc` installation over PATH, and every corpus
    // copy lives under this package's work directory — so Node's upward
    // lookup reaches `tests/experiment/node_modules/ttsc` before PATH is ever
    // consulted. Provisioning a different release here puts two producers on
    // one lane and proves whichever one resolution happened to reach: that is
    // exactly how a lane pinned to 0.23.0 kept passing while the workspace
    // moved to a release that speaks the native protocol.
    //
    // Reading the lockfile's release also makes the pin real. The platform
    // binary is an exact-versioned optional dependency of `ttsc`, so its bytes
    // are fixed by `pnpm-lock.yaml`'s integrity hash rather than by whatever a
    // mutable global install channel serves that hour.
    const ttscPackage = createRequire(import.meta.url).resolve(
      "ttsc/package.json",
    );
    const ttscVersion = JSON.parse(
      fs.readFileSync(ttscPackage, "utf8"),
    ).version;
    const executable =
      process.platform === "win32" ? "ttscgraph.exe" : "ttscgraph";
    const platformPackage = `@ttsc/${process.platform}-${process.arch}`;
    const ttscGraph = createRequire(ttscPackage).resolve(
      `${platformPackage}/bin/${executable}`,
    );
    if (process.platform !== "win32") fs.chmodSync(ttscGraph, 0o755);
    const link = path.join(binRoot, executable);
    fs.rmSync(link, { force: true });
    fs.symlinkSync(ttscGraph, link);
    record({
      tool: "ttscgraph",
      version: ttscVersion,
      source: `${platformPackage}@${ttscVersion} resolved from the workspace lockfile`,
      digest: createHash("sha256")
        .update(fs.readFileSync(ttscGraph))
        .digest("hex"),
    });
    break;
  }
  case "go": {
    const archive = path.join(
      toolsRoot,
      "scip-go-v0.2.7-linux-amd64.tar.gz",
    );
    const extracted = path.join(toolsRoot, "scip-go-v0.2.7");
    await downloadFile(
      "https://github.com/scip-code/scip-go/releases/download/v0.2.7/scip-go-linux-amd64.tar.gz",
      archive,
    );
    verifySha256(
      archive,
      "5bfe39016ca04f5b3b1cce41d1b63ea120a7d7e93b55407bfb17a6b02d18135a",
    );
    fs.rmSync(extracted, { force: true, recursive: true });
    ensureDir(extracted);
    run("tar", ["-xzf", archive, "-C", extracted]);
    const scipGo = findFile(extracted, "scip-go");
    if (scipGo === undefined) {
      throw new Error("scip-go binary not found after extraction");
    }
    fs.chmodSync(scipGo, 0o755);
    record({
      tool: "scip-go",
      version: "v0.2.7",
      source:
        "https://github.com/scip-code/scip-go/releases/download/v0.2.7/scip-go-linux-amd64.tar.gz",
      digest:
        "sha256:5bfe39016ca04f5b3b1cce41d1b63ea120a7d7e93b55407bfb17a6b02d18135a",
    });
    const scipLink = path.join(binRoot, "scip-go");
    fs.rmSync(scipLink, { force: true });
    fs.symlinkSync(scipGo, scipLink);
    run(
      "go",
      ["build", "-trimpath", "-o", path.join(binRoot, "samchon-graph-go"), "."],
      { cwd: path.join(repositoryRoot, "sidecars", "go") },
    );
    record({
      tool: "samchon-graph-go",
      version: "workspace",
      source: "sidecars/go",
      digest: "built-from-source",
    });
    break;
  }
  case "rust": {
    // The installer script comes through the same hardened seam as every
    // other fetch. Piping curl into `sh` would be the one shape curl's own
    // manual tells us not to retry: a retried mid-body transfer is not
    // rewound in a pipe, so `sh` could read the partial prefix twice.
    await downloadFile("https://sh.rustup.rs", path.join(toolsRoot, "rustup-init.sh"));
    shell(
      `sh "${path.join(toolsRoot, "rustup-init.sh")}" -y --profile minimal --default-toolchain 1.95.0`,
    );
    const cargoBin = path.join(os.homedir(), ".cargo", "bin");
    appendGithubPath(cargoBin);
    run(
      path.join(
        cargoBin,
        process.platform === "win32" ? "rustup.exe" : "rustup",
      ),
      [
        "component",
        "add",
        "rust-src",
        "--toolchain",
        "1.95.0",
      ],
    );
    record({
      tool: "rust-toolchain",
      version: "1.95.0",
      source: "rustup profile minimal with rust-src",
      digest: "rustup:1.95.0",
    });
    const producerRoot = path.join(toolsRoot, "samchon-rust-analyzer-source");
    fs.rmSync(producerRoot, { force: true, recursive: true });
    ensureDir(producerRoot);
    run("git", ["init"], { cwd: producerRoot });
    run("git", ["remote", "add", "origin", experiment.producerRepository], {
      cwd: producerRoot,
    });
    run(
      "git",
      ["fetch", "--depth=1", "origin", experiment.producerCommit],
      { cwd: producerRoot },
    );
    run("git", ["checkout", "--detach", "FETCH_HEAD"], {
      cwd: producerRoot,
    });
    const producerHead = String(
      run("git", ["rev-parse", "HEAD"], {
        cwd: producerRoot,
        stdio: "pipe",
      }).stdout,
    ).trim();
    if (producerHead !== experiment.producerCommit) {
      throw new Error(
        `rust producer checkout is ${producerHead}, not ${experiment.producerCommit}`,
      );
    }
    const cargo = path.join(
      cargoBin,
      process.platform === "win32" ? "cargo.exe" : "cargo",
    );
    verifyRustGraphProducer({ cargo, producerRoot, run });
    run(cargo, ["build", "--locked", "--release", "-p", "rust-analyzer"], {
      cwd: producerRoot,
    });
    const producerBinary = path.join(
      producerRoot,
      "target",
      "release",
      process.platform === "win32" ? "rust-analyzer.exe" : "rust-analyzer",
    );
    for (const command of ["samchon-rust-analyzer", "rust-analyzer"]) {
      const link = path.join(
        binRoot,
        `${command}${process.platform === "win32" ? ".exe" : ""}`,
      );
      fs.rmSync(link, { force: true });
      fs.linkSync(producerBinary, link);
    }
    recordProvisionedEnvironment(
      "SAMCHON_GRAPH_RUST_ANALYZER_HIR",
      path.join(
        binRoot,
        `samchon-rust-analyzer${process.platform === "win32" ? ".exe" : ""}`,
      ),
    );
    record({
      tool: "samchon-rust-analyzer",
      version: experiment.producerCommit,
      source: `${experiment.producerRepository}@${experiment.producerCommit}`,
      digest: `git:${experiment.producerCommit}`,
    });
    record({
      tool: "rust-analyzer",
      version: experiment.producerCommit,
      source: "alias of samchon-rust-analyzer",
      digest: `git:${experiment.producerCommit}`,
    });
    await installScip();
    break;
  }
  case "cpp":
  case "c":
    // `clang`, `cmake` and `ninja-build` are what builds the pinned producer:
    // this row's clangd is compiled from the fork below rather than installed,
    // so the distribution's own clangd is deliberately absent from this list.
    //
    // `bear` is for a compilation database a configure step cannot write. Both
    // pinned corpora are CMake and emit one themselves, so nothing here uses it
    // today; it stays because the database is what makes this route selectable
    // at all, and a Makefile corpus would otherwise be unable to produce one.
    const allowClangProducerBuild =
      process.env.SAMCHON_GRAPH_CLANG_PRODUCER_ALLOW_BUILD !== "0";
    apt([
      ...(allowClangProducerBuild ? CLANG_PRODUCER_BUILD_PACKAGES : []),
      "bear",
    ]);
    installClangGraphProducer({
      language: experiment.language,
      toolsRoot,
      binRoot,
      producerRepository: experiment.producerRepository,
      producerCommit: experiment.producerCommit,
      record,
      allowBuild: allowClangProducerBuild,
    });
    record({
      tool: "bear",
      version: "unpinned",
      source: "apt bear",
      digest: "unpinned",
    });
    await installScipClang();
    await installScip();
    break;
  case "java": {
    // Both compiler-owned lanes are built from exact source archives. JDT.LS
    // needs Java 21+ and its launcher is a Python script that locates plugins
    // relative to the built product repository.
    apt(["openjdk-21-jdk", "python3"]);
    // jdtls crashes on the runner's default JDK; point it at Java 21.
    const javaHome = "/usr/lib/jvm/java-21-openjdk-amd64";
    process.env.JAVA_HOME = javaHome;
    recordProvisionedEnvironment("JAVA_HOME", javaHome);
    if (process.env.GITHUB_ENV !== undefined) {
      fs.appendFileSync(process.env.GITHUB_ENV, `JAVA_HOME=${javaHome}${os.EOL}`);
    }
    appendGithubPath(path.join(javaHome, "bin"));
    // One launcher, built from the pinned fork. It serves both the strict
    // javac route and the SCIP lane behind it, so installing the released
    // binary first only downloaded a `scip-java` the source build then
    // shadowed under the same name — and recorded it in the tool manifest as
    // though a run had used it.
    await installScip();
    await installJavacGraphProducer(await installGradle());
    await installJdtGraphProducer();
    break;
  }
  case "csharp": {
    // Use the same runtime generation for the language server and MSBuild.
    // csharp-ls 0.26.0 targets .NET 10 and can register the .NET 10 SDK that
    // the pinned Serilog fixture asks Roslyn to load.
    const dotnetHome = path.join(os.homedir(), ".dotnet");
    const dotnet = path.join(dotnetHome, "dotnet");
    const dotnetInstaller = path.join(toolsRoot, "dotnet-install.sh");
    await downloadFile("https://dot.net/v1/dotnet-install.sh", dotnetInstaller);
    shell(`bash "${dotnetInstaller}" --channel 10.0`);
    appendGithubPath(dotnetHome);
    appendGithubPath(path.join(dotnetHome, "tools"));
    shell(`"${dotnet}" tool install --global csharp-ls --version 0.26.0 || "${dotnet}" tool update --global csharp-ls --version 0.26.0`);
    record({
      tool: "dotnet-sdk",
      version: "channel 10.0",
      source: "https://dot.net/v1/dotnet-install.sh",
      digest: "unpinned",
    });
    record({
      tool: "csharp-ls",
      version: "0.26.0",
      source: "dotnet tool install --global csharp-ls",
      digest: "unpinned",
    });
    const producerRoot = path.join(toolsRoot, "samchon-roslyn");
    fs.rmSync(producerRoot, { force: true, recursive: true });
    run(dotnet, [
      "publish",
      path.join(repositoryRoot, "sidecars", "csharp", "Samchon.Graph.CSharp.csproj"),
      "--configuration",
      "Release",
      "--output",
      producerRoot,
      "--no-self-contained",
      "-p:RestoreLockedMode=true",
    ]);
    const producer = path.join(producerRoot, "samchon-roslyn");
    fs.chmodSync(producer, 0o755);
    const producerLink = path.join(binRoot, "samchon-roslyn");
    fs.rmSync(producerLink, { force: true });
    fs.symlinkSync(producer, producerLink);
    process.env.SAMCHON_GRAPH_ROSLYN_WORKSPACE = producerLink;
    recordProvisionedEnvironment(
      "SAMCHON_GRAPH_ROSLYN_WORKSPACE",
      producerLink,
    );
    record({
      tool: "samchon-roslyn",
      version: "workspace",
      source: "sidecars/csharp",
      digest: "built-from-locked-source",
    });
    // Keep scip-dotnet installed only for the registered optional navigation
    // fallback; the Roslyn workspace service above owns strict C# facts.
    shell(`"${dotnet}" tool install --global scip-dotnet || "${dotnet}" tool update --global scip-dotnet`);
    record({
      tool: "scip-dotnet",
      version: "unpinned",
      source: "dotnet tool install --global scip-dotnet",
      digest: "unpinned",
    });
    await installScip();
    break;
  }
  case "kotlin":
    await installKotlinLanguageServer();
    const gradle = await installGradle();
    // The strict lane launches one persistent Gradle Tooling connection and
    // drives the project's ordinary Kotlin/JVM compile task. KGP therefore
    // retains its daemon, configuration, classpath and incremental caches
    // across lifecycle requests while the compiler plugin owns every fact.
    apt(["openjdk-21-jdk"]);
    const javaHome = "/usr/lib/jvm/java-21-openjdk-amd64";
    process.env.JAVA_HOME = javaHome;
    recordProvisionedEnvironment("JAVA_HOME", javaHome);
    if (process.env.GITHUB_ENV !== undefined) {
      fs.appendFileSync(
        process.env.GITHUB_ENV,
        `JAVA_HOME=${javaHome}${os.EOL}`,
      );
    }
    appendGithubPath(path.join(javaHome, "bin"));
    await installScipJavaKotlinSnapshot(gradle);
    await installScip();
    break;
  case "swift": {
    // sourcekit-lsp ships with the toolchain installed by the workflow's Setup
    // Swift step. It has no `--version` flag (that exits 64), so just confirm it
    // resolves on PATH.
    shell("command -v sourcekit-lsp");
    record({
      tool: "sourcekit-lsp",
      version: "unpinned",
      source: "swift toolchain installed by the workflow",
      digest: "unpinned",
    });
    const sidecar = path.join(repositoryRoot, "sidecars", "swift");
    const swift = String(run("which", ["swift"], { stdio: "pipe" }).stdout).trim();
    const swiftRoot = path.dirname(path.dirname(swift));
    const swiftBuildArguments = [
      "build",
      "--package-path",
      sidecar,
      "--configuration",
      "release",
      ...(process.platform === "linux"
        ? [
            "-Xcxx",
            `-I${path.join(swiftRoot, "lib", "swift")}`,
            "-Xcxx",
            `-I${path.join(swiftRoot, "lib", "swift", "Block")}`,
          ]
        : []),
    ];
    run("swift", swiftBuildArguments);
    const sidecarBin = String(
      run(
        "swift",
        ["build", "--package-path", sidecar, "--show-bin-path", "--configuration", "release"],
        { stdio: "pipe" },
      ).stdout,
    ).trim();
    const producer = path.join(sidecarBin, "samchon-swift-graph");
    run(producer, ["--version"]);
    process.env.SAMCHON_GRAPH_SWIFT_GRAPH = producer;
    process.env.SAMCHON_GRAPH_SWIFT_TOOLCHAIN = swift;
    recordProvisionedEnvironment("SAMCHON_GRAPH_SWIFT_GRAPH", producer);
    recordProvisionedEnvironment("SAMCHON_GRAPH_SWIFT_TOOLCHAIN", swift);
    record({
      tool: "samchon-swift-graph",
      version: "0.1.0",
      source: "sidecars/swift",
      digest: "built-from-workspace-source:indexstore-db-54212fce1aecb199070808bdb265e7f17e396015",
    });
    break;
  }
  case "scala": {
    apt(["openjdk-21-jdk", "maven"]);
    const javaHome = "/usr/lib/jvm/java-21-openjdk-amd64";
    const java = path.join(javaHome, "bin", "java");
    process.env.JAVA_HOME = javaHome;
    recordProvisionedEnvironment("JAVA_HOME", javaHome);
    if (process.env.GITHUB_ENV !== undefined) {
      fs.appendFileSync(
        process.env.GITHUB_ENV,
        `JAVA_HOME=${javaHome}${os.EOL}`,
      );
    }
    appendGithubPath(path.join(javaHome, "bin"));

    run("mvn", [
      "--batch-mode",
      "--file",
      path.join(repositoryRoot, "sidecars", "scala", "pom.xml"),
      "verify",
    ]);
    const sidecarRoot = path.join(repositoryRoot, "sidecars", "scala");
    const version = "0.1.0-SNAPSHOT";
    const scala2Plugin = path.join(
      sidecarRoot,
      "scala2-plugin",
      "target",
      `scala-graph-plugin_2.13.18-${version}.jar`,
    );
    const scala3Plugin = path.join(
      sidecarRoot,
      "scala3-plugin",
      "target",
      `scala-graph-plugin_3.9.0-${version}.jar`,
    );
    const server = path.join(
      sidecarRoot,
      "server",
      "target",
      `samchon-scala-graph-${version}.jar`,
    );
    for (const artifact of [scala2Plugin, scala3Plugin, server]) {
      if (!fs.statSync(artifact, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Scala graph build omitted ${artifact}`);
      }
    }
    const producer = path.join(binRoot, "samchon-scala-graph");
    fs.writeFileSync(
      producer,
      `#!/bin/sh\nexec '${java}' -jar '${server}' "$@"\n`,
    );
    fs.chmodSync(producer, 0o755);
    run(producer, ["--version"]);
    const serverHelp = String(
      run(producer, ["graph-server", "--help"], { stdio: "pipe" }).stdout,
    );
    if (
      !serverHelp.includes(
        "Serve BSP-driven Scala compiler graph generations over NDJSON.",
      )
    ) {
      throw new Error(
        `scala: the built producer does not publish the resident graph protocol:\n${serverHelp}`,
      );
    }

    const sbtVersion = "1.11.7";
    const sbtJar = path.join(toolsRoot, `sbt-launch-${sbtVersion}.jar`);
    const sbtUrl = `https://repo.maven.apache.org/maven2/org/scala-sbt/sbt-launch/${sbtVersion}/sbt-launch-${sbtVersion}.jar`;
    await downloadFile(sbtUrl, sbtJar);
    verifySha256(
      sbtJar,
      "f92a2095ac75008764fe3b2b793ffe624c4fbef5bfd9b0022e4bc2daf668c651",
    );
    const sbt = path.join(binRoot, "sbt");
    fs.writeFileSync(sbt, `#!/bin/sh\nexec '${java}' -jar '${sbtJar}' "$@"\n`);
    fs.chmodSync(sbt, 0o755);

    for (const [name, value] of Object.entries({
      SAMCHON_GRAPH_SCALA_GRAPH: producer,
      SAMCHON_GRAPH_SCALA2_PLUGIN: scala2Plugin,
      SAMCHON_GRAPH_SCALA3_PLUGIN: scala3Plugin,
      SAMCHON_GRAPH_SCALA_PLUGIN_VERSION: version,
      SAMCHON_GRAPH_JAVA_TOOLCHAIN: java,
    })) {
      process.env[name] = value;
      recordProvisionedEnvironment(name, value);
    }
    record({
      tool: "samchon-scala-graph",
      version,
      source: "sidecars/scala",
      digest: "built-from-workspace-source",
    });
    record({
      tool: "scalac-graph plugins",
      version: "Scala 2.13.18; Scala 3.9.0",
      source: "sidecars/scala",
      digest: "built-from-workspace-source",
    });
    record({
      tool: "sbt",
      version: sbtVersion,
      source: sbtUrl,
      digest:
        "sha256:f92a2095ac75008764fe3b2b793ffe624c4fbef5bfd9b0022e4bc2daf668c651",
    });
    record({
      tool: "maven",
      version: "unpinned",
      source: "apt maven",
      digest: "unpinned",
    });
    break;
  }
  case "zig":
    await installZls();
    break;
  case "python":
    await installScipPython();
    await installScip();
    // The interpreter decides what the index means and now decides the
    // provider's published `compilerVersion`, so the result has to name the one
    // this run used rather than leave it to the runner image.
    record({
      tool: "python3",
      version: "unpinned",
      source: "ubuntu-latest runner image",
      digest: "unpinned",
    });
    break;
  case "ruby":
    // The runner ships ruby but not bundler, which both the fixture's
    // `bundle install` prepare step and ruby-lsp's composed bundle need.
    shell("sudo gem install bundler ruby-lsp");
    record({
      tool: "ruby-lsp",
      version: "unpinned",
      source: "gem install ruby-lsp",
      digest: "unpinned",
    });
    await installScipRuby();
    await installScip();
    break;
  case "php":
    shell("npm install -g intelephense");
    record({
      tool: "intelephense",
      version: "unpinned",
      source: "npm install -g intelephense",
      digest: "unpinned",
    });
    // Composer, but not scip-php: the indexer is a dependency of the project it
    // indexes, not a tool beside it. Its instructions are `composer require
    // --dev` followed by `vendor/bin/scip-php`, and the post-v0.0.2 dependency
    // install fix reads the analyzed project's flattened vendor and autoloader.
    //
    // The corpus fixture pins that upstream fix and this only supplies the
    // runtime and Composer to install it with. `resolveProviderCommand` looks
    // in `vendor/bin` for the same reason it looks in `node_modules/.bin`.
    apt(["php-cli", "php-xml", "php-mbstring", "composer"]);
    record({
      tool: "composer",
      version: "unpinned",
      source: "apt composer",
      digest: "unpinned",
    });
    await installScip();
    break;

  case "lua": {
    // Pinned, because this row's acceptance is a claim about one build's
    // behaviour and it used to take whichever release was latest that hour.
    //
    // The pin was proposed as the cause of a red lane and is not: 3.19.0 is
    // the release every green run used, and the lane fails on it too. So this
    // removes a variable rather than fixing a defect, which is worth doing on
    // its own terms — a row that cannot say which build it measured cannot be
    // debugged — but the degraded-publication claim above it is still
    // unexplained, and the refusal now prints what it compared.
    //
    // Moving this pin is a deliberate act with its own evidence. The two other
    // `latestAsset` downloads stay latest on purpose: they provision generic
    // language servers for the fallback arm, whose rows assert counts rather
    // than a producer's exact publication behaviour.
    const version = "3.19.0";
    const url = `https://github.com/LuaLS/lua-language-server/releases/download/${version}/lua-language-server-${version}-linux-x64.tar.gz`;
    const archive = path.join(toolsRoot, "lua-language-server.tar.gz");
    const target = path.join(toolsRoot, "lua-language-server");
    await downloadFile(url, archive);
    verifySha256(
      archive,
      "624ae8dd3bfbd5c2ee3ccf2f3547d33aeefa209971cce8c11d48f69fc1ec065a",
    );
    fs.rmSync(target, { force: true, recursive: true });
    ensureDir(target);
    run("tar", ["-xzf", archive, "-C", target]);
    appendGithubPath(path.join(target, "bin"));
    record({
      tool: "lua-language-server",
      version,
      source: url,
      digest:
        "624ae8dd3bfbd5c2ee3ccf2f3547d33aeefa209971cce8c11d48f69fc1ec065a",
    });
    break;
  }
  case "dart": {
    const archive = path.join(toolsRoot, "dartsdk.zip");
    const target = path.join(toolsRoot, "dart-sdk-root");
    await downloadFile(
      "https://storage.googleapis.com/dart-archive/channels/stable/release/latest/sdk/dartsdk-linux-x64-release.zip",
      archive,
    );
    fs.rmSync(target, { force: true, recursive: true });
    ensureDir(target);
    run("unzip", ["-q", archive, "-d", target]);
    appendGithubPath(path.join(target, "dart-sdk", "bin"));
    record({
      tool: "dart-sdk",
      version: "unpinned",
      source:
        "https://storage.googleapis.com/dart-archive/channels/stable/release/latest/sdk/dartsdk-linux-x64-release.zip",
      digest: "unpinned",
    });
    // scip_dart is a pub package rather than a released binary, so it activates
    // through the SDK just installed and lands in the pub cache's bin directory.
    // The registry used to name a `samchon-graph-dart` sidecar that was never
    // written; darthttp exceeded an hour on the language-server lane while a
    // real indexer for the language already existed on pub.dev.
    shell("dart pub global activate scip_dart 1.6.2");
    appendGithubPath(path.join(os.homedir(), ".pub-cache", "bin"));
    record({
      tool: "scip_dart",
      version: "1.6.2",
      source: "dart pub global activate scip_dart 1.6.2",
      digest: "unpinned",
    });
    await installScip();
    break;
  }
  default:
    throw new Error(`No setup recipe for ${experiment.language}`);
}

console.log(`Prepared ${experiment.language} language server.`);
