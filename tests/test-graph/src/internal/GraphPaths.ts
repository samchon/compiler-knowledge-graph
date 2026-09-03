import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Find the root by the file that marks it, not by counting `..` upward.
//
// esbuild inlines this module into every entry point, so `import.meta.url` is
// the *entry's* location, not this file's: a bundle under `lib/features/` sits
// one directory deeper than one under `lib/`. A fixed number of `..` is
// therefore only correct for the depth it was written against, and silently
// resolves outside the repository for any other — which is a wrong path, not an
// error, so it surfaces far from its cause.
const repositoryRootOf = (start: string): string => {
  for (let dir = start; ; ) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `test paths: no pnpm-workspace.yaml above ${start}, so the repository root is unknown.`,
      );
    }
    dir = parent;
  }
};

const repositoryRoot = repositoryRootOf(
  path.dirname(fileURLToPath(import.meta.url)),
);
const graphPackageRoot = path.join(repositoryRoot, "packages", "graph");

// `os.tmpdir()` does not report the canonical spelling of the temp root on
// every platform, yet the paths a test compares against are canonical by
// construction:
//
//   - POSIX `getcwd(3)` resolves every symlink, so a spawned language server's
//     `process.cwd()` names the real directory, not the one it was spawned with;
//   - Node's `require.resolve` returns realpaths unless `--preserve-symlinks`,
//     so a resolved binary or package manifest is canonical too;
//   - Windows `where.exe` (and the kernel generally) reports the long-form path
//     of an executable, never an 8.3 short name.
//
// Two spellings diverge from a raw `os.tmpdir()` root:
//
//   - macOS: `os.tmpdir()` is a symlink (`/var/folders/...` ->
//     `/private/var/folders/...`);
//   - Windows: `TMP`/`TEMP` — and therefore `os.tmpdir()` — is commonly the 8.3
//     short form (the GitHub `windows-latest` runner reports
//     `C:\Users\RUNNER~1\AppData\Local\Temp`, aliasing `runneradmin`).
//
// The default `fs.realpathSync` is a JS implementation that resolves symlinks
// but does NOT expand 8.3 short names, so it leaves the Windows divergence in
// place — a fixture path would keep `RUNNER~1` while the product, resolving the
// same binary through `where.exe`, reports the long `runneradmin`, and the two
// would compare unequal only on CI. `fs.realpathSync.native` delegates to the OS
// realpath, which resolves symlinks AND expands short names, canonicalizing the
// root once so every path a fixture constructs stays comparable with the paths
// the product and the kernel hand back — on every platform.
const createTempDirectory = (prefix: string): string =>
  fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

export const GraphPaths = {
  createTempDirectory,
  fakeCmake: path.join(repositoryRoot, "tests", "test-graph", "src", "internal", "fake-cmake.cjs"),
  fakeLspServer: path.join(repositoryRoot, "tests", "test-graph", "src", "internal", "fake-lsp-server.cjs"),
  fakeCppGraphServer: path.join(repositoryRoot, "tests", "test-graph", "src", "internal", "fake-cpp-graph-server.cjs"),
  fakeCsharpGraphServer: path.join(repositoryRoot, "tests", "test-graph", "src", "internal", "fake-csharp-graph-server.cjs"),
  fakeJdtGraphServer: path.join(repositoryRoot, "tests", "test-graph", "src", "internal", "fake-jdt-graph-server.cjs"),
  fakeRustGraphServer: path.join(repositoryRoot, "tests", "test-graph", "src", "internal", "fake-rust-graph-server.cjs"),
  fakeTtscGraphServer: path.join(repositoryRoot, "tests", "test-graph", "src", "internal", "fake-ttscgraph-server.cjs"),
  fakePub: path.join(repositoryRoot, "tests", "test-graph", "src", "internal", "fake-pub.cjs"),
  fakeScipIndexer: path.join(repositoryRoot, "tests", "test-graph", "src", "internal", "fake-scip-indexer.cjs"),
  fakeScipJava: path.join(repositoryRoot, "tests", "test-graph", "src", "internal", "fake-scip-java.cjs"),
  fakeScipDecoder: path.join(repositoryRoot, "tests", "test-graph", "src", "internal", "fake-scip-decoder.cjs"),
  fakeStandardProvider: path.join(repositoryRoot, "tests", "test-graph", "src", "internal", "fake-standard-provider.cjs"),
  fakeToolchain: path.join(repositoryRoot, "tests", "test-graph", "src", "internal", "fake-toolchain.cjs"),
  fakeSidecar: path.join(repositoryRoot, "tests", "test-graph", "src", "internal", "fake-sidecar.cjs"),
  graphBin: path.join(graphPackageRoot, "lib", "bin.js"),
  graphPackageRoot,
  repositoryRoot,
  ttscCanonicalContract: path.join(
    repositoryRoot,
    "tests",
    "test-graph",
    "src",
    "internal",
    "ttsc-canonical-contract.json",
  ),
};
