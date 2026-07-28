import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import path from "node:path";

import { luaGraphProvider } from "@samchon/graph";
import { exporterTemporaryParent } from "../../../../packages/graph/src/provider/lua/exporterTemporaryParent";
import { LuaGraphSession } from "../../../../packages/graph/src/provider/lua/LuaGraphSession";
import { GraphPaths } from "../internal/GraphPaths";

/**
 * The Lua provider's refusals, shown firing.
 *
 * Its producer runs once over a whole workspace inside a server it does not
 * own, so several ordinary build options simply cannot be honoured. Each of
 * those is a sentence the indexer records as the reason a language fell
 * through, and a sentence no test has seen is a claim rather than a behaviour.
 */
export const test_lua_provider_declines_what_it_cannot_serve =
  async (): Promise<void> => {
    assertBoundedOptionsAreRefusedByName();
    assertASessionNeedsNoConfiguration();
    assertTheProviderWatchesLuaBuildInputs();
    assertTheProviderResolvesTheServerItDrives();
    assertAnInstallationWithoutItsExporterDeclines();
    assertExporterTemporaryParentKeepsOnePathNamespace();
    await assertExporterConfigurationIsIsolatedAndVersioned();
    await assertTheServerVersionIsPublished();
    await assertAnUnreadableSourceIsNotPublishedAround();
    await assertAnOutsideSourceIsNotReadBack();
  };

function assertExporterTemporaryParentKeepsOnePathNamespace(): void {
  TestValidator.equals(
    "a Windows temp directory on the project volume remains the parent",
    exporterTemporaryParent(
      "D:\\work\\project",
      "D:\\temp",
      path.win32,
    ),
    "D:\\temp",
  );
  TestValidator.equals(
    "a Windows temp directory on another volume falls back to a sibling",
    exporterTemporaryParent(
      "D:\\work\\project",
      "C:\\temp",
      path.win32,
    ),
    "D:\\work",
  );
  TestValidator.equals(
    "a repo-local Windows temp directory also falls back to a sibling",
    exporterTemporaryParent(
      "D:\\work\\project",
      "D:\\work\\project\\.tmp",
      path.win32,
    ),
    "D:\\work",
  );
  TestValidator.equals(
    "a repo-local POSIX temp directory also falls back to a sibling",
    exporterTemporaryParent(
      "/work/project",
      "/work/project/.tmp",
      path.posix,
    ),
    "/work",
  );
  TestValidator.equals(
    "a different UNC namespace also falls back to a sibling",
    exporterTemporaryParent(
      "\\\\server\\share\\project",
      "\\\\other\\share\\temp",
      path.win32,
    ),
    "\\\\server\\share\\",
  );
  TestValidator.error(
    "a volume-root project is declined rather than written into",
    () =>
      exporterTemporaryParent(
        "D:\\",
        "C:\\temp",
        path.win32,
      ),
  );
  TestValidator.error(
    "a POSIX root project is declined even when temp is in its namespace",
    () => exporterTemporaryParent("/", "/tmp", path.posix),
  );
}

/**
 * Every option the exporter cannot honour is named in the refusal.
 *
 * Naming them matters more than refusing: a caller who passed `maxFiles`
 * without meaning to would otherwise see Lua quietly fall to the generic lane
 * and read the slower number as Lua's cost.
 */
function assertBoundedOptionsAreRefusedByName(): void {
  TestValidator.equals(
    "an unbounded build is accepted",
    luaGraphProvider.refuse({ cwd: "." }),
    undefined,
  );
  for (const [option, options] of [
    ["server", { cwd: ".", server: "lua-language-server" }],
    ["maxFiles", { cwd: ".", maxFiles: 10 }],
    ["lspReferenceLimit", { cwd: ".", lspReferenceLimit: 5 }],
  ] as const) {
    const reason = luaGraphProvider.refuse(options);
    TestValidator.predicate(
      `${option} is refused by name`,
      reason !== undefined && reason.includes(option),
    );
  }
  const many = luaGraphProvider.refuse({
    cwd: ".",
    maxFiles: 10,
    lspReferenceLimit: 5,
  });
  TestValidator.predicate(
    "several refused options are listed together",
    many !== undefined &&
      many.includes("maxFiles") &&
      many.includes("lspReferenceLimit") &&
      many.includes("those options"),
  );
}

async function assertTheServerVersionIsPublished(): Promise<void> {
  const root = GraphPaths.createTempDirectory("samchon-graph-lua-version-");
  fs.writeFileSync(path.join(root, "main.lua"), "return 1\n");
  const artifact = JSON.stringify({
    schemaVersion: 2,
    compilerVersion: "LuaJIT",
    files: ["main.lua"],
    nodes: [],
    edges: [],
    skipped: { unnamed: 0, outsideRoot: 0, refsFailed: 0 },
    warnings: [],
  });
  for (const [row, expected] of [
    ["lua-language-server=3.16.1", "3.16.1"],
    ["lua-language-server=unavailable", ""],
    ["lua-language-server=unreported", ""],
    ["lua-language-server=unasked", ""],
    ["another-tool=1.0.0", ""],
  ] as const) {
    const session = new LuaGraphSession({
      root,
      languages: ["lua"],
      provider: "samchon-graph-lua",
      command: {
        command: process.execPath,
        args: [
          "-e",
          `require("node:fs").writeFileSync(process.argv[1], ${JSON.stringify(
            artifact,
          )})`,
        ],
      },
      indexArgs: (produced) => [produced],
      inputs: () => ["main.lua"],
      configuration: () => [row],
    });
    try {
      const refreshed = await session.refresh();
      TestValidator.equals(
        `Lua provenance maps ${row} to its publishable server version`,
        [
          refreshed.snapshot.provenance.toolVersion,
          refreshed.snapshot.provenance.compilerVersion,
        ],
        [expected, "LuaJIT"],
      );
    } finally {
      await session.close();
    }
  }
}

/**
 * Exporter selection is both a build input and private to one generation.
 *
 * The exporter may live outside the project, so changing it does not move any
 * source hash. Its content digest must still rebuild a resident session, the
 * exact bytes behind that digest must be what the server executes, and every
 * generated input must disappear with that generation rather than remain in
 * the project or in a root-keyed shared temporary file.
 */
async function assertExporterConfigurationIsIsolatedAndVersioned(): Promise<void> {
  const root = GraphPaths.createTempDirectory("samchon-graph-lua-exporter-");
  const outside = GraphPaths.createTempDirectory(
    "samchon-graph-lua-exporter-outside-",
  );
  const exporter = path.join(outside, "export.lua");
  const replacement = path.join(outside, "replacement.lua");
  const capture = path.join(outside, "capture.json");
  const producer = path.join(root, "producer.cjs");
  fs.writeFileSync(path.join(root, "main.lua"), "return 1\n");
  fs.writeFileSync(exporter, "return 'first'\n");
  fs.writeFileSync(replacement, "return 'replacement'\n");
  const artifact = JSON.stringify({
    schemaVersion: 2,
    compilerVersion: "Lua 5.4",
    files: ["main.lua"],
    nodes: [],
    edges: [],
    skipped: { unnamed: 0, outsideRoot: 0, refsFailed: 0 },
    warnings: [],
  });
  fs.writeFileSync(
    producer,
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'if (process.argv.includes("--version")) {',
      '  process.stdout.write("fixture-lua-language-server 1.0.0\\n");',
      "} else {",
      '  const output = process.argv.find((arg) => arg.startsWith("--doc_out_path=")).slice("--doc_out_path=".length);',
      '  const config = process.argv.find((arg) => arg.startsWith("--configpath=")).slice("--configpath=".length);',
      '  const root = process.argv.find((arg) => arg.startsWith("--doc=")).slice("--doc=".length);',
      '  const body = fs.readFileSync(config, "utf8");',
      '  fs.appendFileSync(process.env.SAMCHON_GRAPH_LUA_EXPORTER, "-- changed after derivation\\n");',
      '  const script = path.normalize(root + JSON.parse(body)["Lua.docScriptPath"]);',
      `  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ config, body, script, source: fs.readFileSync(script, "utf8") }));`,
      `  fs.writeFileSync(path.join(output, ${JSON.stringify(LuaGraphSession.ARTIFACT)}), ${JSON.stringify(artifact)});`,
      "}",
    ].join("\n"),
  );

  const previous = process.env.SAMCHON_GRAPH_LUA_EXPORTER;
  process.env.SAMCHON_GRAPH_LUA_EXPORTER = exporter;
  const session = luaGraphProvider.open({
    root,
    languages: ["lua"],
    command: { command: process.execPath, args: [producer] },
    options: { cwd: root },
  });
  try {
    const initial = await session.refresh();
    const first = JSON.parse(fs.readFileSync(capture, "utf8")) as {
      config: string;
      body: string;
      script: string;
      source: string;
    };
    fs.writeFileSync(exporter, "return 'second'\n");
    const rebuilt = await session.refresh();
    const second = JSON.parse(fs.readFileSync(capture, "utf8")) as {
      config: string;
      body: string;
      script: string;
      source: string;
    };
    process.env.SAMCHON_GRAPH_LUA_EXPORTER = replacement;
    const replaced = await session.refresh();
    const third = JSON.parse(fs.readFileSync(capture, "utf8")) as {
      config: string;
      body: string;
      script: string;
      source: string;
    };

    TestValidator.equals(
      "exporter content and selection rebuild resident generations",
      [
        initial.mode,
        rebuilt.mode,
        rebuilt.generation,
        replaced.mode,
        replaced.generation,
      ],
      ["initial", "rebuild", 2, "rebuild", 3],
    );
    TestValidator.predicate(
      "each generation owns and removes a different config",
      first.config !== second.config &&
        second.config !== third.config &&
        !fs.existsSync(first.config) &&
        !fs.existsSync(second.config) &&
        !fs.existsSync(third.config) &&
        !fs.existsSync(first.script) &&
        !fs.existsSync(second.script) &&
        !fs.existsSync(third.script),
    );
    TestValidator.predicate(
      "generation directories are reachable without entering the project",
      [first, second, third].every(
        (entry) => {
          const relative = path.relative(root, entry.config);
          return (
            !path.isAbsolute(relative) &&
            relative.split(path.sep)[0] === ".." &&
            path.parse(entry.config).root === path.parse(root).root &&
            !fs.existsSync(path.dirname(entry.config))
          );
        },
      ),
    );
    TestValidator.equals(
      "the server reads the exact exporter bytes that moved each universe",
      [first.source, second.source, third.source],
      [
        "return 'first'\n",
        "return 'second'\n",
        "return 'replacement'\n",
      ],
    );
    TestValidator.predicate(
      "every config points at its private exporter copy",
      [first, second, third].every(
        (entry) =>
          entry.body.includes("docScriptPath") &&
          entry.body.includes("samchon-graph-lua-export.lua"),
      ),
    );
    TestValidator.equals(
      "nothing generated is written into the project",
      fs
        .readdirSync(root)
        .filter((entry) => entry.includes("samchon-graph-lua-config")),
      [],
    );
    const retained = session.current;
    process.env.SAMCHON_GRAPH_LUA_EXPORTER = path.join(
      outside,
      "absent.lua",
    );
    let message = "";
    try {
      await session.refresh();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    TestValidator.predicate(
      "a vanished exporter rejects one generation and retains the last snapshot",
      message.includes("exporter script is missing or unreadable") &&
        session.generation === 3 &&
        session.current === retained,
    );
  } finally {
    await session.close();
    if (previous === undefined) delete process.env.SAMCHON_GRAPH_LUA_EXPORTER;
    else process.env.SAMCHON_GRAPH_LUA_EXPORTER = previous;
  }
}

/**
 * A file the exporter indexed and that cannot be read back is a moved
 * generation, not a snapshot to publish around.
 */
async function assertAnUnreadableSourceIsNotPublishedAround(): Promise<void> {
  const root = GraphPaths.createTempDirectory("samchon-graph-lua-vanished-");
  const artifact = path.join(root, LuaGraphSession.ARTIFACT);
  const session = new LuaGraphSession({
    root,
    languages: ["lua"],
    provider: "samchon-graph-lua",
    // A producer that writes an artifact naming a file which is not there.
    command: {
      command: process.execPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync(process.argv[1], ${JSON.stringify(
          JSON.stringify({
            schemaVersion: 2,
            compilerVersion: "Lua 5.4",
            files: ["absent.lua"],
            nodes: [],
            edges: [],
            skipped: { unnamed: 0, outsideRoot: 0, refsFailed: 0 },
            warnings: [],
          }),
        )})`,
      ],
    },
    indexArgs: (produced) => [produced],
    inputs: () => [],
    // Supplied here because the provider supplies one too: a session built
    // without it takes the other arm, and both are ordinary.
    configuration: () => ["lua-language-server=fixture"],
  });
  TestValidator.equals(
    "a session that has not built reports no generation and no snapshot",
    [session.generation, session.current],
    [0, undefined],
  );
  let message = "";
  try {
    await session.refresh();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  } finally {
    await session.close();
    fs.rmSync(artifact, { force: true });
  }
  TestValidator.predicate(
    "a source that cannot be read back refuses the snapshot",
    message.includes("could not be read back"),
  );
}

/**
 * The producer artifact is input from a separately spawned process. Even when
 * an outside path exists and is readable, it cannot become project source
 * provenance merely because the report asked for it.
 */
async function assertAnOutsideSourceIsNotReadBack(): Promise<void> {
  const root = GraphPaths.createTempDirectory("samchon-graph-lua-confined-");
  const outside = GraphPaths.createTempDirectory(
    "samchon-graph-lua-outside-",
  );
  const outsideFile = path.join(outside, "secret.lua");
  fs.writeFileSync(outsideFile, "return 'outside'\n");
  const declared = path.relative(root, outsideFile).replaceAll("\\", "/");
  const message = await refreshLuaArtifact(root, declared);
  TestValidator.predicate(
    "a readable outside source is refused before publication",
    message.includes("escapes the project"),
  );

  const linked = path.join(root, "linked");
  fs.symlinkSync(
    outside,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  const linkedMessage = await refreshLuaArtifact(root, "linked/secret.lua");
  TestValidator.predicate(
    "an in-project link cannot redirect a source read outside",
    linkedMessage.includes("crosses a link outside the project"),
  );
}

async function refreshLuaArtifact(
  root: string,
  declared: string,
): Promise<string> {
  const session = new LuaGraphSession({
    root,
    languages: ["lua"],
    provider: "samchon-graph-lua",
    command: {
      command: process.execPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync(process.argv[1], ${JSON.stringify(
          JSON.stringify({
            schemaVersion: 2,
            compilerVersion: "Lua 5.4",
            files: [declared],
            nodes: [],
            edges: [],
            skipped: { unnamed: 0, outsideRoot: 0, refsFailed: 0 },
            warnings: [],
          }),
        )})`,
      ],
    },
    indexArgs: (produced) => [produced],
    inputs: () => [],
  });
  let message = "";
  try {
    await session.refresh();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  } finally {
    await session.close();
  }
  return message;
}

/**
 * A session built without a configuration is ordinary.
 *
 * The provider supplies one, because a Lua build universe should move when the
 * server's version does. A caller driving the session directly need not, and
 * the session has to accept both — so both are built here rather than one being
 * swapped for the other, which is how the arm this covers went bare in the
 * first place.
 */
function assertASessionNeedsNoConfiguration(): void {
  const root = GraphPaths.createTempDirectory("samchon-graph-lua-bare-");
  const session = new LuaGraphSession({
    root,
    languages: ["lua"],
    provider: "samchon-graph-lua",
    command: { command: process.execPath, args: ["-e", ""] },
    indexArgs: (produced) => [produced],
    inputs: () => [],
  });
  TestValidator.equals(
    "the session reports the root and language it was opened for",
    [session.root, [...session.languages]],
    [root, ["lua"]],
  );
}

/**
 * The provider watches the files that decide what a Lua build means.
 *
 * `.luarc.json` names the runtime version, the library paths and the workspace
 * roots the server resolves against, so a change there changes what an index
 * says even when no source moved. A provider that did not watch it would serve
 * a graph built under settings the project no longer has.
 */
function assertTheProviderWatchesLuaBuildInputs(): void {
  const root = GraphPaths.createTempDirectory("samchon-graph-lua-inputs-");
  fs.writeFileSync(
    path.join(root, ".luarc.json"),
    `${JSON.stringify({ "Lua.runtime.version": "Lua 5.4" })}\n`,
  );
  const inputs =
    typeof luaGraphProvider.buildInputs === "function"
      ? luaGraphProvider.buildInputs(root)
      : luaGraphProvider.buildInputs;
  TestValidator.predicate(
    "the workspace configuration is a build input",
    [...inputs].includes(".luarc.json"),
  );
}

/**
 * The provider resolves the server it drives, and declines when it is absent.
 *
 * `assertRegisteredFixture` hands a session a synthetic command, so nothing in
 * the contract suite had ever called `resolve` — a gap the coverage ignore
 * around its body was hiding until that ignore was narrowed to the one line it
 * was meant for.
 *
 * Resolution goes through the project's own `.samchon-graph/bin` before `PATH`,
 * which is what lets a fixture prove this without a server installed on the
 * machine running it.
 */
function assertTheProviderResolvesTheServerItDrives(): void {
  const root = GraphPaths.createTempDirectory("samchon-graph-lua-resolve-");
  const bin = path.join(root, ".samchon-graph", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const server = path.join(
    bin,
    process.platform === "win32"
      ? "lua-language-server.cmd"
      : "lua-language-server",
  );
  fs.writeFileSync(server, process.platform === "win32" ? "@echo off\n" : "#!/bin/sh\n");
  fs.chmodSync(server, 0o755);

  TestValidator.predicate(
    "the project's own server is resolved",
    luaGraphProvider.resolve(root, {
      PATH: "",
      Path: "",
      PATHEXT: ".EXE;.CMD;.BAT",
      SystemRoot: process.env.SystemRoot,
    }) !== undefined,
  );

  const bare = GraphPaths.createTempDirectory("samchon-graph-lua-noserver-");
  TestValidator.equals(
    "a machine without the server resolves nothing",
    luaGraphProvider.resolve(bare, {
      PATH: "",
      Path: "",
      PATHEXT: ".EXE;.CMD;.BAT",
      SystemRoot: process.env.SystemRoot,
    }),
    undefined,
  );
}

/**
 * Without its own exporter the provider declines rather than driving the server.
 *
 * Driving lua-language-server with the stock documentation export would produce
 * a graph with no edges at all — that export omits references entirely — and a
 * provider publishing an edgeless graph is worse than one that steps aside.
 *
 * `SAMCHON_GRAPH_LUA_EXPORTER` is what makes this checkable. The shipped script
 * cannot be removed mid-run, so before the override existed this behaviour was
 * asserted only by the comment above it.
 */
function assertAnInstallationWithoutItsExporterDeclines(): void {
  const root = GraphPaths.createTempDirectory("samchon-graph-lua-noexporter-");
  const previous = process.env.SAMCHON_GRAPH_LUA_EXPORTER;
  process.env.SAMCHON_GRAPH_LUA_EXPORTER = path.join(root, "absent.lua");
  try {
    TestValidator.equals(
      "a provider without its exporter resolves nothing",
      luaGraphProvider.resolve(root, process.env),
      undefined,
    );
    let message = "";
    try {
      luaGraphProvider.open({
        root,
        languages: ["lua"],
        command: { command: process.execPath, args: ["-e", ""] },
        options: { cwd: root },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    TestValidator.predicate(
      "and says so rather than writing a config pointing nowhere",
      message.includes("exporter script is missing"),
    );
    process.env.SAMCHON_GRAPH_LUA_EXPORTER = root;
    const unreadableEnv = {
      PATH: "",
      Path: "",
      PATHEXT: ".EXE;.CMD;.BAT",
      SystemRoot: process.env.SystemRoot,
      SAMCHON_GRAPH_LUA_EXPORTER: root,
    };
    TestValidator.predicate(
      "an unreadable exporter is distinguished in configuration evidence",
      luaGraphProvider
        .configuration?.(root, unreadableEnv)
        .includes("lua-exporter=unreadable") === true &&
        luaGraphProvider.resolve(root, unreadableEnv) === undefined,
    );
  } finally {
    if (previous === undefined) delete process.env.SAMCHON_GRAPH_LUA_EXPORTER;
    else process.env.SAMCHON_GRAPH_LUA_EXPORTER = previous;
  }
}
