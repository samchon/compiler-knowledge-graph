import fs from "node:fs";
import { createHash } from "node:crypto";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import { findExperiment } from "./catalog.mjs";
import {
  appendGithubPath,
  ensureDir,
  parseArgs,
  recordTool,
  repositoryRoot,
  run,
  shell,
  resetToolManifest,
  workRoot,
} from "./process.mjs";

const args = parseArgs(process.argv.slice(2));
const experiment = findExperiment(args.language);
const toolsRoot = path.join(workRoot, "tools");
const binRoot = path.join(toolsRoot, "bin");
ensureDir(binRoot);
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
  const archive = path.join(toolsRoot, "scip-v0.7.1-linux-amd64.tar.gz");
  const target = path.join(toolsRoot, "scip-v0.7.1");
  await downloadFile(
    "https://github.com/scip-code/scip/releases/download/v0.7.1/scip-linux-amd64.tar.gz",
    archive,
  );
  verifySha256(
    archive,
    "7bb1a566787478641a13bd9c93c2f571337556c76d659206f2225dc7d71a648b",
  );
  record({
    tool: "scip",
    version: "v0.7.1",
    source:
      "https://github.com/scip-code/scip/releases/download/v0.7.1/scip-linux-amd64.tar.gz",
    digest:
      "sha256:7bb1a566787478641a13bd9c93c2f571337556c76d659206f2225dc7d71a648b",
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
  case "typescript":
    break;
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
  case "rust":
    shell("curl --retry 3 --retry-all-errors --retry-delay 2 https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal");
    appendGithubPath(path.join(os.homedir(), ".cargo", "bin"));
    shell(`${path.join(os.homedir(), ".cargo", "bin", "rustup")} component add rust-analyzer`);
    record({
      tool: "rust-analyzer",
      version: "unpinned",
      source: "rustup component add rust-analyzer",
      digest: "unpinned",
    });
    await installScip();
    break;
  case "cpp":
  case "c":
    apt(["clangd"]);
    record({
      tool: "clangd",
      version: "unpinned",
      source: "apt clangd",
      digest: "unpinned",
    });
    break;
  case "java": {
    // jdtls is not an apt package and requires Java 21+; install the JDK and the
    // Eclipse JDT.LS snapshot tarball, then put its bin on PATH. The launcher is
    // a Python script that locates its plugins relative to its own path, so it
    // must run from the extracted tree rather than a symlink.
    apt(["openjdk-21-jdk", "python3"]);
    // jdtls crashes on the runner's default JDK; point it at Java 21.
    const javaHome = "/usr/lib/jvm/java-21-openjdk-amd64";
    process.env.JAVA_HOME = javaHome;
    if (process.env.GITHUB_ENV !== undefined) {
      fs.appendFileSync(process.env.GITHUB_ENV, `JAVA_HOME=${javaHome}${os.EOL}`);
    }
    appendGithubPath(path.join(javaHome, "bin"));
    const target = path.join(toolsRoot, "jdtls");
    const archive = path.join(toolsRoot, "jdtls.tar.gz");
    await downloadFile(
      "https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz",
      archive,
    );
    fs.rmSync(target, { force: true, recursive: true });
    ensureDir(target);
    run("tar", ["-xzf", archive, "-C", target]);
    appendGithubPath(path.join(target, "bin"));
    record({
      tool: "jdtls",
      version: "unpinned",
      source:
        "https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz",
      digest: "unpinned",
    });
    break;
  }
  case "csharp": {
    // Use the same runtime generation for the language server and MSBuild.
    // csharp-ls 0.26.0 targets .NET 10 and can register the .NET 10 SDK that
    // the pinned Serilog fixture asks Roslyn to load.
    const dotnetHome = path.join(os.homedir(), ".dotnet");
    const dotnet = path.join(dotnetHome, "dotnet");
    shell("curl --retry 3 --retry-all-errors --retry-delay 2 -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh");
    shell("bash /tmp/dotnet-install.sh --channel 10.0");
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
    break;
  }
  case "kotlin":
    await installKotlinLanguageServer();
    break;
  case "swift":
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
    break;
  case "scala":
    apt(["openjdk-17-jdk", "gzip"]);
    await downloadFile("https://github.com/coursier/coursier/releases/latest/download/cs-x86_64-pc-linux.gz", path.join(toolsRoot, "cs.gz"));
    shell(`gzip -dc "${path.join(toolsRoot, "cs.gz")}" > "${path.join(binRoot, "cs")}"`);
    shell(`chmod +x "${path.join(binRoot, "cs")}"`);
    run(path.join(binRoot, "cs"), ["install", "metals"]);
    appendGithubPath(path.join(os.homedir(), ".local", "share", "coursier", "bin"));
    record({
      tool: "metals",
      version: "unpinned",
      source: "coursier install metals",
      digest: "unpinned",
    });
    break;
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
    break;
  case "php":
    shell("npm install -g intelephense");
    record({
      tool: "intelephense",
      version: "unpinned",
      source: "npm install -g intelephense",
      digest: "unpinned",
    });
    break;
  case "lua": {
    const url = await latestAsset("LuaLS/lua-language-server", /linux-x64\.tar\.gz$/);
    const archive = path.join(toolsRoot, "lua-language-server.tar.gz");
    const target = path.join(toolsRoot, "lua-language-server");
    await downloadFile(url, archive);
    fs.rmSync(target, { force: true, recursive: true });
    ensureDir(target);
    run("tar", ["-xzf", archive, "-C", target]);
    appendGithubPath(path.join(target, "bin"));
    record({
      tool: "lua-language-server",
      version: "unpinned",
      source: url,
      digest: "unpinned",
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
    break;
  }
  default:
    throw new Error(`No setup recipe for ${experiment.language}`);
}

console.log(`Prepared ${experiment.language} language server.`);
