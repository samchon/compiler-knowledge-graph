import { TestValidator } from "@nestia/e2e";
import { standardScipProviders } from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";

import { BoundedMap } from "../../../../packages/graph/src/utils/boundedMap";
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
 * The database is the build's own record of how each unit was compiled, so
 * these cases pin what the provider is allowed to read out of it, and what it
 * must refuse to mistake for a compiler.
 */
export const test_compile_database_names_the_compiler_that_built_it =
  async () => {
    assertTheDatabaseDecidesTheToolchain();
    assertALauncherIsNotTheCompiler();
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
    // The two documented shapes plus one quoted Windows-style path, which a
    // whitespace split would truncate at the space in "Program Files".
    { command: `"${shim(rootOf("graph-compdb-drivers-"), "cl")}" /c c.cpp` },
  ]);
  writeShims(root, ["gcc", "cc"]);
  const rows = configuration(root);
  TestValidator.equals(
    "every distinct driver the database names becomes its own row",
    rows.filter((row) => !row.startsWith("scip")),
    ["cc=cc v1.0.0", "gcc=gcc v1.0.0"],
  );
}

function assertALauncherIsNotTheCompiler(): void {
  const root = fixture("graph-compdb-launcher-", [
    // CMake writes this whenever CMAKE_<LANG>_COMPILER_LAUNCHER is set, which
    // is the ordinary configuration for a project that uses ccache. Publishing
    // ccache's version as the toolchain would name a cache as the thing that
    // decided the program's semantics.
    { arguments: ["ccache", "gcc", "-c", "a.c"] },
    // A leading shell assignment is not a program either.
    { command: "SOURCE_DATE_EPOCH=0 sccache clang -c b.cpp" },
  ]);
  writeShims(root, ["gcc", "clang", "ccache", "sccache"]);
  TestValidator.equals(
    "a compiler launcher and a leading assignment are stepped over",
    configuration(root).filter((row) => !row.startsWith("scip")),
    ["clang=clang v1.0.0", "gcc=gcc v1.0.0"],
  );
}

function assertADriverWithAPathIsTakenLiterally(): void {
  const root = fixture("graph-compdb-path-", []);
  const toolchain = path.join(root, "toolchain");
  fs.mkdirSync(toolchain, { recursive: true });
  const absolute = shim(toolchain, "gcc");
  // An absolute driver is probed exactly as recorded, and a driver written with
  // a separator is relative to the entry's own directory rather than to the
  // project root — the database records where each unit was compiled precisely
  // because those differ.
  fs.writeFileSync(
    path.join(root, "compile_commands.json"),
    JSON.stringify([
      { directory: root, file: "a.c", arguments: [absolute, "-c", "a.c"] },
      {
        directory: root,
        file: "b.c",
        command: "toolchain/gcc -c b.c",
      },
      { directory: root, file: "c.c", arguments: ["missing-driver", "-c"] },
    ]),
  );
  writeShims(root, []);
  TestValidator.equals(
    "an absolute and a directory-relative driver both resolve, an absent one is dropped",
    configuration(root).filter((row) => !row.startsWith("scip")),
    ["gcc=gcc v1.0.0"],
  );
}

function assertAnUnusableDatabaseNamesNoCompiler(): void {
  for (const [label, contents] of [
    ["malformed", "{ not json"],
    ["not an array", '{"entries":[]}'],
    ["entries that are not objects", "[1, null, \"a\"]"],
    ["entries naming no program", '[{"file":"a.c"},{"command":"   "}]'],
  ] as const) {
    const root = rootOf("graph-compdb-unusable-");
    fs.writeFileSync(path.join(root, "compile_commands.json"), contents);
    writeShims(root, []);
    TestValidator.equals(
      `a ${label} database names no compiler`,
      configuration(root).filter((row) => !row.startsWith("scip")),
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
  TestValidator.equals("the bound holds", bounded.size, 2);
  TestValidator.equals("the oldest entry went first", bounded.get("a"), undefined);
  // Re-setting a key keeps it, so the entry a caller is still using is not the
  // one evicted next.
  bounded.set("b", 20);
  bounded.set("d", 4);
  TestValidator.equals("a re-set entry survives", bounded.get("b"), 20);
  TestValidator.equals("and the untouched one is gone", bounded.get("c"), undefined);
}

function configuration(root: string): string[] {
  return [...(clang.configuration?.(root, environment(root)) ?? [])];
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

const roots = new Map<string, string>();

/** One temporary root per prefix, so a fixture can name it before writing it. */
function rootOf(prefix: string): string {
  const existing = roots.get(prefix);
  if (existing !== undefined) return existing;
  const created = GraphPaths.createTempDirectory(prefix);
  roots.set(prefix, created);
  return created;
}

function fixture(prefix: string, entries: readonly object[]): string {
  const root = rootOf(prefix);
  fs.writeFileSync(
    path.join(root, "compile_commands.json"),
    JSON.stringify(entries.map((entry) => ({ directory: root, ...entry }))),
  );
  return root;
}

function writeShims(root: string, names: readonly string[]): void {
  const bin = path.join(root, ".samchon-graph", "bin");
  fs.mkdirSync(bin, { recursive: true });
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

/** An executable that answers `--version` with its own name. */
function shim(directory: string, name: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(
    directory,
    process.platform === "win32" ? `${name}.cmd` : name,
  );
  fs.writeFileSync(
    file,
    process.platform === "win32"
      ? ["@echo off", `echo ${name} v1.0.0`, ""].join("\r\n")
      : ["#!/bin/sh", `echo "${name} v1.0.0"`, ""].join("\n"),
  );
  fs.chmodSync(file, 0o755);
  return file;
}
