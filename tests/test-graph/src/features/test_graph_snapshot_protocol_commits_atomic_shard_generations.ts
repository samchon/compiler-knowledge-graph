import { TestValidator } from "@nestia/e2e";
import {
  GRAPH_EDGE_KINDS,
  GraphSnapshotProtocol,
  IBulkGraphSession,
  assertGraphSnapshotContract,
  graphCoverageOf,
  graphSnapshotDigests,
  graphUnresolvedOf,
} from "@samchon/graph";
import path from "node:path";

const digest = (letter: string): string => letter.repeat(64);

function sequenceOf(generation: string): number {
  const suffix = /-(\d+)$/u.exec(generation);
  return suffix === null ? 4 : Number(suffix[1]);
}

/**
 * Graph Snapshot Protocol publishes one validated complete generation or keeps
 * the prior one byte-for-byte. The fixture is an external producer oracle: all
 * digests are computed from the public protocol helpers, never copied from the
 * store under test.
 */
export const test_graph_snapshot_protocol_commits_atomic_shard_generations =
  async () => {
    const store = new GraphSnapshotProtocol.Store(process.cwd());
    const initialFrames = transaction("generation-1");
    const ndjson = initialFrames.map(JSON.stringify).join("\n");
    const parsed = GraphSnapshotProtocol.parse(ndjson);
    const initial = store.apply(parsed);
    const provider = {
      name: "fixture-compiler",
      authority: "compiler" as const,
      facts: ["calls" as const],
    };
    assertGraphSnapshotContract(
      initial,
      provider,
      ["typescript"],
      process.cwd(),
    );

    TestValidator.equals(
      "the committed generation reconstructs every protocol plane",
      [
        initial.protocol?.sequence,
        initial.protocol?.generation,
        initial.protocol?.manifest,
        initial.protocol?.shards.map((shard) => shard.key),
        initial.nodes.map((node) => node.name),
        initial.coverage?.length,
        initial.unresolved?.map((site) => site.reason),
      ],
      [
        1,
        "generation-1",
        digest("b"),
        ["coverage", "source"],
        ["run"],
        GRAPH_EDGE_KINDS.length,
        ["dynamic", "reflection"],
      ],
    );
    TestValidator.equals(
      "protocol-aware helpers preserve explicit coverage and uncertainty",
      [
        graphCoverageOf(initial).length,
        graphUnresolvedOf(initial).length,
        graphSnapshotDigests.contentOf(initial).length,
        GraphSnapshotProtocol.factDigest({
          languages: initial.languages,
          nodes: initial.nodes,
          edges: initial.edges,
          diagnostics: initial.diagnostics,
          provenance: initial.provenance,
        }).length,
      ],
      [GRAPH_EDGE_KINDS.length, 2, 64, 64],
    );
    for (const [label, expected, mutateSnapshot] of invalidProtocolSnapshots()) {
      let message = "";
      try {
        const candidate = cloneSnapshot(initial);
        mutateSnapshot(candidate);
        assertGraphSnapshotContract(
          candidate,
          provider,
          ["typescript"],
          process.cwd(),
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      TestValidator.predicate(
        `${label} fails at the protocol publication gate: ${message}`,
        message.includes(expected),
      );
    }
    TestValidator.error("a published generation is deeply immutable", () => {
      initial.nodes.push({ ...initial.nodes[0]! });
    });

    const editedFrames = transaction("generation-2", {
      baseGeneration: "generation-1",
      baseSequence: 1,
      nodeName: "edited",
    });
    const edited = store.apply(editedFrames);
    TestValidator.equals(
      "a delta reuses unchanged shards and replaces only its upsert",
      [
        edited.nodes.map((node) => node.name),
        edited.protocol?.baseSequence,
        edited.protocol?.baseGeneration,
        edited.protocol?.shards[0]?.digest ===
          initial.protocol?.shards[0]?.digest,
      ],
      [["edited"], 1, "generation-1", true],
    );

    const deleted = store.apply(
      transaction("generation-3", {
        baseGeneration: "generation-2",
        baseSequence: 2,
        deleteSource: true,
      }),
    );
    TestValidator.equals(
      "an explicit delete removes the shard without disturbing coverage",
      [deleted.nodes, deleted.coverage?.length],
      [[], GRAPH_EDGE_KINDS.length],
    );

    await rejectedWithoutMovement(
      store,
      transaction("stale", {
        sequence: 4,
        baseSequence: 1,
        baseGeneration: "generation-1",
      }),
      "a stale base",
    );
    await rejectedWithoutMovement(
      store,
      mutate(
        transaction("changed-identity", {
          baseGeneration: "generation-3",
          baseSequence: 3,
          coverageState: "complete",
        }),
        (frames) => {
          (frames[0] as GraphSnapshotProtocol.IHello).producer = "other";
        },
      ),
      "producer identity movement across a delta",
    );
    await rejectedWithoutMovement(
      store,
      transaction("missing-delete", {
        baseGeneration: "generation-3",
        baseSequence: 3,
        deleteSource: true,
      }),
      "deleting an absent shard",
    );
    const manifestWithoutDelta = mutate(
      transaction("manifest-without-delta", {
        baseGeneration: "generation-3",
        baseSequence: 3,
        deleteSource: true,
      }),
      (frames) => {
        (frames[1] as GraphSnapshotProtocol.IBegin).manifest = digest("d");
        frames.splice(2, 2);
      },
    );
    await rejectedWithoutMovement(
      store,
      manifestWithoutDelta,
      "manifest movement without a shard delta",
    );
    await rejectedWithoutMovement(
      store,
      transaction("generation-3", { sequence: 3 }),
      "a non-advancing generation sequence",
    );
    await rejectedWithoutMovement(
      store,
      mutate(
        transaction("moved-universe", {
          baseGeneration: "generation-3",
          baseSequence: 3,
          coverageState: "complete",
        }),
        (frames) => {
          (frames[1] as GraphSnapshotProtocol.IBegin).universe = digest("d");
        },
      ),
      "universe movement retaining an untouched shard",
    );
    await rejectedWithoutMovement(
      store,
      mutate(
        transaction("moved-target", {
          baseGeneration: "generation-3",
          baseSequence: 3,
          coverageState: "complete",
        }),
        (frames) => {
          (frames[1] as GraphSnapshotProtocol.IBegin).targets.push("other");
        },
      ),
      "target movement retaining an untouched shard",
    );
    await rejectedWithoutMovement(
      store,
      mutate(
        transaction("bad-shard", {
          baseGeneration: "generation-3",
          baseSequence: 3,
          coverageState: "complete",
        }),
        (frames) => {
          upsert(frames, "source").digest = digest("f");
        },
      ),
      "a shard digest mismatch",
    );
    await rejectedWithoutMovement(
      store,
      mutate(
        transaction("bad-facts", {
          baseGeneration: "generation-3",
          baseSequence: 3,
          coverageState: "complete",
        }),
        (frames) => {
          commit(frames).factDigest = digest("f");
        },
      ),
      "a fact digest mismatch",
    );
    await rejectedWithoutMovement(
      store,
      mutate(
        transaction("bad-manifest", {
          baseGeneration: "generation-3",
          baseSequence: 3,
          coverageState: "complete",
        }),
        (frames) => {
          commit(frames).shards.reverse();
        },
      ),
      "a non-canonical manifest",
    );
    await rejectedWithoutMovement(
      store,
      mutate(transaction("missing-coverage"), (frames) => {
        coverageShard(frames).shard.coverage.pop();
        refreshDigests(frames);
      }),
      "a missing coverage family",
    );
    await rejectedWithoutMovement(
      store,
      mutate(transaction("wrong-owner"), (frames) => {
        coverageShard(frames).shard.coverage[0]!.provider = "other";
        refreshDigests(frames);
      }),
      "foreign coverage ownership",
    );
    await rejectedWithoutMovement(
      store,
      mutate(transaction("wrong-uncertainty"), (frames) => {
        coverageShard(frames).shard.coverage.find(
          (row) => row.family === "calls",
        )!.state = "complete";
        refreshDigests(frames);
      }),
      "an unresolved site without partial coverage",
    );
    await rejectedWithoutMovement(
      store,
      mutate(transaction("missing-uncertainty"), (frames) => {
        coverageShard(frames).shard.unresolved = [];
        refreshDigests(frames);
      }),
      "partial coverage without unresolved evidence",
    );
    await rejectedWithoutMovement(
      store,
      mutate(transaction("wrong-universe"), (frames) => {
        coverageShard(frames).shard.unresolved[0]!.universe = digest("d");
        refreshDigests(frames);
      }),
      "an unresolved site from another universe",
    );

    const aborted = new AbortController();
    aborted.abort();
    await rejectedWithoutMovement(
      store,
      transaction("aborted"),
      "an aborted transaction",
      aborted.signal,
    );
    TestValidator.error("an empty stream is rejected", () =>
      GraphSnapshotProtocol.parse(""),
    );
    TestValidator.error("a blank NDJSON frame is rejected", () =>
      GraphSnapshotProtocol.parse("{}\n"),
    );
    TestValidator.error("malformed NDJSON is rejected", () =>
      GraphSnapshotProtocol.parse("{"),
    );

    for (const [label, frames] of malformedTransactions()) {
      await rejectedWithoutMovement(store, frames, label);
    }

    const manifestStore = new GraphSnapshotProtocol.Store(process.cwd());
    manifestStore.apply(transaction("manifest-generation-1"));
    const manifestEdit = mutate(
      transaction("manifest-generation-2", {
        baseGeneration: "manifest-generation-1",
        baseSequence: 1,
        nodeName: "manifest-edited",
      }),
      (frames) => {
        (frames[1] as GraphSnapshotProtocol.IBegin).manifest = digest("d");
      },
    );
    TestValidator.equals(
      "manifest movement commits when a shard delta carries the affected facts",
      manifestStore.apply(manifestEdit).nodes.map((node) => node.name),
      ["manifest-edited"],
    );
    const replayedManifestShard = mutate(
      transaction("manifest-generation-3", {
        baseGeneration: "manifest-generation-2",
        baseSequence: 2,
        nodeName: "manifest-edited",
      }),
      (frames) => {
        (frames[1] as GraphSnapshotProtocol.IBegin).manifest = digest("e");
      },
    );
    await rejectedWithoutMovement(
      manifestStore,
      replayedManifestShard,
      "manifest movement disguised as a byte-identical shard upsert",
    );
    const replayedUniverseShard = mutate(
      transaction("manifest-generation-3", {
        baseGeneration: "manifest-generation-2",
        baseSequence: 2,
        nodeName: "manifest-edited",
      }),
      (frames) => {
        (frames[1] as GraphSnapshotProtocol.IBegin).universe = digest("d");
      },
    );
    await rejectedWithoutMovement(
      manifestStore,
      replayedUniverseShard,
      "universe movement disguised as a byte-identical shard upsert",
    );

    const boundedGenerationStore = new GraphSnapshotProtocol.Store(process.cwd());
    boundedGenerationStore.apply(transaction("bounded-generation-1"));
    boundedGenerationStore.apply(
      transaction("bounded-generation-2", {
        baseGeneration: "bounded-generation-1",
        baseSequence: 1,
        nodeName: "second",
      }),
    );
    const returnedToken = boundedGenerationStore.apply(
      transaction("bounded-generation-1", {
        sequence: 3,
        baseGeneration: "bounded-generation-2",
        baseSequence: 2,
        nodeName: "third",
      }),
    );
    TestValidator.equals(
      "a bounded generation pair can reuse an old spelling without retaining token history",
      [returnedToken.protocol?.sequence, returnedToken.protocol?.generation],
      [3, "bounded-generation-1"],
    );
    await rejectedWithoutMovement(
      boundedGenerationStore,
      transaction("stale-after-aba", {
        sequence: 2,
        baseGeneration: "bounded-generation-1",
        baseSequence: 1,
        nodeName: "stale",
      }),
      "an obsolete sequence cannot exploit a repeated generation spelling",
    );

    const deleteStore = new GraphSnapshotProtocol.Store(process.cwd());
    deleteStore.apply(transaction("delete-generation-1"));
    const duplicateDelete = transaction("delete-generation-2", {
      baseGeneration: "delete-generation-1",
      baseSequence: 1,
      deleteSource: true,
    });
    const deleteFrame = duplicateDelete.find(
      (frame): frame is GraphSnapshotProtocol.IDeleteShard =>
        frame.type === "deleteShard",
    )!;
    duplicateDelete.splice(
      -1,
      0,
      structuredClone(deleteFrame),
    );
    await rejectedWithoutMovement(
      deleteStore,
      duplicateDelete,
      "a duplicate delete delta",
    );

    const bundledStore = new GraphSnapshotProtocol.Store(process.cwd());
    const bundledFrames = mutate(
      transaction("bundled-generation"),
      (frames) => {
        const shard = upsert(frames, "source").shard;
        const file = "bundled:///typescript/lib.d.ts";
        Object.assign(shard.nodes[0]!, {
          id: file,
          kind: "file",
          name: "lib.d.ts",
          file,
          external: true,
        });
        shard.sources[0]!.file = file;
        for (const site of coverageShard(frames).shard.unresolved) {
          site.evidence.file = file;
          if (site.candidates !== undefined) site.candidates = [file];
        }
        refreshDigests(frames);
      },
    );
    TestValidator.equals(
      "a canonical bundled source identity commits",
      [...bundledStore.apply(bundledFrames).sources.keys()],
      ["bundled:///typescript/lib.d.ts"],
    );
  };

interface ITransactionOptions {
  sequence?: number;
  baseSequence?: number;
  baseGeneration?: string;
  coverageState?: "complete" | "partial";
  nodeName?: string;
  deleteSource?: boolean;
}

function transaction(
  generation: string,
  options: ITransactionOptions = {},
): GraphSnapshotProtocol.Frame[] {
  const hello = validHello();
  const begin: GraphSnapshotProtocol.IBegin = {
    type: "begin",
    sequence: options.sequence ?? sequenceOf(generation),
    generation,
    ...(options.baseGeneration !== undefined
      ? {
          baseSequence:
            options.baseSequence ?? sequenceOf(options.baseGeneration),
          baseGeneration: options.baseGeneration,
        }
      : {}),
    universe: digest("a"),
    manifest: digest("b"),
    targets: ["app"],
  };
  const coverage: GraphSnapshotProtocol.IShard = {
    key: "coverage",
    target: "app",
    languages: ["typescript"],
    nodes: [],
    edges: [],
    diagnostics: [],
    coverage: GRAPH_EDGE_KINDS.map((family) => ({
      provider: hello.provider,
      language: "typescript",
      target: "app",
      family,
      state:
        family === "calls"
          ? options.coverageState ??
            (options.deleteSource === true ? "complete" : "partial")
          : "unsupported",
    })),
    unresolved:
      (options.coverageState ??
        (options.deleteSource === true ? "complete" : "partial")) ===
      "complete"
        ? []
        : [
            {
              provider: hello.provider,
              language: "typescript",
              target: "app",
              universe: begin.universe,
              family: "calls",
              evidence: { file: "src/main.ts", startLine: 1, startCol: 1 },
              reason: "dynamic",
              candidates: ["src/main.ts#target:function"],
            },
            {
              provider: hello.provider,
              language: "typescript",
              target: "app",
              universe: begin.universe,
              family: "calls",
              evidence: { file: "src/main.ts", startLine: 2, startCol: 1 },
              reason: "reflection",
            },
          ],
    sources: [],
  };
  const source: GraphSnapshotProtocol.IShard = {
    key: "source",
    target: "app",
    languages: ["typescript"],
    nodes: [
      {
        id: "src/main.ts#run:function",
        kind: "function",
        language: "typescript",
        name: options.nodeName ?? "run",
        file: "src/main.ts",
        external: false,
      },
    ],
    edges: [],
    diagnostics: [],
    coverage: [],
    unresolved: [],
    sources: [
      {
        file: path.resolve("src/main.ts"),
        checkerDigest: digest("c"),
        diskDigest: digest("c"),
      },
    ],
  };
  const upserts: GraphSnapshotProtocol.IUpsertShard[] =
    options.baseGeneration === undefined
      ? [upsertOf(coverage), ...(options.deleteSource === true ? [] : [upsertOf(source)])]
      : options.deleteSource === true
        ? [upsertOf(coverage)]
        : [upsertOf(source)];
  const middle: GraphSnapshotProtocol.Frame[] = [
    ...upserts,
    ...(options.deleteSource === true
      ? [{ type: "deleteShard" as const, key: "source" }]
      : []),
  ];
  const retained = new Map<string, GraphSnapshotProtocol.IShard>();
  retained.set("coverage", coverage);
  if (options.deleteSource !== true) retained.set("source", source);
  const manifest = [...retained]
    .sort(([left], [right]) => Number(left > right) - Number(left < right))
    .map(([key, shard]) => ({
      key,
      digest: GraphSnapshotProtocol.shardDigest(shard),
    }));
  const snapshot = snapshotOf(hello, begin, [...retained.values()]);
  return [
    hello,
    begin,
    ...middle,
    {
      type: "commit",
      sequence: begin.sequence,
      generation,
      shards: manifest,
      factDigest: GraphSnapshotProtocol.factDigest(snapshot),
    },
  ];
}

function snapshotOf(
  hello: GraphSnapshotProtocol.IHello,
  begin: GraphSnapshotProtocol.IBegin,
  shards: readonly GraphSnapshotProtocol.IShard[],
): Pick<
  IBulkGraphSession.ISnapshot,
  | "languages"
  | "nodes"
  | "edges"
  | "diagnostics"
  | "coverage"
  | "unresolved"
  | "provenance"
> {
  return {
    languages: [...hello.languages],
    nodes: shards.flatMap((shard) => shard.nodes),
    edges: shards.flatMap((shard) => shard.edges),
    diagnostics: shards.flatMap((shard) => shard.diagnostics),
    coverage: shards.flatMap((shard) => shard.coverage),
    unresolved: shards.flatMap((shard) => shard.unresolved),
    provenance: {
      provider: hello.provider,
      authority: hello.authority,
      facts: [...hello.supportedFacts],
      schemaVersion: hello.schemaVersion,
      tool: hello.producer,
      toolVersion: hello.producerVersion,
      compilerVersion: hello.compilerVersion,
      protocolVersion: hello.protocolVersion,
      universe: begin.universe,
      capabilities: [...hello.capabilities],
    },
  };
}

function validHello(): GraphSnapshotProtocol.IHello {
  return {
    type: "hello",
    protocolVersion: 1,
    schemaVersion: GraphSnapshotProtocol.SCHEMA_VERSION,
    provider: "fixture-compiler",
    producer: "fixture-exporter",
    producerVersion: "1.0.0",
    compilerVersion: "fixture-1",
    languages: ["typescript"],
    authority: "compiler",
    supportedFacts: ["calls"],
    capabilities: [
      "universe",
      "sourceDigests",
      "diskDigests",
      "shards",
      "deltas",
    ],
  };
}

function upsertOf(
  shard: GraphSnapshotProtocol.IShard,
): GraphSnapshotProtocol.IUpsertShard {
  return {
    type: "upsertShard",
    digest: GraphSnapshotProtocol.shardDigest(shard),
    shard,
  };
}

function mutate(
  frames: GraphSnapshotProtocol.Frame[],
  operation: (frames: GraphSnapshotProtocol.Frame[]) => void,
): GraphSnapshotProtocol.Frame[] {
  const cloned = structuredClone(frames);
  operation(cloned);
  return cloned;
}

function refreshDigests(frames: GraphSnapshotProtocol.Frame[]): void {
  const hello = frames[0] as GraphSnapshotProtocol.IHello;
  const begin = frames[1] as GraphSnapshotProtocol.IBegin;
  const shards = frames
    .filter(
      (frame): frame is GraphSnapshotProtocol.IUpsertShard =>
        frame.type === "upsertShard",
    )
    .map((frame) => {
      frame.digest = GraphSnapshotProtocol.shardDigest(frame.shard);
      return frame.shard;
    });
  const last = commit(frames);
  last.shards = shards
    .map((shard) => ({
      key: shard.key,
      digest: GraphSnapshotProtocol.shardDigest(shard),
    }))
    .sort((left, right) => Number(left.key > right.key) - Number(left.key < right.key));
  last.factDigest = GraphSnapshotProtocol.factDigest(
    snapshotOf(hello, begin, shards),
  );
}

function commit(
  frames: GraphSnapshotProtocol.Frame[],
): GraphSnapshotProtocol.ICommit {
  return frames.at(-1) as GraphSnapshotProtocol.ICommit;
}

function coverageShard(
  frames: GraphSnapshotProtocol.Frame[],
): GraphSnapshotProtocol.IUpsertShard {
  return upsert(frames, "coverage");
}

function upsert(
  frames: GraphSnapshotProtocol.Frame[],
  key: string,
): GraphSnapshotProtocol.IUpsertShard {
  return frames.find(
    (frame): frame is GraphSnapshotProtocol.IUpsertShard =>
      frame.type === "upsertShard" && frame.shard.key === key,
  )!;
}

function malformedTransactions(): Array<
  [string, GraphSnapshotProtocol.Frame[]]
> {
  const valid = transaction("malformed");
  return [
    ["an incomplete transaction", valid.slice(0, 2)],
    [
      "a transaction not starting with hello",
      [{ type: "deleteShard", key: "x" }, ...valid.slice(1)],
    ],
    [
      "a transaction without begin second",
      [valid[0]!, { type: "deleteShard", key: "x" }, ...valid.slice(2)],
    ],
    [
      "a transaction not ending in commit",
      [...valid.slice(0, -1), { type: "deleteShard", key: "x" }],
    ],
    [
      "an unknown protocol version",
      mutate(valid, (frames) => {
        record(frames[0]!).protocolVersion = 2;
      }),
    ],
    [
      "an unknown schema version",
      mutate(valid, (frames) => {
        record(frames[0]!).schemaVersion = 2;
      }),
    ],
    [
      "duplicate hello languages",
      mutate(valid, (frames) => {
        record(frames[0]!).languages = ["typescript", "typescript"];
      }),
    ],
    [
      "an empty hello language set",
      mutate(valid, (frames) => {
        record(frames[0]!).languages = [];
      }),
    ],
    [
      "an unknown hello language",
      mutate(valid, (frames) => {
        record(frames[0]!).languages = ["future-language"];
      }),
    ],
    [
      "duplicate advertised facts",
      mutate(valid, (frames) => {
        record(frames[0]!).supportedFacts = ["calls", "calls"];
      }),
    ],
    [
      "an unknown advertised fact",
      mutate(valid, (frames) => {
        record(frames[0]!).supportedFacts = ["future-fact"];
      }),
    ],
    [
      "an unknown provider authority",
      mutate(valid, (frames) => {
        record(frames[0]!).authority = "future-authority";
      }),
    ],
    [
      "duplicate advertised capabilities",
      mutate(valid, (frames) => {
        record(frames[0]!).capabilities = ["universe", "universe"];
      }),
    ],
    [
      "an empty advertised capability",
      mutate(valid, (frames) => {
        record(frames[0]!).capabilities = ["universe", ""];
      }),
    ],
    [
      "an empty provider identity",
      mutate(valid, (frames) => {
        record(frames[0]!).provider = "";
      }),
    ],
    [
      "a NUL producer identity",
      mutate(valid, (frames) => {
        record(frames[0]!).producer = "bad\0producer";
      }),
    ],
    [
      "a fractional begin sequence",
      mutate(valid, (frames) => {
        record(frames[1]!).sequence = 1.5;
        record(commit(frames)).sequence = 1.5;
      }),
    ],
    [
      "a non-positive begin sequence",
      mutate(valid, (frames) => {
        record(frames[1]!).sequence = 0;
        record(commit(frames)).sequence = 0;
      }),
    ],
    [
      "a base generation without its sequence",
      mutate(valid, (frames) => {
        record(frames[1]!).baseGeneration = "base";
      }),
    ],
    [
      "a base sequence without its generation",
      mutate(valid, (frames) => {
        record(frames[1]!).baseSequence = 3;
      }),
    ],
    [
      "a fractional base sequence",
      mutate(valid, (frames) => {
        record(frames[1]!).baseSequence = 1.5;
        record(frames[1]!).baseGeneration = "base";
      }),
    ],
    [
      "a non-positive base sequence",
      mutate(valid, (frames) => {
        record(frames[1]!).baseSequence = 0;
        record(frames[1]!).baseGeneration = "base";
      }),
    ],
    [
      "a base sequence not older than its generation",
      mutate(valid, (frames) => {
        record(frames[1]!).baseSequence = 4;
        record(frames[1]!).baseGeneration = "base";
      }),
    ],
    [
      "a NUL base generation",
      mutate(valid, (frames) => {
        record(frames[1]!).baseSequence = 3;
        record(frames[1]!).baseGeneration = "bad\0base";
      }),
    ],
    [
      "an empty base generation",
      mutate(valid, (frames) => {
        record(frames[1]!).baseSequence = 3;
        record(frames[1]!).baseGeneration = "";
      }),
    ],
    [
      "a malformed universe digest",
      mutate(valid, (frames) => {
        record(frames[1]!).universe = "bad";
      }),
    ],
    [
      "a malformed manifest digest",
      mutate(valid, (frames) => {
        record(frames[1]!).manifest = "bad";
      }),
    ],
    [
      "duplicate targets",
      mutate(valid, (frames) => {
        record(frames[1]!).targets = ["app", "app"];
      }),
    ],
    [
      "an empty target set",
      mutate(valid, (frames) => {
        record(frames[1]!).targets = [];
      }),
    ],
    [
      "an empty target identity",
      mutate(valid, (frames) => {
        record(frames[1]!).targets = [""];
      }),
    ],
    [
      "a mismatched commit sequence",
      mutate(valid, (frames) => {
        commit(frames).sequence += 1;
      }),
    ],
    [
      "a mismatched commit generation",
      mutate(valid, (frames) => {
        commit(frames).generation = "other";
      }),
    ],
    [
      "an unknown target",
      mutate(valid, (frames) => {
        coverageShard(frames).shard.target = "other";
        refreshDigests(frames);
      }),
    ],
    [
      "an empty shard language set",
      mutate(valid, (frames) => {
        coverageShard(frames).shard.languages = [];
        refreshDigests(frames);
      }),
    ],
    [
      "a foreign shard language",
      mutate(valid, (frames) => {
        record(coverageShard(frames).shard).languages = ["go"];
        refreshDigests(frames);
      }),
    ],
    [
      "a duplicated node inside one shard",
      mutate(valid, (frames) => {
        const shard = upsert(frames, "source").shard;
        shard.nodes.push(structuredClone(shard.nodes[0]!));
        refreshDigests(frames);
      }),
    ],
    [
      "a foreign-language node",
      mutate(valid, (frames) => {
        record(upsert(frames, "source").shard.nodes[0]!).language = "go";
        refreshDigests(frames);
      }),
    ],
    [
      "an empty node display name",
      mutate(valid, (frames) => {
        upsert(frames, "source").shard.nodes[0]!.name = "";
        refreshDigests(frames);
      }),
    ],
    [
      "an invalid node evidence span",
      mutate(valid, (frames) => {
        upsert(frames, "source").shard.nodes[0]!.evidence = {
          startLine: 0,
        };
        refreshDigests(frames);
      }),
    ],
    [
      "node evidence absent from the source manifest",
      mutate(valid, (frames) => {
        upsert(frames, "source").shard.nodes[0]!.evidence = {
          file: "src/missing.ts",
          startLine: 1,
        };
        refreshDigests(frames);
      }),
    ],
    [
      "an edge from an unadvertised family",
      mutate(valid, (frames) => {
        const shard = upsert(frames, "source").shard;
        shard.edges.push({
          kind: "type_ref",
          from: shard.nodes[0]!.id,
          to: shard.nodes[0]!.id,
        });
        refreshDigests(frames);
      }),
    ],
    [
      "an unknown edge family",
      mutate(valid, (frames) => {
        const shard = upsert(frames, "source").shard;
        shard.edges.push({
          kind: "calls",
          from: shard.nodes[0]!.id,
          to: shard.nodes[0]!.id,
        });
        record(shard.edges[0]!).kind = "future-fact";
        refreshDigests(frames);
      }),
    ],
    [
      "a duplicated edge inside one shard",
      mutate(valid, (frames) => {
        const shard = upsert(frames, "source").shard;
        const edge = {
          kind: "calls" as const,
          from: shard.nodes[0]!.id,
          to: shard.nodes[0]!.id,
        };
        shard.edges.push(edge, { ...edge });
        refreshDigests(frames);
      }),
    ],
    [
      "a duplicated source inside one shard",
      mutate(valid, (frames) => {
        const shard = upsert(frames, "source").shard;
        shard.sources.push({ ...shard.sources[0]! });
        refreshDigests(frames);
      }),
    ],
    [
      "a malformed source digest",
      mutate(valid, (frames) => {
        upsert(frames, "source").shard.sources[0]!.checkerDigest = "bad";
        refreshDigests(frames);
      }),
    ],
    [
      "a relative source identity",
      mutate(valid, (frames) => {
        upsert(frames, "source").shard.sources[0]!.file = "src/main.ts";
        refreshDigests(frames);
      }),
    ],
    [
      "a non-canonical bundled source identity",
      mutate(valid, (frames) => {
        upsert(frames, "source").shard.sources[0]!.file =
          "bundled:///typescript/../lib";
        refreshDigests(frames);
      }),
    ],
    [
      "shards disagreeing about source bytes",
      mutate(valid, (frames) => {
        coverageShard(frames).shard.sources.push({
          file: path.resolve("src/main.ts"),
          checkerDigest: digest("d"),
          diskDigest: digest("d"),
        });
        refreshDigests(frames);
      }),
    ],
    [
      "shards disagreeing only about disk bytes",
      mutate(valid, (frames) => {
        coverageShard(frames).shard.sources.push({
          file: path.resolve("src/main.ts"),
          checkerDigest: digest("c"),
          diskDigest: digest("d"),
        });
        refreshDigests(frames);
      }),
    ],
    [
      "duplicate coverage rows",
      mutate(valid, (frames) => {
        const shard = coverageShard(frames).shard;
        shard.coverage.push({ ...shard.coverage[0]! });
        refreshDigests(frames);
      }),
    ],
    [
      "an unknown coverage family",
      mutate(valid, (frames) => {
        record(coverageShard(frames).shard.coverage[0]!).family =
          "future-fact";
        refreshDigests(frames);
      }),
    ],
    [
      "an unknown coverage state",
      mutate(valid, (frames) => {
        record(coverageShard(frames).shard.coverage[0]!).state = "unknown";
        refreshDigests(frames);
      }),
    ],
    [
      "an unadvertised partial family",
      mutate(valid, (frames) => {
        coverageShard(frames).shard.coverage.find(
          (row) => row.family === "contains",
        )!.state = "partial";
        refreshDigests(frames);
      }),
    ],
    [
      "duplicate unresolved sites",
      mutate(valid, (frames) => {
        const shard = coverageShard(frames).shard;
        shard.unresolved.push(structuredClone(shard.unresolved[0]!));
        refreshDigests(frames);
      }),
    ],
    [
      "an unknown unresolved reason",
      mutate(valid, (frames) => {
        record(coverageShard(frames).shard.unresolved[0]!).reason = "unknown";
        refreshDigests(frames);
      }),
    ],
    [
      "duplicate unresolved candidates",
      mutate(valid, (frames) => {
        coverageShard(frames).shard.unresolved[0]!.candidates = [
          "candidate",
          "candidate",
        ];
        refreshDigests(frames);
      }),
    ],
    [
      "a node duplicated across shards",
      mutate(valid, (frames) => {
        coverageShard(frames).shard.nodes.push(
          structuredClone(upsert(frames, "source").shard.nodes[0]!),
        );
        refreshDigests(frames);
      }),
    ],
    [
      "an edge duplicated across shards",
      mutate(valid, (frames) => {
        const source = upsert(frames, "source").shard;
        const edge = {
          kind: "calls" as const,
          from: source.nodes[0]!.id,
          to: source.nodes[0]!.id,
        };
        source.edges.push(edge);
        coverageShard(frames).shard.edges.push({ ...edge });
        refreshDigests(frames);
      }),
    ],
    [
      "an edge with an absent endpoint",
      mutate(valid, (frames) => {
        const source = upsert(frames, "source").shard;
        source.edges.push({
          kind: "calls",
          from: source.nodes[0]!.id,
          to: "missing",
        });
        refreshDigests(frames);
      }),
    ],
    [
      "an edge with an absent source endpoint",
      mutate(valid, (frames) => {
        const source = upsert(frames, "source").shard;
        source.edges.push({
          kind: "calls",
          from: "missing",
          to: source.nodes[0]!.id,
        });
        refreshDigests(frames);
      }),
    ],
    [
      "a duplicate shard delta",
      mutate(valid, (frames) => {
        frames.splice(3, 0, structuredClone(frames[2]!));
      }),
    ],
    [
      "an unexpected middle frame",
      mutate(valid, (frames) => {
        frames.splice(2, 0, structuredClone(frames[0]!));
      }),
    ],
  ];
}

function cloneSnapshot(
  snapshot: IBulkGraphSession.ISnapshot,
): IBulkGraphSession.ISnapshot {
  const {
    sources: _sources,
    ...plain
  } = snapshot;
  return {
    ...structuredClone(plain),
    sources: new Map(
      [...snapshot.sources].map(([file, value]) => [file, { ...value }]),
    ),
  };
}

function invalidProtocolSnapshots(): Array<
  [string, string, (snapshot: IBulkGraphSession.ISnapshot) => void]
> {
  return [
    [
      "an unknown committed protocol version",
      "invalid protocol generation",
      (snapshot) => {
        snapshot.protocol!.version = 2;
      },
    ],
    [
      "an empty committed generation",
      "invalid protocol generation",
      (snapshot) => {
        snapshot.protocol!.generation = "";
      },
    ],
    [
      "an empty committed target set",
      "invalid protocol generation",
      (snapshot) => {
        snapshot.protocol!.targets = [];
      },
    ],
    [
      "duplicate committed targets",
      "invalid protocol generation",
      (snapshot) => {
        snapshot.protocol!.targets.push(snapshot.protocol!.targets[0]!);
      },
    ],
    [
      "a malformed committed manifest digest",
      "invalid protocol generation",
      (snapshot) => {
        snapshot.protocol!.manifest = "bad";
      },
    ],
    [
      "a malformed committed fact digest",
      "invalid protocol generation",
      (snapshot) => {
        snapshot.protocol!.factDigest = "bad";
      },
    ],
    [
      "missing committed coverage",
      "invalid protocol generation",
      (snapshot) => {
        snapshot.coverage = undefined;
        snapshot.unresolved = [];
      },
    ],
    [
      "missing committed uncertainty",
      "invalid protocol generation",
      (snapshot) => {
        snapshot.unresolved = undefined;
      },
    ],
    [
      "unresolved evidence absent from the source manifest",
      "without binding that file to its source manifest",
      (snapshot) => {
        snapshot.unresolved![0]!.evidence.file = "src/missing.ts";
      },
    ],
    [
      "a NUL-delimited committed source identity",
      "source identity that is not normalized and absolute",
      (snapshot) => {
        snapshot.sources = new Map(
          [...snapshot.sources].map(([file, value]) => [
            `${file}\0other`,
            value,
          ]),
        );
      },
    ],
    [
      "a fractional protocol generation sequence",
      "invalid protocol generation",
      (snapshot) => {
        snapshot.protocol!.sequence = 1.5;
      },
    ],
    [
      "a non-positive protocol generation sequence",
      "invalid protocol generation",
      (snapshot) => {
        snapshot.protocol!.sequence = 0;
      },
    ],
    [
      "a fractional protocol base sequence",
      "invalid protocol generation",
      (snapshot) => {
        Object.assign(snapshot.protocol!, {
          sequence: 2,
          baseSequence: 1.5,
          baseGeneration: "base",
        });
      },
    ],
    [
      "a non-positive protocol base sequence",
      "invalid protocol generation",
      (snapshot) => {
        Object.assign(snapshot.protocol!, {
          sequence: 2,
          baseSequence: 0,
          baseGeneration: "base",
        });
      },
    ],
    [
      "a protocol base sequence not older than its generation",
      "invalid protocol generation",
      (snapshot) => {
        Object.assign(snapshot.protocol!, {
          sequence: 2,
          baseSequence: 2,
          baseGeneration: "base",
        });
      },
    ],
    [
      "a non-string protocol base generation",
      "invalid protocol generation",
      (snapshot) => {
        Object.assign(snapshot.protocol!, {
          sequence: 2,
          baseSequence: 1,
          baseGeneration: 1,
        });
      },
    ],
    [
      "an empty protocol base generation",
      "invalid protocol generation",
      (snapshot) => {
        Object.assign(snapshot.protocol!, {
          sequence: 2,
          baseSequence: 1,
          baseGeneration: "",
        });
      },
    ],
    [
      "a NUL protocol base generation",
      "invalid protocol generation",
      (snapshot) => {
        Object.assign(snapshot.protocol!, {
          sequence: 2,
          baseSequence: 1,
          baseGeneration: "bad\0base",
        });
      },
    ],
    [
      "a protocol base token without its sequence",
      "invalid protocol generation",
      (snapshot) => {
        snapshot.protocol!.baseGeneration = "orphan";
      },
    ],
    [
      "a non-string protocol generation",
      "invalid protocol generation",
      (snapshot) => {
        record(snapshot.protocol!).generation = 1;
      },
    ],
    [
      "a NUL protocol generation",
      "invalid protocol generation",
      (snapshot) => {
        snapshot.protocol!.generation = "bad\0generation";
      },
    ],
    [
      "a non-string protocol target",
      "invalid protocol generation",
      (snapshot) => {
        record(snapshot.protocol!).targets = [1];
      },
    ],
    [
      "an empty protocol target",
      "invalid protocol generation",
      (snapshot) => {
        snapshot.protocol!.targets[0] = "";
      },
    ],
    [
      "a NUL protocol target",
      "invalid protocol generation",
      (snapshot) => {
        snapshot.protocol!.targets[0] = "bad\0target";
      },
    ],
    [
      "an empty committed shard key",
      "invalid protocol shard manifest",
      (snapshot) => {
        snapshot.protocol!.shards[0]!.key = "";
      },
    ],
    [
      "a NUL committed shard key",
      "invalid protocol shard manifest",
      (snapshot) => {
        snapshot.protocol!.shards[0]!.key = "bad\0key";
      },
    ],
    [
      "duplicate committed shard keys",
      "invalid protocol shard manifest",
      (snapshot) => {
        snapshot.protocol!.shards[1]!.key =
          snapshot.protocol!.shards[0]!.key;
      },
    ],
    [
      "a malformed committed shard digest",
      "invalid protocol shard manifest",
      (snapshot) => {
        snapshot.protocol!.shards[0]!.digest = "bad";
      },
    ],
    [
      "a mismatched committed fact digest",
      "mismatched protocol fact digest",
      (snapshot) => {
        snapshot.protocol!.factDigest = digest("f");
      },
    ],
  ];
}

async function rejectedWithoutMovement(
  store: GraphSnapshotProtocol.Store,
  frames: readonly GraphSnapshotProtocol.Frame[],
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  const before = store.current;
  await TestValidator.error(`${label} rejects`, () =>
    store.apply(frames, { signal }),
  );
  TestValidator.predicate(`${label} retains the prior generation`, store.current === before);
}

function record(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}
