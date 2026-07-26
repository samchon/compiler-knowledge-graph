import { TestValidator } from "@nestia/e2e";
import { standardScipProviders } from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";

import { BoundedMap } from "../../../../packages/graph/src/utils/BoundedMap";
import { GraphPaths } from "../internal/GraphPaths";

/**
 * A C or C++ index means whatever the driver that compiled it means.
 *
 * `scip-clang` used to require a `clang` driver on `PATH` and publish its
 * version as the compiler behind the facts. Upstream needs an external Clang
 * only for CUDA — the indexer carries its own — so the requirement declined
 * every GCC or MSVC project whose compilation database was exactly what the
 * indexer consumes, and the version it would have published named a program
 * that compiled none of those translation units.
 *
 * The database is the build's own record of how each unit was compiled. These
 * cases pin what the provider may read out of it, what it must refuse to
 * mistake for a compiler, and what it does when the record says nothing.
 *
 * Every fixture is written to be platform-independent. A case that only fires
 * on the platform whose separator or executable suffix it happens to use is
 * a case the other two coverage legs report as dead code.
 */
export const test_compile_database_names_the_compiler_that_built_it =
  async () => {
    assertTheDatabaseDecidesTheToolchain();
    assertALauncherIsNotTheCompiler();
    assertAQuotedOrEscapedDriverSurvives();
    assertADriverWithAPathIsTakenLiterally();
    assertAnUnusableDatabaseNamesNoCompiler();
    assertTheMemoCannotGrowWithoutBound();
  };

const clang = standardScipProviders.find(
  (provider) => provider.name === "scip-clang",
)!;

function assertTheDatabaseDecidesTheToolchain(): void {
  const root = fixture("graph-compdb-drivers-", [
    { arguments: ["gcc", "-c", "a.c"] },
    { command: "cc -c b.c" },
    // An empty leading argument is not a program, and neither `arguments` nor
    // `command` is guaranteed to have one.
    { arguments: ["", "gcc", "-c", "c.c"] },
  ]);
  writeShims(root, ["gcc", "cc"]);
  TestValidator.equals(
    "every distinct driver the database names becomes its own row",
    drivers(root),
    ["cc=cc v1.0.0", "gcc=gcc v1.0.0"],
  );
  // The second call must not re-read the database, and must not answer
  // differently for having been memoized.
  TestValidator.equals("the memoized answer is the same answer", drivers(root), [
    "cc=cc v1.0.0",
    "gcc=gcc v1.0.0",
  ]);
}

function assertALauncherIsNotTheCompiler(): void {
  const root = fixture("graph-compdb-launcher-", [
    // CMake writes this whenever CMAKE_<LANG>_COMPILER_LAUNCHER is set, which
    // is the ordinary configuration for a project that uses ccache. Publishing
    // ccache's version as the toolchain would name a cache as the thing that
    // decided the program's semantics.
    { arguments: ["ccache", "gcc", "-c", "a.c"] },
    // A leading shell assignment is not a program either, and a launcher named
    // with a Windows spelling is the same launcher — the comparison cannot
    // depend on the case, the suffix, or which platform is reading the file.
    { command: "SOURCE_DATE_EPOCH=0 C:\\tools\\CCACHE.EXE clang -c b.cpp" },
  ]);
  writeShims(root, ["gcc", "clang", "ccache"]);
  TestValidator.equals(
    "a launcher, its Windows spelling, and a leading assignment are stepped over",
    drivers(root),
    ["clang=clang v1.0.0", "gcc=gcc v1.0.0"],
  );
}

function assertAQuotedOrEscapedDriverSurvives(): void {
  const root = fixture("graph-compdb-quoting-", []);
  const spaced = path.join(root, "Program Files");
  fs.mkdirSync(spaced, { recursive: true });
  const quoted = shim(spaced, "gcc");
  const escaped = shim(spaced, "cc");
  fs.writeFileSync(
    path.join(root, "compile_commands.json"),
    JSON.stringify([
      // A backslash before a path separator is a separator, not an escape.
      // Treating it as one turned `C:\Program Files\LLVM` into
      // `C:Program FilesLLVM` — the exact input the quoting exists for.
      { directory: root, file: "a.c", command: `"${quoted}" -c a.c` },
      // POSIX build generators quote the other way, or escape the space.
      {
        directory: root,
        file: "b.c",
        command: `${escaped.replace(/ /g, "\\ ")} -c b.c`,
      },
      { directory: root, file: "c.c", command: `'${quoted}' -c c.c` },
    ]),
  );
  writeShims(root, []);
  TestValidator.equals(
    "a driver quoted either way, or with an escaped space, is one token",
    drivers(root),
    ["cc=cc v1.0.0", "gcc=gcc v1.0.0"],
  );
}

function assertADriverWithAPathIsTakenLiterally(): void {
  const root = fixture("graph-compdb-path-", []);
  const toolchain = path.join(root, "toolchain");
  const absolute = shim(toolchain, "gcc");
  // An absolute driver is probed exactly as recorded, and a driver written with
  // a separator is relative to the entry's own directory rather than to the
  // project root — the database records where each unit was compiled precisely
  // because those differ. Both name the same file here, so both must produce
  // the one row.
  fs.writeFileSync(
    path.join(root, "compile_commands.json"),
    JSON.stringify([
      { directory: root, file: "a.c", arguments: [absolute, "-c", "a.c"] },
      // The same file, named the way the build wrote it. `path.basename` of the
      // absolute one, so the entry demonstrates directory-relative resolution
      // on every platform rather than only where the suffix happens to match.
      {
        directory: root,
        file: "b.c",
        command: `toolchain/${path.basename(absolute)} -c b.c`,
      },
      // A driver the machine does not have contributes nothing rather than
      // failing the whole database — whether it was named bare, named by a
      // path that leads nowhere, or named as a directory.
      { directory: root, file: "c.c", arguments: ["missing-driver", "-c"] },
      {
        directory: root,
        file: "c1.c",
        arguments: [path.join(toolchain, "absent-driver"), "-c"],
      },
      { directory: root, file: "c2.c", arguments: [toolchain, "-c"] },
      // An executable suffix is the machine's spelling of a location, not the
      // program's name; a provenance field compared across platforms carries
      // the name. Suffixed on every platform — `.cmd` where that is what the
      // system can run and `.exe` where a shebang is — because a case that only
      // fires on Windows is dead code on the other two coverage legs.
      {
        directory: root,
        file: "d.c",
        arguments: [
          exactShim(
            toolchain,
            process.platform === "win32" ? "gpp.cmd" : "gpp.exe",
            "gpp",
          ),
          "-c",
        ],
      },
    ]),
  );
  writeShims(root, []);
  TestValidator.equals(
    "an absolute and a directory-relative driver name one program, an absent one is dropped",
    drivers(root),
    ["gcc=gcc v1.0.0", "gpp=gpp v1.0.0"],
  );
}

function assertAnUnusableDatabaseNamesNoCompiler(): void {
  for (const [label, contents] of [
    ["malformed", "{ not json"],
    ["not an array", '{"entries":[]}'],
    ["entries that are not objects", '[1, null, "a"]'],
    ["entries naming no program", '[{"file":"a.c"},{"command":"   "}]'],
    ["entries whose command is only a launcher", '[{"command":"ccache"}]'],
  ] as const) {
    // A distinct root per case. Sharing one would let the memo answer a later
    // case from an earlier parse whenever two rewrites land in the same
    // modification-time tick with the same length.
    const root = GraphPaths.createTempDirectory("graph-compdb-unusable-");
    fs.writeFileSync(path.join(root, "compile_commands.json"), contents);
    writeShims(root, []);
    TestValidator.equals(
      `a ${label} database names no compiler`,
      drivers(root),
      ["cc=unavailable"],
    );
    // A database that names nothing cannot say what an index would mean, so the
    // provider declines rather than publishing a compiler it did not find.
    TestValidator.equals(
      `and the provider declines a ${label} database`,
      clang.resolve(root, environment(root)),
      undefined,
    );
  }
}

function assertTheMemoCannotGrowWithoutBound(): void {
  const bounded = new BoundedMap<number>(2);
  bounded.set("a", 1);
  bounded.set("b", 2);
  bounded.set("c", 3);
  TestValidator.equals(
    "the bound holds by dropping the oldest entry",
    [bounded.get("a"), bounded.get("b"), bounded.get("c")],
    [undefined, 2, 3],
  );
  // Re-setting a key keeps it, so the entry a caller is still using is not the
  // one evicted next.
  bounded.set("b", 20);
  bounded.set("d", 4);
  TestValidator.equals("a re-set entry survives", bounded.get("b"), 20);
  TestValidator.equals(
    "and the untouched one is gone",
    bounded.get("c"),
    undefined,
  );
}

/** The toolchain rows, without the indexer and decoder rows around them. */
function drivers(root: string): string[] {
  return [...(clang.configuration?.(root, environment(root)) ?? [])].filter(
    (row) => !row.startsWith("scip"),
  );
}

function environment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: "",
    Path: "",
    PATHEXT: ".EXE;.CMD;.BAT",
    SystemRoot: process.env.SystemRoot,
    SAMCHON_GRAPH_SCIP_CLANG: shimPath(root, "scip-clang"),
    SAMCHON_GRAPH_SCIP: shimPath(root, "scip"),
  };
}

function fixture(prefix: string, entries: readonly object[]): string {
  const root = GraphPaths.createTempDirectory(prefix);
  fs.writeFileSync(
    path.join(root, "compile_commands.json"),
    JSON.stringify(entries.map((entry) => ({ directory: root, ...entry }))),
  );
  return root;
}

function writeShims(root: string, names: readonly string[]): void {
  const bin = path.join(root, ".samchon-graph", "bin");
  for (const name of [...names, "scip-clang", "scip"]) shim(bin, name);
}

function shimPath(root: string, name: string): string {
  return path.join(
    root,
    ".samchon-graph",
    "bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
}

/** An executable, under the platform's own suffix, answering with its name. */
function shim(directory: string, name: string): string {
  return exactShim(
    directory,
    process.platform === "win32" ? `${name}.cmd` : name,
    name,
  );
}

/** An executable under exactly this file name, whatever the platform. */
function exactShim(
  directory: string,
  file: string,
  reports: string,
): string {
  fs.mkdirSync(directory, { recursive: true });
  const absolute = path.join(directory, file);
  fs.writeFileSync(
    absolute,
    process.platform === "win32"
      ? ["@echo off", `echo ${reports} v1.0.0`, ""].join("\r\n")
      : ["#!/bin/sh", `echo "${reports} v1.0.0"`, ""].join("\n"),
  );
  fs.chmodSync(absolute, 0o755);
  return absolute;
}
