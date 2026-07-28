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
    assertEnvExecutionContextIsCompilerContext();
    assertEnvPlatformAndSplitRules();
    assertMemoizedDatabaseUsesTheCurrentEnvironment();
    assertAQuotedOrEscapedDriverSurvives();
    assertADriverWithAPathIsTakenLiterally();
    assertAnUnusableDatabaseNamesNoCompiler();
    assertSameSizeSameTimestampRewriteInvalidatesMemo();
    assertBuildDirectoryDatabaseIsWatched();
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
    {
      arguments: ["ccache", relativeShimPath("gcc"), "-c", "a.c"],
    },
    // A leading shell assignment is not a program either, and a launcher named
    // with a Windows spelling is the same launcher — the comparison cannot
    // depend on the case, the suffix, or which platform is reading the file.
    {
      command:
        `SOURCE_DATE_EPOCH=0 C:\\tools\\CCACHE.EXE ${relativeShimPath("clang")} -c b.cpp`,
    },
    // `env` is itself a launcher, but its flags and their operands are not
    // programs. The command after them remains the compiler even when another
    // launcher follows it.
    {
      arguments: [
        "env",
        "",
        "-i",
        "-u",
        "CPATH",
        "PATH=.samchon-graph/bin",
        "PATHEXT=.EXE;.CMD;.BAT",
        "SOURCE_DATE_EPOCH=0",
        "ccache",
        "gcc",
        "-c",
        "c.c",
      ],
    },
    // GNU env's split-string inserts command tokens back into its argv. The
    // option terminator also has to disappear rather than becoming a driver.
    {
      command:
        "env -S'PATH=.samchon-graph/bin ccache gcc' -c d.c",
    },
    {
      command:
        "env -vS'PATH=.samchon-graph/bin ccache gcc' -c d0.c",
    },
    {
      arguments: [
        "env",
        "--split-string",
        "PATH=.samchon-graph/bin ccache clang",
        "-c",
        "d1.c",
      ],
    },
    {
      command:
        "env --split-string='PATH=.samchon-graph/bin ccache gcc' -c d2.c",
    },
    {
      arguments: [
        "env",
        "-S",
        "PATH=.samchon-graph/bin ccache\\_gcc",
        "-c",
        "d3.c",
      ],
    },
    {
      arguments: [
        "env",
        "--unset=CPATH",
        "PATH=.samchon-graph/bin",
        "clang",
        "-c",
        "d3.c",
      ],
    },
    {
      arguments: [
        "env",
        "-a",
        "compiler",
        "1=X",
        "PATH=.samchon-graph/bin",
        "clang",
        "-c",
        "d4.c",
      ],
    },
    {
      arguments: [
        "env",
        "--ignore-environment",
        "--",
        "PATH=.samchon-graph/bin",
        "PATHEXT=.EXE;.CMD;.BAT",
        "clang",
        "-c",
        "e.c",
      ],
    },
  ]);
  writeShims(root, ["gcc", "clang", "ccache", "env"]);
  TestValidator.equals(
    "launchers, env options, and leading assignments are stepped over",
    drivers(root),
    ["clang=clang v1.0.0", "gcc=gcc v1.0.0"],
  );
}

function assertEnvExecutionContextIsCompilerContext(): void {
  const root = GraphPaths.createTempDirectory("graph-compdb-env-context-");
  const changed = path.join(root, "changed");
  const nested = path.join(changed, "nested");
  const searched = path.join(root, "searched");
  const missing = path.join(root, "missing");
  const changedDriver = shim(changed, "gxx");
  shim(nested, "nestedcc");
  shim(searched, "cc");
  shim(searched, "g#cc");
  shim(searched, "ccache");
  shim(root, "gcc");
  writeShims(root, []);
  fs.writeFileSync(
    path.join(root, "compile_commands.json"),
    JSON.stringify([
      {
        directory: root,
        file: "a.c",
        arguments: [
          "env",
          `-C${changed}`,
          `.${path.sep}${path.basename(changedDriver)}`,
          "-c",
          "a.c",
        ],
      },
      {
        directory: root,
        file: "b.c",
        arguments: [
          "env",
          "--chdir",
          path.relative(root, changed),
          path.basename(changedDriver).replace(/\.(?:cmd|exe|bat)$/i, ""),
          "-c",
          "b.c",
        ],
      },
      {
        directory: root,
        file: "c.c",
        arguments: ["env", `-P${searched}`, "cc", "-c", "c.c"],
      },
      {
        directory: root,
        file: "d.c",
        arguments: [
          "env",
          "-S",
          `-P${envSplitQuoted(searched)} cc`,
          "-c",
          "d.c",
        ],
      },
      {
        directory: root,
        file: "e.c",
        arguments: ["env", "PATH=searched", "cc", "-c", "e.c"],
      },
      {
        directory: root,
        file: "f.c",
        arguments: [
          "env",
          "-",
          `PATH=${searched}`,
          "PATHEXT=.EXE;.CMD;.BAT",
          "env",
          "cc",
          "-c",
          "f.c",
        ],
      },
      {
        directory: root,
        file: "g.c",
        arguments: ["env", "--unset=PATH", changedDriver, "-c", "g.c"],
      },
      {
        directory: root,
        file: "h.c",
        arguments: [
          "env",
          "-S",
          `PATH=${envSplitQuoted(searched)} g\\#cc`,
          "-c",
          "h.c",
        ],
      },
      {
        directory: root,
        file: "i.c",
        arguments: [
          "env",
          "--block-signal",
          "--default-signal=PIPE",
          "--ignore-signal=INT",
          "--list-signal-handling",
          "--argv0",
          "compiler",
          changedDriver,
          "-c",
          "i.c",
        ],
      },
      {
        directory: root,
        file: "j.c",
        arguments: [
          "env",
          "-C",
          changed,
          "env",
          "-C",
          "nested",
          "nestedcc",
          "-c",
          "j.c",
        ],
      },
      {
        directory: root,
        file: "k.c",
        arguments: [
          "env",
          `-P${searched}`,
          "ccache",
          "gcc",
          "-c",
          "k.c",
        ],
      },
      {
        directory: root,
        file: "l.c",
        arguments: [
          "env",
          `-P${missing}`,
          "missing-env-driver",
          "-c",
          "l.c",
        ],
      },
      {
        directory: root,
        file: "m.c",
        arguments: ["env", "-S", "'\\q'", "-c", "m.c"],
      },
      {
        directory: root,
        file: "n.c",
        arguments: ["env", "-S", '"ccache\\_gcc"', "-c", "n.c"],
      },
      {
        directory: root,
        file: "o.c",
        arguments: ["env", "-S", "'$gcc'", "-c", "o.c"],
      },
      {
        directory: root,
        file: "p.c",
        arguments: ["env", "-S", "g\\$cc", "-c", "p.c"],
      },
    ]),
  );
  TestValidator.equals(
    "env chdir and search-path options decide the executable that is probed",
    drivers(root).sort(),
    [
      "$gcc=unavailable",
      "cc=cc v1.0.0",
      "ccache gcc=unavailable",
      "g#cc=g#cc v1.0.0",
      "g$cc=unavailable",
      "gcc=gcc v1.0.0",
      "gxx=gxx v1.0.0",
      "missing-env-driver=unavailable",
      "nestedcc=nestedcc v1.0.0",
      "q=unavailable",
    ],
  );
  TestValidator.predicate(
    "an unresolved env-selected driver keeps scip-clang ineligible",
    clang.resolve(root, environment(root)) === undefined,
  );
}

function assertEnvPlatformAndSplitRules(): void {
  const root = GraphPaths.createTempDirectory("graph-compdb-env-rules-");
  const searched = path.join(root, "searched");
  for (const name of [
    "--",
    "casecc",
    "spacecc",
    "unsetcc",
  ]) {
    shim(searched, name);
  }
  exactShim(searched, "pathext.cmd", "cmd");
  exactShim(searched, "pathext.bat", "bat");
  exactShim(root, "leading.cmd", "leading-cmd");
  exactShim(root, "leading.bat", "leading-bat");
  writeShims(root, ["leading"]);
  fs.writeFileSync(
    path.join(root, "compile_commands.json"),
    JSON.stringify([
      {
        directory: root,
        file: "a.c",
        arguments: ["env", `Path=${searched}`, "casecc", "-c", "a.c"],
      },
      {
        directory: root,
        file: "b.c",
        arguments: [
          "env",
          `PATH=${searched}`,
          "env",
          "-u",
          "Path",
          "unsetcc",
          "-c",
          "b.c",
        ],
      },
      {
        directory: root,
        file: "c.c",
        arguments: [
          "env",
          "-S",
          `PATH=${envSplitQuoted(searched)} \t\n\v\f\rspacecc`,
          "-c",
          "c.c",
        ],
      },
      {
        directory: root,
        file: "d.c",
        arguments: [
          "env",
          `PATH=${searched}`,
          "PATHEXT=CMD",
          "pathext",
          "-c",
          "d.c",
        ],
      },
      {
        directory: root,
        file: "e.c",
        arguments: [
          "env",
          `PATH=${searched}`,
          "Pathext=.BAT",
          "pathext",
          "-c",
          "e.c",
        ],
      },
      {
        directory: root,
        file: "f.c",
        arguments: ["env", `PATH=${searched}`, "--", "-c", "f.c"],
      },
      {
        directory: root,
        file: "g.c",
        arguments: [
          "env",
          "-i",
          `PATH=${searched}`,
          "pathext",
          "-c",
          "g.c",
        ],
      },
      {
        directory: root,
        file: "h.c",
        arguments: [
          "env",
          `PATH=${searched}`,
          "PATHEXT=.CMD",
          "env",
          "-u",
          "PaThExT",
          "pathext",
          "-c",
          "h.c",
        ],
      },
      {
        directory: root,
        file: "i.c",
        arguments: [
          "env",
          `PATH=${searched}`,
          "PATHEXT=.CMD",
          "env",
          "--unset=PATHEXT",
          "pathext",
          "-c",
          "i.c",
        ],
      },
      {
        directory: root,
        file: "j.c",
        arguments: [
          "env",
          `PATH=${searched}`,
          "PATHEXT=",
          "pathext",
          "-c",
          "j.c",
        ],
      },
      {
        directory: root,
        file: "k.c",
        arguments: [
          `PATH=${searched}`,
          "PATHEXT=.CMD",
          "env",
          "pathext",
          "-c",
          "k.c",
        ],
      },
      {
        directory: root,
        file: "l.c",
        arguments: ["PATHEXT=.BAT", "leading", "-c", "l.c"],
      },
      {
        directory: root,
        file: "m.c",
        arguments: ["leading", "-c", "m.c"],
      },
      {
        directory: root,
        file: "n.c",
        arguments: [
          "env",
          `PATH=${searched}`,
          "PATHEXT=.COM",
          "configured.com",
          "-c",
          "n.c",
        ],
      },
      {
        directory: root,
        file: "o.c",
        arguments: [
          "env",
          `PATH=${searched}`,
          "PATHEXT=.CMD",
          "native.exe",
          "-c",
          "o.c",
        ],
      },
      {
        directory: root,
        file: "p.c",
        arguments: [`PATH=${searched}`, "pathext", "-c", "p.c"],
      },
    ]),
  );
  TestValidator.equals(
    "env follows native name casing, complete split whitespace, and post-assignment utility rules",
    drivers(root).sort(),
    process.platform === "win32"
      ? [
          "--=-- v1.0.0",
          "casecc=casecc v1.0.0",
          "configured=unavailable",
          "leading=leading v1.0.0",
          "leading=leading-bat v1.0.0",
          "native=unavailable",
          "pathext=bat v1.0.0",
          "pathext=cmd v1.0.0",
          "pathext=unavailable",
          "spacecc=spacecc v1.0.0",
        ]
      : [
          "--=-- v1.0.0",
          "casecc=unavailable",
          "configured=unavailable",
          "leading=leading v1.0.0",
          "native=unavailable",
          "pathext=unavailable",
          "spacecc=spacecc v1.0.0",
          "unsetcc=unsetcc v1.0.0",
        ],
  );
}

function assertMemoizedDatabaseUsesTheCurrentEnvironment(): void {
  const root = GraphPaths.createTempDirectory("graph-compdb-env-memo-");
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  exactShim(first, process.platform === "win32" ? "cc.cmd" : "cc", "first");
  exactShim(second, process.platform === "win32" ? "cc.cmd" : "cc", "second");
  writeShims(root, []);
  fs.writeFileSync(
    path.join(root, "compile_commands.json"),
    JSON.stringify([
      { directory: root, file: "a.c", arguments: ["env", "cc", "-c", "a.c"] },
    ]),
  );
  const rows = (overrides: NodeJS.ProcessEnv): string[] =>
    [
      ...(clang.configuration?.(root, {
        ...environment(root),
        ...overrides,
      }) ?? []),
    ].filter((row) => !row.startsWith("scip"));
  TestValidator.equals(
    "the first environment materializes the memoized command in its PATH",
    rows({ PATH: first, Path: first }),
    ["cc=first v1.0.0"],
  );
  TestValidator.equals(
    "a later environment resolves the same parsed command from Path",
    rows({ PATH: undefined, Path: second }),
    process.platform === "win32"
      ? ["cc=second v1.0.0"]
      : ["cc=unavailable"],
  );
  TestValidator.equals(
    "an inherited environment without a search path declines a bare command",
    rows({ PATH: undefined, Path: undefined, PATHEXT: undefined }),
    ["cc=unavailable"],
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
      // A driver the machine does not have remains explicit rather than being
      // omitted from the program's semantic identity, whether it was named
      // bare, named by a path that leads nowhere, or named as a directory.
      { directory: root, file: "c.c", arguments: ["missing-driver", "-c"] },
      {
        directory: root,
        file: "c1.c",
        arguments: [path.join(toolchain, "absent-driver"), "-c"],
      },
      { directory: root, file: "c2.c", arguments: [toolchain, "-c"] },
      // A bare driver whose name already carries the platform's executable
      // suffix. Command resolution appends one, so it looked in the project's
      // own bin for `gxx.cmd.exe` and never for the file that is there; it
      // still resolved through the global lookup, so a project-pinned driver
      // lost to whatever the machine happened to have.
      {
        directory: root,
        file: "e.c",
        arguments: [suffixed("gxx"), "-c"],
      },
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
  exactShim(path.join(root, ".samchon-graph", "bin"), suffixed("gxx"), "gxx");
  TestValidator.equals(
    "an absolute and a directory-relative driver name one program, and every absent driver remains explicit",
    drivers(root),
    [
      "toolchain=unavailable",
      "absent-driver=unavailable",
      "gcc=gcc v1.0.0",
      "gpp=gpp v1.0.0",
      "gxx=gxx v1.0.0",
      "missing-driver=unavailable",
    ],
  );
}

function assertAnUnusableDatabaseNamesNoCompiler(): void {
  for (const [label, contents] of [
    ["malformed", "{ not json"],
    ["not an array", '{"entries":[]}'],
    ["entries that are not objects", '[1, null, "a"]'],
    ["entries naming no program", '[{"file":"a.c"},{"command":"   "}]'],
    ["entries whose command is only a launcher", '[{"command":"ccache"}]'],
    [
      "entries whose env invocation names no command",
      '[{"command":"env -i -u CPATH"},{"arguments":["env","-S"]}]',
    ],
    [
      "entries whose env split cannot be replayed",
      JSON.stringify([
        { arguments: ["env", "-S", "${HISTORICAL_PATH} gcc"] },
        { arguments: ["env", "-S", "'' gcc"] },
        { arguments: ["env", "-S", "'unterminated"] },
        { arguments: ["env", "-S", "gcc\\"] },
        { arguments: ["env", "-S", '"gcc\\c"'] },
        { arguments: ["env", "-S", "gcc\\q"] },
        { arguments: ["env", "-S", "gcc\\ gcc"] },
        { arguments: ["env", "-S", "gcc\\\tgcc"] },
        { arguments: ["env", "-S", "gcc\\\ngcc"] },
        { arguments: ["env", "-S", "gcc\\\vgcc"] },
        { arguments: ["env", "-S", "gcc\\\fgcc"] },
        { arguments: ["env", "-S", "gcc\\\rgcc"] },
      ]),
    ],
    [
      "entries whose env options alter unknowable state",
      JSON.stringify([
        { arguments: ["env", "-L", "root/default", "gcc"] },
        { arguments: ["env", "-Uroot/default", "gcc"] },
        { arguments: ["env", "--unknown", "gcc"] },
        { arguments: ["env", "-x", "gcc"] },
        { arguments: ["env", "-0", "gcc"] },
        { arguments: ["env", "--null", "gcc"] },
        { arguments: ["env", "-u", "PATH", "gcc"] },
        { arguments: ["env", "-u", "", "gcc"] },
        { arguments: ["env", "--unset=A=B", "gcc"] },
        { arguments: ["env", "--unset"] },
        { arguments: ["env", "--chdir=", "gcc"] },
        { arguments: ["env", "--chdir"] },
        { arguments: ["env", "--debug=yes", "gcc"] },
        { arguments: ["env", "-P", "", "gcc"] },
        { arguments: ["env", "=X", "gcc"] },
        { arguments: ["env", "-", "-i", "gcc"] },
        { arguments: ["env", "--help", "gcc"] },
        { arguments: ["env", "--version", "gcc"] },
        { arguments: ["env", "-C", "relative", "gcc"] },
        { arguments: ["env", `.${path.sep}gcc`] },
        { arguments: ["env", "PATH=relative", "gcc"] },
      ]),
    ],
    [
      "entries whose env split comments or cuts off the command",
      JSON.stringify([
        { arguments: ["env", "-S", "# no command"] },
        { arguments: ["env", "-S", "ccache\\c gcc"] },
      ]),
    ],
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

function assertSameSizeSameTimestampRewriteInvalidatesMemo(): void {
  const root = GraphPaths.createTempDirectory("graph-compdb-content-memo-");
  const database = path.join(root, "compile_commands.json");
  const timestamp = new Date("2020-01-02T03:04:05.000Z");
  const contents = (driver: string): string =>
    JSON.stringify([
      { directory: root, file: "a.c", arguments: [driver, "-c", "a.c"] },
    ]);
  writeShims(root, ["gcc", "gxx"]);
  fs.writeFileSync(database, contents("gcc"));
  fs.utimesSync(database, timestamp, timestamp);
  const before = fs.statSync(database);
  TestValidator.equals("the first same-metadata parse names gcc", drivers(root), [
    "gcc=gcc v1.0.0",
  ]);

  fs.writeFileSync(database, contents("gxx"));
  fs.utimesSync(database, timestamp, timestamp);
  const after = fs.statSync(database);
  TestValidator.equals(
    "the rewrite preserves the old metadata cache key",
    [after.size, after.mtimeMs],
    [before.size, before.mtimeMs],
  );
  TestValidator.equals(
    "the memo follows changed bytes rather than unchanged metadata",
    drivers(root),
    ["gxx=gxx v1.0.0"],
  );
}

function assertBuildDirectoryDatabaseIsWatched(): void {
  const empty = GraphPaths.createTempDirectory("graph-compdb-no-build-input-");
  const emptyBuildInputs =
    typeof clang.buildInputs === "function"
      ? clang.buildInputs(empty)
      : (clang.buildInputs ?? []);
  TestValidator.equals(
    "database absence is watched so later creation can select scip-clang",
    emptyBuildInputs,
    ["build/compile_commands.json", "compile_commands.json"],
  );

  const root = GraphPaths.createTempDirectory("graph-compdb-build-input-");
  const build = path.join(root, "build");
  fs.mkdirSync(build);
  fs.writeFileSync(path.join(root, "a.c"), "int main(void) { return 0; }\n");
  fs.writeFileSync(
    path.join(build, "compile_commands.json"),
    JSON.stringify([
      {
        directory: root,
        file: "a.c",
        arguments: ["gcc", "-c", "a.c"],
      },
    ]),
  );

  const buildInputs =
    typeof clang.buildInputs === "function"
      ? clang.buildInputs(root)
      : (clang.buildInputs ?? []);
  TestValidator.predicate(
    "the coordinator watches the generated database scip-clang consumes",
    buildInputs.includes("build/compile_commands.json") &&
      buildInputs.includes("compile_commands.json"),
  );
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

function relativeShimPath(name: string): string {
  return path.join(
    ".samchon-graph",
    "bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
}

/** One literal token inside an `env -S` operand. */
function envSplitQuoted(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/** The file name a platform can launch, for a program of this name. */
function suffixed(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : `${name}.exe`;
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
