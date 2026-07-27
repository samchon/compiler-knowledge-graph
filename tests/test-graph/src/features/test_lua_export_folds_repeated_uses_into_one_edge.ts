import { TestValidator } from "@nestia/e2e";

import { adaptLuaExport } from "../../../../packages/graph/src/provider/lua/adaptLuaExport";

/**
 * Two uses of one symbol are one relationship, not two edges.
 *
 * The dump keys an edge by `(kind, from, to)` and nothing else, so a second
 * identical edge is not a redundancy it tolerates — it fails the whole build.
 * `vm.getRefs` reports every occurrence, and a function that reads one upvalue
 * twice is ordinary Lua, so the adapter is where the two become one.
 *
 * This is the shape `lualine` hit on the first real corpus run, after unit
 * fixtures with one reference apiece had passed: `get_mode_color` reads
 * `colors` more than once, and the build died naming that edge. Which means the
 * provider had never once produced a graph on real code.
 */
export const test_lua_export_folds_repeated_uses_into_one_edge = (): void => {
  const report: adaptLuaExport.IReport = {
    schemaVersion: 1,
    files: ["theme.lua"],
    nodes: [
      node("colors", "local", "local", "theme.lua", 0, 6),
      withBody(
        node("get_mode_color", "function", "function", "theme.lua", 2, 20),
        { startLine: 2, startColumn: 0, endLine: 6, endColumn: 3 },
      ),
    ],
    edges: [
      // Both inside `get_mode_color`, both naming `colors`, at different lines.
      edge(1, "theme.lua", 3, 9),
      edge(1, "theme.lua", 4, 12),
    ],
    skipped: { unnamed: 0, outsideRoot: 0, refsFailed: 0 },
    warnings: [],
  };

  const result = adaptLuaExport(report, "samchon-graph-lua");

  TestValidator.equals(
    "a symbol read twice yields one edge",
    result.edges.map((entry) => `${entry.from} -> ${entry.to}`),
    ["theme.lua#get_mode_color@3:function -> theme.lua#colors@1:variable"],
  );
  // The earliest use is the one that proves the relationship; a later position
  // would claim the reference starts further down the body than it does.
  TestValidator.equals(
    "and keeps the first use as its evidence",
    result.edges[0]?.evidence.startLine,
    4,
  );
};

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

function withBody(
  entry: adaptLuaExport.INode,
  body: adaptLuaExport.ILocation | Omit<adaptLuaExport.ILocation, "file">,
): adaptLuaExport.INode {
  return {
    ...entry,
    body: { file: entry.location.file, ...body },
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
