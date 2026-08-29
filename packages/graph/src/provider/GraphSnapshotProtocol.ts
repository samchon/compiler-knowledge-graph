import { createHash, Hash } from "node:crypto";
import path from "node:path";

import {
  ISamchonGraphCoverage,
  ISamchonGraphDiagnostic,
  ISamchonGraphEdge,
  ISamchonGraphNode,
  ISamchonGraphUnresolved,
} from "../structures";
import {
  GRAPH_EDGE_KINDS,
  GraphEdgeKind,
  GraphLanguage,
  GraphProviderAuthority,
} from "../typings";
import { freezeDeep } from "../utils/freezeDeep";
import { sealedMap } from "../utils/sealedMap";
import { assertGraphSnapshotPayload } from "./assertGraphSnapshotPayload";
import { IBulkGraphSession } from "./IBulkGraphSession";

/**
 * Versioned NDJSON producer contract for atomic, shard-based graph snapshots.
 *
 * A caller collects one complete frame transaction and applies it at once.
 * There is deliberately no partially visible state: parsing, base checks,
 * shard digests, coverage, endpoint closure and the final fact digest all pass
 * before `current` changes.
 */
export namespace GraphSnapshotProtocol {
  export const VERSION = 1;
  export const SCHEMA_VERSION = 1;

  const LANGUAGES = new Set<GraphLanguage>([
    "typescript",
    "go",
    "rust",
    "cpp",
    "c",
    "java",
    "csharp",
    "kotlin",
    "swift",
    "scala",
    "zig",
    "python",
    "ruby",
    "php",
    "lua",
    "dart",
    "unknown",
  ]);
  const AUTHORITIES = new Set<GraphProviderAuthority>([
    "compiler",
    "analyzer",
    "semantic-index",
    "navigation",
    "heuristic",
  ]);
  const FACTS = new Set<GraphEdgeKind>(GRAPH_EDGE_KINDS);
  const COVERAGE_STATES = new Set(["complete", "partial", "unsupported"]);
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

  export interface IHello {
    type: "hello";
    protocolVersion: 1;
    schemaVersion: 1;
    /** Schema version of the producer payload normalized into this protocol. */
    producerSchemaVersion: number;
    provider: string;
    producer: string;
    producerVersion: string;
    compilerVersion: string;
    languages: GraphLanguage[];
    authority: GraphProviderAuthority;
    supportedFacts: GraphEdgeKind[];
    capabilities: string[];
  }

  export interface IBegin {
    type: "begin";
    sequence: number;
    generation: string;
    baseSequence?: number;
    baseGeneration?: string;
    universe: string;
    manifest: string;
    targets: string[];
  }

  export interface ISource {
    file: string;
    checkerDigest: string;
    diskDigest: string;
  }

  export interface IShard {
    key: string;
    target: string;
    languages: GraphLanguage[];
    nodes: ISamchonGraphNode[];
    edges: ISamchonGraphEdge[];
    diagnostics: ISamchonGraphDiagnostic[];
    coverage: ISamchonGraphCoverage[];
    unresolved: ISamchonGraphUnresolved[];
    sources: ISource[];
  }

  export interface IUpsertShard {
    type: "upsertShard";
    digest: string;
    shard: IShard;
  }

  export interface IDeleteShard {
    type: "deleteShard";
    key: string;
  }

  export interface ICommit {
    type: "commit";
    sequence: number;
    generation: string;
    shards: IBulkGraphSession.IShard[];
    factDigest: string;
  }

  export type Frame = IHello | IBegin | IUpsertShard | IDeleteShard | ICommit;

  /** SHA-256 over the canonical content of one shard. */
  export function shardDigest(shard: IShard): string {
    return digest(shard);
  }

  /**
   * SHA-256 over the ordered input-file manifest carried by the shards.
   *
   * Producers include source, configuration, generated and dependency inputs
   * here. The store recomputes this digest from the reconstructed generation,
   * so `begin.manifest` is evidence rather than an unchecked producer label.
   */
  export function manifestDigest(sources: readonly ISource[]): string {
    const unique = new Map<string, ISource>();
    for (const source of sources) {
      const prior = unique.get(source.file);
      if (
        prior !== undefined &&
        (prior.checkerDigest !== source.checkerDigest ||
          prior.diskDigest !== source.diskDigest)
      ) {
        throw new Error(
          `graph snapshot protocol: input manifest disagrees about source ${source.file}`,
        );
      }
      unique.set(source.file, source);
    }
    return digest(
      [...unique.values()]
        .sort((left, right) => compareText(left.file, right.file))
        .map((source) => ({ ...source })),
    );
  }

  /**
   * SHA-256 over the complete reconstructed fact payload.
   *
   * Producer and consumer call this same function; a commit cannot substitute a
   * manifest whose shards happen to parse but reconstruct different facts.
   */
  export function factDigest(
    snapshot: Pick<
      IBulkGraphSession.ISnapshot,
      | "languages"
      | "nodes"
      | "edges"
      | "diagnostics"
      | "coverage"
      | "unresolved"
      | "provenance"
    >,
  ): string {
    return digest({
      languages: snapshot.languages,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      diagnostics: snapshot.diagnostics,
      coverage: snapshot.coverage ?? [],
      unresolved: snapshot.unresolved ?? [],
      provenance: snapshot.provenance,
    });
  }

  /** Parse a complete NDJSON transaction without accepting blank frames. */
  export function parse(text: string): Frame[] {
    if (text === "") throw new Error("graph snapshot protocol: empty stream");
    return text.split(/\r?\n/u).map((line, index) => {
      if (line === "") {
        throw new Error(
          `graph snapshot protocol: empty frame at line ${String(index + 1)}`,
        );
      }
      try {
        return JSON.parse(line) as Frame;
      } catch {
        throw new Error(
          `graph snapshot protocol: malformed JSON at line ${String(index + 1)}`,
        );
      }
    });
  }

  function digest(value: unknown): string {
    // Written into the hash as it is made. A generation's fact digest covers
    // every node and edge in it, and on a project of any size the text of
    // that is longer than a string is allowed to be -- a limit of the runtime
    // rather than of the thing being proved. The bytes are the same either
    // way, so the digests are the ones already published.
    const hash = createHash("sha256");
    canonicalInto(hash, value);
    return hash.digest("hex");
  }

  /**
   * One fact's canonical text, remembered against the fact itself.
   *
   * Shards share the entities they name -- a header's declaration is one
   * object that four hundred shards point at -- so digesting a generation
   * shard by shard walked the same objects once per naming. On libuv that was
   * six and a half million serializations of thirty-eight thousand entities,
   * and it cost more than the walk that produced them.
   *
   * Keyed by identity, so an entity that is genuinely rebuilt is a different
   * key and gets its own text, and held weakly, so remembering it keeps
   * nothing alive that the generation has let go.
   */
  const remembered = new WeakMap<object, string>();

  function canonicalInto(hash: Hash, value: unknown, depth = 0): void {
    if (value === null || typeof value !== "object") {
      hash.update(JSON.stringify(value));
      return;
    }
    // Only inside a lane, never the shard or snapshot itself: the root is
    // named once and its text is the whole generation, which is the string
    // this deliberately never builds.
    if (depth >= 2) {
      const known = remembered.get(value);
      if (known !== undefined) {
        hash.update(known);
        return;
      }
      const text = canonical(value);
      remembered.set(value, text);
      hash.update(text);
      return;
    }
    if (Array.isArray(value)) {
      hash.update("[");
      for (let index = 0; index < value.length; ++index) {
        if (index !== 0) hash.update(",");
        canonicalInto(hash, value[index], depth + 1);
      }
      hash.update("]");
      return;
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort(compareText);
    hash.update("{");
    for (let index = 0; index < keys.length; ++index) {
      if (index !== 0) hash.update(",");
      const key = keys[index]!;
      hash.update(`${JSON.stringify(key)}:`);
      canonicalInto(hash, object[key], depth + 1);
    }
    hash.update("}");
  }

  function canonical(value: unknown): string {
    if (value === null || typeof value !== "object")
      return JSON.stringify(value);
    if (Array.isArray(value))
      return `[${value.map((entry) => canonical(entry)).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }

  function compareText(left: string, right: string): number {
    // Two-way: canonical object keys and shard-manifest keys are distinct by
    // construction, so the equal arm cannot run and an ignore directive over it
    // would take the two reachable arms out of the coverage gate with it.
    return left < right ? -1 : 1;
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

  /**
   * Atomic shard store for one provider.
   *
   * Failed transactions throw without modifying `current`, `generation`, or
   * the committed shard set.
   */
  export class Store {
    private committed = new Map<string, ICommittedShard>();
    // The same shards as `committed`, without the digest beside them, so a
    // caller reading them costs a map of references rather than a rebuild.
    private published = new Map<string, IShard>();
    private identity: IHello | undefined;
    private readonly root: string;
    private snapshot: IBulkGraphSession.ISnapshot | undefined;

    /** Project root used to bind relative fact evidence to source digests. */
    public constructor(root: string) {
      this.root = path.resolve(root);
    }

    public get current(): IBulkGraphSession.ISnapshot | undefined {
      return this.snapshot;
    }

    /**
     * The shards of the committed generation, by key.
     *
     * A route that builds the next generation from the previous one needs the
     * shards that did not change, and it was keeping its own copy of every one
     * of them beside this store's. On a 242 translation-unit C project that
     * second copy is gigabytes of the same objects.
     *
     * Read-only, and meant to be read: these are the published generation, and
     * a caller that mutates one corrupts a generation this store has already
     * promised is immutable. Handing them to `apply` is safe -- it deep-clones
     * everything it retains, so the next generation never shares structure
     * with this one.
     */
    public get shards(): ReadonlyMap<string, IShard> {
      return this.published;
    }

    /**
     * Commit one transaction.
     *
     * `adopt` hands the frames' shards to this store instead of copying them.
     * The copy exists because a published generation cannot share structure
     * with a caller that still holds a reference and might write through it,
     * so a caller may only adopt when it drops every reference it has as this
     * returns. On a 469-shard generation the copy is a second whole graph,
     * held at the moment the caller is still holding the first.
     */
    public apply(
      frames: readonly Frame[],
      options: {
        signal?: AbortSignal;
        warnings?: readonly string[];
        validate?: (snapshot: IBulkGraphSession.ISnapshot) => void;
        adopt?: boolean;
      } = {},
    ): IBulkGraphSession.ISnapshot {
      throwIfAborted(options.signal);
      if (frames.length < 3) {
        throw new Error("graph snapshot protocol: incomplete transaction");
      }
      const hello = frames[0];
      const begin = frames[1];
      const commit = frames.at(-1);
      if (hello?.type !== "hello") {
        throw new Error(
          "graph snapshot protocol: transaction must start with hello",
        );
      }
      if (begin?.type !== "begin") {
        throw new Error(
          "graph snapshot protocol: hello must be followed by begin",
        );
      }
      if (commit?.type !== "commit") {
        throw new Error(
          "graph snapshot protocol: transaction must end with commit",
        );
      }
      assertHello(hello);
      assertBegin(begin);
      if (
        commit.sequence !== begin.sequence ||
        commit.generation !== begin.generation
      ) {
        throw new Error(
          "graph snapshot protocol: commit generation does not match begin",
        );
      }
      const priorGeneration = this.snapshot?.protocol?.generation;
      const priorSequence = this.snapshot?.protocol?.sequence;
      if (
        begin.baseGeneration !== undefined &&
        (begin.baseSequence !== priorSequence ||
          begin.baseGeneration !== priorGeneration)
      ) {
        throw new Error("graph snapshot protocol: stale base generation");
      }
      if (priorSequence !== undefined && begin.sequence <= priorSequence) {
        throw new Error(
          "graph snapshot protocol: generation sequence did not advance",
        );
      }
      if (
        begin.baseGeneration !== undefined &&
        this.identity !== undefined &&
        !sameIdentity(this.identity, hello)
      ) {
        throw new Error(
          "graph snapshot protocol: producer identity changed across a delta",
        );
      }

      const next =
        begin.baseGeneration === undefined
          ? new Map<string, ICommittedShard>()
          : new Map(this.committed);
      const touched = new Set<string>();
      const invalidated = new Set<string>();
      for (const frame of frames.slice(2, -1)) {
        throwIfAborted(options.signal);
        if (frame.type === "upsertShard") {
          if (touched.has(frame.shard.key)) {
            throw new Error(
              `graph snapshot protocol: duplicate shard delta: ${frame.shard.key}`,
            );
          }
          touched.add(frame.shard.key);
          assertShard(frame.shard, hello, begin);
          const digest = shardDigest(frame.shard);
          if (frame.digest !== digest) {
            throw new Error(
              `graph snapshot protocol: shard digest mismatch: ${frame.shard.key}`,
            );
          }
          if (this.committed.get(frame.shard.key)?.digest !== digest) {
            invalidated.add(frame.shard.key);
          }
          next.set(frame.shard.key, {
            digest,
            shard: options.adopt === true ? frame.shard : clone(frame.shard),
          });
        } else if (frame.type === "deleteShard") {
          assertString(frame.key, "deleteShard.key");
          if (touched.has(frame.key)) {
            throw new Error(
              `graph snapshot protocol: duplicate shard delta: ${frame.key}`,
            );
          }
          touched.add(frame.key);
          if (!next.delete(frame.key)) {
            throw new Error(
              `graph snapshot protocol: deleted shard does not exist: ${frame.key}`,
            );
          }
          invalidated.add(frame.key);
        } else {
          throw new Error(
            `graph snapshot protocol: unexpected ${frame.type} inside transaction`,
          );
        }
      }
      if (
        begin.baseGeneration !== undefined &&
        this.snapshot !== undefined &&
        begin.manifest !== this.snapshot.protocol!.manifest &&
        invalidated.size === 0
      ) {
        throw new Error(
          "graph snapshot protocol: manifest movement reported no shard delta",
        );
      }
      if (
        begin.baseGeneration !== undefined &&
        this.snapshot !== undefined &&
        (begin.universe !== this.snapshot.provenance.universe ||
          !sameList(begin.targets, this.snapshot.protocol!.targets))
      ) {
        const retained = [...this.committed.keys()].find(
          (key) => !invalidated.has(key),
        );
        if (retained !== undefined) {
          throw new Error(
            `graph snapshot protocol: universe or target movement retained shard ${retained}`,
          );
        }
      }

      const expectedManifest = [...next]
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, value]) => ({ key, digest: value.digest }));
      if (!equalManifest(commit.shards, expectedManifest)) {
        throw new Error(
          "graph snapshot protocol: commit shard manifest mismatch",
        );
      }
      const assembled = assemble(
        hello,
        begin,
        commit,
        expectedManifest,
        next,
        options.warnings ?? [],
      );
      assertAssembledFacts(assembled, hello);
      if (
        manifestDigest(
          [...assembled.sources].map(([file, source]) => ({
            file,
            checkerDigest: source.checkerDigest,
            diskDigest: source.diskDigest,
          })),
        ) !== begin.manifest
      ) {
        throw new Error(
          "graph snapshot protocol: input manifest digest mismatch",
        );
      }
      if (factDigest(assembled) !== commit.factDigest) {
        throw new Error("graph snapshot protocol: commit fact digest mismatch");
      }
      assertCompleteCoverage(assembled, hello, begin);
      assertGraphSnapshotPayload(
        assembled,
        this.root,
        `graph snapshot protocol: provider "${hello.provider}"`,
      );
      throwIfAborted(options.signal);
      freezeDeep(assembled, "the graph snapshot protocol generation");
      options.validate?.(assembled);
      throwIfAborted(options.signal);
      this.committed = next;
      this.published = new Map(
        [...next].map(([key, entry]) => [key, entry.shard]),
      );
      this.identity = clone(hello);
      this.snapshot = assembled;
      return assembled;
    }
  }

  interface ICommittedShard {
    digest: string;
    shard: IShard;
  }

  /**
   * Fold shards' node, edge and diagnostic lanes into one graph.
   *
   * Exposed because a provider that composes a generation without the store
   * -- one that was handed every frame at once rather than streamed them --
   * has to arrive at the same graph. A rule about what a node id means
   * cannot hold in one composition path and not the other.
   */
  export function fold(shards: readonly IShard[]): {
    nodes: ISamchonGraphNode[];
    edges: ISamchonGraphEdge[];
    diagnostics: ISamchonGraphDiagnostic[];
  } {
    const nodes: ISamchonGraphNode[] = [];
    const edges: ISamchonGraphEdge[] = [];
    const diagnostics: ISamchonGraphDiagnostic[] = [];
    const seenNodes = new Set<string>();
    const seenEdges = new Set<string>();
    const seenDiagnostics = new Set<string>();
    for (const shard of shards) {
      for (const node of shard.nodes) foldNode(nodes, seenNodes, node);
      for (const edge of shard.edges) foldEdge(edges, seenEdges, edge);
      for (const row of shard.diagnostics)
        foldDiagnostic(diagnostics, seenDiagnostics, row);
    }
    return { nodes, edges, diagnostics };
  }

  /**
   * Keep one node per identity across the shards that name it.
   *
   * A node id names an entity, and an entity a shard did not invent -- a
   * function declared in a header -- is named by every shard whose unit read
   * that header. Concatenating shard arrays therefore held one copy of every
   * header's facts per including unit, which is the size of how often a
   * project is read rather than the size of what it declares.
   *
   * The first instance is kept, because a provider that publishes an entity
   * from two shards publishes the same entity: settling what each of them
   * knows about it is the provider's own business, done while its generation
   * is still being adapted, not something to redo here from what survived.
   */
  function foldNode(
    nodes: ISamchonGraphNode[],
    seen: Set<string>,
    node: ISamchonGraphNode,
  ): void {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    nodes.push(node);
    // Kept, not compared: a provider that publishes the same node from two
    // shards publishes the same node.
  }

  /** Keep one edge per endpoint pair and kind, for the same reason. */
  function foldEdge(
    edges: ISamchonGraphEdge[],
    seen: Set<string>,
    edge: ISamchonGraphEdge,
  ): void {
    const key = [edge.kind, edge.from, edge.to].join(String.fromCharCode(0));
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  }

  /**
   * Keep one diagnostic per place and message.
   *
   * A warning in a header is reported by every unit that compiles it. It is
   * one warning about one line, and repeating it once per including unit
   * tells a reader nothing it did not already know.
   */
  function foldDiagnostic(
    diagnostics: ISamchonGraphDiagnostic[],
    seen: Set<string>,
    row: ISamchonGraphDiagnostic,
  ): void {
    const key = [
      row.file,
      row.line,
      row.column,
      row.code,
      row.severity,
      row.message,
    ].join(String.fromCharCode(0));
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(row);
  }

  function assemble(
    hello: IHello,
    begin: IBegin,
    commit: ICommit,
    manifest: IBulkGraphSession.IShard[],
    shards: ReadonlyMap<string, ICommittedShard>,
    warnings: readonly string[],
  ): IBulkGraphSession.ISnapshot {
    const nodes: ISamchonGraphNode[] = [];
    const edges: ISamchonGraphEdge[] = [];
    const diagnostics: ISamchonGraphDiagnostic[] = [];
    const coverage: ISamchonGraphCoverage[] = [];
    const unresolved: ISamchonGraphUnresolved[] = [];
    const sources = new Map<string, IBulkGraphSession.ISourceDigest>();
    const seenNodes = new Set<string>();
    const seenEdges = new Set<string>();
    const seenDiagnostics = new Set<string>();
    for (const entry of manifest) {
      const shard = shards.get(entry.key)!.shard;
      for (const node of shard.nodes) foldNode(nodes, seenNodes, node);
      for (const edge of shard.edges) foldEdge(edges, seenEdges, edge);
      for (const row of shard.diagnostics)
        foldDiagnostic(diagnostics, seenDiagnostics, row);
      coverage.push(...shard.coverage);
      unresolved.push(...shard.unresolved);
      for (const source of shard.sources) {
        const value = {
          checkerDigest: source.checkerDigest,
          diskDigest: source.diskDigest,
        };
        const prior = sources.get(source.file);
        if (
          prior !== undefined &&
          (prior.checkerDigest !== value.checkerDigest ||
            prior.diskDigest !== value.diskDigest)
        ) {
          throw new Error(
            `graph snapshot protocol: shards disagree about source ${source.file}`,
          );
        }
        sources.set(source.file, value);
      }
    }
    return {
      languages: [...hello.languages],
      nodes,
      edges,
      diagnostics,
      sources: sealedMap(
        sources,
        "the graph snapshot protocol source manifest",
      ),
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
      coverage,
      unresolved,
      protocol: {
        version: VERSION,
        sequence: begin.sequence,
        generation: begin.generation,
        ...(begin.baseGeneration !== undefined
          ? {
              baseSequence: begin.baseSequence,
              baseGeneration: begin.baseGeneration,
            }
          : {}),
        manifest: begin.manifest,
        targets: [...begin.targets],
        shards: manifest.map((entry) => ({ ...entry })),
        factDigest: commit.factDigest,
      },
      warnings: [...warnings],
    };
  }

  function assertHello(hello: IHello): void {
    if (hello.protocolVersion !== VERSION) {
      throw new Error(
        `graph snapshot protocol: unsupported version ${String(hello.protocolVersion)}`,
      );
    }
    if (hello.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        `graph snapshot protocol: unsupported schema version ${String(hello.schemaVersion)}`,
      );
    }
    if (
      !Number.isSafeInteger(hello.producerSchemaVersion) ||
      hello.producerSchemaVersion < 1
    ) {
      throw new Error(
        "graph snapshot protocol: invalid producer schema version",
      );
    }
    assertString(hello.provider, "hello.provider");
    assertString(hello.producer, "hello.producer");
    assertString(hello.producerVersion, "hello.producerVersion");
    assertString(hello.compilerVersion, "hello.compilerVersion");
    assertUnique(hello.languages, "hello.languages");
    if (
      hello.languages.length === 0 ||
      hello.languages.some((language) => !LANGUAGES.has(language))
    ) {
      throw new Error("graph snapshot protocol: hello languages are invalid");
    }
    assertUnique(hello.supportedFacts, "hello.supportedFacts");
    if (hello.supportedFacts.some((fact) => !FACTS.has(fact))) {
      throw new Error("graph snapshot protocol: hello facts are invalid");
    }
    if (!AUTHORITIES.has(hello.authority)) {
      throw new Error("graph snapshot protocol: hello authority is invalid");
    }
    assertUnique(hello.capabilities, "hello.capabilities");
    if (hello.capabilities.some((capability) => capability === "")) {
      throw new Error(
        "graph snapshot protocol: hello capabilities are invalid",
      );
    }
  }

  function assertBegin(begin: IBegin): void {
    if (!Number.isSafeInteger(begin.sequence) || begin.sequence < 1) {
      throw new Error("graph snapshot protocol: invalid begin.sequence");
    }
    assertString(begin.generation, "begin.generation");
    if (
      (begin.baseSequence === undefined) !==
      (begin.baseGeneration === undefined)
    ) {
      throw new Error(
        "graph snapshot protocol: base sequence and generation must appear together",
      );
    }
    if (begin.baseGeneration !== undefined) {
      if (
        !Number.isSafeInteger(begin.baseSequence) ||
        begin.baseSequence! < 1 ||
        begin.baseSequence! >= begin.sequence
      ) {
        throw new Error("graph snapshot protocol: invalid begin.baseSequence");
      }
      assertString(begin.baseGeneration, "begin.baseGeneration");
    }
    assertDigest(begin.universe, "begin.universe");
    assertDigest(begin.manifest, "begin.manifest");
    assertUnique(begin.targets, "begin.targets");
    for (const target of begin.targets) assertString(target, "begin.targets");
    if (begin.targets.length === 0) {
      throw new Error("graph snapshot protocol: begin targets are empty");
    }
  }

  function assertShard(shard: IShard, hello: IHello, begin: IBegin): void {
    assertString(shard.key, "shard.key");
    if (!begin.targets.includes(shard.target)) {
      throw new Error(
        `graph snapshot protocol: shard ${shard.key} has an unknown target`,
      );
    }
    assertUnique(shard.languages, `shard ${shard.key} languages`);
    if (
      shard.languages.length === 0 ||
      shard.languages.some((language) => !hello.languages.includes(language))
    ) {
      throw new Error(
        `graph snapshot protocol: shard ${shard.key} has invalid languages`,
      );
    }
    const nodeIds = new Set<string>();
    for (const node of shard.nodes) {
      if (nodeIds.has(node.id)) {
        throw new Error(
          `graph snapshot protocol: shard ${shard.key} duplicated node ${node.id}`,
        );
      }
      nodeIds.add(node.id);
      if (!shard.languages.includes(node.language)) {
        throw new Error(
          `graph snapshot protocol: shard ${shard.key} published a foreign-language node`,
        );
      }
    }
    const edgeKeys = new Set<string>();
    for (const edge of shard.edges) {
      const key = `${edge.kind}\0${edge.from}\0${edge.to}`;
      if (edgeKeys.has(key)) {
        throw new Error(
          `graph snapshot protocol: shard ${shard.key} duplicated edge ${key}`,
        );
      }
      edgeKeys.add(key);
    }
    const sourceFiles = new Set<string>();
    for (const source of shard.sources) {
      assertString(source.file, `shard ${shard.key} source file`);
      if (!isCanonicalSource(source.file)) {
        throw new Error(
          `graph snapshot protocol: shard ${shard.key} has a non-canonical source identity`,
        );
      }
      if (sourceFiles.has(source.file)) {
        throw new Error(
          `graph snapshot protocol: shard ${shard.key} duplicated source ${source.file}`,
        );
      }
      sourceFiles.add(source.file);
      assertDigest(
        source.checkerDigest,
        `shard ${shard.key} source checker digest`,
      );
      if (source.diskDigest !== "") {
        assertDigest(
          source.diskDigest,
          `shard ${shard.key} source disk digest`,
        );
      }
    }
  }

  function assertCompleteCoverage(
    snapshot: IBulkGraphSession.ISnapshot,
    hello: IHello,
    begin: IBegin,
  ): void {
    const rows = new Map<string, ISamchonGraphCoverage>();
    for (const row of snapshot.coverage!) {
      if (
        row.provider !== hello.provider ||
        !hello.languages.includes(row.language) ||
        !begin.targets.includes(row.target) ||
        !FACTS.has(row.family) ||
        !COVERAGE_STATES.has(row.state)
      ) {
        throw new Error(
          "graph snapshot protocol: coverage row has foreign ownership",
        );
      }
      const key = coverageKey(row);
      if (rows.has(key)) {
        throw new Error(
          `graph snapshot protocol: duplicate coverage row ${key}`,
        );
      }
      rows.set(key, row);
    }
    for (const target of begin.targets)
      for (const language of hello.languages)
        for (const family of GRAPH_EDGE_KINDS) {
          const key = coverageKey({
            provider: hello.provider,
            language,
            target,
            family,
          });
          const row = rows.get(key);
          if (row === undefined) {
            throw new Error(
              `graph snapshot protocol: missing coverage row ${key}`,
            );
          }
          if (
            row.state !== "unsupported" &&
            !hello.supportedFacts.includes(family)
          ) {
            throw new Error(
              `graph snapshot protocol: unadvertised family is not unsupported: ${key}`,
            );
          }
        }
    const unresolvedKeys = new Set<string>();
    const unresolvedCoverage = new Set<string>();
    for (const site of snapshot.unresolved!) {
      if (!UNRESOLVED_REASONS.has(site.reason)) {
        throw new Error(
          "graph snapshot protocol: unresolved site has an invalid reason",
        );
      }
      assertUnique(site.candidates ?? [], "unresolved candidates");
      if (site.universe !== begin.universe) {
        throw new Error(
          "graph snapshot protocol: unresolved site has a foreign universe",
        );
      }
      const row = rows.get(
        coverageKey({
          provider: site.provider,
          language: site.language,
          target: site.target,
          family: site.family,
        }),
      );
      if (row?.state !== "partial") {
        throw new Error(
          "graph snapshot protocol: unresolved site lacks partial coverage",
        );
      }
      unresolvedCoverage.add(coverageKey(site));
      const key = canonical(site);
      if (unresolvedKeys.has(key)) {
        throw new Error("graph snapshot protocol: duplicate unresolved site");
      }
      unresolvedKeys.add(key);
    }
    for (const [key, row] of rows) {
      if (row.state === "partial" && !unresolvedCoverage.has(key)) {
        throw new Error(
          `graph snapshot protocol: partial coverage lacks unresolved evidence: ${key}`,
        );
      }
    }
  }

  function assertAssembledFacts(
    snapshot: IBulkGraphSession.ISnapshot,
    hello: IHello,
  ): void {
    // Uniqueness is not checked here. The assembled lanes come from `fold`,
    // which keeps one node per id and one edge per endpoint pair by
    // construction, so a check for duplicates could only ever pass -- and a
    // check that cannot fail says nothing about the thing it guards.
    const nodeIds = new Set<string>();
    const files = new Set(snapshot.sources.keys());
    for (const node of snapshot.nodes) {
      nodeIds.add(node.id);
      if (node.file !== "") files.add(node.file);
    }
    for (const edge of snapshot.edges) {
      if (!hello.supportedFacts.includes(edge.kind)) {
        throw new Error(
          `graph snapshot protocol: assembled edge uses unadvertised family ${String(edge.kind)}`,
        );
      }
      if (
        (!nodeIds.has(edge.from) && !files.has(edge.from)) ||
        (!nodeIds.has(edge.to) && !files.has(edge.to))
      ) {
        throw new Error(
          `graph snapshot protocol: assembled edge has an absent endpoint: ${edge.from} -> ${edge.to}`,
        );
      }
    }
  }

  function coverageKey(
    row: Pick<
      ISamchonGraphCoverage,
      "provider" | "language" | "target" | "family"
    >,
  ): string {
    return `${row.provider}\0${row.language}\0${row.target}\0${row.family}`;
  }

  function equalManifest(
    left: readonly IBulkGraphSession.IShard[],
    right: readonly IBulkGraphSession.IShard[],
  ): boolean {
    return (
      left.length === right.length &&
      left.every(
        (entry, index) =>
          entry.key === right[index]?.key &&
          entry.digest === right[index]?.digest,
      )
    );
  }

  function sameIdentity(left: IHello, right: IHello): boolean {
    return canonical(left) === canonical(right);
  }

  function assertUnique<T>(values: readonly T[], label: string): void {
    if (new Set(values).size !== values.length) {
      throw new Error(`graph snapshot protocol: ${label} contains duplicates`);
    }
  }

  function assertString(value: string, label: string): void {
    if (value === "" || value.includes("\0")) {
      throw new Error(`graph snapshot protocol: invalid ${label}`);
    }
  }

  function assertDigest(value: string, label: string): void {
    if (!/^[a-f0-9]{64}$/u.test(value)) {
      throw new Error(`graph snapshot protocol: invalid ${label}`);
    }
  }

  function isCanonicalSource(file: string): boolean {
    if (!file.startsWith("bundled:///")) {
      return path.isAbsolute(file) && path.normalize(file) === file;
    }
    const relative = file.slice("bundled:///".length);
    return (
      relative !== "" &&
      !relative.includes("\\") &&
      path.posix.normalize(relative) === relative &&
      relative
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== "..")
    );
  }

  function clone<T>(value: T): T {
    return structuredClone(value);
  }

  function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted !== true) return;
    const error = new Error("graph snapshot protocol: transaction was aborted");
    error.name = "AbortError";
    throw error;
  }
}
