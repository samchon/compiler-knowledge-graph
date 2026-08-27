import { TestValidator } from "@nestia/e2e";
import {
  IGraphSemanticIdentity,
  ISamchonGraphDump,
  ISamchonGraphEdge,
  ISamchonGraphNode,
  SamchonGraphMemory,
  assignSemanticIdentities,
  dedupeNodes,
  finalizeGraph,
  isSemanticGraphNodeId,
  legacyGraphNodeIds,
  semanticGraphNodeId,
  validateSemanticGraphNode,
} from "@samchon/graph";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { GraphPaths } from "../internal/GraphPaths";

const importLib = <T>(relative: string): Promise<T> =>
  import(
    pathToFileURL(path.join(GraphPaths.graphPackageRoot, "lib", relative)).href
  ) as Promise<T>;

const identity = (
  over: Partial<IGraphSemanticIdentity> & { symbol: string },
): IGraphSemanticIdentity => ({
  version: 2,
  language: "go",
  role: "function",
  stability: "persistent",
  ...over,
});

const gnode = (over: Partial<ISamchonGraphNode>): ISamchonGraphNode =>
  ({
    id: "src/a.go#x:function",
    name: "x",
    kind: "function",
    language: "go",
    file: "src/a.go",
    ...over,
  }) as ISamchonGraphNode;

/**
 * Every defensive and low-traffic branch of the semantic identity layer stays
 * covered. These are the collision guards, the opaque-id file recovery, the
 * strict-slice normalization, and the ambiguous-endpoint tiebreaks that no
 * ordinary fixture exercises but the 100% gate requires.
 */
export const test_semantic_identity_edge_cases_stay_covered = async () => {
  // fileOfNodeId: a bare file id (no `#`) and a symbol id.
  const { fileOfNodeId } = await importLib<{
    fileOfNodeId: ((id: string) => string) & {
      parseLegacy(id: string): {
        file: string;
        name: string;
        kind?: string;
      } | undefined;
      unescape(value: string): string;
    };
  }>("utils/fileOfNodeId.js");
  const { mergeSemanticNodes } = await importLib<{
    mergeSemanticNodes: (nodes: readonly ISamchonGraphNode[]) => ISamchonGraphNode[];
  }>("indexer/dedupeNodes.js");
  const { mergeGraphSlices } = await importLib<{
    mergeGraphSlices: (options: {
      root: string;
      files: readonly string[];
      genericNodes: ISamchonGraphNode[];
      genericEdges: ISamchonGraphEdge[];
      strictNodes: ISamchonGraphNode[];
      strictEdges: ISamchonGraphEdge[];
    }) => {
      nodes: ISamchonGraphNode[];
      edges: ISamchonGraphEdge[];
      warnings: string[];
    };
  }>("provider/mergeGraphSlices.js");
  TestValidator.equals("a file id has no hash", fileOfNodeId("src/a.go"), "src/a.go");
  TestValidator.equals(
    "a symbol id keeps its file prefix",
    fileOfNodeId("src/a.go#Foo:class"),
    "src/a.go",
  );
  TestValidator.equals(
    "an empty legacy tail is not a node identity",
    fileOfNodeId.parseLegacy("src/a.go#"),
    undefined,
  );
  TestValidator.equals(
    "a legacy kind without a name is not an identity",
    fileOfNodeId.parseLegacy("src/a.go#:function"),
    undefined,
  );
  TestValidator.equals(
    "a legacy name without a kind remains decodable",
    fileOfNodeId.parseLegacy("src/a.go#run"),
    { file: "src/a.go", name: "run" },
  );
  TestValidator.equals(
    "three leading legacy slashes are not collapsed as a UNC prefix",
    fileOfNodeId.unescape("\\\\\\server"),
    "\\\\server",
  );
  TestValidator.equals(
    "a hash after a legacy slash pair is not mistaken for a UNC host",
    fileOfNodeId.unescape("\\\\#server"),
    "\\#server",
  );
  TestValidator.error("malformed semantic display escapes fail closed", () =>
    validateSemanticGraphNode({
      id: `@v2/go/${"a".repeat(64)}#%ZZ:function`,
      language: "go",
      kind: "function",
      name: "run",
    }),
  );

  const duplicateId = semanticGraphNodeId(
    identity({ symbol: "demo.run" }),
    "demo.run",
  );
  const duplicate = gnode({
    id: duplicateId,
    name: "run",
    qualifiedName: "demo.run",
  });
  TestValidator.error("duplicate semantic ids are rejected in memory", () =>
    SamchonGraphMemory.from({
      project: path.resolve("semantic-duplicate"),
      languages: ["go"],
      indexer: "lsp",
      nodes: [duplicate, { ...duplicate }],
      edges: [],
    }),
  );

  // validateIdentity: a positional native without a structural overload, and a
  // generation-scoped identity without a generation key, are both refused.
  TestValidator.error(
    "a positional native identity without an overload discriminator is refused",
    () =>
      semanticGraphNodeId(
        identity({ symbol: "demo.run", native: { key: "+1", stability: "positional" } }),
        "demo.run",
      ),
  );
  TestValidator.error(
    "a generation-scoped identity without a generation key is refused",
    () => semanticGraphNodeId(identity({ symbol: "demo.run", stability: "generation" }), "demo.run"),
  );
  TestValidator.error("an empty semantic symbol is refused", () =>
    semanticGraphNodeId(identity({ symbol: "" }), "demo.run"),
  );
  TestValidator.error("an older provider identity schema is refused", () =>
    semanticGraphNodeId(
      {
        ...identity({ symbol: "demo.run" }),
        version: 1,
      } as unknown as IGraphSemanticIdentity,
      "demo.run",
    ),
  );
  TestValidator.error("an empty semantic display name is refused", () =>
    semanticGraphNodeId(identity({ symbol: "demo.run" }), ""),
  );
  TestValidator.error("an empty native symbol key is refused", () =>
    semanticGraphNodeId(
      identity({ symbol: "demo.run", native: { key: "", stability: "semantic" } }),
      "demo.run",
    ),
  );

  TestValidator.equals(
    "a legacy path beginning with the semantic namespace stays legacy",
    isSemanticGraphNodeId("@v2/source.go#run:function"),
    false,
  );
  TestValidator.notEquals(
    "display spelling is part of the semantic id digest",
    semanticGraphNodeId(identity({ symbol: "demo.run" }), "demo.run"),
    semanticGraphNodeId(identity({ symbol: "demo.run" }), "demo.execute"),
  );

  // assignSemanticIdentities: an empty-file scope, a generation-scoped node with
  // no evidence, and two same-id callables an edge cannot disambiguate.
  const ambiguous: ISamchonGraphNode[] = [
    gnode({
      id: "src/a.go#foo:function",
      name: "foo",
      qualifiedName: "foo",
      evidence: { file: "src/a.go", startLine: 1, startCol: 0 },
    }),
    gnode({
      id: "src/a.go#foo:function",
      name: "foo",
      qualifiedName: "foo",
      evidence: { file: "src/a.go", startLine: 5, startCol: 0 },
    }),
    gnode({ id: "src/a.go#fileless:function", name: "fileless", qualifiedName: "fileless", file: "" }),
    gnode({ id: "src/a.go#bare:function", name: "bare", qualifiedName: "bare" }),
    gnode({ id: "src/a.go#value:parameter", name: "value", kind: "parameter", qualifiedName: "value" }),
  ];
  const ambiguousEdges: ISamchonGraphEdge[] = [
    { kind: "calls", from: "src/a.go#foo:function", to: "src/a.go#bare:function", evidence: { file: "src/a.go", startLine: 3 } },
  ];
  const ambiguousWarnings: string[] = [];
  assignSemanticIdentities(ambiguous, ambiguousEdges, ambiguousWarnings);
  TestValidator.predicate(
    "an empty-file declaration still receives a generation-scoped id",
    ambiguous[2]!.id.startsWith("@g2/"),
  );
  TestValidator.predicate(
    "a parameter without a callable owner is generation scoped",
    ambiguous[4]!.id.startsWith("@g2/"),
  );
  TestValidator.equals(
    "an unresolved ambiguous endpoint is omitted instead of bound by hash order",
    ambiguousEdges,
    [],
  );
  TestValidator.equals(
    "the omitted endpoint is reported precisely below the warning cap",
    ambiguousWarnings,
    [
      "@samchon/graph: omitted an ambiguous generic edge without provider endpoint proof: calls src/a.go#foo:function -> src/a.go#bare:function",
    ],
  );

  const floodAmbiguousWarnings = (
    targets: readonly string[],
  ): { edges: ISamchonGraphEdge[]; warnings: string[] } => {
    const nodes: ISamchonGraphNode[] = [
      gnode({
        id: "src/flood.go#foo:function",
        name: "foo",
        qualifiedName: "foo",
        file: "src/flood.go",
        evidence: { file: "src/flood.go", startLine: 1 },
      }),
      gnode({
        id: "src/flood.go#foo:function",
        name: "foo",
        qualifiedName: "foo",
        file: "src/flood.go",
        evidence: { file: "src/flood.go", startLine: 5 },
      }),
    ];
    const edges = targets.map(
      (target): ISamchonGraphEdge => ({
        kind: "calls",
        from: "src/flood.go#foo:function",
        to: target,
      }),
    );
    const warnings: string[] = [];
    assignSemanticIdentities(nodes, edges, warnings);
    return { edges, warnings };
  };
  const floodTargets = [
    ...Array.from(
      { length: 11 },
      (_, at) => `target-${String(at).padStart(2, "0")}`,
    ),
    "target-00",
  ];
  const flooded = floodAmbiguousWarnings(floodTargets);
  const reversedFlood = floodAmbiguousWarnings([...floodTargets].reverse());
  TestValidator.equals(
    "amplified ambiguous generic-edge warnings are capped and deterministic",
    [
      flooded.edges.length,
      reversedFlood.edges.length,
      flooded.warnings.length,
      flooded.warnings[0],
      flooded.warnings[1],
      flooded.warnings[10],
      flooded.warnings.some((warning) => warning.includes("target-10")),
    ],
    [
      0,
      0,
      11,
      "@samchon/graph: omitted 12 ambiguous generic edges without provider endpoint proof; up to 10 distinct examples follow",
      "@samchon/graph: omitted an ambiguous generic edge without provider endpoint proof: calls src/flood.go#foo:function -> target-00",
      "@samchon/graph: omitted an ambiguous generic edge without provider endpoint proof: calls src/flood.go#foo:function -> target-09",
      false,
    ],
  );
  TestValidator.equals(
    "the capped examples do not depend on reverse-splice input order",
    reversedFlood.warnings,
    flooded.warnings,
  );

  const duplicateLocations: ISamchonGraphNode[] = [
    gnode({
      id: "src/service.cs#Service.GetEnumerator():method",
      language: "csharp",
      name: "GetEnumerator()",
      qualifiedName: "Service.GetEnumerator()",
      modifiers: ["public"],
      evidence: { file: "src/service.cs", startLine: 1 },
    }),
    gnode({
      id: "src/service.cs#Service.GetEnumerator():method",
      language: "csharp",
      name: "GetEnumerator()",
      qualifiedName: "Service.GetEnumerator()",
      modifiers: ["public"],
      evidence: { file: "src/service.cs", startLine: 8 },
    }),
  ];
  const duplicateLocationEdges: ISamchonGraphEdge[] = [
    {
      kind: "calls",
      from: "src/service.cs#Service.GetEnumerator():method",
      to: "src/service.cs#Service.GetEnumerator():method",
    },
  ];
  assignSemanticIdentities(duplicateLocations, duplicateLocationEdges);
  TestValidator.equals(
    "matching observations retain one persistent declaration identity",
    duplicateLocations[0]!.id,
    duplicateLocations[1]!.id,
  );
  TestValidator.equals(
    "an edge to duplicate observations with one final id remains unambiguous",
    duplicateLocationEdges[0],
    {
      kind: "calls",
      from: duplicateLocations[0]!.id,
      to: duplicateLocations[0]!.id,
    },
  );
  const conflictingFacts: ISamchonGraphNode[] = [
    { ...duplicateLocations[0]!, id: "src/service.cs#Service.GetEnumerator():method", modifiers: ["public"], evidence: { file: "src/service.cs", startLine: 1 } },
    { ...duplicateLocations[1]!, id: "src/service.cs#Service.GetEnumerator():method", modifiers: ["private"], evidence: { file: "src/service.cs", startLine: 8 } },
  ];
  assignSemanticIdentities(conflictingFacts);
  TestValidator.predicate(
    "conflicting generic facts become distinct generation-scoped identities",
    conflictingFacts.every((node) => node.id.startsWith("@g2/")) &&
      conflictingFacts[0]!.id !== conflictingFacts[1]!.id,
  );
  const sameCoordinateConflicts: ISamchonGraphNode[] = [
    {
      ...duplicateLocations[0]!,
      id: "src/service.cs#Service.GetEnumerator():method",
      modifiers: ["public"],
      evidence: { file: "src/service.cs", startLine: 1 },
    },
    {
      ...duplicateLocations[1]!,
      id: "src/service.cs#Service.GetEnumerator():method",
      modifiers: ["private"],
      evidence: { file: "src/service.cs", startLine: 1 },
    },
  ];
  assignSemanticIdentities(sameCoordinateConflicts);
  TestValidator.predicate(
    "same-coordinate conflicting facts receive distinct generation identities",
    sameCoordinateConflicts.every((node) => node.id.startsWith("@g2/")) &&
      sameCoordinateConflicts[0]!.id !== sameCoordinateConflicts[1]!.id,
  );

  const finalNodes: ISamchonGraphNode[] = [
    gnode({ id: "src/a.go#outer:function", name: "outer", evidence: { file: "src/a.go", startLine: 1, endLine: 12 } }),
    gnode({ id: "src/a.go#outer.value:variable", name: "value", kind: "variable", qualifiedName: "outer.value", evidence: { file: "src/a.go", startLine: 3 } }),
    gnode({ id: "src/a.go#outer.value:variable", name: "value", kind: "variable", qualifiedName: "outer.value", evidence: { file: "src/a.go", startLine: 7 } }),
    gnode({ id: "src/a.go#Box:class", name: "Box", kind: "class", evidence: { file: "src/a.go", startLine: 14, endLine: 20 } }),
    gnode({ id: "src/a.go#Box.value:variable", name: "value", kind: "variable", qualifiedName: "Box.value", evidence: { file: "src/a.go", startLine: 16 } }),
    gnode({ id: "src/a.go#flat:variable", name: "flat", kind: "variable", evidence: { file: "src/a.go", startLine: 22 } }),
    gnode({ id: "src/a.go#outside:variable", name: "outside", kind: "variable", external: true, evidence: { file: "src/a.go", startLine: 23 } }),
  ];
  finalizeGraph("/repo", ["src/a.go"], finalNodes, []);
  const locals = finalNodes.filter((node) => node.qualifiedName === "outer.value");
  TestValidator.predicate(
    "locals receive distinct generation identities after closure ownership is known",
    locals.every((node) => node.id.startsWith("@g2/")) && locals[0]!.id !== locals[1]!.id,
  );
  const property = finalNodes.find((node) => node.qualifiedName === "Box.value")!;
  TestValidator.equals("member kind normalizes before identity assignment", property.kind, "property");
  TestValidator.predicate("member identity carries the normalized role", property.id.endsWith(":property"));
  const alreadySemantic = gnode({
    id: semanticGraphNodeId(
      identity({ symbol: "demo.Existing", role: "class", native: { key: "existing", stability: "semantic" } }),
      "demo.Existing",
    ),
    name: "Existing",
    qualifiedName: "demo.Existing",
    kind: "class",
  });
  assignSemanticIdentities([alreadySemantic]);
  TestValidator.predicate("an already-semantic node is not re-keyed", alreadySemantic.id.startsWith("@v2/"));

  // dedupeNodes / mergeSemanticNodes: every location is considered together,
  // then the ttsc-compatible declaration/implementation pair is canonicalized.
  const semId = semanticGraphNodeId(
    identity({ symbol: "demo.Widget.draw", role: "method", native: { key: "u", stability: "semantic" }, overload: "parameters=" }),
    "demo.Widget.draw",
  );
  const threeLocations: ISamchonGraphNode[] = [
    gnode({ id: semId, name: "draw", kind: "method", qualifiedName: "demo.Widget.draw", file: "src/a.go", evidence: { file: "src/a.go", startLine: 2, startCol: 0 }, ignored: true }),
    gnode({ id: semId, name: "draw", kind: "method", qualifiedName: "demo.Widget.draw", file: "src/a.go", evidence: { file: "src/a.go", startLine: 5, startCol: 0 }, exported: true }),
    gnode({ id: semId, name: "draw", kind: "method", qualifiedName: "demo.Widget.draw", file: "src/a.go", evidence: { file: "src/a.go", startLine: 9, startCol: 0 }, closure: true }),
  ];
  const locationWarnings: Array<readonly [string, number]> = [];
  const forward = dedupeNodes(threeLocations, (id, count) =>
    locationWarnings.push([id, count]),
  );
  const reverse = dedupeNodes([...threeLocations].reverse());
  TestValidator.equals("dedupe merges arbitrary semantic locations", forward.length, 1);
  TestValidator.equals("the overflow is reported", locationWarnings, [[semId, 3]]);
  TestValidator.equals(
    "canonical location selection is independent of producer order",
    [forward[0]!.evidence, forward[0]!.implementation],
    [reverse[0]!.evidence, reverse[0]!.implementation],
  );
  TestValidator.equals(
    "semantic location merging preserves every truthy graph modifier",
    [forward[0]!.ignored, forward[0]!.exported, forward[0]!.closure],
    [true, true, true],
  );
  const withoutLocations = dedupeNodes([
    gnode({ id: semId, name: "draw", kind: "method", qualifiedName: "demo.Widget.draw", file: "src/no-span.go", ignored: true }),
    gnode({ id: semId, name: "draw", kind: "method", qualifiedName: "demo.Widget.draw", file: "src/no-span.go", ignored: true }),
  ]);
  TestValidator.equals(
    "semantic facts without locations preserve their source file alone",
    [
      withoutLocations[0]!.file,
      withoutLocations[0]!.ignored,
      withoutLocations[0]!.evidence,
      withoutLocations[0]!.implementation,
    ],
    ["src/no-span.go", true, undefined, undefined],
  );
  const merged = mergeSemanticNodes(threeLocations);
  TestValidator.equals("mergeSemanticNodes collapses a repeated semantic id", merged.length, 1);
  TestValidator.error("semantic location facts cannot disagree", () =>
    dedupeNodes([
      threeLocations[0]!,
      { ...threeLocations[1]!, name: "other" },
    ]),
  );

  const aliases = legacyGraphNodeIds(
    gnode({
      id: semId,
      name: "draw(string)",
      kind: "method",
      qualifiedName: "demo.Widget.draw(string)",
      file: "src/Widget.go",
      evidence: { file: "src/Widget.decl.go", startLine: 2 },
      implementation: { file: "src/Widget.impl.go", startLine: 8 },
    }),
  );
  TestValidator.predicate(
    "legacy aliases retain the declaration evidence file",
    aliases.includes("src/Widget.decl.go#demo.Widget.draw(string):method"),
  );
  TestValidator.predicate(
    "legacy aliases fall back to the node file when evidence is absent",
    legacyGraphNodeIds(
      gnode({
        id: semId,
        name: "draw(string)",
        kind: "method",
        qualifiedName: "demo.Widget.draw(string)",
        file: "src/Widget.file-only.go",
      }),
    ).includes("src/Widget.file-only.go#demo.Widget.draw(string):method"),
  );

  // mergeGraphSlices: a strict slice normalizes and orders its nodes and edges.
  const strictA = gnode({ id: semanticGraphNodeId(identity({ symbol: "demo.A", role: "class", native: { key: "a", stability: "semantic" }, overload: "" }), "demo.A"), name: "A", qualifiedName: "demo.A", kind: "class", file: "src/a.go" });
  const strictB = gnode({ id: semanticGraphNodeId(identity({ symbol: "demo.B", role: "class", native: { key: "b", stability: "semantic" }, overload: "" }), "demo.B"), name: "B", qualifiedName: "demo.B", kind: "class", file: "src/b.go" });
  const strictEdges: ISamchonGraphEdge[] = [
    { kind: "references", from: strictB.id, to: strictA.id, evidence: { file: "src/b.go", startLine: 2 } },
    { kind: "references", from: strictA.id, to: strictB.id, evidence: { file: "src/a.go", startLine: 4 } },
    { kind: "type_ref", from: strictA.id, to: strictA.id },
  ];
  const mergedSlice = mergeGraphSlices({
    root: "/repo",
    files: ["src/a.go", "src/b.go"],
    genericNodes: [],
    genericEdges: [],
    strictNodes: [strictA, strictB],
    strictEdges,
  });
  TestValidator.equals("a strict slice keeps every ordered edge", mergedSlice.edges.length, 3);
  TestValidator.error("a strict duplicate node remains a provider defect", () =>
    mergeGraphSlices({
      root: "/repo",
      files: ["src/a.go"],
      genericNodes: [],
      genericEdges: [],
      strictNodes: [strictA, { ...strictA }],
      strictEdges: [],
    }),
  );

  // wireEdges: a source in the node map, a legacy source absent from it, and an
  // opaque semantic source absent from it.
  const { wireEdges } = await importLib<{
    wireEdges: (edges: readonly ISamchonGraphEdge[], nodes?: readonly ISamchonGraphNode[]) => ISamchonGraphDump.IEdge[];
  }>("indexer/wireEdges.js");
  const wired = wireEdges(
    [
      { kind: "calls", from: "src/a.go#present:function", to: "t", evidence: { file: "src/a.go", startLine: 1 } },
      { kind: "calls", from: "src/gone.go#missing:function", to: "t", evidence: { file: "src/gone.go", startLine: 1 } },
      { kind: "calls", from: strictA.id, to: "t", evidence: { file: "src/a.go", startLine: 1 } },
    ],
    [gnode({ id: "src/a.go#present:function", name: "present", file: "src/a.go" })],
  );
  TestValidator.equals("every edge survives wiring", wired.length, 3);
  const legacyWired = wireEdges([
    { kind: "calls", from: strictA.id, to: "t", evidence: { file: "src/a.go", startLine: 1 } },
  ]);
  TestValidator.equals(
    "one-argument edge wiring retains opaque source evidence",
    legacyWired[0]?.evidence?.file,
    "src/a.go",
  );

  // overrideEdges: two members that share a signature key.
  const { overrideEdges } = await importLib<{
    overrideEdges: (nodes: ISamchonGraphNode[], edges: ISamchonGraphEdge[]) => ISamchonGraphEdge[];
  }>("indexer/overrideEdges.js");
  const sharedMembers = [
    gnode({ id: "src/a.go#Base.run:method", name: "run(x)", kind: "method", qualifiedName: "Base.run" }),
    gnode({ id: "src/a.go#Impl.run:method", name: "run(x)", kind: "method", qualifiedName: "Impl.run" }),
  ];
  const sharedContains = sharedMembers.map((node) => ({
    from: "src/a.go#Owner:class",
    to: node.id,
    kind: "contains" as const,
  }));
  const sharedOverrides = overrideEdges(sharedMembers, sharedContains);
  // Two members with the same signature key and no inheritance between their
  // owners are two methods that happen to share a name. Asserting only that
  // the call returns states nothing: a version that invented an override for
  // every key collision would return too, and so would one that rewrote the
  // `contains` edges it was handed.
  TestValidator.equals(
    "a shared member key is not by itself an override",
    [sharedOverrides, sharedContains.map((edge) => edge.kind)],
    [[], ["contains", "contains"]],
  );

  // SamchonGraphMemory: a duplicate semantic id in a dump is a producer defect.
  const dupId = semanticGraphNodeId(identity({ symbol: "demo.Dup", role: "class", native: { key: "d", stability: "semantic" }, overload: "" }), "demo.Dup");
  const dumpWithDup: ISamchonGraphDump = {
    project: "p",
    languages: ["go"],
    indexer: "static",
    nodes: [
      gnode({ id: dupId, name: "Dup", kind: "class", file: "src/a.go", evidence: { file: "src/a.go", startLine: 1, startCol: 0 } }),
      gnode({ id: dupId, name: "Dup", kind: "class", file: "src/a.go", evidence: { file: "src/a.go", startLine: 8, startCol: 0 } }),
    ],
    edges: [],
  } as unknown as ISamchonGraphDump;
  TestValidator.error("a duplicate semantic id in a dump is refused", () =>
    SamchonGraphMemory.from(dumpWithDup),
  );

  // SamchonGraphMemory: an edge whose opaque semantic source is absent from the
  // dump cannot recover a file and fails closed.
  const orphanId = semanticGraphNodeId(identity({ symbol: "demo.Orphan", role: "class", native: { key: "o", stability: "semantic" }, overload: "" }), "demo.Orphan");
  const dumpWithOrphanEdge: ISamchonGraphDump = {
    project: "p",
    languages: ["go"],
    indexer: "static",
    nodes: [gnode({ id: "src/a.go#Real:class", name: "Real", kind: "class", file: "src/a.go", evidence: { file: "src/a.go", startLine: 1, startCol: 0 } })],
    edges: [{ kind: "references", from: orphanId, to: "src/a.go#Real:class", evidence: { startLine: 1 } }],
  } as unknown as ISamchonGraphDump;
  TestValidator.error("an absent semantic edge source fails closed", () =>
    SamchonGraphMemory.from(dumpWithOrphanEdge),
  );

  const semanticProperty = semanticGraphNodeId(
    identity({ symbol: "demo.Box.value", role: "property", native: { key: "p", stability: "semantic" } }),
    "demo.Box.value",
  );
  const resident = SamchonGraphMemory.from({
    project: "p",
    languages: ["go"],
    indexer: "static",
    nodes: [
      gnode({ id: "src/a.go#Box:class", name: "Box", kind: "class", qualifiedName: "demo.Box", evidence: { file: "src/a.go", startLine: 1, endLine: 4 } }),
      gnode({ id: semanticProperty, name: "value", kind: "variable", qualifiedName: "demo.Box.value", evidence: { file: "src/a.go", startLine: 2 } }),
    ],
    edges: [],
  } as unknown as ISamchonGraphDump);
  TestValidator.equals(
    "resident normalization validates the semantic property role after refinement",
    resident.node(semanticProperty)!.kind,
    "property",
  );
};
