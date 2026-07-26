import { TestValidator } from "@nestia/e2e";

import { adaptLuaExport } from "../../../../packages/graph/src/provider/lua/adaptLuaExport";

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
