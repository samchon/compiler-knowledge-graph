import { TestValidator } from "@nestia/e2e";

import { adaptLuaExport } from "../../../../packages/graph/src/provider/lua/adaptLuaExport";

/**
 * The Lua exporter's report becomes a graph without gaining anything on the way.
 *
 * Shapes here are the ones `lua-probe.yml` actually produced against a two-file
 * project — a module table in a local, a function assigned onto it, and a global
 * — rather than a fixture invented to match the adapter. The two facts that
 * mattered in that run are the ones this pins: a module-local function is
 * reachable at all, and its use in another file is resolved.
 */
export const test_lua_export_adapts_only_what_it_proves = (): void => {
  const report: adaptLuaExport.IReport = {
    schemaVersion: 1,
    files: ["main.lua", "util.lua"],
    nodes: [
      node("util", "local", "local", "main.lua", 0, 6),
      node("Start", "global", "setglobal", "main.lua", 1, 9),
      node("M", "local", "local", "util.lua", 0, 6),
      node("greet", "field", "setfield", "util.lua", 1, 9),
    ],
    edges: [
      // `vm.getRefs` reports the declaration site among the references.
      edge(1, "main.lua", 0, 6),
      edge(1, "main.lua", 2, 9),
      // The one the whole design turned on: a module-local function used from
      // another file.
      edge(4, "main.lua", 2, 9),
    ],
    skipped: { unnamed: 2, outsideRoot: 11, refsFailed: 0 },
    warnings: [],
  };

  const result = adaptLuaExport(report, "samchon-graph-lua");

  TestValidator.equals(
    "every named declaration becomes a node with a positioned identity",
    result.nodes.map((entry) => entry.id),
    [
      "main.lua#util@1:variable",
      "main.lua#Start@2:variable",
      "util.lua#M@1:variable",
      "util.lua#greet@2:field",
    ],
  );

  // Zero-based from the engine, one-based in the graph. An off-by-one here
  // moves every symbol in every Lua project by a line and nothing else notices.
  TestValidator.equals(
    "coordinates arrive one-based on both axes",
    result.nodes[0]?.evidence,
    { file: "main.lua", startLine: 1, startCol: 7, endLine: 1, endCol: 11 },
  );

  TestValidator.equals(
    "a declaration is not a reference to itself",
    result.edges.length,
    2,
  );
  TestValidator.equals(
    "a module-local function keeps its cross-file use",
    result.edges.some(
      (entry) =>
        entry.from === "util.lua#greet@2:field" && entry.to === "main.lua",
    ),
    true,
  );

  assertUnmappedKindsAreDeclinedNotGuessed();
  assertADroppedDeclarationDoesNotShiftItsNeighboursEdges();
};

/**
 * A kind the graph has no word for is refused and said out loud.
 *
 * Lua has no classes and no declared types, so the vocabulary it can fill is
 * small, and the temptation is to map anything unrecognised onto `variable` to
 * keep the count up. That publishes a claim the index never made.
 */
function assertUnmappedKindsAreDeclinedNotGuessed(): void {
  const result = adaptLuaExport(
    {
      schemaVersion: 1,
      files: ["main.lua"],
      nodes: [node("mystery", "coroutine", "setcoroutine", "main.lua", 0, 0)],
      edges: [],
      skipped: { unnamed: 0, outsideRoot: 0, refsFailed: 0 },
      warnings: [],
    },
    "samchon-graph-lua",
  );
  TestValidator.equals(
    "an unmapped declaration kind produces no node",
    result.nodes.length,
    0,
  );
  TestValidator.predicate(
    "and says which kind it refused",
    result.warnings.some((warning) => warning.includes("coroutine")),
  );
}

/**
 * Edge indices point into the exporter's own list, not the adapted one.
 *
 * The exporter numbers edges against every declaration it emitted, including
 * ones this adapter then drops. Resolving through the surviving array instead
 * would hand each edge to whichever declaration slid into that position — every
 * reference after the first dropped node silently attributed to its neighbour,
 * which is the kind of wrong that still looks like a working graph.
 */
function assertADroppedDeclarationDoesNotShiftItsNeighboursEdges(): void {
  const result = adaptLuaExport(
    {
      schemaVersion: 1,
      files: ["main.lua"],
      nodes: [
        node("dropped", "coroutine", "setcoroutine", "main.lua", 0, 0),
        node("kept", "local", "local", "main.lua", 5, 0),
      ],
      edges: [edge(2, "main.lua", 9, 0)],
      skipped: { unnamed: 0, outsideRoot: 0, refsFailed: 0 },
      warnings: [],
    },
    "samchon-graph-lua",
  );
  TestValidator.equals(
    "the surviving declaration keeps its own edge",
    result.edges.map((entry) => entry.from),
    ["main.lua#kept@6:variable"],
  );
}

function node(
  name: string,
  kind: string,
  sourceType: string,
  file: string,
  startLine: number,
  startColumn: number,
): adaptLuaExport.INode {
  return {
    name,
    kind,
    sourceType,
    location: {
      file,
      startLine,
      startColumn,
      endLine: startLine,
      endColumn: startColumn + name.length,
    },
  };
}

function edge(
  from: number,
  file: string,
  startLine: number,
  startColumn: number,
): adaptLuaExport.IEdge {
  return {
    from,
    kind: "references",
    sourceType: "getlocal",
    location: {
      file,
      startLine,
      startColumn,
      endLine: startLine,
      endColumn: startColumn + 4,
    },
  };
}
