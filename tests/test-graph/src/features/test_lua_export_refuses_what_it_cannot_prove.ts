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
  assertTheInnermostEnclosingDeclarationWins();
  assertEdgesAgainstDeclarationsThatDidNotSurvive();
  assertARecursiveUseIsNotAnEdgeToItself();
  assertAUseInsideAnUnmappedDeclarationIsDropped();
  assertABodylessDeclarationCanBeDisplaced();
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
      "a file entry that is not a string",
      { schemaVersion: 1, files: [42], nodes: [], edges: [], warnings: [] },
      "not a path",
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
  // A negative count is as unusable as an absent one, and inventing a number
  // from it would be worse than reporting none.
  TestValidator.equals(
    "a nonsensical skip counter reads as zero",
    adaptLuaExport.parse(
      {
        schemaVersion: 1,
        files: [],
        nodes: [],
        edges: [],
        warnings: [],
        skipped: { unnamed: -3, outsideRoot: 1.5, refsFailed: 2 },
      },
      "samchon-graph-lua",
    ).skipped,
    { unnamed: 0, outsideRoot: 0, refsFailed: 2 },
  );
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

/**
 * A reference belongs to the innermost declaration that encloses it.
 *
 * Lua nests: a function assigned inside another function's body sits within
 * both spans, and attributing the use to the outer one would say the wrong
 * declaration references the target. Ties go to the later declaration, which is
 * the inner one in source order.
 */
function assertTheInnermostEnclosingDeclarationWins(): void {
  const outer = withBody(
    node("outer", "function", "function", "main.lua", 0, 9),
    { startLine: 0, startColumn: 0, endLine: 20, endColumn: 3 },
  );
  const inner = withBody(
    node("inner", "function", "function", "main.lua", 5, 11),
    { startLine: 5, startColumn: 2, endLine: 10, endColumn: 5 },
  );
  const target = node("target", "local", "local", "util.lua", 0, 6);
  const result = adaptLuaExport(
    {
      schemaVersion: 1,
      files: ["main.lua", "util.lua"],
      // Outer first, so the inner one is found second and has to displace it.
      nodes: [outer, inner, target],
      edges: [edge(3, "main.lua", 7, 4)],
      skipped: { unnamed: 0, outsideRoot: 0, refsFailed: 0 },
      warnings: [],
    },
    "samchon-graph-lua",
  );
  TestValidator.equals(
    "the inner declaration owns the reference",
    result.edges.map((entry) => entry.from),
    ["main.lua#inner@6:function"],
  );
}

function withBody(
  entry: adaptLuaExport.INode,
  body: Omit<adaptLuaExport.ILocation, "file">,
): adaptLuaExport.INode {
  return { ...entry, body: { file: entry.location.file, ...body } };
}

/**
 * An edge whose declaration did not survive the node pass produces nothing.
 *
 * Two ways a declaration is dropped — a kind the graph has no word for, and an
 * identity already taken — and an edge naming either would otherwise be emitted
 * against an id no node carries, which is a dangling endpoint in a published
 * graph.
 */
function assertEdgesAgainstDeclarationsThatDidNotSurvive(): void {
  const result = adaptLuaExport(
    {
      schemaVersion: 1,
      files: ["main.lua"],
      nodes: [
        node("odd", "coroutine", "setcoroutine", "main.lua", 1, 0),
        withBody(node("host", "function", "function", "main.lua", 4, 9), {
          startLine: 4,
          startColumn: 0,
          endLine: 8,
          endColumn: 3,
        }),
      ],
      edges: [edge(1, "main.lua", 5, 2)],
      skipped: { unnamed: 0, outsideRoot: 0, refsFailed: 0 },
      warnings: [],
    },
    "samchon-graph-lua",
  );
  TestValidator.equals(
    "no edge names a declaration the graph has no word for",
    result.edges,
    [],
  );
}

/**
 * A recursive call is not an edge from a function to itself.
 *
 * `vm.getRefs(f)` returns the call inside `f`'s own body, so the declaration
 * containing the use and the one being used are the same. An edge there says
 * nothing a reader can act on.
 */
function assertARecursiveUseIsNotAnEdgeToItself(): void {
  const result = adaptLuaExport(
    {
      schemaVersion: 1,
      files: ["main.lua"],
      nodes: [
        withBody(node("loop", "function", "function", "main.lua", 0, 9), {
          startLine: 0,
          startColumn: 0,
          endLine: 4,
          endColumn: 3,
        }),
      ],
      edges: [edge(1, "main.lua", 2, 2)],
      skipped: { unnamed: 0, outsideRoot: 0, refsFailed: 0 },
      warnings: [],
    },
    "samchon-graph-lua",
  );
  TestValidator.equals(
    "a declaration referencing itself produces no edge",
    result.edges,
    [],
  );
}

/**
 * A use inside a declaration the graph has no word for names nothing.
 *
 * The enclosing declaration is what an edge runs from, so if the graph cannot
 * name it the edge has no origin — and attributing the use to whatever mapped
 * declaration sits further out would say the wrong thing referenced the target.
 */
function assertAUseInsideAnUnmappedDeclarationIsDropped(): void {
  const result = adaptLuaExport(
    {
      schemaVersion: 1,
      files: ["main.lua"],
      nodes: [
        node("target", "local", "local", "main.lua", 0, 0),
        withBody(node("odd", "coroutine", "setcoroutine", "main.lua", 3, 0), {
          startLine: 3,
          startColumn: 0,
          endLine: 9,
          endColumn: 3,
        }),
      ],
      edges: [edge(1, "main.lua", 5, 2)],
      skipped: { unnamed: 0, outsideRoot: 0, refsFailed: 0 },
      warnings: [],
    },
    "samchon-graph-lua",
  );
  TestValidator.equals(
    "a use inside an unnameable declaration produces no edge",
    result.edges,
    [],
  );
}

/**
 * A declaration with no body still competes for containment, and loses.
 *
 * Only a function statement carries a body span; a plain local's span is its
 * own name. When one of those happens to enclose a position — a single-line
 * declaration and a use on the same line — the function that also encloses it
 * has to win, and the comparison has to read the bodyless one's own span to
 * decide that.
 */
function assertABodylessDeclarationCanBeDisplaced(): void {
  const result = adaptLuaExport(
    {
      schemaVersion: 1,
      files: ["main.lua"],
      nodes: [
        node("target", "local", "local", "util.lua", 0, 0),
        // No body: its span is the name, and it encloses the use below.
        node("bare", "local", "local", "main.lua", 5, 0),
        withBody(node("inner", "function", "function", "main.lua", 5, 2), {
          startLine: 5,
          startColumn: 1,
          endLine: 5,
          endColumn: 40,
        }),
      ],
      edges: [edge(1, "main.lua", 5, 3)],
      skipped: { unnamed: 0, outsideRoot: 0, refsFailed: 0 },
      warnings: [],
    },
    "samchon-graph-lua",
  );
  TestValidator.equals(
    "the declaration that starts later owns the use",
    result.edges.map((entry) => entry.from),
    ["main.lua#inner@6:function"],
  );
}
