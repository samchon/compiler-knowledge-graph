import { TestValidator } from "@nestia/e2e";
import {
  type GraphEdgeKind,
  type IBulkGraphSession,
  ScipEnrichment,
  ScipSession,
  graphSnapshotDigests,
  scipProvider,
} from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";

/**
 * Language-specific SCIP facts are explicit, versioned, and strictly additive.
 *
 * A bare artifact still owns its navigation skeleton. The language contract may
 * add a fact family only after declaring its precise version, and no enrichment
 * may replace that skeleton or move a published session forward on failure.
 */
export const test_scip_enrichment_is_additive_and_versioned = async () => {
  assertTheAdditiveBoundary();
  await assertTheSessionFence();
};

function assertTheAdditiveBoundary(): void {
  const common = commonSlice();
  TestValidator.equals(
    "no enrichment preserves the common SCIP slice exactly",
    ScipEnrichment.apply({
      index: indexOf(),
      root: "/fixture",
      provider: "scip-fixture",
      languages: ["go"],
      common,
    }),
    { edges: common.edges, warnings: [] },
  );

  let immutable = false;
  let immutableIndex = false;
  let immutableDescriptor = false;
  let immutableIndexDescriptor = false;
  const rawIndex = indexOf();
  const calls = enrichment({
    enrich: ({ common: snapshot, index }) => {
      try {
        (snapshot.nodes[0] as { name: string }).name = "rewritten";
      } catch {
        immutable = true;
      }
      try {
        (index.metadata as { projectRoot: string }).projectRoot = "/rewritten";
      } catch {
        immutableIndex = true;
      }
      try {
        (
          Object.getOwnPropertyDescriptor(snapshot.edges, "0")!.value as {
            kind: GraphEdgeKind;
          }
        ).kind = "calls";
      } catch {
        immutableDescriptor = true;
      }
      try {
        (
          Object.getOwnPropertyDescriptor(index, "metadata")!.value as {
            projectRoot: string;
          }
        ).projectRoot = "/descriptor-rewrite";
      } catch {
        immutableIndexDescriptor = true;
      }
      return {
        edges: [
          { kind: "calls", from: "caller", to: "callee" },
          { kind: "calls", from: "callee", to: "caller" },
        ],
        warnings: ["one limitation", "one limitation", "another limitation"],
      };
    },
  });
  const enriched = ScipEnrichment.apply({
    enrichment: calls,
    index: rawIndex,
    root: "/fixture",
    provider: "scip-fixture",
    languages: ["go"],
    common,
  });
  TestValidator.equals(
    "an enrichment adds only its declared facts in deterministic order",
    [
      enriched.edges.map((edge) => `${edge.kind}:${edge.from}->${edge.to}`),
      enriched.warnings,
      immutable,
      immutableIndex,
      immutableDescriptor,
      immutableIndexDescriptor,
      common.nodes[0]!.name,
      common.edges[0]!.kind,
      rawIndex.metadata.projectRoot,
      Object.isFrozen(rawIndex),
      Object.isFrozen(rawIndex.metadata),
      Object.isFrozen(common.edges),
      Object.isFrozen(common.edges[0]),
      ScipEnrichment.capability(calls),
    ],
    [
      [
        "references:caller->callee",
        "calls:callee->caller",
        "calls:caller->callee",
      ],
      ["another limitation", "one limitation"],
      true,
      true,
      true,
      true,
      "caller",
      "references",
      "/fixture",
      true,
      true,
      true,
      true,
      "scip-enrichment:go-calls@2",
    ],
  );

  const receiverAware = {
    ...enrichment(),
    marker: "receiver-preserved",
    enrich() {
      return { edges: [], warnings: [this.marker] };
    },
  };
  TestValidator.equals(
    "normalization preserves a method enrichment receiver",
    ScipEnrichment.apply({
      enrichment: ScipEnrichment.normalize(receiverAware, ["go"]),
      index: indexOf(),
      root: "/fixture",
      provider: "scip-fixture",
      languages: ["go"],
      common: commonSlice(),
    }).warnings,
    ["receiver-preserved"],
  );

  const mutable = enrichment();
  const normalized = ScipEnrichment.normalize(mutable, ["go"]);
  (mutable as { name: string }).name = "changed";
  TestValidator.equals(
    "a normalized contract keeps the declaration it registered",
    [
      normalized.name,
      normalized.version,
      normalized.languages,
      normalized.facts,
      Object.isFrozen(normalized),
      Object.isFrozen(normalized.languages),
      Object.isFrozen(normalized.facts),
    ],
    ["go-calls", 2, ["go"], ["calls"], true, true, true],
  );

  // Freezing the copy is not the whole boundary. The implementation keeps the
  // original object as its receiver, so a rename after registration would let
  // `this.name` disagree with the capability the snapshot publishes. Detecting
  // that at run time is what makes the two inseparable — and each declared field
  // gets its own twin, because one case that moves all of them at once would
  // still pass if the check stopped comparing any single field.
  for (const [label, drift] of [
    ["a renamed contract", (draft: ScipEnrichment.IContract) => {
      (draft as { name: string }).name = "renamed";
    }],
    ["a reversioned contract", (draft: ScipEnrichment.IContract) => {
      (draft as { version: number }).version = 9;
    }],
    ["a relanguaged contract", (draft: ScipEnrichment.IContract) => {
      (draft.languages as unknown as string[])[0] = "rust";
    }],
    ["a contract that widened its languages", (draft) => {
      (draft.languages as unknown as string[]).push("rust");
    }],
    ["a refacted contract", (draft: ScipEnrichment.IContract) => {
      (draft.facts as GraphEdgeKind[])[0] = "tests";
    }],
    ["a contract with a replaced implementation", (draft) => {
      (draft as { enrich: ScipEnrichment.IContract["enrich"] }).enrich = () => ({
        edges: [{ kind: "tests", from: "caller", to: "callee" }],
      });
    }],
  ] as const) {
    const draft = enrichment({ enrich: () => ({ edges: [], warnings: ["ran"] }) });
    const contract = ScipEnrichment.normalize(draft, ["go"]);
    drift(draft);
    TestValidator.predicate(
      `${label} cannot run after registration`,
      throws(() => apply(common, contract)),
    );
  }
  // The positive twin has to publish something no other path produces. An
  // implementation returning no edges is indistinguishable from one that never
  // ran, so this one answers with a warning only it can emit.
  TestValidator.equals(
    "an untouched registered contract still runs the implementation it captured",
    apply(
      common,
      ScipEnrichment.normalize(
        enrichment({ enrich: () => ({ edges: [], warnings: ["captured"] }) }),
        ["go"],
      ),
    ),
    { edges: common.edges, warnings: ["captured"] },
  );

  // A registry entry owns every language its indexer serves; one build selects
  // only the languages that build requested. Demanding equality at open time
  // would reject the correctly registered multi-language provider outright.
  const shared = enrichment({ languages: ["c", "cpp"] });
  TestValidator.equals(
    "a session over part of a registered slice keeps the whole declaration",
    [
      ScipEnrichment.slice(shared, ["c"]).languages,
      ScipEnrichment.slice(shared, ["c", "cpp"]).languages,
    ],
    [
      ["c", "cpp"],
      ["c", "cpp"],
    ],
  );
  for (const [label, selected] of [
    ["a session cannot publish a language the contract never declared", ["go"]],
    ["a session must publish at least one declared language", []],
    ["a session cannot name one language twice", ["c", "c"]],
  ] as const) {
    TestValidator.predicate(
      label,
      throws(() => ScipEnrichment.slice(shared, selected)),
    );
  }

  // `Object.freeze` fixes which getter runs, never what the getter returns, so
  // an accessor left in an input would stay the live channel the seal exists to
  // close. A cycle and a shared subtree prove the walk terminates on both.
  TestValidator.predicate(
    "an accessor cannot hide mutable state inside an enrichment input",
    throws(() =>
      apply(
        {
          ...common,
          nodes: [
            Object.defineProperty({ ...common.nodes[0]! }, "name", {
              get: () => "recomputed",
              enumerable: true,
              configurable: true,
            }),
            common.nodes[1]!,
          ],
        },
        enrichment(),
      ),
    ),
  );
  // `Object.freeze` seals an object's own properties and nothing else, so a
  // `Map`, `Set`, or `Date` would be reported sealed while every mutator kept
  // working. Published evidence is plain data, and anything else is refused
  // where a caller can still act on the message.
  for (const [label, exotic] of [
    ["a Map", new Map()],
    ["a Set", new Set()],
    ["a Date", new Date(0)],
    ["a class instance", new (class Evidence {})()],
  ] as const) {
    TestValidator.predicate(
      `${label} cannot enter a sealed enrichment input`,
      throws(() =>
        apply(
          {
            ...common,
            nodes: [
              { ...common.nodes[0]!, evidence: exotic as never },
              common.nodes[1]!,
            ],
          },
          enrichment(),
        ),
      ),
    );
  }
  TestValidator.equals(
    "a null inside a sealed input is data, not a value to walk",
    apply(
      {
        ...common,
        nodes: [
          { ...common.nodes[0]!, evidence: null as never },
          common.nodes[1]!,
        ],
      },
      enrichment(),
    ).edges,
    common.edges,
  );

  const sharedSpan = { file: "src/main.go", startLine: 1, startCol: 1 };
  const cyclic = indexOf() as ReturnType<typeof indexOf> & { self?: unknown };
  cyclic.self = cyclic;
  TestValidator.equals(
    "a cyclic or shared input tree is sealed once rather than walked forever",
    ScipEnrichment.apply({
      enrichment: enrichment(),
      index: cyclic,
      root: "/fixture",
      provider: "scip-fixture",
      languages: ["go"],
      common: {
        ...common,
        nodes: common.nodes.map((node) => ({ ...node, evidence: sharedSpan })),
      },
    }).edges,
    common.edges,
  );
  TestValidator.predicate(
    "sealing a shared span reaches it through every parent that holds it",
    Object.isFrozen(sharedSpan) && Object.isFrozen(cyclic),
  );

  TestValidator.predicate(
    "the bare common slice cannot smuggle in a language-owned fact",
    throws(() =>
      apply(
        {
          ...common,
          edges: [
            ...common.edges,
            { kind: "calls", from: "caller", to: "callee" },
          ],
        },
        calls,
      ),
    ),
  );

  for (const [label, candidate] of [
    ["an invalid enrichment name", { ...calls, name: "Go calls" }],
    ["a non-positive enrichment version", { ...calls, version: 0 }],
    ["a mismatched enrichment language slice", { ...calls, languages: ["rust"] }],
    ["an empty enrichment language slice", { ...calls, languages: [] }],
    [
      "a declaration whose languages and facts are not arrays",
      {
        ...calls,
        languages: undefined as unknown as ScipEnrichment.IContract["languages"],
        facts: undefined as unknown as ScipEnrichment.IContract["facts"],
      },
    ],
    ["a duplicate enrichment language slice", { ...calls, languages: ["go", "go"] }],
    ["an empty enrichment fact declaration", { ...calls, facts: [] }],
    ["a duplicate enrichment fact declaration", { ...calls, facts: ["calls", "calls"] }],
    [
      "a missing enrichment implementation",
      {
        ...calls,
        enrich: undefined as unknown as ScipEnrichment.IContract["enrich"],
      },
    ],
    [
      "an unknown enrichment fact declaration",
      {
        ...calls,
        facts: ["not-a-graph-fact" as GraphEdgeKind],
      },
    ],
    ["an attempted common-fact replacement", { ...calls, facts: ["references"] }],
  ] as const) {
    TestValidator.predicate(label, throws(() => ScipEnrichment.assert(candidate, ["go"])));
  }
  TestValidator.predicate(
    "a registry entry cannot name one provider language twice",
    throws(() => ScipEnrichment.assert(calls, ["go", "go"])),
  );
  // The capability string is what a snapshot publishes about which contract
  // ran, so formatting one from a declaration nothing validated would put an
  // unchecked name and version into the provenance a reader degrades against.
  TestValidator.predicate(
    "an unvalidated contract cannot name itself in a published capability",
    throws(() => ScipEnrichment.capability(enrichment({ name: "Go Calls" }))),
  );
  // The only inputs on which registration and session validation disagree.
  // Equality is what keeps a provider from leaving part of its own entry
  // unenriched, and nothing else in this file exercises a length mismatch.
  TestValidator.predicate(
    "a contract cannot cover fewer languages than the provider registering it",
    throws(() =>
      ScipEnrichment.assert(enrichment({ languages: ["go"] }), ["go", "rust"]),
    ),
  );
  TestValidator.predicate(
    "a contract cannot cover more languages than the provider registering it",
    throws(() =>
      ScipEnrichment.assert(enrichment({ languages: ["go", "rust"] }), ["go"]),
    ),
  );
  TestValidator.equals(
    "a session may still publish part of that same wider slice",
    ScipEnrichment.slice(enrichment({ languages: ["go", "rust"] }), ["go"])
      .languages,
    ["go", "rust"],
  );

  TestValidator.predicate(
    "the common SCIP slice cannot duplicate a node",
    throws(() =>
      apply(
        {
          ...common,
          nodes: [...common.nodes, { ...common.nodes[0]! }],
        },
        calls,
      ),
    ),
  );
  TestValidator.predicate(
    "the common SCIP slice cannot duplicate a file",
    throws(() =>
      apply(
        {
          ...common,
          files: [...common.files, common.files[0]!],
        },
        calls,
      ),
    ),
  );
  TestValidator.predicate(
    "the common SCIP slice cannot duplicate an edge",
    throws(() =>
      apply(
        {
          ...common,
          edges: [...common.edges, { ...common.edges[0]! }],
        },
        calls,
      ),
    ),
  );
  TestValidator.predicate(
    "the common SCIP slice cannot publish an absent endpoint",
    throws(() =>
      apply(
        {
          ...common,
          edges: [
            { kind: "references", from: "caller", to: "missing" },
          ],
        },
        calls,
      ),
    ),
  );
  TestValidator.predicate(
    "the common SCIP slice cannot publish from an absent endpoint",
    throws(() =>
      apply(
        {
          ...common,
          edges: [
            { kind: "references", from: "missing", to: "callee" },
          ],
        },
        calls,
      ),
    ),
  );
  TestValidator.equals(
    "common file containers remain valid edge endpoints",
    apply(
      {
        ...common,
        edges: [
          { kind: "contains", from: "src/main.go", to: "caller" },
          { kind: "references", from: "caller", to: "src/main.go" },
        ],
      },
      enrichment(),
    ).edges,
    [
      { kind: "contains", from: "src/main.go", to: "caller" },
      { kind: "references", from: "caller", to: "src/main.go" },
    ],
  );
  TestValidator.predicate(
    "an enrichment cannot publish a fact it did not declare",
    throws(() =>
      apply(common, enrichment({ facts: ["tests"], enrich: () => ({
        edges: [{ kind: "calls", from: "caller", to: "callee" }],
      }) })),
    ),
  );
  TestValidator.predicate(
    "an enrichment cannot publish an endpoint outside the common slice",
    throws(() =>
      apply(common, enrichment({ enrich: () => ({
        edges: [{ kind: "calls", from: "caller", to: "missing" }],
      }) })),
    ),
  );
  TestValidator.predicate(
    "an enrichment cannot publish from an endpoint outside the common slice",
    throws(() =>
      apply(
        common,
        enrichment({
          enrich: () => ({
            edges: [{ kind: "calls", from: "missing", to: "callee" }],
          }),
        }),
      ),
    ),
  );
  TestValidator.predicate(
    "an enrichment cannot publish one language fact twice",
    throws(() =>
      apply(common, enrichment({ enrich: () => ({
        edges: [
          { kind: "calls", from: "caller", to: "callee" },
          { kind: "calls", from: "caller", to: "callee" },
        ],
      }) })),
    ),
  );
  TestValidator.predicate(
    "a non-object enrichment edge cannot enter a graph",
    throws(() =>
      apply(
        common,
        enrichment({
          enrich: () =>
            ({
              edges: [null],
            }) as unknown as ScipEnrichment.IResult,
        }),
      ),
    ),
  );
  TestValidator.predicate(
    "a null enrichment result cannot enter a graph",
    throws(() =>
      apply(
        common,
        enrichment({
          enrich: () => null as unknown as ScipEnrichment.IResult,
        }),
      ),
    ),
  );
  TestValidator.predicate(
    "a malformed enrichment result cannot enter a graph",
    throws(() =>
      apply(
        common,
        enrichment({
          enrich: () => ({ edges: undefined } as unknown as ScipEnrichment.IResult),
        }),
      ),
    ),
  );
  TestValidator.predicate(
    "non-array warnings cannot enter a graph",
    throws(() =>
      apply(
        common,
        enrichment({
          enrich: () =>
            ({
              edges: [],
              warnings: "not an array",
            }) as unknown as ScipEnrichment.IResult,
        }),
      ),
    ),
  );
  TestValidator.predicate(
    "empty enrichment warnings cannot enter a graph",
    throws(() =>
      apply(
        common,
        enrichment({ enrich: () => ({ edges: [], warnings: [""] }) }),
      ),
    ),
  );
  TestValidator.predicate(
    "whitespace-only enrichment warnings cannot enter a graph",
    throws(() =>
      apply(
        common,
        enrichment({ enrich: () => ({ edges: [], warnings: ["   "] }) }),
      ),
    ),
  );
}

async function assertTheSessionFence(): Promise<void> {
  const root = GraphPaths.createTempDirectory("samchon-graph-scip-enrichment-");
  const source = path.join(root, "main.go");
  fs.writeFileSync(source, "package main\n");
  let calls = 0;
  const contract = enrichment({
    enrich: ({ common }) => {
      calls += 1;
      return {
        edges:
          calls === 1
            ? [{ kind: "calls", from: common.nodes[0]!.id, to: common.nodes[0]!.id }]
            : [{ kind: "calls", from: common.nodes[0]!.id, to: "missing" }],
      };
    },
  });
  const session = sessionOf(root, contract);
  const first = await session.refresh();
  TestValidator.equals(
    "a session publishes its versioned enrichment beside common facts",
    [
      first.snapshot.provenance.facts,
      first.snapshot.provenance.capabilities.includes(
        "scip-enrichment:go-calls@2",
      ),
      first.snapshot.edges.map((edge) => edge.kind),
    ],
    [["contains", "references", "type_ref", "calls"], true, ["calls"]],
  );
  fs.appendFileSync(source, "// force a new candidate\n");
  await rejects(session.refresh());
  TestValidator.equals(
    "a failed enrichment leaves the prior whole generation standing",
    [session.generation, session.current],
    [1, first.snapshot],
  );
  await session.close();

  let externallyValidated = false;
  const sourceBacked = sessionOf(
    root,
    enrichment({
      enrich: ({ common }) => ({
        edges: [
          { kind: "calls", from: common.nodes[0]!.id, to: common.nodes[0]!.id },
        ],
      }),
    }),
    true,
    () => {
      externallyValidated = true;
    },
  );
  const sourceBackedRefresh = await sourceBacked.refresh();
  TestValidator.predicate(
    "a source-backed enrichment retains both source and contract capabilities",
    sourceBackedRefresh.snapshot.provenance.capabilities.includes(
      "sourceDigests",
    ) &&
      sourceBackedRefresh.snapshot.provenance.capabilities.includes(
        "scip-enrichment:go-calls@2",
      ) &&
      externallyValidated,
  );
  TestValidator.notEquals(
    "the full snapshot digest includes every observable enrichment envelope field",
    graphSnapshotDigests.snapshotOf(sourceBackedRefresh.snapshot),
    graphSnapshotDigests.snapshotOf({
      ...sourceBackedRefresh.snapshot,
      warnings: ["a different observable warning"],
    }),
  );
  await sourceBacked.close();

  const mutatingValidator = sessionOf(
    root,
    enrichment(),
    false,
    (snapshot) => {
      snapshot.edges.push({
        kind: "tests",
        from: snapshot.nodes[0]!.id,
        to: snapshot.nodes[0]!.id,
      });
    },
  );
  await rejects(mutatingValidator.refresh());
  TestValidator.equals(
    "a caller-supplied validator cannot rewrite the candidate it gates",
    [mutatingValidator.generation, mutatingValidator.current],
    [0, undefined],
  );
  await mutatingValidator.close();

  // Ordering the two validators is not enough on its own: a validator that
  // keeps its argument can wait until `refresh` has published the generation
  // and change `current` with no contract check left to run.
  let retained: IBulkGraphSession.ISnapshot | undefined;
  const retaining = sessionOf(root, enrichment(), false, (snapshot) => {
    retained = snapshot;
  });
  const published = await retaining.refresh();
  const held = retained!;
  TestValidator.equals(
    "a retained snapshot cannot be changed after its generation is published",
    [
      held === published.snapshot,
      throws(() =>
        held.edges.push({
          kind: "tests",
          from: held.nodes[0]!.id,
          to: held.nodes[0]!.id,
        }),
      ),
      throws(() => held.warnings.push("an unproven claim")),
      throws(() => held.provenance.capabilities.push("sourceDigests")),
      throws(() => {
        (held.provenance as { provider: string }).provider = "another-provider";
      }),
      // Not `held.sources.set(...)`: shadowing an instance method would only
      // block that spelling. The published manifest is not a `Map` at all, so
      // the prototype writers have no receiver they can operate on.
      throws(() =>
        (held.sources as Map<string, IBulkGraphSession.ISourceDigest>).set(
          "/unproven.go",
          { checkerDigest: "", diskDigest: "" },
        ),
      ),
      throws(() =>
        Map.prototype.set.call(held.sources, "/unproven.go", {
          checkerDigest: "",
          diskDigest: "",
        }),
      ),
      throws(() => Map.prototype.delete.call(held.sources, "/unproven.go")),
      throws(() => Map.prototype.clear.call(held.sources)),
      [...held.sources.keys()].length,
      [...held.sources.entries()].length,
      retaining.current === published.snapshot,
      retaining.current!.edges.length,
      retaining.current!.sources.size,
    ],
    [
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      published.snapshot.sources.size,
      published.snapshot.sources.size,
      true,
      published.snapshot.edges.length,
      published.snapshot.sources.size,
    ],
  );
  // A published manifest still has to read like the map it replaced.
  const manifest = new Map<string, IBulkGraphSession.ISourceDigest>();
  held.sources.forEach((digest, file, map) => {
    manifest.set(file, digest);
    if (map !== held.sources) throw new Error("the view leaked its backing map");
  });
  TestValidator.equals(
    "a sealed manifest still reads like the map it replaced",
    [
      manifest.size,
      [...held.sources].length,
      [...held.sources.values()].every(
        (digest) => Object.isFrozen(digest) && typeof digest.diskDigest === "string",
      ),
      held.sources.has([...held.sources.keys()][0]!),
      held.sources.get([...held.sources.keys()][0]!) !== undefined,
    ],
    [held.sources.size, held.sources.size, true, true, true],
  );
  await retaining.close();

  // The drift a resident build actually meets: one generation published, the
  // contract changed underneath it, the next refresh asked to publish another.
  // The whole point of failing closed is that the standing generation survives.
  const drifting = enrichment({
    enrich: ({ common }) => ({
      edges: [
        { kind: "calls", from: common.nodes[0]!.id, to: common.nodes[0]!.id },
      ],
    }),
  });
  const driftingSession = sessionOf(root, drifting);
  const standing = await driftingSession.refresh();
  (drifting as { version: number }).version = 99;
  fs.appendFileSync(source, "// force a drifted candidate\n");
  await rejects(driftingSession.refresh());
  TestValidator.equals(
    "a contract that drifted between refreshes cannot replace a generation",
    [
      driftingSession.generation,
      driftingSession.current,
      standing.snapshot.provenance.capabilities.includes(
        "scip-enrichment:go-calls@2",
      ),
    ],
    [1, standing.snapshot, true],
  );
  await driftingSession.close();

  let gatedBeforeTheContract = false;
  const malformed = sessionOf(
    root,
    enrichment({
      enrich: ({ common }) => ({
        edges: [
          {
            kind: "calls",
            from: common.nodes[0]!.id,
            to: common.nodes[0]!.id,
            evidence: {
              file: "main.go",
              startLine: 0,
              startCol: 0,
            },
          },
        ],
      }),
    }),
    false,
    () => {
      gatedBeforeTheContract = true;
    },
  );
  await rejects(malformed.refresh());
  // The seal makes a validator unable to change what it gates, so the ordering
  // of the two gates is no longer observable through a mutation. It is still
  // observable here: a candidate the mandatory contract refuses would never
  // reach a caller-supplied validator that ran second.
  TestValidator.equals(
    "a direct SCIP session validates enrichment before publication",
    [malformed.generation, malformed.current, gatedBeforeTheContract],
    [0, undefined, true],
  );
  await malformed.close();

  const providerProps: scipProvider.IProps = {
    name: "scip-enriched-fixture",
    authority: "semantic-index",
    languages: ["go"],
    resolve: () => ({ command: process.execPath, args: [] }),
    decode: () => ({
      command: process.execPath,
      args: [GraphPaths.fakeScipDecoder],
    }),
    indexArgs: (artifact) => [
      `--output=${artifact}`,
      `--root=${root}`,
    ],
    inputs: () => ["main.go"],
    languageOf: () => "go",
    enrichment: enrichment(),
  };
  const provider = scipProvider(providerProps);
  providerProps.name = "mutated-after-registration";
  providerProps.authority = "compiler";
  providerProps.decode = () => ({
    command: "missing-decoder-after-registration",
    args: [],
  });
  providerProps.indexArgs = () => [];
  providerProps.inputs = () => [];
  providerProps.languageOf = () => "rust";
  TestValidator.equals(
    "a registry entry captures identity and fact families at registration",
    [provider.name, provider.authority, provider.facts],
    [
      "scip-enriched-fixture",
      "semantic-index",
      ["contains", "references", "type_ref", "calls"],
    ],
  );
  const providerSession = provider.open({
      root,
      command: {
        command: process.execPath,
        args: [GraphPaths.fakeScipIndexer],
      },
      languages: ["go"],
      options: {},
    });
  const providerRefresh = await providerSession.refresh();
  TestValidator.equals(
    "an opened session cannot drift with mutable registration props",
    [
      providerRefresh.snapshot.provenance.provider,
      providerRefresh.snapshot.provenance.authority,
      providerRefresh.snapshot.languages,
    ],
    ["scip-enriched-fixture", "semantic-index", ["go"]],
  );
  await providerSession.close();

  // One build selects only the languages it asked for, so a registry entry that
  // owns several opens a session over a subset of them. The enrichment still
  // has to cover the whole entry, which is what made the two checks different.
  const sharedProvider = scipProvider({
    name: "scip-shared-fixture",
    languages: ["go", "rust"],
    resolve: () => ({ command: process.execPath, args: [] }),
    decode: () => ({
      command: process.execPath,
      args: [GraphPaths.fakeScipDecoder],
    }),
    indexArgs: (artifact) => [`--output=${artifact}`, `--root=${root}`],
    inputs: () => ["main.go"],
    languageOf: () => "go",
    enrichment: enrichment({ languages: ["go", "rust"] }),
  });
  const sharedSession = sharedProvider.open({
    root,
    command: {
      command: process.execPath,
      args: [GraphPaths.fakeScipIndexer],
    },
    languages: ["go"],
    options: {},
  });
  const sharedRefresh = await sharedSession.refresh();
  TestValidator.equals(
    "a session over one language of a shared entry publishes its enrichment",
    [
      sharedRefresh.snapshot.languages,
      sharedRefresh.snapshot.provenance.capabilities.includes(
        "scip-enrichment:go-calls@2",
      ),
      sharedProvider.facts,
    ],
    [["go"], true, ["contains", "references", "type_ref", "calls"]],
  );
  await sharedSession.close();

  const bareProvider = scipProvider({
    name: "scip-bare-fixture",
    languages: ["go"],
    resolve: () => ({ command: process.execPath, args: [] }),
    decode: () => ({ command: process.execPath, args: [] }),
    indexArgs: () => [],
    inputs: () => [],
    languageOf: () => "go",
  });
  TestValidator.equals(
    "a registry entry without enrichment retains only bare SCIP facts",
    bareProvider.facts,
    ["contains", "references", "type_ref"],
  );
  await bareProvider
    .open({
      root,
      command: { command: process.execPath, args: [] },
      languages: ["go"],
      options: {},
    })
    .close();
}

function apply(
  common: ReturnType<typeof commonSlice>,
  enrichment: ScipEnrichment.IContract,
): ScipEnrichment.IApplyResult {
  return ScipEnrichment.apply({
    enrichment,
    index: indexOf(),
    root: "/fixture",
    provider: "scip-fixture",
    languages: ["go"],
    common,
  });
}

function commonSlice() {
  return {
    nodes: [
      {
        id: "caller",
        kind: "function" as const,
        language: "go" as const,
        name: "caller",
        file: "src/main.go",
        external: false,
      },
      {
        id: "callee",
        kind: "function" as const,
        language: "go" as const,
        name: "callee",
        file: "src/main.go",
        external: false,
      },
    ],
    edges: [
      {
        kind: "references" as const,
        from: "caller",
        to: "callee",
      },
    ],
    diagnostics: [],
    warnings: [],
    files: ["src/main.go"],
  };
}

function indexOf() {
  return {
    metadata: { projectRoot: "/fixture" },
    documents: [],
  };
}

function enrichment(
  override: Partial<ScipEnrichment.IContract> = {},
): ScipEnrichment.IContract {
  return {
    name: "go-calls",
    version: 2,
    languages: ["go"],
    facts: ["calls"],
    enrich: () => ({ edges: [] }),
    ...override,
  };
}

function sessionOf(
  root: string,
  enrichment: ScipEnrichment.IContract,
  sourceText: boolean = false,
  validate?: ScipSession.IOptions["validate"],
): ScipSession {
  return new ScipSession({
    root,
    languages: ["go"],
    provider: "scip-enrichment-fixture",
    authority: "semantic-index",
    command: {
      command: process.execPath,
      args: [GraphPaths.fakeScipIndexer],
    },
    decode: {
      command: process.execPath,
      args: [GraphPaths.fakeScipDecoder],
    },
    indexArgs: (artifact) => [
      `--output=${artifact}`,
      `--root=${root}`,
      ...(sourceText ? ["--with-text"] : []),
    ],
    inputs: () => ["main.go"],
    languageOf: () => "go",
    enrichment,
    ...(sourceText ? { sourceText: true } : {}),
    ...(validate === undefined ? {} : { validate }),
  });
}

async function rejects(task: Promise<unknown>): Promise<void> {
  let failed = false;
  try {
    await task;
  } catch {
    failed = true;
  }
  TestValidator.predicate("the candidate rejects", failed);
}

function throws(task: () => unknown): boolean {
  try {
    task();
    return false;
  } catch {
    return true;
  }
}
