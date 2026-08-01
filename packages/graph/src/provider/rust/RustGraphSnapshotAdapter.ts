import { createHash } from "node:crypto";
import path from "node:path";

import {
  ISamchonGraphCoverage,
  ISamchonGraphDiagnostic,
  ISamchonGraphEdge,
  ISamchonGraphEvidence,
  ISamchonGraphNode,
  ISamchonGraphUnresolved,
} from "../../structures";
import {
  GRAPH_EDGE_KINDS,
  GraphEdgeKind,
  GraphNodeKind,
} from "../../typings";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { GraphSnapshotProtocol } from "../GraphSnapshotProtocol";
import { semanticGraphNodeId } from "../semanticIdentity";
import { IRustGraphCacheState } from "./IRustGraphCacheState";
import { IRustGraphCheckpoint } from "./IRustGraphCheckpoint";
import { IRustGraphCoverage } from "./IRustGraphCoverage";
import { IRustGraphEvidence } from "./IRustGraphEvidence";
import { IRustGraphNode } from "./IRustGraphNode";
import { IRustGraphShard } from "./IRustGraphShard";
import { IRustGraphSnapshot } from "./IRustGraphSnapshot";
import { RUST_HIR_FACTS } from "./RUST_HIR_FACTS";
import { RUST_HIR_PRODUCER } from "./RUST_HIR_PRODUCER";
import { RUST_HIR_PROVIDER } from "./RUST_HIR_PROVIDER";

const DIGEST = /^[a-f0-9]{64}$/u;
const NODE_KINDS = new Set<GraphNodeKind>([
  "file",
  "package",
  "namespace",
  "module",
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "variable",
  "method",
  "property",
  "parameter",
  "field",
  "constructor",
]);
const COVERAGE_STATES = new Set(["complete", "partial", "unsupported"]);
const DIAGNOSTIC_SEVERITIES = new Set(["error", "warning", "info", "hint"]);
const UNRESOLVED_REASONS = new Set<ISamchonGraphUnresolved["reason"]>([
  "dynamic",
  "reflection",
  "macro-or-generated",
  "conditional-build",
  "external-boundary",
  "analysis-error",
  "excluded-input",
  "identity-unstable",
  "provider-gap",
]);
const CAPABILITIES = [
  "coverage",
  "diagnostics",
  "incremental",
  "sourceDigests",
  "universe",
  "unresolved",
  "validatedConsumerCheckpoint",
];

export class RustGraphSnapshotAdapter {
  public store: GraphSnapshotProtocol.Store;
  private rawShards = new Map<string, IRustGraphShard>();
  private graphShards = new Map<string, GraphSnapshotProtocol.IShard>();
  private rawGeneration: string | undefined;
  private checkpoint: IRustGraphCheckpoint | undefined;

  public constructor(
    private readonly root: string,
    private readonly producerCommit: string,
    cached?: IRustGraphCacheState,
  ) {
    this.store = new GraphSnapshotProtocol.Store(root);
    if (cached !== undefined) this.restore(cached);
  }

  public get persistedCheckpoint(): IRustGraphCheckpoint | undefined {
    return this.checkpoint === undefined
      ? undefined
      : structuredClone(this.checkpoint);
  }

  public get hasPersistedSnapshot(): boolean {
    return this.store.current !== undefined;
  }

  public discardPersistedSnapshot(): void {
    if (this.rawGeneration === undefined) return;
    this.rawShards.clear();
    this.graphShards.clear();
    this.rawGeneration = undefined;
    this.checkpoint = undefined;
    this.store = new GraphSnapshotProtocol.Store(this.root);
  }

  public prepare(
    raw: IRustGraphSnapshot,
  ): RustGraphSnapshotAdapter.IPrepared {
    assertSnapshot(raw, this.producerCommit);
    const prior = this.store.current;
    const priorRawGeneration = this.rawGeneration;
    if (raw.baseGeneration !== null) {
      if (raw.baseGeneration !== priorRawGeneration) {
        throw new Error("rust HIR graph: stale producer base generation");
      }
    } else if (priorRawGeneration !== undefined && raw.generation === priorRawGeneration) {
      throw new Error("rust HIR graph: unchanged generation lost its base");
    }

    const nextRaw =
      raw.baseGeneration === null
        ? new Map<string, IRustGraphShard>()
        : new Map(this.rawShards);
    const touched = new Set<string>();
    for (const key of raw.deletes) {
      assertKey(key, "delete key");
      if (touched.has(key) || !nextRaw.delete(key)) {
        throw new Error(`rust HIR graph: invalid duplicate/missing delete ${key}`);
      }
      touched.add(key);
    }
    for (const shard of raw.upserts) {
      assertRawShard(shard, raw);
      if (touched.has(shard.key)) {
        throw new Error(`rust HIR graph: duplicate shard delta ${shard.key}`);
      }
      touched.add(shard.key);
      nextRaw.set(shard.key, structuredClone(shard));
    }
    const expectedRawManifest = [...nextRaw.values()]
      .sort((left, right) => compareText(left.key, right.key))
      .map((shard) => ({ key: shard.key, digest: shard.digest }));
    if (!sameManifest(raw.manifest, expectedRawManifest)) {
      throw new Error("rust HIR graph: producer shard manifest mismatch");
    }
    if (
      rawGeneration(raw.universe.digest, expectedRawManifest) !== raw.generation
    ) {
      throw new Error("rust HIR graph: producer generation digest mismatch");
    }
    if (
      prior !== undefined &&
      raw.generation === priorRawGeneration &&
      raw.baseGeneration === priorRawGeneration &&
      raw.upserts.length === 0 &&
      raw.deletes.length === 0
    ) {
      return {
        changed: false,
        mode: "unchanged",
        snapshot: prior,
        checkpoint: checkpointOf(raw, nextRaw),
      };
    }

    const hello = helloOf(raw);
    const nodeIds = nodeIdsOf(raw, nextRaw);
    const nextGraph =
      raw.baseGeneration === null
        ? new Map<string, GraphSnapshotProtocol.IShard>()
        : new Map(this.graphShards);
    for (const key of raw.deletes) nextGraph.delete(graphKey(key));
    for (const shard of raw.upserts) {
      const adapted = adaptShard(this.root, raw, shard, nodeIds);
      nextGraph.set(adapted.key, adapted);
    }
    const metadata = metadataShard(this.root, raw, nextRaw, nodeIds);
    nextGraph.set(metadata.key, metadata);

    const sequence = (prior?.protocol?.sequence ?? 0) + 1;
    const graphManifest = [...nextGraph]
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, shard]) => ({
        key,
        digest: GraphSnapshotProtocol.shardDigest(shard),
      }));
    const begin = beginOf(raw, sequence, graphManifest, nextGraph, prior);
    const commit = commitOf(hello, begin, graphManifest, nextGraph);
    const frames: GraphSnapshotProtocol.Frame[] = [hello, begin];
    if (begin.baseGeneration === undefined) {
      for (const entry of graphManifest) {
        frames.push({
          type: "upsertShard",
          digest: entry.digest,
          shard: structuredClone(nextGraph.get(entry.key)!),
        });
      }
    } else {
      const previous = new Map(
        prior!.protocol!.shards.map((entry) => [entry.key, entry.digest]),
      );
      for (const entry of graphManifest) {
        if (previous.get(entry.key) === entry.digest) continue;
        frames.push({
          type: "upsertShard",
          digest: entry.digest,
          shard: structuredClone(nextGraph.get(entry.key)!),
        });
      }
      for (const key of previous.keys()) {
        if (!nextGraph.has(key)) frames.push({ type: "deleteShard", key });
      }
    }
    frames.push(commit);

    const fullBegin: GraphSnapshotProtocol.IBegin = {
      ...begin,
      sequence,
      baseSequence: undefined,
      baseGeneration: undefined,
    };
    const fullFrames: GraphSnapshotProtocol.Frame[] = [hello, fullBegin];
    for (const entry of graphManifest) {
      fullFrames.push({
        type: "upsertShard",
        digest: entry.digest,
        shard: structuredClone(nextGraph.get(entry.key)!),
      });
    }
    fullFrames.push({ ...commit, sequence });
    new GraphSnapshotProtocol.Store(this.root).apply(fullFrames);

    const checkpoint = checkpointOf(raw, nextRaw);
    const state: IRustGraphCacheState = {
      version: 1,
      producerCommit: this.producerCommit,
      checkpoint,
      rawShards: [...nextRaw.values()].map((shard) => structuredClone(shard)),
      frames: fullFrames,
    };
    const mode: IBulkGraphSession.Mode =
      prior === undefined
        ? "initial"
        : raw.baseGeneration === null
          ? prior.provenance.universe === raw.universe.digest
            ? "rebuild"
            : "reload"
          : "incremental";
    return {
      changed: true,
      mode,
      frames,
      state,
      sequence,
      generation: raw.generation,
      commit: (snapshot) => {
        this.rawShards = nextRaw;
        this.graphShards = nextGraph;
        this.rawGeneration = raw.generation;
        this.checkpoint = checkpoint;
        return snapshot;
      },
    };
  }

  private restore(cached: IRustGraphCacheState): void {
    if (
      cached.version !== 1 ||
      cached.producerCommit !== this.producerCommit ||
      cached.checkpoint.producer.commit !== this.producerCommit
    ) {
      throw new Error("rust HIR graph: persisted producer identity mismatch");
    }
    const rawShards = [...cached.rawShards].sort((left, right) =>
      compareText(left.key, right.key),
    );
    for (const shard of rawShards) assertRawShardPayload(shard);
    if (
      !isSortedUnique(rawShards.map((shard) => shard.key)) ||
      !rawShards.every((shard) => shard.key.endsWith(`\0${shard.source}`))
    ) {
      throw new Error("rust HIR graph: persisted raw shard identity mismatch");
    }
    const manifest = rawShards.map((shard) => ({
      key: shard.key,
      digest: shard.digest,
    }));
    const sources = [...rawShards]
      .sort((left, right) => compareText(left.source, right.source))
      .map((shard) => ({
        source: shard.source,
        checkerDigest: shard.checkerDigest,
      }));
    if (
      !sameManifest(cached.checkpoint.manifest, manifest) ||
      canonical(cached.checkpoint.sources) !== canonical(sources) ||
      canonical(cached.checkpoint.shards) !== canonical(rawShards) ||
      rawGeneration(cached.checkpoint.universe, manifest) !==
        cached.checkpoint.generation
    ) {
      throw new Error("rust HIR graph: persisted producer checkpoint is corrupt");
    }
    const snapshot = this.store.apply(cached.frames);
    if (
      snapshot.protocol?.generation !== cached.checkpoint.generation ||
      snapshot.provenance.universe !== cached.checkpoint.universe
    ) {
      throw new Error("rust HIR graph: persisted checkpoint generation mismatch");
    }
    this.rawShards = new Map(
      cached.rawShards.map((shard) => [shard.key, structuredClone(shard)]),
    );
    this.graphShards = new Map(
      cached.frames
        .filter(
          (frame): frame is GraphSnapshotProtocol.IUpsertShard =>
            frame.type === "upsertShard",
        )
        .map((frame) => [frame.shard.key, structuredClone(frame.shard)]),
    );
    this.rawGeneration = cached.checkpoint.generation;
    this.checkpoint = structuredClone(cached.checkpoint);
  }
}

export namespace RustGraphSnapshotAdapter {
  export type IPrepared =
    | {
        changed: false;
        mode: "unchanged";
        snapshot: IBulkGraphSession.ISnapshot;
        checkpoint: IRustGraphCheckpoint;
      }
    | {
        changed: true;
        mode: IBulkGraphSession.Mode;
        frames: GraphSnapshotProtocol.Frame[];
        state: IRustGraphCacheState;
        sequence: number;
        generation: string;
        commit: (
          snapshot: IBulkGraphSession.ISnapshot,
        ) => IBulkGraphSession.ISnapshot;
      };
}

function adaptShard(
  root: string,
  raw: IRustGraphSnapshot,
  shard: IRustGraphShard,
  nodeIds: ReadonlyMap<string, string>,
): GraphSnapshotProtocol.IShard {
  const source = sourceFile(root, shard.source);
  return {
    key: graphKey(shard.key),
    target: raw.universe.target,
    languages: ["rust"],
    nodes: shard.nodes
      .filter((node) => !node.external)
      .map((node) => adaptNode(root, raw, node)),
    edges: shard.edges.map((edge) => ({
      from: requireNodeId(nodeIds, edge.from, "edge source"),
      to: requireNodeId(nodeIds, edge.to, "edge target"),
      kind: edge.kind as GraphEdgeKind,
      ...(edge.evidence === null
        ? {}
        : { evidence: adaptEvidence(root, edge.evidence) }),
    })),
    diagnostics: shard.diagnostics.map((diagnostic) => ({
      file: graphFile(root, diagnostic.file),
      line: diagnostic.line,
      ...(diagnostic.column === null ? {} : { column: diagnostic.column }),
      code: diagnostic.code,
      message: diagnostic.message,
      ...(diagnostic.severity === null
        ? {}
        : {
            severity:
              diagnostic.severity as ISamchonGraphDiagnostic["severity"],
          }),
    })),
    coverage: [],
    unresolved: shard.unresolved.map((site) => ({
      provider: RUST_HIR_PROVIDER,
      language: "rust",
      target: raw.universe.target,
      universe: raw.universe.digest,
      family: site.family as GraphEdgeKind,
      evidence: adaptEvidence(root, site.evidence),
      reason: site.reason as ISamchonGraphUnresolved["reason"],
      ...(site.candidates.length === 0
        ? {}
        : {
            candidates: site.candidates.map(
              (candidate) => nodeIds.get(candidate) ?? candidate,
            ),
          }),
    })),
    sources: [
      {
        file: source,
        checkerDigest: shard.checkerDigest,
        diskDigest: "",
      },
    ],
  };
}

function metadataShard(
  root: string,
  raw: IRustGraphSnapshot,
  shards: ReadonlyMap<string, IRustGraphShard>,
  nodeIds: ReadonlyMap<string, string>,
): GraphSnapshotProtocol.IShard {
  const coverage = coverageOf(raw, shards);
  const external = new Map<string, ISamchonGraphNode>();
  for (const shard of shards.values()) {
    for (const node of shard.nodes.filter((node) => node.external)) {
      const adapted = adaptNode(root, raw, node);
      const prior = external.get(adapted.id);
      if (prior !== undefined && canonical(prior) !== canonical(adapted)) {
        throw new Error(`rust HIR graph: external node ${adapted.id} disagrees across shards`);
      }
      external.set(adapted.id, adapted);
    }
  }
  const nodes = [...external.values()].sort((left, right) =>
    compareText(left.id, right.id),
  );
  const dependencyDigest = digest(nodes);
  return {
    key: `rust-metadata:${raw.universe.digest}`,
    target: raw.universe.target,
    languages: ["rust"],
    nodes,
    edges: [],
    diagnostics: [],
    coverage,
    unresolved: [],
    sources: [
      {
        file: "bundled:///rust/dependencies",
        checkerDigest: dependencyDigest,
        diskDigest: "",
      },
      {
        file: "bundled:///rust/universe",
        checkerDigest: raw.universe.digest,
        diskDigest: "",
      },
    ],
  };
}

function coverageOf(
  raw: IRustGraphSnapshot,
  shards: ReadonlyMap<string, IRustGraphShard>,
): ISamchonGraphCoverage[] {
  let established: string | undefined;
  let rows: IRustGraphCoverage[] | undefined;
  for (const shard of shards.values()) {
    const current = canonical(
      [...shard.coverage].sort((left, right) => compareText(left.family, right.family)),
    );
    if (established !== undefined && established !== current) {
      throw new Error("rust HIR graph: shards disagree about coverage");
    }
    established = current;
    rows = shard.coverage;
  }
  if (rows === undefined) throw new Error("rust HIR graph: snapshot has no coverage");
  return [...rows]
    .sort((left, right) => compareText(left.family, right.family))
    .map((row) => ({
      provider: RUST_HIR_PROVIDER,
      language: "rust",
      target: raw.universe.target,
      family: row.family as GraphEdgeKind,
      state: row.state as ISamchonGraphCoverage["state"],
    }));
}

function adaptNode(
  root: string,
  raw: IRustGraphSnapshot,
  node: IRustGraphNode,
): ISamchonGraphNode {
  const kind = node.external ? "external_symbol" : (node.kind as GraphNodeKind);
  return {
    id: rustGraphNodeId(raw, node),
    kind,
    language: "rust",
    name: node.name,
    ...(node.qualifiedName === null
      ? {}
      : { qualifiedName: node.qualifiedName }),
    file: graphFile(root, node.file),
    external: node.external,
    ...(node.exported ? { exported: true } : {}),
    ...(node.signature === null ? {} : { signature: node.signature }),
    ...(node.evidence === null
      ? {}
      : { evidence: adaptEvidence(root, node.evidence) }),
  };
}

function nodeIdsOf(
  raw: IRustGraphSnapshot,
  shards: ReadonlyMap<string, IRustGraphShard>,
): Map<string, string> {
  const output = new Map<string, string>();
  for (const shard of shards.values()) {
    for (const node of shard.nodes) {
      const adapted = rustGraphNodeId(raw, node);
      const prior = output.get(node.id);
      if (prior !== undefined && prior !== adapted) {
        throw new Error(`rust HIR graph: native node identity disagrees ${node.id}`);
      }
      output.set(node.id, adapted);
    }
  }
  return output;
}

function rustGraphNodeId(raw: IRustGraphSnapshot, node: IRustGraphNode): string {
  const role = node.external ? "external_symbol" : (node.kind as GraphNodeKind);
  const display = node.qualifiedName ?? node.name;
  return semanticGraphNodeId(
    {
      version: 2,
      language: "rust",
      symbol: display,
      role,
      native: { key: node.id, stability: "semantic" },
      scope: { target: raw.universe.target },
      stability: "persistent",
    },
    display,
  );
}

function requireNodeId(
  nodeIds: ReadonlyMap<string, string>,
  rawId: string,
  label: string,
): string {
  const id = nodeIds.get(rawId);
  if (id === undefined) {
    throw new Error(`rust HIR graph: ${label} is absent ${rawId}`);
  }
  return id;
}

function adaptEvidence(
  root: string,
  evidence: IRustGraphEvidence,
): ISamchonGraphEvidence {
  return {
    file: graphFile(root, evidence.file),
    startLine: evidence.startLine,
    startCol: evidence.startColumn,
    endLine: evidence.endLine,
    endCol: evidence.endColumn,
  };
}

function helloOf(raw: IRustGraphSnapshot): GraphSnapshotProtocol.IHello {
  const compilerVersion =
    raw.universe.configurations
      .find((row) => row.startsWith("rustc-version="))
      ?.slice("rustc-version=".length) ?? "unavailable";
  return {
    type: "hello",
    protocolVersion: 1,
    schemaVersion: 1,
    producerSchemaVersion: raw.schemaVersion,
    provider: RUST_HIR_PROVIDER,
    producer: raw.producer.name,
    producerVersion: `${raw.producer.version} (${raw.producer.commit})`,
    compilerVersion,
    languages: ["rust"],
    authority: "analyzer",
    supportedFacts: [...RUST_HIR_FACTS],
    capabilities: [...CAPABILITIES],
  };
}

function beginOf(
  raw: IRustGraphSnapshot,
  sequence: number,
  _manifest: readonly IBulkGraphSession.IShard[],
  shards: ReadonlyMap<string, GraphSnapshotProtocol.IShard>,
  prior: IBulkGraphSession.ISnapshot | undefined,
): GraphSnapshotProtocol.IBegin {
  const sources = [...shards.values()].flatMap((shard) => shard.sources);
  const canDelta = raw.baseGeneration !== null && prior !== undefined;
  return {
    type: "begin",
    sequence,
    generation: raw.generation,
    ...(canDelta
      ? {
          baseSequence: prior.protocol!.sequence,
          baseGeneration: prior.protocol!.generation,
        }
      : {}),
    universe: raw.universe.digest,
    manifest: GraphSnapshotProtocol.manifestDigest(sources),
    targets: [raw.universe.target],
  };
}

function commitOf(
  hello: GraphSnapshotProtocol.IHello,
  begin: GraphSnapshotProtocol.IBegin,
  manifest: IBulkGraphSession.IShard[],
  shards: ReadonlyMap<string, GraphSnapshotProtocol.IShard>,
): GraphSnapshotProtocol.ICommit {
  const facts = factsOf(hello, begin, manifest, shards);
  return {
    type: "commit",
    sequence: begin.sequence,
    generation: begin.generation,
    shards: manifest,
    factDigest: GraphSnapshotProtocol.factDigest(facts),
  };
}

function factsOf(
  hello: GraphSnapshotProtocol.IHello,
  begin: GraphSnapshotProtocol.IBegin,
  manifest: readonly IBulkGraphSession.IShard[],
  shards: ReadonlyMap<string, GraphSnapshotProtocol.IShard>,
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
  const ordered = manifest.map((entry) => shards.get(entry.key)!);
  return {
    languages: ["rust"],
    nodes: ordered.flatMap((shard) => shard.nodes),
    edges: ordered.flatMap((shard) => shard.edges),
    diagnostics: ordered.flatMap((shard) => shard.diagnostics),
    coverage: ordered.flatMap((shard) => shard.coverage),
    unresolved: ordered.flatMap((shard) => shard.unresolved),
    provenance: {
      provider: hello.provider,
      authority: hello.authority,
      facts: [...hello.supportedFacts],
      schemaVersion: hello.producerSchemaVersion,
      tool: hello.producer,
      toolVersion: hello.producerVersion,
      compilerVersion: hello.compilerVersion,
      protocolVersion: hello.protocolVersion,
      universe: begin.universe,
      capabilities: [...hello.capabilities],
    },
  };
}

function checkpointOf(
  raw: IRustGraphSnapshot,
  shards: ReadonlyMap<string, IRustGraphShard>,
): IRustGraphCheckpoint {
  return {
    protocolVersion: raw.protocolVersion,
    schemaVersion: raw.schemaVersion,
    producer: structuredClone(raw.producer),
    universe: raw.universe.digest,
    generation: raw.generation,
    manifest: raw.manifest.map((entry) => ({ ...entry })),
    sources: [...shards.values()]
      .sort((left, right) => compareText(left.source, right.source))
      .map((shard) => ({
        source: shard.source,
        checkerDigest: shard.checkerDigest,
      })),
    shards: [...shards.values()]
      .sort((left, right) => compareText(left.key, right.key))
      .map((shard) => structuredClone(shard)),
  };
}

function assertSnapshot(raw: IRustGraphSnapshot, commit: string): void {
  if (raw === null || typeof raw !== "object") {
    throw new Error("rust HIR graph: response is not an object");
  }
  if (raw.protocolVersion !== 1 || raw.schemaVersion !== 1) {
    throw new Error("rust HIR graph: unsupported producer protocol/schema");
  }
  if (
    raw.producer?.name !== RUST_HIR_PRODUCER ||
    raw.producer.commit !== commit ||
    typeof raw.producer.version !== "string" ||
    raw.producer.version === ""
  ) {
    throw new Error("rust HIR graph: producer identity/commit mismatch");
  }
  assertDigest(raw.universe?.digest, "universe digest");
  assertString(raw.universe?.target, "universe target");
  assertStringArray(raw.universe?.workspaceRoots, "workspace roots");
  assertStringArray(raw.universe?.toolchains, "toolchains");
  assertStringArray(raw.universe?.configurations, "configurations");
  assertDigest(raw.generation, "generation");
  if (
    !Number.isSafeInteger(raw.sequence) ||
    raw.sequence < 1 ||
    !Array.isArray(raw.upserts) ||
    !Array.isArray(raw.deletes) ||
    !Array.isArray(raw.manifest) ||
    raw.phases === null ||
    typeof raw.phases !== "object"
  ) {
    throw new Error("rust HIR graph: malformed generation envelope");
  }
  if (
    ![
      raw.phases.semanticMillis,
      raw.phases.shardMillis,
      raw.phases.encodeMillis,
      raw.phases.totalMillis,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    typeof raw.phases.cacheHit !== "boolean"
  ) {
    throw new Error("rust HIR graph: malformed phase telemetry");
  }
  if (raw.baseGeneration !== null) assertDigest(raw.baseGeneration, "base generation");
  for (const entry of raw.manifest) {
    assertKey(entry.key, "manifest key");
    assertDigest(entry.digest, "manifest digest");
  }
  if (!isSortedUnique(raw.manifest.map((entry) => entry.key))) {
    throw new Error("rust HIR graph: manifest is not sorted and unique");
  }
  if (!isSortedUnique(raw.deletes)) {
    throw new Error("rust HIR graph: deletes are not sorted and unique");
  }
}

function assertRawShard(shard: IRustGraphShard, raw: IRustGraphSnapshot): void {
  assertRawShardPayload(shard);
  if (shard.key !== `${raw.universe.target}\0${shard.source}`) {
    throw new Error("rust HIR graph: shard key does not match its universe/source");
  }
}

function assertRawShardPayload(shard: IRustGraphShard): void {
  assertKey(shard.key, "shard key");
  assertString(shard.source, "shard source");
  assertDigest(shard.checkerDigest, "checker digest");
  assertDigest(shard.interfaceFingerprint, "interface fingerprint");
  assertDigest(shard.digest, "shard digest");
  if (rawShardDigest(shard) !== shard.digest) {
    throw new Error(`rust HIR graph: shard digest mismatch ${shard.key}`);
  }
  if (
    !Array.isArray(shard.nodes) ||
    !Array.isArray(shard.edges) ||
    !Array.isArray(shard.diagnostics) ||
    !Array.isArray(shard.coverage) ||
    !Array.isArray(shard.unresolved)
  ) {
    throw new Error("rust HIR graph: malformed shard arrays");
  }
  for (const node of shard.nodes) {
    assertNativeNodeId(node.id, "node id");
    assertString(node.name, "node name");
    assertString(node.file, "node file");
    if (
      typeof node.external !== "boolean" ||
      typeof node.exported !== "boolean"
    ) {
      throw new Error("rust HIR graph: malformed node flags");
    }
    assertNullableString(node.qualifiedName, "qualified node name");
    assertNullableString(node.signature, "node signature");
    if (!NODE_KINDS.has(node.kind as GraphNodeKind)) {
      throw new Error(`rust HIR graph: unknown node kind ${node.kind}`);
    }
    if (node.evidence !== null) assertEvidence(node.evidence);
  }
  for (const edge of shard.edges) {
    assertNativeNodeId(edge.from, "edge from");
    assertNativeNodeId(edge.to, "edge to");
    if (!GRAPH_EDGE_KINDS.includes(edge.kind as GraphEdgeKind) || edge.kind === "renders") {
      throw new Error(`rust HIR graph: unknown/unsupported edge kind ${edge.kind}`);
    }
    if (edge.evidence !== null) assertEvidence(edge.evidence);
  }
  for (const diagnostic of shard.diagnostics) {
    assertString(diagnostic.file, "diagnostic file");
    assertPositiveInteger(diagnostic.line, "diagnostic line");
    if (diagnostic.column !== null) {
      assertPositiveInteger(diagnostic.column, "diagnostic column");
    }
    assertString(diagnostic.code, "diagnostic code");
    assertString(diagnostic.message, "diagnostic message");
    if (
      diagnostic.severity !== null &&
      !DIAGNOSTIC_SEVERITIES.has(diagnostic.severity)
    ) {
      throw new Error("rust HIR graph: invalid diagnostic severity");
    }
  }
  const coverage = new Map<string, string>();
  for (const row of shard.coverage) {
    if (
      !GRAPH_EDGE_KINDS.includes(row.family as GraphEdgeKind) ||
      !COVERAGE_STATES.has(row.state) ||
      coverage.has(row.family)
    ) {
      throw new Error("rust HIR graph: malformed coverage row");
    }
    coverage.set(row.family, row.state);
  }
  if (coverage.size !== GRAPH_EDGE_KINDS.length) {
    throw new Error("rust HIR graph: incomplete coverage matrix");
  }
  for (const site of shard.unresolved) {
    if (
      !GRAPH_EDGE_KINDS.includes(site.family as GraphEdgeKind) ||
      !UNRESOLVED_REASONS.has(site.reason as ISamchonGraphUnresolved["reason"]) ||
      !Array.isArray(site.candidates) ||
      site.candidates.some(
        (candidate) =>
          typeof candidate !== "string" ||
          !candidate.startsWith("rust-hir-v1|"),
      ) ||
      new Set(site.candidates).size !== site.candidates.length
    ) {
      throw new Error("rust HIR graph: malformed unresolved site");
    }
    assertEvidence(site.evidence);
  }
}

function assertEvidence(evidence: IRustGraphEvidence): void {
  assertString(evidence.file, "evidence file");
  for (const value of [
    evidence.startLine,
    evidence.startColumn,
    evidence.endLine,
    evidence.endColumn,
  ]) {
    assertPositiveInteger(value, "evidence coordinate");
  }
  if (
    evidence.endLine < evidence.startLine ||
    (evidence.endLine === evidence.startLine &&
      evidence.endColumn < evidence.startColumn)
  ) {
    throw new Error("rust HIR graph: reversed evidence range");
  }
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

function rawGeneration(
  universe: string,
  manifest: readonly { key: string; digest: string }[],
): string {
  return digest({ universe, manifest });
}

function graphFile(root: string, file: string): string {
  if (file.startsWith("bundled:///")) return file;
  return path.relative(root, path.resolve(root, file)).split(path.sep).join("/");
}

function sourceFile(root: string, file: string): string {
  return file.startsWith("bundled:///")
    ? file
    : path.normalize(path.resolve(root, file));
}

function graphKey(rawKey: string): string {
  return `rust-shard:${digest(rawKey)}`;
}

function sameManifest(
  left: readonly { key: string; digest: string }[],
  right: readonly { key: string; digest: string }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.key === right[index]?.key && entry.digest === right[index]?.digest,
    )
  );
}

function isSortedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || compareText(values[index - 1]!, value) < 0,
  );
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value === "" || value.includes("\0")) {
    throw new Error(`rust HIR graph: invalid ${label}`);
  }
}

function assertNativeNodeId(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (!value.startsWith("rust-hir-v1|")) {
    throw new Error(`rust HIR graph: invalid ${label}`);
  }
}

function assertNullableString(
  value: unknown,
  label: string,
): asserts value is string | null {
  if (value !== null) assertString(value, label);
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`rust HIR graph: invalid ${label}`);
  }
}

function assertKey(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`rust HIR graph: invalid ${label}`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new Error(`rust HIR graph: invalid ${label}`);
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry === "") ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`rust HIR graph: invalid ${label}`);
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
