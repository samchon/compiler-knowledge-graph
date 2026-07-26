import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import path from "node:path";

import { luaGraphProvider } from "@samchon/graph";
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
    assertPrepareWritesAConfigOutsideTheProject();
  assertASessionNeedsNoConfiguration();
  assertTheProviderWatchesLuaBuildInputs();
  assertTheProviderResolvesTheServerItDrives();
    await assertAnUnreadableSourceIsNotPublishedAround();
  };

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

/**
 * The config lands outside the project, and points back into the package.
 *
 * `Lua.docScriptPath` is concatenated onto the indexed root as a plain string,
 * so the path has to be relative to that root — and it has to escape it, since
 * writing our exporter into somebody's repository to index it is not a trade
 * this provider makes.
 */
function assertPrepareWritesAConfigOutsideTheProject(): void {
  const root = GraphPaths.createTempDirectory("samchon-graph-lua-prepare-");
  luaGraphProvider.prepare?.(root, { cwd: root });
  const written = fs
    .readdirSync(root)
    .filter((entry) => entry.endsWith(".json"));
  TestValidator.equals(
    "nothing is written into the project being indexed",
    written,
    [],
  );
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
            schemaVersion: 1,
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
