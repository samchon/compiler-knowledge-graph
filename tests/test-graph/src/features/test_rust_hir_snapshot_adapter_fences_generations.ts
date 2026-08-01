import { TestValidator } from "@nestia/e2e";
import {
  GRAPH_EDGE_KINDS,
  RUST_GRAPH_PRODUCER_COMMIT,
  RustGraphCache,
  RustGraphSnapshotAdapter,
  type IRustGraphCacheState,
  type IRustGraphShard,
  type IRustGraphSnapshot,
} from "@samchon/graph";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths.js";

const COMMIT = RUST_GRAPH_PRODUCER_COMMIT;

export const test_rust_hir_snapshot_adapter_fences_generations = () => {
  const root = GraphPaths.createTempDirectory("samchon-graph-rust-adapter-");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/lib.rs"), "pub fn answer() -> u8 { 42 }\n");

  const adapter = new RustGraphSnapshotAdapter(root, COMMIT);
  const initialRaw = snapshot({ nodeName: "answer" });
  const initial = adapter.prepare(initialRaw);
  if (!initial.changed) throw new Error("initial Rust generation did not change");
  const initialSnapshot = adapter.store.apply(initial.frames);
  initial.commit(initialSnapshot);
  TestValidator.equals(
    "a full HIR response becomes one validated graph generation",
    [
      initial.mode,
      adapter.hasPersistedSnapshot,
      adapter.persistedCheckpoint?.generation,
      initialSnapshot.nodes.map((node) => [node.name, node.kind, node.external]),
      initialSnapshot.edges.map((edge) => edge.kind),
      initialSnapshot.diagnostics.map((diagnostic) => diagnostic.severity),
      initialSnapshot.coverage?.length,
      initialSnapshot.unresolved?.length,
      initialSnapshot.provenance.provider,
      initialSnapshot.provenance.compilerVersion.startsWith("rustc 1.95.0"),
      initialSnapshot.nodes.every((node) => node.id.startsWith("@v2/rust/")),
      initialSnapshot.edges.every(
        (edge) =>
          initialSnapshot.nodes.some((node) => node.id === edge.from) &&
          initialSnapshot.nodes.some((node) => node.id === edge.to),
      ),
    ],
    [
      "initial",
      true,
      initialRaw.generation,
      [
        ["dependency", "external_symbol", true],
        ["answer", "function", false],
      ],
      ["calls"],
      ["warning"],
      GRAPH_EDGE_KINDS.length,
      GRAPH_EDGE_KINDS.length - 1,
      "samchon-rust-analyzer-hir",
      true,
      true,
      true,
    ],
  );

  const unchangedRaw = snapshot({
    base: initialRaw,
    upserts: [],
    sequence: 2,
  });
  const unchanged = adapter.prepare(unchangedRaw);
  if (unchanged.changed) throw new Error("Rust producer no-op changed the graph");
  TestValidator.equals(
    "a producer no-op preserves the exact published object",
    [unchanged.changed, unchanged.mode, unchanged.snapshot === initialSnapshot],
    [false, "unchanged", true],
  );

  const incrementalRaw = snapshot({
    base: initialRaw,
    nodeName: "edited_answer",
    sequence: 3,
  });
  const incremental = adapter.prepare(incrementalRaw);
  if (!incremental.changed) throw new Error("incremental Rust generation did not change");
  const incrementalSnapshot = adapter.store.apply(incremental.frames);
  incremental.commit(incrementalSnapshot);
  TestValidator.equals(
    "a producer delta advances only from its exact raw base",
    [incremental.mode, incrementalSnapshot.nodes.some((node) => node.name === "edited_answer")],
    ["incremental", true],
  );

  const rebuiltRaw = snapshot({ nodeName: "rebuilt", sequence: 4 });
  const rebuilt = adapter.prepare(rebuiltRaw);
  if (!rebuilt.changed) throw new Error("rebuilt Rust generation did not change");
  const rebuiltSnapshot = adapter.store.apply(rebuilt.frames);
  rebuilt.commit(rebuiltSnapshot);
  TestValidator.equals("a full response in one universe is a rebuild", rebuilt.mode, "rebuild");

  const reloadedRaw = snapshot({
    nodeName: "reloaded",
    sequence: 5,
    universe: digest("universe-2"),
  });
  const reloaded = adapter.prepare(reloadedRaw);
  if (!reloaded.changed) throw new Error("reloaded Rust generation did not change");
  const reloadedSnapshot = adapter.store.apply(reloaded.frames);
  reloaded.commit(reloadedSnapshot);
  TestValidator.equals("a full response in another universe is a reload", reloaded.mode, "reload");

  const restored = new RustGraphSnapshotAdapter(root, COMMIT, reloaded.state);
  TestValidator.equals(
    "a validated consumer checkpoint restores raw and graph state",
    [
      restored.store.current?.protocol?.generation,
      restored.persistedCheckpoint?.generation,
      restored.store.current?.nodes.map((node) => node.name),
    ],
    [reloadedRaw.generation, reloadedRaw.generation, ["dependency", "reloaded"]],
  );
  restored.discardPersistedSnapshot();
  restored.discardPersistedSnapshot();
  TestValidator.equals(
    "discarding a persisted checkpoint returns to an empty adapter",
    [restored.hasPersistedSnapshot, restored.persistedCheckpoint],
    [false, undefined],
  );

  assertAdapterRefusals(root, initialRaw, reloaded.state);
  assertDeltaDeletionAndCrossShardRefusals(root);
  assertOptionalProducerFields(root);
  assertCacheFallback(root, reloaded.state);
};

function assertOptionalProducerFields(root: string): void {
  const optional = snapshot({ nodeName: "optional" });
  optional.universe.configurations = [];
  optional.upserts[0]!.edges[0]!.evidence = null;
  optional.upserts[0]!.diagnostics[0]!.column = 7;
  optional.upserts[0]!.diagnostics[0]!.severity = null;
  optional.upserts[0]!.unresolved[0]!.candidates = [
    "rust-hir-v1|dependency",
    "rust-hir-v1|unknown",
  ];
  refresh(optional);
  const adapter = new RustGraphSnapshotAdapter(root, COMMIT);
  const prepared = adapter.prepare(optional);
  if (!prepared.changed) throw new Error("optional Rust fixture did not change");
  const adapted = adapter.store.apply(prepared.frames);
  TestValidator.equals(
    "optional producer fields preserve absence, positions, and unresolved native identities",
    [
      adapted.edges[0]?.evidence,
      adapted.diagnostics[0]?.column,
      adapted.diagnostics[0]?.severity,
      adapted.unresolved?.[0]?.candidates?.some((candidate) =>
        candidate.endsWith("rust-hir-v1|unknown"),
      ),
      adapted.provenance.compilerVersion,
    ],
    [undefined, 7, undefined, true, "unavailable"],
  );

  const bundledUniverse = digest("bundled-universe");
  const bundledRaw = snapshot({
    universe: bundledUniverse,
    upserts: [rawShard("bundled", bundledUniverse, "bundled:///rust/source")],
  });
  const bundledAdapter = new RustGraphSnapshotAdapter(root, COMMIT);
  const bundled = bundledAdapter.prepare(bundledRaw);
  if (!bundled.changed) throw new Error("bundled Rust fixture did not change");
  TestValidator.predicate(
    "bundled producer sources retain their URI identity",
    bundledAdapter.store.apply(bundled.frames).sources.has("bundled:///rust/source"),
  );

  TestValidator.error("a snapshot without shards cannot establish coverage", () =>
    new RustGraphSnapshotAdapter(root, COMMIT).prepare(snapshot({ upserts: [] })),
  );
}

function assertAdapterRefusals(
  root: string,
  valid: IRustGraphSnapshot,
  state: IRustGraphCacheState,
): void {
  const rejects = (label: string, mutate: (value: IRustGraphSnapshot) => void): void => {
    TestValidator.error(label, () => {
      const candidate = structuredClone(valid);
      mutate(candidate);
      new RustGraphSnapshotAdapter(root, COMMIT).prepare(candidate);
    });
  };
  TestValidator.error("a non-object producer response is refused", () =>
    new RustGraphSnapshotAdapter(root, COMMIT).prepare(null as unknown as IRustGraphSnapshot),
  );
  rejects("an unknown producer protocol is refused", (value) => {
    value.protocolVersion = 2;
  });
  rejects("a producer commit mismatch is refused", (value) => {
    value.producer.commit = "wrong";
  });
  rejects("an empty producer version is refused", (value) => {
    value.producer.version = "";
  });
  rejects("a malformed universe is refused", (value) => {
    value.universe.digest = "wrong";
  });
  rejects("duplicate workspace roots are refused", (value) => {
    value.universe.workspaceRoots = ["same", "same"];
  });
  rejects("a malformed generation envelope is refused", (value) => {
    value.sequence = 0;
  });
  rejects("malformed producer phase telemetry is refused", (value) => {
    value.phases.totalMillis = -1;
  });
  rejects("a malformed base generation is refused", (value) => {
    value.baseGeneration = "wrong";
  });
  rejects("a non-canonical manifest is refused", (value) => {
    value.manifest.push({ ...value.manifest[0]! });
  });
  rejects("a non-canonical delete list is refused", (value) => {
    value.deletes = ["same", "same"];
  });
  rejects("a stale producer base is refused", (value) => {
    value.baseGeneration = digest("stale");
  });
  TestValidator.error("a generation cannot lose its base", () => {
    const adapter = new RustGraphSnapshotAdapter(root, COMMIT);
    const prepared = adapter.prepare(structuredClone(valid));
    if (!prepared.changed) throw new Error("initial Rust generation did not change");
    prepared.commit(adapter.store.apply(prepared.frames));
    adapter.prepare(structuredClone(valid));
  });
  rejects("a missing delete is refused", (value) => {
    value.baseGeneration = null;
    value.deletes = ["missing"];
  });
  rejects("a shard delta cannot collide with a delete", (value) => {
    value.deletes = [value.upserts[0]!.key];
  });
  rejects("a raw manifest mismatch is refused", (value) => {
    value.manifest[0]!.digest = digest("wrong");
  });
  rejects("a raw generation mismatch is refused", (value) => {
    value.generation = digest("wrong");
  });
  rejects("a raw shard key must match target and source", (value) => {
    value.upserts[0]!.key = `wrong\0${value.upserts[0]!.source}`;
    refresh(value);
  });
  rejects("a raw shard digest mismatch is refused", (value) => {
    value.upserts[0]!.digest = digest("wrong");
  });
  rejects("an empty raw shard key is refused", (value) => {
    value.upserts[0]!.key = "";
    refresh(value);
  });
  rejects("an empty raw node identity is refused", (value) => {
    value.upserts[0]!.nodes[0]!.id = "";
    refresh(value);
  });
  rejects("a foreign raw node identity is refused", (value) => {
    value.upserts[0]!.nodes[0]!.id = "foreign|node";
    refresh(value);
  });
  rejects("malformed raw node flags are refused", (value) => {
    (value.upserts[0]!.nodes[0] as unknown as { external: string }).external =
      "false";
    refresh(value);
  });
  rejects("malformed raw exported flags are refused", (value) => {
    (value.upserts[0]!.nodes[0] as unknown as { exported: string }).exported =
      "true";
    refresh(value);
  });
  rejects("a malformed qualified node name is refused", (value) => {
    (
      value.upserts[0]!.nodes[0] as unknown as { qualifiedName: number }
    ).qualifiedName = 1;
    refresh(value);
  });
  rejects("a malformed node signature is refused", (value) => {
    (value.upserts[0]!.nodes[0] as unknown as { signature: number }).signature =
      1;
    refresh(value);
  });
  rejects("malformed raw shard arrays are refused", (value) => {
    (value.upserts[0] as unknown as { nodes: null }).nodes = null;
    refresh(value);
  });
  rejects("an unknown raw node kind is refused", (value) => {
    value.upserts[0]!.nodes[0]!.kind = "unknown";
    refresh(value);
  });
  rejects("an unsupported raw edge family is refused", (value) => {
    value.upserts[0]!.edges[0]!.kind = "renders";
    refresh(value);
  });
  rejects("a foreign raw edge identity is refused", (value) => {
    value.upserts[0]!.edges[0]!.from = "foreign|node";
    refresh(value);
  });
  rejects("an invalid diagnostic line is refused", (value) => {
    value.upserts[0]!.diagnostics[0]!.line = 0;
    refresh(value);
  });
  rejects("an invalid diagnostic column is refused", (value) => {
    value.upserts[0]!.diagnostics[0]!.column = 0;
    refresh(value);
  });
  rejects("an invalid diagnostic severity is refused", (value) => {
    value.upserts[0]!.diagnostics[0]!.severity = "fatal";
    refresh(value);
  });
  rejects("an invalid diagnostic code is refused", (value) => {
    value.upserts[0]!.diagnostics[0]!.code = "";
    refresh(value);
  });
  rejects("an invalid diagnostic message is refused", (value) => {
    value.upserts[0]!.diagnostics[0]!.message = "";
    refresh(value);
  });
  rejects("a duplicate coverage family is refused", (value) => {
    value.upserts[0]!.coverage.push({ ...value.upserts[0]!.coverage[0]! });
    refresh(value);
  });
  rejects("an incomplete coverage matrix is refused", (value) => {
    value.upserts[0]!.coverage.pop();
    refresh(value);
  });
  rejects("a malformed unresolved boundary is refused", (value) => {
    value.upserts[0]!.unresolved[0]!.candidates = ["same", "same"];
    refresh(value);
  });
  rejects("a foreign unresolved candidate identity is refused", (value) => {
    value.upserts[0]!.unresolved[0]!.candidates = ["foreign|node"];
    refresh(value);
  });
  rejects("an invalid evidence range is refused", (value) => {
    value.upserts[0]!.nodes[0]!.evidence!.startLine = 0;
    refresh(value);
  });
  rejects("a reversed evidence range is refused", (value) => {
    value.upserts[0]!.nodes[0]!.evidence!.startColumn = 5;
    value.upserts[0]!.nodes[0]!.evidence!.endColumn = 4;
    refresh(value);
  });
  const corruptStates: Array<[string, (value: IRustGraphCacheState) => void]> = [
    ["persisted producer identity", (value) => (value.producerCommit = "wrong")],
    ["persisted raw shard payload", (value) => (value.rawShards[0]!.digest = digest("bad"))],
    [
      "persisted raw shard identity",
      (value) => {
        value.rawShards[0]!.key = "wrong";
        value.rawShards[0]!.digest = rawShardDigest(value.rawShards[0]!);
      },
    ],
    ["persisted producer checkpoint", (value) => value.checkpoint.manifest.pop()],
    [
      "persisted graph checkpoint",
      (value) => ((value.frames[1]! as { type: string }).type = "hello"),
    ],
    [
      "persisted graph generation",
      (value) => {
        const generation = digest("graph-only-generation");
        (value.frames[1]! as { generation: string }).generation = generation;
        (value.frames.at(-1)! as { generation: string }).generation = generation;
      },
    ],
  ];
  for (const [label, mutate] of corruptStates) {
    TestValidator.error(`${label} corruption is refused`, () => {
      const candidate = structuredClone(state);
      mutate(candidate);
      new RustGraphSnapshotAdapter(root, COMMIT, candidate);
    });
  }
}

function assertDeltaDeletionAndCrossShardRefusals(root: string): void {
  const universe = digest("multi-shard-universe");
  const first = rawShard("first", universe, "src/first.rs", "-first");
  const second = rawShard("second", universe, "src/second.rs", "-second");
  const full = snapshot({ universe, upserts: [first, second] });
  const adapter = new RustGraphSnapshotAdapter(root, COMMIT);
  const prepared = adapter.prepare(full);
  if (!prepared.changed) throw new Error("multi-shard Rust fixture did not change");
  prepared.commit(adapter.store.apply(prepared.frames));
  const deleted = snapshot({
    base: full,
    universe,
    upserts: [],
    deletes: [second.key],
    sequence: 2,
  });
  const deletion = adapter.prepare(deleted);
  if (!deletion.changed) throw new Error("Rust shard deletion did not change");
  const afterDeletion = deletion.commit(adapter.store.apply(deletion.frames));
  TestValidator.equals(
    "an incremental Rust generation deletes exactly its named shard",
    afterDeletion.nodes.map((node) => node.name),
    ["dependency", "first"],
  );

  const initialized = (): RustGraphSnapshotAdapter => {
    const value = new RustGraphSnapshotAdapter(root, COMMIT);
    const initial = value.prepare(structuredClone(full));
    if (!initial.changed) throw new Error("multi-shard Rust fixture did not change");
    initial.commit(value.store.apply(initial.frames));
    return value;
  };
  TestValidator.error("one delta cannot delete and upsert the same shard", () => {
    initialized().prepare(
      snapshot({
        base: full,
        universe,
        upserts: [structuredClone(first)],
        deletes: [first.key],
        sequence: 2,
      }),
    );
  });
  TestValidator.error("an edge endpoint absent from every raw shard is refused", () => {
    const bad = structuredClone(full);
    bad.upserts[0]!.edges[0]!.to = "rust-hir-v1|absent";
    refresh(bad);
    new RustGraphSnapshotAdapter(root, COMMIT).prepare(bad);
  });
  TestValidator.error("two raw shards cannot disagree about coverage", () => {
    const badSecond = structuredClone(second);
    badSecond.coverage[0]!.state = "complete";
    badSecond.digest = rawShardDigest(badSecond);
    new RustGraphSnapshotAdapter(root, COMMIT).prepare(
      snapshot({ universe, upserts: [structuredClone(first), badSecond] }),
    );
  });
  TestValidator.error("one native node identity cannot describe two declarations", () => {
    const badSecond = structuredClone(second);
    badSecond.nodes[0]!.id = first.nodes[0]!.id;
    badSecond.digest = rawShardDigest(badSecond);
    new RustGraphSnapshotAdapter(root, COMMIT).prepare(
      snapshot({ universe, upserts: [structuredClone(first), badSecond] }),
    );
  });
  TestValidator.error("external node facts must agree across raw shards", () => {
    const badSecond = structuredClone(second);
    badSecond.nodes[1]!.signature = "fn(u8)";
    badSecond.digest = rawShardDigest(badSecond);
    new RustGraphSnapshotAdapter(root, COMMIT).prepare(
      snapshot({ universe, upserts: [structuredClone(first), badSecond] }),
    );
  });
}

function assertCacheFallback(root: string, state: IRustGraphCacheState): void {
  const cacheRoot = GraphPaths.createTempDirectory("samchon-graph-rust-cache-");
  const props = { root, producerCommit: COMMIT, cacheRoot };
  const sequence = (state.frames.at(-1) as { sequence: number }).sequence;
  TestValidator.equals("an absent Rust checkpoint cache is empty", RustGraphCache.load(props), undefined);
  TestValidator.error("invalid persisted coordinates are refused", () =>
    RustGraphCache.save(props, 0, state.checkpoint.generation, state),
  );
  RustGraphCache.save(props, sequence, state.checkpoint.generation, state);
  const directory = findGenerationDirectory(cacheRoot);
  const invalidCacheFiles = [
    `999999999999999999999999-${state.checkpoint.generation}.json`,
    `${String(sequence + 102)}-${state.checkpoint.generation}.json`,
    `${String(sequence + 101)}-${state.checkpoint.generation}.json`,
  ];
  fs.writeFileSync(path.join(directory, invalidCacheFiles[0]!), "{}");
  fs.writeFileSync(path.join(directory, invalidCacheFiles[1]!), "");
  fs.writeFileSync(
    path.join(directory, invalidCacheFiles[2]!),
    JSON.stringify({ ...state, frames: [null] }),
  );
  TestValidator.equals(
    "a saved Rust checkpoint skips invalid coordinates, empty files, and malformed commit frames",
    [
      RustGraphCache.load(props)?.checkpoint.generation,
      RustGraphCache.load(props, () => false),
    ],
    [state.checkpoint.generation, undefined],
  );
  for (const file of invalidCacheFiles) fs.rmSync(path.join(directory, file));
  RustGraphCache.save(props, sequence, state.checkpoint.generation, state);
  fs.writeFileSync(
    path.join(directory, `${String(sequence + 1)}-${digest("second")}.json`),
    "{",
  );
  TestValidator.equals(
    "a torn newest generation falls back to the prior immutable checkpoint",
    RustGraphCache.load(props)?.checkpoint.generation,
    state.checkpoint.generation,
  );
  fs.rmSync(path.join(directory, `${String(sequence + 1)}-${digest("second")}.json`));
  const second = cacheStateAtSequence(state, sequence + 1);
  const third = cacheStateAtSequence(state, sequence + 2);
  RustGraphCache.save(props, sequence + 1, state.checkpoint.generation, second);
  RustGraphCache.save(props, sequence + 2, state.checkpoint.generation, third);
  TestValidator.equals(
    "the immutable cache retains only its two newest validated generations",
    fs
      .readdirSync(directory)
      .filter((file) => file.endsWith(".json"))
      .sort(),
    [
      `${String(sequence + 1)}-${state.checkpoint.generation}.json`,
      `${String(sequence + 2)}-${state.checkpoint.generation}.json`,
    ],
  );
  const mutableFs = fs as typeof fs & { renameSync: typeof fs.renameSync };
  const renameSync = mutableFs.renameSync;
  try {
    mutableFs.renameSync = (temporary, file) => {
      fs.copyFileSync(temporary, file);
      throw new Error("fixture concurrent cache winner");
    };
    const winner = cacheStateAtSequence(state, sequence + 3);
    RustGraphCache.save(props, sequence + 3, state.checkpoint.generation, winner);
    mutableFs.renameSync = () => {
      throw new Error("fixture cache rename failure");
    };
    TestValidator.error("a cache rename failure without a winner is surfaced", () => {
      const losing = cacheStateAtSequence(state, sequence + 4);
      RustGraphCache.save(props, sequence + 4, state.checkpoint.generation, losing);
    });
  } finally {
    mutableFs.renameSync = renameSync;
  }
  fs.writeFileSync(
    path.join(directory, `.1-${String(sequence)}-${digest("temporary")}.tmp`),
    "torn",
  );
  fs.writeFileSync(path.join(directory, "unrelated.txt"), "keep");
  RustGraphCache.clear(props);
  TestValidator.equals(
    "cache cleanup removes owned generations and temporaries only",
    fs.readdirSync(directory),
    ["unrelated.txt"],
  );
  RustGraphCache.clear({ ...props, root: path.join(root, "absent") });
  assertDefaultCacheRootBranches(root);
}

function cacheStateAtSequence(
  state: IRustGraphCacheState,
  sequence: number,
): IRustGraphCacheState {
  const output = structuredClone(state);
  for (const frame of output.frames) {
    if (frame.type === "begin" || frame.type === "commit") frame.sequence = sequence;
  }
  return output;
}

function assertDefaultCacheRootBranches(root: string): void {
  const names = ["SAMCHON_GRAPH_CACHE_DIR", "LOCALAPPDATA", "XDG_CACHE_HOME"] as const;
  const prior = new Map(names.map((name) => [name, process.env[name]]));
  try {
    delete process.env.SAMCHON_GRAPH_CACHE_DIR;
    process.env.LOCALAPPDATA = GraphPaths.createTempDirectory("samchon-rust-local-cache-");
    delete process.env.XDG_CACHE_HOME;
    RustGraphCache.clear({ root, producerCommit: COMMIT });

    delete process.env.LOCALAPPDATA;
    process.env.XDG_CACHE_HOME = GraphPaths.createTempDirectory("samchon-rust-xdg-cache-");
    RustGraphCache.clear({ root, producerCommit: COMMIT });

    process.env.XDG_CACHE_HOME = "relative-cache";
    RustGraphCache.clear({ root, producerCommit: COMMIT });
  } finally {
    for (const name of names) {
      const value = prior.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

interface ISnapshotOptions {
  base?: IRustGraphSnapshot;
  nodeName?: string;
  sequence?: number;
  universe?: string;
  upserts?: IRustGraphShard[];
  deletes?: string[];
}

function snapshot(options: ISnapshotOptions = {}): IRustGraphSnapshot {
  const universe = options.universe ?? options.base?.universe.digest ?? digest("universe-1");
  const shard = rawShard(options.nodeName ?? "answer", universe);
  const rawShards = options.upserts ?? [shard];
  const next = new Map<string, IRustGraphShard>();
  if (options.base !== undefined) {
    for (const prior of options.base.upserts) next.set(prior.key, structuredClone(prior));
  }
  for (const deleted of options.deletes ?? []) next.delete(deleted);
  for (const upsert of rawShards) next.set(upsert.key, structuredClone(upsert));
  const manifest = [...next.values()]
    .sort((left, right) => compare(left.key, right.key))
    .map((entry) => ({ key: entry.key, digest: entry.digest }));
  const generation = digest({ universe, manifest });
  return {
    protocolVersion: 1,
    schemaVersion: 1,
    producer: {
      name: "samchon-rust-analyzer",
      version: "1.95.0",
      commit: COMMIT,
    },
    universe: {
      digest: universe,
      target: "app",
      workspaceRoots: ["."],
      toolchains: ["stable"],
      configurations: [
        "rustc-version=rustc 1.95.0 (fixture)\ncommit-hash: fixture\nhost: fixture",
      ],
    },
    sequence: options.sequence ?? 1,
    generation,
    baseGeneration: options.base?.generation ?? null,
    upserts: rawShards.map((entry) => structuredClone(entry)),
    deletes: [...(options.deletes ?? [])].sort(compare),
    manifest,
    phases: {
      semanticMillis: 1,
      shardMillis: 2,
      encodeMillis: 3,
      totalMillis: 6,
      cacheHit: rawShards.length === 0,
    },
  };
}

function rawShard(
  nodeName: string,
  _universe: string,
  source = "src/lib.rs",
  suffix = "",
): IRustGraphShard {
  const evidence = {
    file: source,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 10,
  };
  const shard: IRustGraphShard = {
    key: `app\0${source}`,
    source,
    checkerDigest: digest(`checker-${source}-${nodeName}`),
    interfaceFingerprint: digest(`interface-${nodeName}`),
    digest: "",
    nodes: [
      {
        id: `rust-hir-v1|answer${suffix}`,
        kind: "function",
        name: nodeName,
        qualifiedName: `fixture::${nodeName}`,
        file: source,
        external: false,
        exported: true,
        signature: "fn() -> u8",
        evidence,
      },
      {
        id: "rust-hir-v1|dependency",
        kind: "function",
        name: "dependency",
        qualifiedName: null,
        file: "bundled:///rust/dependencies",
        external: true,
        exported: false,
        signature: null,
        evidence: null,
      },
    ],
    edges: [
      {
        from: `rust-hir-v1|answer${suffix}`,
        to: "rust-hir-v1|dependency",
        kind: "calls",
        evidence,
      },
    ],
    diagnostics: [
      {
        file: source,
        line: 1,
        column: null,
        code: "fixture",
        message: "fixture warning",
        severity: "warning",
      },
    ],
    coverage: GRAPH_EDGE_KINDS.map((family) => ({
      family,
      state: family === "renders" ? "unsupported" : "partial",
    })),
    unresolved: GRAPH_EDGE_KINDS.filter((family) => family !== "renders").map(
      (family) => ({
        family,
        evidence,
        reason: "provider-gap",
        candidates: ["rust-hir-v1|dependency"],
      }),
    ),
  };
  shard.digest = rawShardDigest(shard);
  return shard;
}

function refresh(value: IRustGraphSnapshot): void {
  for (const shard of value.upserts) shard.digest = rawShardDigest(shard);
  value.manifest = value.upserts
    .map((shard) => ({ key: shard.key, digest: shard.digest }))
    .sort((left, right) => compare(left.key, right.key));
  value.generation = digest({ universe: value.universe.digest, manifest: value.manifest });
}

function rawShardDigest(shard: IRustGraphShard): string {
  return digest({
    key: shard.key,
    source: shard.source,
    checkerDigest: shard.checkerDigest,
    interfaceFingerprint: shard.interfaceFingerprint,
    nodes: shard.nodes,
    edges: shard.edges,
    diagnostics: shard.diagnostics,
    coverage: shard.coverage,
    unresolved: shard.unresolved,
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort(compare)
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function findGenerationDirectory(cacheRoot: string): string {
  const rust = path.join(cacheRoot, "rust", COMMIT);
  return path.join(rust, fs.readdirSync(rust)[0]!);
}
