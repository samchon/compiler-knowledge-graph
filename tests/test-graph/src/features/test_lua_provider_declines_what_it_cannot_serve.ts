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
