import { createHash } from "node:crypto";
import path from "node:path";

import {
  ISamchonGraphCoverage,
  ISamchonGraphEdge,
  ISamchonGraphEvidence,
  ISamchonGraphNode,
  ISamchonGraphUnresolved,
  SamchonGraphNodeModifier,
} from "../../structures";
import {
  GRAPH_EDGE_KINDS,
  GraphEdgeKind,
  GraphNodeKind,
} from "../../typings";
import { GraphSnapshotProtocol } from "../GraphSnapshotProtocol";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { semanticGraphNodeId } from "../semanticIdentity";
import { IJavaGraphSnapshot } from "./IJavaGraphSnapshot";
import { JAVA_GRAPH_FACTS } from "./JAVA_GRAPH_FACTS";
import { JAVA_GRAPH_PRODUCER } from "./JAVA_GRAPH_PRODUCER";
import { JAVA_GRAPH_PROVIDER } from "./JAVA_GRAPH_PROVIDER";

const SHA256 = /^[0-9a-f]{64}$/u;
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
const MODIFIERS = new Set<SamchonGraphNodeModifier>([
  "export",
  "default",
  "declare",
  "abstract",
  "static",
  "readonly",
  "async",
  "const",
  "public",
  "private",
  "protected",
  "internal",
  "optional",
]);
const COVERAGE_STATES = new Set<ISamchonGraphCoverage["state"]>([
  "complete",
  "partial",
  "unsupported",
]);
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

/**
 * What this route proves about itself, published so a consumer degrades
 * against a claim instead of guessing from an empty list.
 *
 * `diagnostics` is deliberately absent. The producer's own capability block
 * reports it false: javac's messages stay with the build that emitted them and
 * never reach the graph artifact, so an empty diagnostic list here means "not
 * carried", not "the build was clean".
 */
const CAPABILITIES = [
  "coverage",
  "diskDigests",
  "incremental",
  "sourceDigests",
  "universe",
  "unresolved",
];

/**
 * Turn one committed `scip-java --graph-output` artifact into a validated
 * Graph Snapshot Protocol generation.
 *
 * The producer already commits per target: each target carries its own
 * content-addressed generation and the universe it compiled against, and an
 * incremental build rewrites only the sources javac recompiled. So this
 * adapter's job is not to invent a transaction but to prove the one it was
 * handed — that every edge endpoint exists, that the coverage matrix is
 * complete for every target, that no two targets have been folded into one
 * universe — and then to express it as a delta against the generation this
 * session last published.
 */
export class JavaGraphSnapshotAdapter {
  public readonly store: GraphSnapshotProtocol.Store;

  /**
   * What the producer did to earn the last published generation.
   *
   * Read rather than inferred: a delta exists only when this adapter proved
   * the producer's identity, universe and target set had not moved and then
   * carried shards forward, which is exactly an incremental compile.
   */
  public lastMode: IBulkGraphSession.Mode = "initial";

  /** Shard key to content digest for the last generation this store kept. */
  private committed = new Map<string, string>();
  /** Canonical producer identity of the last generation, for delta fencing. */
  private identity: string | undefined;
  private sequence = 0;

  public constructor(private readonly root: string) {
    this.store = new GraphSnapshotProtocol.Store(root);
  }

  public get current(): IBulkGraphSession.ISnapshot | undefined {
    return this.store.current;
  }

  /** Validate one artifact and publish it, or leave the prior generation. */
  public apply(
    value: unknown,
    options: {
      signal?: AbortSignal | undefined;
      warnings?: readonly string[] | undefined;
      validate?: ((snapshot: IBulkGraphSession.ISnapshot) => void) | undefined;
    } = {},
  ): IBulkGraphSession.ISnapshot {
    const raw = assertSnapshot(value, this.root);
    const universe = universeOf(raw);
    // Keys cannot collide by construction: a target name is unique across the
    // artifact, a source is unique within its target, and the two kinds of key
    // carry different prefixes. Both uniqueness facts are refusals in
    // `assertSnapshot` rather than assumptions made here.
    const shards = new Map<string, GraphSnapshotProtocol.IShard>();
    for (const target of raw.targets) {
      for (const shard of targetShards(this.root, target, universe)) {
        shards.set(shard.key, shard);
      }
    }

    const digests = new Map<string, string>();
    for (const [key, shard] of shards) {
      digests.set(key, GraphSnapshotProtocol.shardDigest(shard));
    }
    const ordered = [...shards.keys()].sort(compareText);
    const manifest = ordered.map((key) => ({
      key,
      digest: digests.get(key)!,
    }));
    const hello = helloOf(raw);
    const identity = canonical(hello);
    const targets = raw.targets.map((target) => target.name);
    const prior = this.store.current;

    // A delta is only meaningful against the same producer, the same build
    // universe and the same target set. When any of those moved, every shard
    // the previous generation held is invalid whether or not its bytes are
    // identical — a source that compiles to the same facts against a different
    // classpath is a different fact, because what it proves about the rest of
    // the program has changed. That is a reload, and stating it as one is
    // cheaper than sending a delta that invalidates everything anyway.
    const canDelta =
      prior !== undefined &&
      this.identity === identity &&
      prior.provenance.universe === universe &&
      sameList(prior.protocol!.targets, targets);

    this.sequence += 1;
    const begin: GraphSnapshotProtocol.IBegin = {
      type: "begin",
      sequence: this.sequence,
      generation: generationOf(raw),
      ...(canDelta
        ? {
            baseSequence: prior.protocol!.sequence,
            baseGeneration: prior.protocol!.generation,
          }
        : {}),
      universe,
      manifest: GraphSnapshotProtocol.manifestDigest(
        ordered.flatMap((key) => shards.get(key)!.sources),
      ),
      targets,
    };

    const frames: GraphSnapshotProtocol.Frame[] = [hello, begin];
    // Only what moved. A Gradle or Maven build that recompiled one source
    // rewrites one shard, and re-sending the rest would make every refresh
    // cost a whole workspace — the thing this route exists to stop paying.
    for (const key of ordered) {
      const digest = digests.get(key)!;
      if (canDelta && this.committed.get(key) === digest) continue;
      frames.push({ type: "upsertShard", digest, shard: shards.get(key)! });
    }
    if (canDelta) {
      for (const key of [...this.committed.keys()].sort(compareText)) {
        if (!shards.has(key)) frames.push({ type: "deleteShard", key });
      }
    }
    frames.push({
      type: "commit",
      sequence: begin.sequence,
      generation: begin.generation,
      shards: manifest,
      // The store recomputes this from the generation it reconstructs and
      // refuses a commit that disagrees, so both sides have to walk the same
      // manifest in the same order. Deriving it from anything else would make
      // the check compare two different things and pass anyway.
      factDigest: GraphSnapshotProtocol.factDigest(
        assembled(hello, begin, manifest, shards),
      ),
    });

    const snapshot = this.store.apply(frames, options);
    this.lastMode =
      prior === undefined ? "initial" : canDelta ? "incremental" : "reload";
    this.committed = digests;
    this.identity = identity;
    return snapshot;
  }
}

/** Reconstruct exactly what the store will assemble, without publishing it. */
function assembled(
  hello: GraphSnapshotProtocol.IHello,
  begin: GraphSnapshotProtocol.IBegin,
  manifest: readonly IBulkGraphSession.IShard[],
  shards: ReadonlyMap<string, GraphSnapshotProtocol.IShard>,
): Parameters<typeof GraphSnapshotProtocol.factDigest>[0] {
  const nodes: ISamchonGraphNode[] = [];
  const edges: ISamchonGraphEdge[] = [];
  const coverage: ISamchonGraphCoverage[] = [];
  const unresolved: ISamchonGraphUnresolved[] = [];
  for (const entry of manifest) {
    const shard = shards.get(entry.key)!;
    nodes.push(...shard.nodes);
    edges.push(...shard.edges);
    coverage.push(...shard.coverage);
    unresolved.push(...shard.unresolved);
  }
  return {
    languages: [...hello.languages],
    nodes,
    edges,
    diagnostics: [],
    coverage,
    unresolved,
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

function helloOf(
  raw: IJavaGraphSnapshot,
): GraphSnapshotProtocol.IHello {
  return {
    type: "hello",
    protocolVersion: 1,
    schemaVersion: 1,
    producerSchemaVersion: raw.schemaVersion,
    provider: JAVA_GRAPH_PROVIDER,
    producer: raw.producer.name,
    producerVersion: raw.producer.version,
    compilerVersion: compilerVersionOf(raw),
    languages: ["java"],
    authority: "compiler",
    supportedFacts: [...JAVA_GRAPH_FACTS],
    capabilities: [...CAPABILITIES],
  };
}

/**
 * The JDKs that ran the plugin, as a set rather than a pick.
 *
 * Every shard states the `java.version` of the compiler that produced it, and
 * one build can legitimately run two — a Gradle toolchain per source set. The
 * one answer this must not give is the first shard's reading presented as the
 * build's, so distinct versions are published together and a reader can see
 * that the generation crossed a compiler boundary.
 */
function compilerVersionOf(raw: IJavaGraphSnapshot): string {
  const versions = new Set<string>();
  for (const target of raw.targets) {
    for (const shard of target.shards) versions.add(shard.compilerVersion);
  }
  return [...versions].sort(compareText).join("; ");
}

/**
 * One identity for a generation the producer committed per target.
 *
 * A build with two targets has two committed generations and no single one of
 * them identifies the pair, so this composes them. Length-prefixed, because a
 * target named `a` with generation `bc` and one named `ab` with generation `c`
 * are different builds and a plain concatenation cannot tell them apart.
 */
function generationOf(raw: IJavaGraphSnapshot): string {
  return digest(
    raw.targets.map((target) => [
      target.name,
      target.generation,
      target.universe,
    ]),
  );
}

/** The same composition over the universes alone. */
function universeOf(raw: IJavaGraphSnapshot): string {
  return digest(
    raw.targets.map((target) => [target.name, target.universe]),
  );
}

/** Every shard one committed target contributes, source shards then metadata. */
function targetShards(
  root: string,
  target: IJavaGraphSnapshot.ITarget,
  universe: string,
): GraphSnapshotProtocol.IShard[] {
  const declared = declaredNodes(root, target);
  const externals = externalNodes(target, declared);
  const shards: GraphSnapshotProtocol.IShard[] = [];
  const located = new Set<GraphEdgeKind>();
  for (const shard of target.shards) {
    const adapted = sourceShard(
      root,
      target,
      shard,
      declared,
      externals,
      universe,
    );
    for (const site of adapted.unresolved) located.add(site.family);
    shards.push(adapted);
  }
  shards.push(metadataShard(target, externals, universe, located));
  return shards;
}

/**
 * Every symbol this target declares, by the producer's canonical symbol.
 *
 * Built across the whole target before any shard is adapted, because a call in
 * one compilation unit names a method declared in another and both endpoints
 * have to resolve to the same identity. A symbol declared twice inside one
 * target is a producer defect whether or not the two records agree: javac
 * attributes one declaration per symbol, and publishing both would put the
 * same node in two shards of one generation.
 *
 * Across targets it is ordinary. One source compiled into a main and a test
 * source set is two declarations in two universes, which is exactly what
 * target-scoped identity keeps apart.
 */
function declaredNodes(
  root: string,
  target: IJavaGraphSnapshot.ITarget,
): Map<string, ISamchonGraphNode> {
  const declared = new Map<string, ISamchonGraphNode>();
  for (const shard of target.shards) {
    for (const node of shard.nodes) {
      if (declared.has(node.symbol)) {
        throw new Error(
          `javac graph: symbol ${node.symbol} is declared twice in target ${target.name}`,
        );
      }
      declared.set(node.symbol, adaptNode(root, target, node));
    }
  }
  return declared;
}

function sourceShard(
  root: string,
  target: IJavaGraphSnapshot.ITarget,
  shard: IJavaGraphSnapshot.IShard,
  declared: ReadonlyMap<string, ISamchonGraphNode>,
  externals: ReadonlyMap<string, ISamchonGraphNode>,
  universe: string,
): GraphSnapshotProtocol.IShard {
  const file = graphFile(root, shard.source);
  const nodes = shard.nodes
    .map((node) => declared.get(node.symbol)!)
    .sort((left, right) => compareText(left.id, right.id));
  const edges: ISamchonGraphEdge[] = [];
  const seen = new Set<string>();
  for (const edge of shard.edges) {
    const from = endpoint(edge.from, file, declared, externals);
    const to = endpoint(edge.to, file, declared, externals);
    // NUL-separated, the way every other edge key in this package is: a
    // project-relative path is a legal endpoint here, and POSIX allows any
    // byte but NUL in one.
    const key = `${edge.kind}\0${from}\0${to}`;
    // The producer keys its own edges by evidence as well as by endpoints, so
    // one relationship written at two call sites arrives twice. The graph's
    // triple is unique and keeps the first source-order evidence, which the
    // producer's canonical ordering makes a deterministic choice rather than
    // whichever record happened to be visited first.
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      from,
      to,
      kind: edge.kind as GraphEdgeKind,
      evidence: adaptEvidence(root, edge.evidence),
    });
  }
  return {
    key: shardKey(target.name, shard.source),
    target: target.name,
    languages: ["java"],
    nodes,
    edges,
    diagnostics: [],
    coverage: [],
    unresolved: shard.unresolved.map((site) => ({
      provider: JAVA_GRAPH_PROVIDER,
      language: "java" as const,
      target: target.name,
      // The generation's universe rather than the target's own. A snapshot
      // fences every fact against one build identity, and a multi-target
      // generation composes its targets' universes into that one — so the
      // target coordinate beside it is what says which of them the site was
      // observed in.
      universe,
      family: site.family as GraphEdgeKind,
      evidence: adaptEvidence(root, site.evidence),
      reason: site.reason as ISamchonGraphUnresolved["reason"],
      ...(site.candidates.length === 0
        ? {}
        : {
            candidates: site.candidates.map(
              (candidate) => declared.get(candidate)?.id ?? candidate,
            ),
          }),
    })),
    sources: [
      {
        file: sourcePath(root, shard.source),
        checkerDigest: shard.checkerDigest,
        diskDigest: shard.diskDigest,
      },
    ],
  };
}

/**
 * The target's coverage matrix and every endpoint outside its own compilation.
 *
 * Both belong to the target rather than to any one of its sources. Coverage
 * has to appear exactly once per target and family or the assembled generation
 * carries duplicate rows; an external symbol is named by however many sources
 * reference it and must still be one node.
 */
function metadataShard(
  target: IJavaGraphSnapshot.ITarget,
  externals: ReadonlyMap<string, ISamchonGraphNode>,
  universe: string,
  located: ReadonlySet<GraphEdgeKind>,
): GraphSnapshotProtocol.IShard {
  const nodes = [...externals.values()].sort((left, right) =>
    compareText(left.id, right.id),
  );
  const coordinate = `bundled:///java/target/${digest([target.name])}`;
  return {
    key: `java-target:${digest([target.name, target.universe])}`,
    target: target.name,
    languages: ["java"],
    nodes,
    edges: [],
    diagnostics: [],
    coverage: GRAPH_EDGE_KINDS.map((family) => ({
      provider: JAVA_GRAPH_PROVIDER,
      language: "java" as const,
      target: target.name,
      family,
      state: target.coverage[family] as ISamchonGraphCoverage["state"],
    })),
    // A partial family with nowhere to point is still a partial family, and it
    // is the one shape a reader cannot act on: "some sites are unproven" with
    // no list reads exactly like "every site is proven". The producer declares
    // several families partial as a property of the exporter rather than of
    // any one call site — a `contains` edge it cannot emit for an anonymous
    // declaration has no location to name — so the gap is published at the
    // target's own coordinate instead of being left implicit.
    unresolved: GRAPH_EDGE_KINDS.filter(
      (family) =>
        target.coverage[family] === "partial" && !located.has(family),
    ).map((family) => ({
      provider: JAVA_GRAPH_PROVIDER,
      language: "java" as const,
      target: target.name,
      universe,
      family,
      evidence: {
        file: coordinate,
        startLine: 1,
        startCol: 1,
        endLine: 1,
        endCol: 1,
      },
      reason: "provider-gap" as const,
    })),
    sources: [
      {
        file: coordinate,
        checkerDigest: target.universe,
        diskDigest: "",
      },
    ],
  };
}

/**
 * Every endpoint the target reaches but does not declare, as one node each.
 *
 * Collected across the whole target before any shard is built, because the
 * producer describes an endpoint at the site that reached it and the sites do
 * not all know the same amount. A reference javac could attribute carries the
 * element kind and both names; one it could not carries three nulls for the
 * same symbol. Resolving that per site would give one symbol two identities
 * depending on which shard was adapted first, so the description is settled
 * once, here, and the shards only look it up.
 *
 * A site that names nothing defers to one that does. Two sites that both name
 * it and disagree are a producer contradiction: one symbol is not two
 * declarations, and picking either would publish a name the compiler never
 * gave it.
 */
function externalNodes(
  target: IJavaGraphSnapshot.ITarget,
  declared: ReadonlyMap<string, ISamchonGraphNode>,
): Map<string, ISamchonGraphNode> {
  const described = new Map<string, INaming>();
  for (const shard of target.shards) {
    for (const edge of shard.edges) {
      for (const symbol of [edge.from, edge.to]) {
        if (symbol === shard.source || declared.has(symbol)) continue;
        const naming = symbol === edge.to ? namingOf(edge) : { name: symbol };
        const prior = described.get(symbol);
        if (prior === undefined || anonymous(prior, symbol)) {
          described.set(symbol, naming);
          continue;
        }
        if (anonymous(naming, symbol)) continue;
        if (
          prior.name !== naming.name ||
          prior.qualifiedName !== naming.qualifiedName
        ) {
          throw new Error(
            `javac graph: external symbol ${symbol} is named two ways in target ${target.name}`,
          );
        }
      }
    }
  }
  const externals = new Map<string, ISamchonGraphNode>();
  for (const [symbol, naming] of described) {
    const display = naming.qualifiedName ?? naming.name;
    externals.set(symbol, {
      id: semanticGraphNodeId(
        {
          version: 2,
          language: "java",
          symbol,
          role: "external_symbol",
          native: { key: symbol, stability: "semantic" },
          scope: { target: target.name },
          stability: "persistent",
        },
        display,
      ),
      kind: "external_symbol",
      language: "java",
      name: naming.name,
      ...(naming.qualifiedName === undefined
        ? {}
        : { qualifiedName: naming.qualifiedName }),
      file: "",
      external: true,
    });
  }
  return externals;
}

interface INaming {
  name: string;
  qualifiedName?: string;
}

/** What one edge says about the endpoint it points at, if anything. */
function namingOf(edge: IJavaGraphSnapshot.IEdge): INaming {
  const name =
    edge.targetName === null || edge.targetName === ""
      ? edge.to
      : edge.targetName;
  const qualifiedName =
    edge.targetQualifiedName === null || edge.targetQualifiedName === ""
      ? undefined
      : edge.targetQualifiedName;
  return qualifiedName === undefined ? { name } : { name, qualifiedName };
}

/** Whether a description says nothing the symbol did not already say. */
function anonymous(naming: INaming, symbol: string): boolean {
  return naming.name === symbol && naming.qualifiedName === undefined;
}

/**
 * Resolve one producer endpoint to a graph identity.
 *
 * Three shapes reach here. The compilation unit own path is what `contains`
 * and `exports` hang off, and it stays a file coordinate rather than becoming
 * a synthesized node: the same file compiled into two targets would otherwise
 * need two file nodes with one id. A symbol the target declares resolves to
 * that declaration. Anything else was settled by {@link externalNodes}.
 */
function endpoint(
  symbol: string,
  file: string,
  declared: ReadonlyMap<string, ISamchonGraphNode>,
  externals: ReadonlyMap<string, ISamchonGraphNode>,
): string {
  if (symbol === file) return file;
  const node = declared.get(symbol);
  // Every endpoint that is neither the source coordinate nor a declaration was
  // collected as an external node from these same edges, so the lookup cannot
  // miss without the two walks having disagreed about what an endpoint is.
  return node === undefined ? externals.get(symbol)!.id : node.id;
}

function adaptNode(
  root: string,
  target: IJavaGraphSnapshot.ITarget,
  node: IJavaGraphSnapshot.INode,
): ISamchonGraphNode {
  const qualifiedName = node.qualifiedName === "" ? undefined : node.qualifiedName;
  const display = qualifiedName ?? node.name;
  return {
    id: semanticGraphNodeId(
      {
        version: 2,
        language: "java",
        symbol: node.symbol,
        role: node.kind as GraphNodeKind,
        native: { key: node.symbol, stability: "semantic" },
        scope: { target: target.name },
        stability: "persistent",
      },
      display,
    ),
    kind: node.kind as GraphNodeKind,
    language: "java",
    name: node.name,
    ...(qualifiedName === undefined ? {} : { qualifiedName }),
    file: graphFile(root, node.file),
    external: false,
    ...(node.exported ? { exported: true } : {}),
    ...(node.modifiers.length === 0
      ? {}
      : { modifiers: [...node.modifiers] as SamchonGraphNodeModifier[] }),
    ...(node.signature === "" ? {} : { signature: node.signature }),
    evidence: adaptEvidence(root, node.evidence),
  };
}

function adaptEvidence(
  root: string,
  evidence: IJavaGraphSnapshot.IEvidence,
): ISamchonGraphEvidence {
  return {
    file: graphFile(root, evidence.file),
    startLine: evidence.startLine,
    startCol: evidence.startColumn,
    endLine: evidence.endLine,
    endCol: evidence.endColumn,
  };
}

function assertSnapshot(
  value: unknown,
  root: string,
): IJavaGraphSnapshot {
  if (!isRecord(value)) {
    throw new Error("javac graph: the graph artifact is not an object");
  }
  const raw = value as unknown as IJavaGraphSnapshot;
  if (raw.schemaVersion !== IJavaGraphSnapshot.SCHEMA_VERSION) {
    throw new Error(
      `javac graph: unsupported artifact schema ${String(raw.schemaVersion)}; this adapter reads ${String(IJavaGraphSnapshot.SCHEMA_VERSION)}`,
    );
  }
  if (!isRecord(raw.producer)) {
    throw new Error("javac graph: the artifact names no producer");
  }
  if (raw.producer.name !== JAVA_GRAPH_PRODUCER) {
    throw new Error(
      `javac graph: foreign producer ${String(raw.producer.name)}`,
    );
  }
  if (raw.producer.protocolVersion !== IJavaGraphSnapshot.PROTOCOL_VERSION) {
    throw new Error(
      `javac graph: unsupported producer protocol ${String(raw.producer.protocolVersion)}`,
    );
  }
  if (typeof raw.producer.version !== "string" || raw.producer.version === "") {
    throw new Error("javac graph: the producer states no version");
  }
  const capabilities = raw.producer.capabilities;
  if (
    !isRecord(capabilities) ||
    typeof capabilities.atomicGenerations !== "boolean" ||
    typeof capabilities.incremental !== "boolean" ||
    typeof capabilities.diagnostics !== "boolean"
  ) {
    throw new Error("javac graph: the producer states no capability block");
  }
  // Atomic generations are what the whole transaction rests on. A producer
  // that says it cannot commit one has published shards this route has no way
  // to fence, and reading them anyway would put a half-written build behind a
  // content-addressed generation identity.
  if (!capabilities.atomicGenerations) {
    throw new Error(
      "javac graph: the producer does not commit atomic generations",
    );
  }
  if (typeof raw.projectRoot !== "string" || raw.projectRoot === "") {
    throw new Error("javac graph: the artifact names no project root");
  }
  if (!samePath(raw.projectRoot, root)) {
    throw new Error(
      `javac graph: the artifact was produced for ${raw.projectRoot}, not ${root}`,
    );
  }
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    throw new Error("javac graph: the artifact committed no target");
  }
  const names = new Set<string>();
  const sources = new Set<string>();
  for (const target of raw.targets) {
    assertTarget(target, names, sources);
  }
  return raw;
}

function assertTarget(
  target: IJavaGraphSnapshot.ITarget,
  names: Set<string>,
  sources: Set<string>,
): void {
  if (
    !isRecord(target) ||
    typeof target.name !== "string" ||
    target.name === "" ||
    !SHA256.test(target.generation) ||
    !SHA256.test(target.universe) ||
    !isRecord(target.coverage) ||
    !Array.isArray(target.shards) ||
    target.shards.length === 0
  ) {
    throw new Error("javac graph: malformed committed target");
  }
  if (names.has(target.name)) {
    throw new Error(`javac graph: duplicate committed target ${target.name}`);
  }
  names.add(target.name);
  // Every family, every time. A matrix missing a row cannot be read as either
  // "complete" or "unsupported", and the difference between those two is the
  // whole reason a consumer is allowed to treat an absent edge as absence.
  const families = Object.keys(target.coverage);
  if (
    families.length !== GRAPH_EDGE_KINDS.length ||
    GRAPH_EDGE_KINDS.some(
      (family) =>
        !COVERAGE_STATES.has(
          target.coverage[family] as ISamchonGraphCoverage["state"],
        ),
    )
  ) {
    throw new Error(
      `javac graph: target ${target.name} has an incomplete coverage matrix`,
    );
  }
  // A family this route is not registered to prove cannot be claimed complete
  // by the producer either; the two statements would contradict each other in
  // the same generation.
  for (const family of GRAPH_EDGE_KINDS) {
    if (
      !JAVA_GRAPH_FACTS.includes(family) &&
      target.coverage[family] !== "unsupported"
    ) {
      throw new Error(
        `javac graph: target ${target.name} claims ${family}, which this route does not prove`,
      );
    }
  }
  for (const shard of target.shards) {
    assertShard(shard, target, sources);
  }
}

function assertShard(
  shard: IJavaGraphSnapshot.IShard,
  target: IJavaGraphSnapshot.ITarget,
  sources: Set<string>,
): void {
  if (
    !isRecord(shard) ||
    shard.schemaVersion !== IJavaGraphSnapshot.SCHEMA_VERSION ||
    shard.language !== "java" ||
    typeof shard.source !== "string" ||
    shard.source === "" ||
    !SHA256.test(shard.checkerDigest) ||
    (shard.diskDigest !== "" && !SHA256.test(shard.diskDigest)) ||
    shard.target !== target.name ||
    typeof shard.compilerVersion !== "string" ||
    shard.compilerVersion === "" ||
    !Array.isArray(shard.nodes) ||
    !Array.isArray(shard.edges) ||
    !Array.isArray(shard.unresolved)
  ) {
    throw new Error(
      `javac graph: malformed shard in target ${target.name}`,
    );
  }
  const key = `${target.name} ${shard.source}`;
  if (sources.has(key)) {
    throw new Error(
      `javac graph: source ${shard.source} is committed twice in target ${target.name}`,
    );
  }
  sources.add(key);
  const symbols = new Set<string>();
  for (const node of shard.nodes) {
    if (
      !isRecord(node) ||
      typeof node.symbol !== "string" ||
      node.symbol === "" ||
      !NODE_KINDS.has(node.kind as GraphNodeKind) ||
      typeof node.name !== "string" ||
      node.name === "" ||
      typeof node.qualifiedName !== "string" ||
      typeof node.file !== "string" ||
      node.file === "" ||
      typeof node.exported !== "boolean" ||
      !Array.isArray(node.modifiers) ||
      node.modifiers.some(
        (modifier) => !MODIFIERS.has(modifier as SamchonGraphNodeModifier),
      ) ||
      new Set(node.modifiers).size !== node.modifiers.length ||
      typeof node.signature !== "string"
    ) {
      throw new Error(
        `javac graph: malformed declaration in ${shard.source}`,
      );
    }
    if (symbols.has(node.symbol)) {
      throw new Error(
        `javac graph: duplicate declaration ${node.symbol} in ${shard.source}`,
      );
    }
    symbols.add(node.symbol);
    assertEvidence(node.evidence, shard.source);
  }
  for (const edge of shard.edges) {
    if (
      !isRecord(edge) ||
      typeof edge.from !== "string" ||
      edge.from === "" ||
      typeof edge.to !== "string" ||
      edge.to === "" ||
      !GRAPH_EDGE_KINDS.includes(edge.kind as GraphEdgeKind) ||
      !JAVA_GRAPH_FACTS.includes(edge.kind as GraphEdgeKind) ||
      !isNullableString(edge.access) ||
      !isNullableString(edge.provenance) ||
      !isNullableString(edge.targetName) ||
      !isNullableString(edge.targetQualifiedName) ||
      (edge.targetKind !== null &&
        !NODE_KINDS.has(edge.targetKind as GraphNodeKind))
    ) {
      throw new Error(`javac graph: malformed edge in ${shard.source}`);
    }
    assertEvidence(edge.evidence, shard.source);
  }
  for (const site of shard.unresolved) {
    if (
      !isRecord(site) ||
      !GRAPH_EDGE_KINDS.includes(site.family as GraphEdgeKind) ||
      !UNRESOLVED_REASONS.has(site.reason as ISamchonGraphUnresolved["reason"]) ||
      !Array.isArray(site.candidates) ||
      site.candidates.some((candidate) => typeof candidate !== "string") ||
      new Set(site.candidates).size !== site.candidates.length
    ) {
      throw new Error(
        `javac graph: malformed unresolved site in ${shard.source}`,
      );
    }
    assertEvidence(site.evidence, shard.source);
  }
}

function assertEvidence(
  evidence: IJavaGraphSnapshot.IEvidence,
  source: string,
): void {
  if (
    !isRecord(evidence) ||
    typeof evidence.file !== "string" ||
    evidence.file === "" ||
    !positiveInteger(evidence.startLine) ||
    !positiveInteger(evidence.startColumn) ||
    !positiveInteger(evidence.endLine) ||
    !positiveInteger(evidence.endColumn)
  ) {
    throw new Error(`javac graph: malformed evidence in ${source}`);
  }
}

function shardKey(target: string, source: string): string {
  return `java-shard:${digest([target, source])}`;
}

function graphFile(root: string, file: string): string {
  return path
    .relative(root, path.resolve(root, file))
    .split(path.sep)
    .join("/");
}

function sourcePath(root: string, file: string): string {
  return path.normalize(path.resolve(root, file));
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  /* c8 ignore next 3 -- only one platform arm runs on a given OS. */
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .sort(compareText)
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

function compareText(left: string, right: string): number {
  /* c8 ignore next 2 -- every collection sorted here holds distinct keys. */
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
