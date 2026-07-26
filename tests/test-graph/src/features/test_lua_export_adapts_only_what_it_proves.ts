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
      // A function statement: the name span is short, and the body span the
      // exporter now carries covers the whole `function … end`. The probe
      // measured exactly this shape — a six-character `setglobal` whose
      // `.value` was a thirty-character `function`.
      withBody(
        node("caller", "function", "function", "main.lua", 2, 9),
        { startLine: 2, startColumn: 0, endLine: 4, endColumn: 3 },
      ),
      node("M", "local", "local", "util.lua", 0, 6),
      node("greet", "field", "setfield", "util.lua", 1, 9),
    ],
    edges: [
      // `vm.getRefs` reports the declaration site among the references.
      edge(1, "main.lua", 0, 6),
      // The one the whole design turned on: a module-local function used from
      // another file, inside `caller`'s body.
      edge(4, "main.lua", 3, 9),
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
      "main.lua#caller@3:function",
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
    1,
  );
  // The relationship the graph wants, and the one an earlier version had
  // backwards. `vm.getRefs(greet)` answers "where is greet used", and the use
  // sits inside `caller` — so the edge runs from the declaration containing the
  // reference to the one it names, not from the named symbol to a file.
  TestValidator.equals(
    "a use is attributed to the declaration that contains it",
    result.edges[0],
    {
      from: "main.lua#caller@3:function",
      to: "util.lua#greet@2:field",
      kind: "references",
      evidence: {
        file: "main.lua",
        startLine: 4,
        startCol: 10,
        endLine: 4,
        endCol: 14,
      },
    },
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
        withBody(
          node("holder", "function", "function", "main.lua", 8, 9),
          { startLine: 8, startColumn: 0, endLine: 12, endColumn: 3 },
        ),
      ],
      edges: [edge(2, "main.lua", 9, 0)],
      skipped: { unnamed: 0, outsideRoot: 0, refsFailed: 0 },
      warnings: [],
    },
    "samchon-graph-lua",
  );
  TestValidator.equals(
    "the edge still names the declaration its index pointed at",
    result.edges.map((entry) => `${entry.from} -> ${entry.to}`),
    ["main.lua#holder@9:function -> main.lua#kept@6:variable"],
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

/**
 * Every refusal this adapter can make, made.
 *
 * A declined path that no test reaches is a claim about behaviour nobody has
 * seen. The contract asks a provider to publish only what it proves, and the
 * same rule read backwards says a refusal has to be shown firing — otherwise
 * the comment above it is the only evidence it works.
 */
export const test_lua_export_refuses_what_it_cannot_prove = (): void => {
  assertADuplicateIdentityIsDroppedAndNamed();
  assertAnEdgeWithNoDeclarationIsNamed();
  assertAUseAtFileScopeIsNotAttributed();
  assertAMalformedArtifactIsRefused();
};

function assertADuplicateIdentityIsDroppedAndNamed(): void {
  // Same name, same line, same kind: two declarations the identity cannot tell
  // apart. Keeping both would publish one id twice.
  const twin = node("same", "local", "local", "main.lua", 0, 0);
  const result = adaptLuaExport(
    {
      schemaVersion: 1,
      files: ["main.lua"],
      nodes: [twin, twin],
      edges: [],
      skipped: { unnamed: 0, outsideRoot: 0, refsFailed: 0 },
      warnings: [],
    },
    "samchon-graph-lua",
  );
  TestValidator.equals("a duplicate identity keeps one node", result.nodes.length, 1);
  TestValidator.predicate(
    "and says which identity collided",
    result.warnings.some((warning) => warning.includes("main.lua#same@1:variable")),
  );
}

function assertAnEdgeWithNoDeclarationIsNamed(): void {
  const result = adaptLuaExport(
    {
      schemaVersion: 1,
      files: ["main.lua"],
      nodes: [node("only", "local", "local", "main.lua", 0, 0)],
      edges: [edge(7, "main.lua", 1, 0)],
      skipped: { unnamed: 0, outsideRoot: 0, refsFailed: 0 },
      warnings: [],
    },
    "samchon-graph-lua",
  );
  TestValidator.equals("an edge with no origin produces none", result.edges.length, 0);
  TestValidator.predicate(
    "and names the index it could not resolve",
    result.warnings.some((warning) => warning.includes("declaration 7")),
  );
}

/**
 * A use outside every declaration belongs to none.
 *
 * Attributing it to the file, or to whichever declaration happens to sit
 * nearest, would invent a relationship the index never resolved.
 */
function assertAUseAtFileScopeIsNotAttributed(): void {
  const result = adaptLuaExport(
    {
      schemaVersion: 1,
      files: ["main.lua"],
      nodes: [node("thing", "local", "local", "main.lua", 5, 0)],
      edges: [edge(1, "main.lua", 40, 0)],
      skipped: { unnamed: 0, outsideRoot: 0, refsFailed: 0 },
      warnings: [],
    },
    "samchon-graph-lua",
  );
  TestValidator.equals(
    "a use enclosed by no declaration produces no edge",
    result.edges.length,
    0,
  );
}

/**
 * The producer is a script inside somebody else's server, and a crashed run is
 * still a JSON file. Each of these would otherwise become a snapshot whose
 * empty arrays publish "this project has no symbols" as a fact.
 */
function assertAMalformedArtifactIsRefused(): void {
  const refusals: Array<[string, unknown, string]> = [
    ["a non-object artifact", 42, "not an object"],
    ["a null artifact", null, "not an object"],
    [
      "an unsupported schema version",
      { schemaVersion: 9, files: [], nodes: [], edges: [], warnings: [] },
      "schemaVersion",
    ],
    [
      "a missing nodes array",
      { schemaVersion: 1, files: [], edges: [], warnings: [] },
      "has no nodes",
    ],
    [
      "a file entry that is not a path",
      { schemaVersion: 1, files: [""], nodes: [], edges: [], warnings: [] },
      "not a path",
    ],
    [
      "a declaration with no name",
      {
        schemaVersion: 1,
        files: ["a.lua"],
        nodes: [{ kind: "local", sourceType: "local", location: span() }],
        edges: [],
        warnings: [],
      },
      "has no name",
    ],
    [
      "a declaration with no kind",
      {
        schemaVersion: 1,
        files: ["a.lua"],
        nodes: [{ name: "x", sourceType: "local", location: span() }],
        edges: [],
        warnings: [],
      },
      "has no kind",
    ],
    [
      "a declaration with no file",
      {
        schemaVersion: 1,
        files: ["a.lua"],
        nodes: [
          {
            name: "x",
            kind: "local",
            sourceType: "local",
            location: { ...span(), file: "" },
          },
        ],
        edges: [],
        warnings: [],
      },
      "has no file",
    ],
    [
      "a declaration with a negative coordinate",
      {
        schemaVersion: 1,
        files: ["a.lua"],
        nodes: [
          {
            name: "x",
            kind: "local",
            sourceType: "local",
            location: { ...span(), startLine: -1 },
          },
        ],
        edges: [],
        warnings: [],
      },
      "has no startLine",
    ],
    [
      "an edge with no origin",
      {
        schemaVersion: 1,
        files: ["a.lua"],
        nodes: [],
        edges: [{ from: 0, kind: "references", sourceType: "x", location: span() }],
        warnings: [],
      },
      "no origin declaration",
    ],
  ];
  for (const [reason, artifact, expected] of refusals) {
    let message = "";
    try {
      adaptLuaExport.parse(artifact, "samchon-graph-lua");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    TestValidator.predicate(
      `${reason} is refused with a reason`,
      message.includes(expected),
    );
  }

  // Counters that are absent or nonsensical read as zero rather than throwing:
  // a producer that forgot to count is still usable, and inventing a number
  // would be worse than reporting none.
  TestValidator.equals(
    "absent skip counters read as zero",
    adaptLuaExport.parse(
      { schemaVersion: 1, files: [], nodes: [], edges: [], warnings: [] },
      "samchon-graph-lua",
    ).skipped,
    { unnamed: 0, outsideRoot: 0, refsFailed: 0 },
  );
}

function span(): adaptLuaExport.ILocation {
  return {
    file: "a.lua",
    startLine: 0,
    startColumn: 0,
    endLine: 0,
    endColumn: 1,
  };
}
