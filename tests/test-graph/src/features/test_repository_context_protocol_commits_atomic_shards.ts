import { TestValidator } from "@nestia/e2e";
import {
  RepositoryContextProtocol,
  repositoryContextFacts,
} from "@samchon/graph";

const { repositoryContextCoverage, repositoryContextId } =
  repositoryContextFacts;

/**
 * The repository plane is a second protocol with the same atomicity promise as
 * the code one, and nothing in the code protocol's tests reaches it. This pins
 * the boundary that keeps the two planes from drifting apart: a published
 * topology generation is frozen, a delta must extend exactly the current
 * generation, coverage stays exhaustive over every relation family, `joins-file`
 * is the one relation whose target is a file rather than a node, and version 1
 * refuses `inferred` authority outright rather than publishing a guessed build
 * fact beside a tool-resolved one.
 */
export const test_repository_context_protocol_commits_atomic_shards =
  async () => {
    const store = new RepositoryContextProtocol.Store();
    const initialFrames = transaction(1);
    const initial = store.apply(initialFrames);
    TestValidator.equals(
      "the initial repository context generation is complete",
      [
        initial.generation.sequence,
        initial.nodes.map((node) => node.kind),
        initial.edges.map((edge) => edge.kind),
        initial.coverage.length,
        initial.files,
        initial.sources,
      ],
      [
        1,
        ["workspace", "source-root"],
        ["contains", "joins-file"],
        RepositoryContextProtocol.RELATION_KINDS.length,
        ["src/main.ts"],
        [{ file: "workspace.json", digest: "a".repeat(64) }],
      ],
    );
    TestValidator.error("a published topology snapshot is immutable", () => {
      initial.nodes.push(initial.nodes[0]!);
    });
    TestValidator.error("conflicting duplicate manifest sources are refused", () =>
      RepositoryContextProtocol.manifestDigest([
        { file: "same", digest: "a".repeat(64) },
        { file: "same", digest: "b".repeat(64) },
      ]),
    );
    TestValidator.error("an invalid initial base is refused", () =>
      new RepositoryContextProtocol.Store().apply(
        transaction(2, initial),
      ),
    );

    const unchanged = store.apply(transaction(2, initial));
    TestValidator.equals(
      "a valid empty delta advances only the generation",
      [
        unchanged.generation.sequence,
        unchanged.generation.shards,
        unchanged.nodes,
      ],
      [2, initial.generation.shards, initial.nodes],
    );

    const prior = store.current;
    const invalid = [
      [] as RepositoryContextProtocol.Frame[],
      mutate(transaction(3, unchanged), (frames) => {
        frames[0] = frames.at(-1)!;
      }),
      mutate(transaction(3, unchanged), (frames) => {
        frames[frames.length - 1] = frames[0]!;
      }),
      mutate(transaction(3, unchanged), (frames) => {
        frames.pop();
      }),
      mutate(transaction(3, unchanged), (frames) => {
        (frames[1] as RepositoryContextProtocol.IBegin).baseSequence = 1;
      }),
      mutate(transaction(3, unchanged), (frames) => {
        (frames.at(-1) as RepositoryContextProtocol.ICommit).generation =
          "other";
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = frames[2] as RepositoryContextProtocol.IUpsertShard;
        upsert.digest = "b".repeat(64);
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        frames.splice(3, 0, structuredClone(frames[2]!));
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = frames[2] as RepositoryContextProtocol.IUpsertShard;
        upsert.shard.edges[0]!.to = "missing";
        refresh(frames);
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const hello = frames[0] as RepositoryContextProtocol.IHello;
        hello.authority = "inferred";
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const hello = frames[0] as RepositoryContextProtocol.IHello;
        (hello as { authority: string }).authority = "guessed";
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = frames[2] as RepositoryContextProtocol.IUpsertShard;
        (upsert.shard.nodes[0] as { kind: string }).kind = "solution";
        refresh(frames);
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = frames[2] as RepositoryContextProtocol.IUpsertShard;
        (upsert.shard.nodes[0] as { authority: string }).authority =
          "guessed";
        refresh(frames);
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = frames[2] as RepositoryContextProtocol.IUpsertShard;
        upsert.shard.nodes[0]!.authority = "inferred";
        refresh(frames);
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = frames[2] as RepositoryContextProtocol.IUpsertShard;
        (upsert.shard.coverage[0] as { state: string }).state = "unknown";
        refresh(frames);
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const begin = frames[1] as RepositoryContextProtocol.IBegin;
        begin.manifest = "c".repeat(64);
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const hello = frames[0] as RepositoryContextProtocol.IHello;
        hello.toolVersion = "changed";
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const hello = frames[0] as RepositoryContextProtocol.IHello;
        hello.protocolVersion = 0 as 1;
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const hello = frames[0] as RepositoryContextProtocol.IHello;
        hello.provider = "";
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const hello = frames[0] as RepositoryContextProtocol.IHello;
        hello.supportedFamilies.push("contains");
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const hello = frames[0] as RepositoryContextProtocol.IHello;
        (hello.supportedFamilies as string[]).push("invented");
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const hello = frames[0] as RepositoryContextProtocol.IHello;
        hello.capabilities.push("fixture");
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const begin = frames[1] as RepositoryContextProtocol.IBegin;
        begin.sequence = 0;
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const begin = frames[1] as RepositoryContextProtocol.IBegin;
        begin.generation = "";
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const begin = frames[1] as RepositoryContextProtocol.IBegin;
        begin.manifest = "invalid";
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const begin = frames[1] as RepositoryContextProtocol.IBegin;
        delete begin.baseGeneration;
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const begin = frames[1] as RepositoryContextProtocol.IBegin;
        begin.baseSequence = 0;
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const begin = frames[1] as RepositoryContextProtocol.IBegin;
        begin.baseGeneration = "";
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.key = "";
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.target = "other";
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.nodes[0]!.name = "";
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.nodes[0]!.ecosystem = "other";
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.nodes.push(structuredClone(upsert.shard.nodes[0]!));
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.nodes[0]!.root = "src";
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.nodes[1]!.root = "";
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.nodes[1]!.file = "";
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.nodes[0]!.evidence = { file: "", startLine: 1 };
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.nodes[0]!.evidence = {
          file: "workspace.json",
          startLine: 0,
        };
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        (upsert.shard.edges[0] as { kind: string }).kind = "invokes";
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        (upsert.shard.edges[0] as { authority: string }).authority =
          "guessed";
        refresh(frames);
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.edges[0]!.authority = "inferred";
        refresh(frames);
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.edges[0]!.from = "";
      }),
      // `joins-file` is the one relation whose target is a file identity rather
      // than a node identity, so it is the one endpoint the ordinary node
      // closure check cannot cover. A join to a file the shard never declared
      // is how the topology plane would start naming code the code generation
      // has no record of.
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.edges.find((edge) => edge.kind === "joins-file")!.to =
          "src/undeclared.ts";
        refresh(frames);
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.edges.push(structuredClone(upsert.shard.edges[0]!));
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.coverage.push(
          structuredClone(upsert.shard.coverage[0]!),
        );
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.coverage.pop();
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.files.push(upsert.shard.files[0]!);
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.sources[0]!.digest = "invalid";
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const upsert = changedUpsert(frames);
        upsert.shard.sources.push(
          structuredClone(upsert.shard.sources[0]!),
        );
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        frames.splice(2, 0, {
          type: "deleteShard",
          key: "absent",
        });
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        frames.splice(2, 0, frames[0]!);
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const commit = frames.at(-1) as RepositoryContextProtocol.ICommit;
        commit.shards = [];
      }),
      mutate(transaction(3, unchanged, changedShard()), (frames) => {
        const commit = frames.at(-1) as RepositoryContextProtocol.ICommit;
        commit.contentDigest = "0".repeat(64);
      }),
    ];
    for (const frames of invalid) {
      TestValidator.error(
        "a malformed repository context transaction is rejected",
        () => store.apply(frames),
      );
      TestValidator.equals(
        "a rejected transaction retains the prior generation",
        store.current,
        prior,
      );
    }
    const aborted = new AbortController();
    aborted.abort();
    TestValidator.error("a cancelled transaction is rejected", () =>
      store.apply(transaction(3, unchanged, changedShard()), {
        signal: aborted.signal,
      }),
    );

    const changed = store.apply(transaction(3, unchanged, changedShard()));
    TestValidator.equals(
      "a changed shard replaces one atomic topology generation",
      [changed.generation.sequence, changed.nodes.at(-1)?.name],
      [3, "source"],
    );

    const multiStore = new RepositoryContextProtocol.Store();
    const first = validShard();
    const second = secondaryShard();
    const multi = multiStore.apply(initialTransaction(1, [first, second]));
    const deleted = multiStore.apply(deleteTransaction(2, multi, first, second));
    TestValidator.equals(
      "a valid delete delta removes exactly one committed shard",
      [
        multi.generation.shards.map((shard) => shard.key),
        deleted.generation.shards.map((shard) => shard.key),
        deleted.nodes.map((node) => node.name),
      ],
      [
        ["fixture:secondary", "fixture:workspace"],
        ["fixture:workspace"],
        ["fixture", "src"],
      ],
    );

    const conflictingSource = secondaryShard();
    const conflictingFrames = initialTransaction(1, [
      validShard(),
      conflictingSource,
    ]);
    const conflictingUpsert = conflictingFrames.find(
      (frame): frame is RepositoryContextProtocol.IUpsertShard =>
        frame.type === "upsertShard" &&
        frame.shard.key === conflictingSource.key,
    )!;
    conflictingUpsert.shard.sources = [
      { file: "workspace.json", digest: "b".repeat(64) },
    ];
    conflictingUpsert.digest = RepositoryContextProtocol.shardDigest(
      conflictingUpsert.shard,
    );
    const conflictingCommit = conflictingFrames.at(
      -1,
    ) as RepositoryContextProtocol.ICommit;
    conflictingCommit.shards = conflictingFrames
      .filter(
        (frame): frame is RepositoryContextProtocol.IUpsertShard =>
          frame.type === "upsertShard",
      )
      .map((frame) => ({ key: frame.shard.key, digest: frame.digest }))
      .sort((left, right) =>
        left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
      );
    TestValidator.error("cross-shard source disagreement is refused", () =>
      new RepositoryContextProtocol.Store().apply(conflictingFrames),
    );
    const duplicateNode = secondaryShard();
    duplicateNode.nodes = [structuredClone(validShard().nodes[0]!)];
    TestValidator.error("cross-shard duplicate nodes are refused", () =>
      new RepositoryContextProtocol.Store().apply(
        initialTransaction(1, [validShard(), duplicateNode]),
      ),
    );
    const duplicateEdge = secondaryShard();
    duplicateEdge.nodes = [];
    duplicateEdge.edges = [structuredClone(validShard().edges[0]!)];
    TestValidator.error("cross-shard duplicate edges are refused", () =>
      new RepositoryContextProtocol.Store().apply(
        initialTransaction(1, [validShard(), duplicateEdge]),
      ),
    );
  };

function transaction(
  sequence: number,
  base?: RepositoryContextProtocol.ISnapshot,
  shard?: RepositoryContextProtocol.IShard,
): RepositoryContextProtocol.Frame[] {
  const selected = shard ?? validShard();
  const manifest = RepositoryContextProtocol.manifestDigest(selected.sources);
  const generation = `generation-${String(sequence)}`;
  const includeShard =
    base === undefined ||
    RepositoryContextProtocol.shardDigest(selected) !==
      base.generation.shards[0]?.digest;
  return [
    hello(),
    {
      type: "begin",
      sequence,
      generation,
      ...(base !== undefined
        ? {
            baseSequence: base.generation.sequence,
            baseGeneration: base.generation.token,
          }
        : {}),
      inputGeneration: RepositoryContextProtocol.digest({ sequence, manifest }),
      universe: "fixture-universe",
      target: "workspace",
      manifest,
    },
    ...(includeShard
      ? [
          {
            type: "upsertShard" as const,
            digest: RepositoryContextProtocol.shardDigest(selected),
            shard: selected,
          },
        ]
      : []),
    {
      type: "commit",
      sequence,
      generation,
      shards: [
        {
          key: selected.key,
          digest: RepositoryContextProtocol.shardDigest(selected),
        },
      ],
      contentDigest: RepositoryContextProtocol.contentDigest(selected),
    },
  ];
}

function changedUpsert(
  frames: RepositoryContextProtocol.Frame[],
): RepositoryContextProtocol.IUpsertShard {
  return frames.find(
    (frame): frame is RepositoryContextProtocol.IUpsertShard =>
      frame.type === "upsertShard",
  )!;
}

function hello(): RepositoryContextProtocol.IHello {
  return {
    type: "hello",
    protocolVersion: 1,
    schemaVersion: 1,
    producerSchemaVersion: 1,
    provider: "fixture-context",
    ecosystem: "fixture",
    authority: "declared",
    tool: "fixture-model",
    toolVersion: "1.0.0",
    supportedFamilies: ["contains", "joins-file"],
    capabilities: ["fixture"],
  };
}

function validShard(): RepositoryContextProtocol.IShard {
  const workspace = repositoryContextId("fixture", "workspace", ".");
  const source = repositoryContextId("fixture", "source-root", "src");
  return {
    key: "fixture:workspace",
    target: "workspace",
    nodes: [
      {
        id: workspace,
        authority: "declared",
        kind: "workspace",
        name: "fixture",
        ecosystem: "fixture",
        coordinate: ".",
        configuration: "default",
        external: false,
      },
      {
        id: source,
        authority: "declared",
        kind: "source-root",
        name: "src",
        ecosystem: "fixture",
        coordinate: "src",
        configuration: "default",
        external: false,
      },
    ],
    edges: [
      {
        authority: "declared",
        kind: "contains",
        from: workspace,
        to: source,
      },
      {
        authority: "declared",
        kind: "joins-file",
        from: source,
        to: "src/main.ts",
      },
    ],
    coverage: repositoryContextCoverage(
      "fixture-context",
      "fixture",
      "workspace",
      ["contains", "joins-file"],
    ),
    files: ["src/main.ts"],
    sources: [{ file: "workspace.json", digest: "a".repeat(64) }],
  };
}

function changedShard(): RepositoryContextProtocol.IShard {
  const shard = validShard();
  shard.nodes[1]!.name = "source";
  return shard;
}

function secondaryShard(): RepositoryContextProtocol.IShard {
  const project = repositoryContextId("fixture", "project", "secondary");
  return {
    key: "fixture:secondary",
    target: "workspace",
    nodes: [
      {
        id: project,
        authority: "declared",
        kind: "project",
        name: "secondary",
        ecosystem: "fixture",
        coordinate: "secondary",
        configuration: "default",
        external: false,
      },
    ],
    edges: [],
    coverage: repositoryContextCoverage(
      "fixture-context",
      "fixture",
      "workspace",
      ["contains", "joins-file"],
    ),
    files: [],
    sources: [{ file: "secondary.json", digest: "b".repeat(64) }],
  };
}

function initialTransaction(
  sequence: number,
  shards: readonly RepositoryContextProtocol.IShard[],
): RepositoryContextProtocol.Frame[] {
  const sources = shards.flatMap((shard) => shard.sources);
  const manifest = RepositoryContextProtocol.manifestDigest(sources);
  const generation = `multi-generation-${String(sequence)}`;
  return [
    hello(),
    {
      type: "begin",
      sequence,
      generation,
      inputGeneration: RepositoryContextProtocol.digest({ sequence, manifest }),
      universe: "fixture-universe",
      target: "workspace",
      manifest,
    },
    ...shards.map((shard) => ({
      type: "upsertShard" as const,
      digest: RepositoryContextProtocol.shardDigest(shard),
      shard,
    })),
    {
      type: "commit",
      sequence,
      generation,
      shards: shards
        .map((shard) => ({
          key: shard.key,
          digest: RepositoryContextProtocol.shardDigest(shard),
        }))
        .sort((left, right) =>
          left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
        ),
      contentDigest: RepositoryContextProtocol.contentDigest({
        nodes: shards.flatMap((shard) => shard.nodes),
        edges: shards.flatMap((shard) => shard.edges),
        coverage: shards.flatMap((shard) => shard.coverage),
      }),
    },
  ];
}

function deleteTransaction(
  sequence: number,
  base: RepositoryContextProtocol.ISnapshot,
  retained: RepositoryContextProtocol.IShard,
  removed: RepositoryContextProtocol.IShard,
): RepositoryContextProtocol.Frame[] {
  const generation = `multi-generation-${String(sequence)}`;
  const manifest = RepositoryContextProtocol.manifestDigest(retained.sources);
  return [
    hello(),
    {
      type: "begin",
      sequence,
      generation,
      baseSequence: base.generation.sequence,
      baseGeneration: base.generation.token,
      inputGeneration: RepositoryContextProtocol.digest({ sequence, manifest }),
      universe: "fixture-universe",
      target: "workspace",
      manifest,
    },
    { type: "deleteShard", key: removed.key },
    {
      type: "commit",
      sequence,
      generation,
      shards: [
        {
          key: retained.key,
          digest: RepositoryContextProtocol.shardDigest(retained),
        },
      ],
      contentDigest: RepositoryContextProtocol.contentDigest(retained),
    },
  ];
}

function mutate(
  frames: RepositoryContextProtocol.Frame[],
  operation: (frames: RepositoryContextProtocol.Frame[]) => void,
): RepositoryContextProtocol.Frame[] {
  const cloned = structuredClone(frames);
  operation(cloned);
  return cloned;
}

function refresh(frames: RepositoryContextProtocol.Frame[]): void {
  const upsert = frames.find(
    (frame): frame is RepositoryContextProtocol.IUpsertShard =>
      frame.type === "upsertShard",
  )!;
  upsert.digest = RepositoryContextProtocol.shardDigest(upsert.shard);
  const commit = frames.at(-1) as RepositoryContextProtocol.ICommit;
  commit.shards = [{ key: upsert.shard.key, digest: upsert.digest }];
  commit.contentDigest = RepositoryContextProtocol.contentDigest(upsert.shard);
}
