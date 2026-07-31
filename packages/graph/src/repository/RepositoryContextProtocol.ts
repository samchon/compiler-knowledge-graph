import { createHash } from "node:crypto";

import { ISamchonRepositoryContextDump } from "../structures";
import {
  RepositoryContextAuthority,
  RepositoryContextCoverageState,
  RepositoryContextNodeKind,
  RepositoryContextRelationKind,
} from "../typings";

/** Atomic, content-addressed repository-context shard protocol. */
export namespace RepositoryContextProtocol {
  export const VERSION = 1 as const;
  export const SCHEMA_VERSION = 1 as const;

  export const RELATION_KINDS = [
    "contains",
    "depends-on",
    "source-of",
    "test-of",
    "produces",
    "invokes",
    "entrypoint-of",
    "joins-file",
  ] as const satisfies readonly RepositoryContextRelationKind[];

  const AUTHORITIES = [
    "tool-resolved",
    "declared",
    "inferred",
  ] as const satisfies readonly RepositoryContextAuthority[];

  const COVERAGE_STATES = [
    "complete",
    "partial",
    "unsupported",
  ] as const satisfies readonly RepositoryContextCoverageState[];

  const NODE_KINDS = [
    "workspace",
    "project",
    "package",
    "source-set",
    "source-root",
    "generated-root",
    "build-target",
    "task",
    "entrypoint",
  ] as const satisfies readonly RepositoryContextNodeKind[];

  export interface IHello {
    type: "hello";
    protocolVersion: 1;
    schemaVersion: 1;
    producerSchemaVersion: number;
    provider: string;
    ecosystem: string;
    authority: RepositoryContextAuthority;
    tool: string;
    toolVersion: string;
    supportedFamilies: RepositoryContextRelationKind[];
    capabilities: string[];
  }

  export interface IBegin {
    type: "begin";
    sequence: number;
    generation: string;
    baseSequence?: number;
    baseGeneration?: string;
    inputGeneration: string;
    universe: string;
    target: string;
    manifest: string;
  }

  export interface IShard {
    key: string;
    target: string;
    nodes: ISamchonRepositoryContextDump.INode[];
    edges: ISamchonRepositoryContextDump.IEdge[];
    coverage: ISamchonRepositoryContextDump.ICoverage[];
    files: string[];
    sources: ISamchonRepositoryContextDump.ISource[];
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
    shards: ISamchonRepositoryContextDump.IShard[];
    contentDigest: string;
  }

  export type Frame =
    | IHello
    | IBegin
    | IUpsertShard
    | IDeleteShard
    | ICommit;

  export interface ISnapshot {
    hello: IHello;
    begin: IBegin;
    generation: ISamchonRepositoryContextDump.IGeneration;
    nodes: ISamchonRepositoryContextDump.INode[];
    edges: ISamchonRepositoryContextDump.IEdge[];
    coverage: ISamchonRepositoryContextDump.ICoverage[];
    files: string[];
    sources: ISamchonRepositoryContextDump.ISource[];
  }

  /** SHA-256 over a canonical JSON value. */
  export function digest(value: unknown): string {
    return createHash("sha256").update(canonical(value)).digest("hex");
  }

  export function shardDigest(shard: IShard): string {
    return digest(normalizeShard(shard));
  }

  export function manifestDigest(
    sources: readonly ISamchonRepositoryContextDump.ISource[],
  ): string {
    const unique = new Map<string, string>();
    for (const source of sources) {
      const prior = unique.get(source.file);
      if (prior !== undefined && prior !== source.digest) {
        throw new Error(
          `repository context protocol: sources disagree about ${source.file}`,
        );
      }
      unique.set(source.file, source.digest);
    }
    return digest(
      [...unique]
        .sort(([left], [right]) => compare(left, right))
        .map(([file, sourceDigest]) => ({ file, digest: sourceDigest })),
    );
  }

  export function contentDigest(
    snapshot: Pick<ISnapshot, "nodes" | "edges" | "coverage">,
  ): string {
    return digest({
      nodes: [...snapshot.nodes].sort((left, right) =>
        compare(left.id, right.id),
      ),
      edges: [...snapshot.edges].sort(compareEdges),
      coverage: [...snapshot.coverage].sort(compareCoverage),
    });
  }

  /** One-provider atomic shard store. */
  export class Store {
    private committed = new Map<string, { digest: string; shard: IShard }>();
    private identity: IHello | undefined;
    private snapshot: ISnapshot | undefined;

    public get current(): ISnapshot | undefined {
      return this.snapshot;
    }

    public apply(
      frames: readonly Frame[],
      options: { signal?: AbortSignal } = {},
    ): ISnapshot {
      throwIfAborted(options.signal);
      if (frames.length < 3) {
        throw new Error("repository context protocol: incomplete transaction");
      }
      const hello = frames[0];
      const begin = frames[1];
      const commit = frames.at(-1);
      if (hello?.type !== "hello" || begin?.type !== "begin") {
        throw new Error(
          "repository context protocol: transaction must start with hello and begin",
        );
      }
      if (commit?.type !== "commit") {
        throw new Error(
          "repository context protocol: transaction must end with commit",
        );
      }
      assertHello(hello);
      assertBegin(begin);
      if (
        commit.sequence !== begin.sequence ||
        commit.generation !== begin.generation
      ) {
        throw new Error(
          "repository context protocol: commit generation does not match begin",
        );
      }
      if (this.identity !== undefined && !sameIdentity(this.identity, hello)) {
        throw new Error(
          "repository context protocol: provider identity changed inside one store",
        );
      }
      const prior = this.snapshot?.begin;
      if (prior === undefined) {
        if (
          begin.sequence !== 1 ||
          begin.baseSequence !== undefined ||
          begin.baseGeneration !== undefined
        ) {
          throw new Error(
            "repository context protocol: initial generation must start at sequence 1 without a base",
          );
        }
      } else if (
        begin.sequence !== prior.sequence + 1 ||
        begin.baseSequence !== prior.sequence ||
        begin.baseGeneration !== prior.generation
      ) {
        throw new Error(
          "repository context protocol: delta does not extend the current generation",
        );
      }

      const next =
        prior === undefined
          ? new Map<string, { digest: string; shard: IShard }>()
          : new Map(this.committed);
      const touched = new Set<string>();
      for (const frame of frames.slice(2, -1)) {
        throwIfAborted(options.signal);
        if (frame.type === "upsertShard") {
          if (touched.has(frame.shard.key)) {
            throw new Error(
              `repository context protocol: duplicate shard delta ${frame.shard.key}`,
            );
          }
          assertShard(frame.shard, hello, begin);
          const actual = shardDigest(frame.shard);
          if (actual !== frame.digest) {
            throw new Error(
              `repository context protocol: shard digest mismatch ${frame.shard.key}`,
            );
          }
          touched.add(frame.shard.key);
          next.set(frame.shard.key, {
            digest: actual,
            shard: clone(frame.shard),
          });
        } else if (frame.type === "deleteShard") {
          if (touched.has(frame.key) || !next.has(frame.key)) {
            throw new Error(
              `repository context protocol: invalid shard deletion ${frame.key}`,
            );
          }
          touched.add(frame.key);
          next.delete(frame.key);
        } else {
          throw new Error(
            `repository context protocol: unexpected transaction frame ${frame.type}`,
          );
        }
      }

      const manifest = [...next]
        .sort(([left], [right]) => compare(left, right))
        .map(([key, value]) => ({ key, digest: value.digest }));
      if (canonical(manifest) !== canonical(commit.shards)) {
        throw new Error(
          "repository context protocol: commit shard manifest mismatch",
        );
      }
      const assembled = assemble(hello, begin, manifest, next);
      assertSnapshot(assembled);
      if (manifestDigest(assembled.sources) !== begin.manifest) {
        throw new Error(
          "repository context protocol: input manifest digest mismatch",
        );
      }
      const facts = contentDigest(assembled);
      if (facts !== commit.contentDigest) {
        throw new Error(
          "repository context protocol: content digest mismatch",
        );
      }
      throwIfAborted(options.signal);
      const published: ISnapshot = {
        ...assembled,
        generation: {
          sequence: begin.sequence,
          token: begin.generation,
          shards: manifest,
          contentDigest: facts,
        },
      };
      freeze(published);
      this.committed = next;
      this.identity = clone(hello);
      this.snapshot = published;
      return published;
    }
  }

  function assemble(
    hello: IHello,
    begin: IBegin,
    manifest: ISamchonRepositoryContextDump.IShard[],
    shards: ReadonlyMap<string, { digest: string; shard: IShard }>,
  ): ISnapshot {
    const nodes: ISamchonRepositoryContextDump.INode[] = [];
    const edges: ISamchonRepositoryContextDump.IEdge[] = [];
    const coverage: ISamchonRepositoryContextDump.ICoverage[] = [];
    const files = new Set<string>();
    const sources = new Map<string, string>();
    for (const entry of manifest) {
      const shard = shards.get(entry.key)!.shard;
      nodes.push(...clone(shard.nodes));
      edges.push(...clone(shard.edges));
      coverage.push(...clone(shard.coverage));
      for (const file of shard.files) files.add(file);
      for (const source of shard.sources) {
        const prior = sources.get(source.file);
        if (prior !== undefined && prior !== source.digest) {
          throw new Error(
            `repository context protocol: shards disagree about ${source.file}`,
          );
        }
        sources.set(source.file, source.digest);
      }
    }
    return {
      hello: clone(hello),
      begin: clone(begin),
      generation: {
        sequence: begin.sequence,
        token: begin.generation,
        shards: manifest,
        contentDigest: "",
      },
      nodes,
      edges,
      coverage,
      files: [...files].sort(compare),
      sources: [...sources]
        .sort(([left], [right]) => compare(left, right))
        .map(([file, sourceDigest]) => ({ file, digest: sourceDigest })),
    };
  }

  function assertHello(hello: IHello): void {
    if (
      hello.protocolVersion !== VERSION ||
      hello.schemaVersion !== SCHEMA_VERSION ||
      !Number.isSafeInteger(hello.producerSchemaVersion) ||
      hello.producerSchemaVersion < 1
    ) {
      throw new Error("repository context protocol: unsupported schema");
    }
    for (const value of [
      hello.provider,
      hello.ecosystem,
      hello.tool,
      hello.toolVersion,
    ]) {
      assertText(value, "hello identity");
    }
    if (!AUTHORITIES.includes(hello.authority)) {
      throw new Error("repository context protocol: unknown authority");
    }
    if (hello.authority === "inferred") {
      throw new Error(
        "repository context protocol: version 1 refuses inferred facts",
      );
    }
    assertUniqueClosed(
      hello.supportedFamilies,
      RELATION_KINDS,
      "supported family",
    );
    assertUniqueText(hello.capabilities, "capability");
  }

  function assertBegin(begin: IBegin): void {
    if (!Number.isSafeInteger(begin.sequence) || begin.sequence < 1) {
      throw new Error("repository context protocol: invalid sequence");
    }
    for (const value of [
      begin.generation,
      begin.inputGeneration,
      begin.universe,
      begin.target,
    ]) {
      assertText(value, "generation identity");
    }
    assertDigest(begin.manifest, "manifest");
    if (
      (begin.baseSequence === undefined) !==
      (begin.baseGeneration === undefined)
    ) {
      throw new Error(
        "repository context protocol: base sequence and generation must move together",
      );
    }
    if (
      begin.baseSequence !== undefined &&
      (!Number.isSafeInteger(begin.baseSequence) || begin.baseSequence < 1)
    ) {
      throw new Error("repository context protocol: invalid base sequence");
    }
    if (begin.baseGeneration !== undefined) {
      assertText(begin.baseGeneration, "base generation");
    }
  }

  function assertShard(
    shard: IShard,
    hello: IHello,
    begin: IBegin,
  ): void {
    assertText(shard.key, "shard key");
    if (shard.target !== begin.target) {
      throw new Error(
        `repository context protocol: shard target mismatch ${shard.key}`,
      );
    }
    const nodeIds = new Set<string>();
    for (const node of shard.nodes) {
      for (const value of [
        node.id,
        node.name,
        node.ecosystem,
        node.coordinate,
        node.configuration,
      ]) {
        assertText(value, "node identity");
      }
      if (node.ecosystem !== hello.ecosystem || nodeIds.has(node.id)) {
        throw new Error(
          `repository context protocol: invalid node ownership ${node.id}`,
        );
      }
      if (!NODE_KINDS.includes(node.kind)) {
        throw new Error(
          `repository context protocol: unknown node kind ${node.kind}`,
        );
      }
      if (node.root !== undefined) {
        assertText(node.root, "node root");
        if (
          node.kind !== "source-root" &&
          node.kind !== "generated-root"
        ) {
          throw new Error(
            `repository context protocol: non-root node carries root ${node.id}`,
          );
        }
      }
      if (node.file !== undefined) {
        assertText(node.file, "node file");
      }
      nodeIds.add(node.id);
      assertEvidence(node.evidence);
    }
    const edgeKeys = new Set<string>();
    for (const edge of shard.edges) {
      if (!hello.supportedFamilies.includes(edge.kind)) {
        throw new Error(
          `repository context protocol: unadvertised edge family ${edge.kind}`,
        );
      }
      assertText(edge.from, "edge source");
      assertText(edge.to, "edge target");
      const key = `${edge.kind}\0${edge.from}\0${edge.to}`;
      if (edgeKeys.has(key)) {
        throw new Error(
          `repository context protocol: duplicate edge ${edge.kind}`,
        );
      }
      edgeKeys.add(key);
      assertEvidence(edge.evidence);
    }
    const coverageKeys = new Set<string>();
    for (const row of shard.coverage) {
      if (
        row.provider !== hello.provider ||
        row.ecosystem !== hello.ecosystem ||
        row.target !== begin.target ||
        !RELATION_KINDS.includes(row.family) ||
        !COVERAGE_STATES.includes(row.state)
      ) {
        throw new Error(
          "repository context protocol: invalid coverage ownership",
        );
      }
      if (coverageKeys.has(row.family)) {
        throw new Error(
          `repository context protocol: duplicate coverage ${row.family}`,
        );
      }
      coverageKeys.add(row.family);
    }
    for (const family of RELATION_KINDS) {
      if (!coverageKeys.has(family)) {
        throw new Error(
          `repository context protocol: missing coverage ${family}`,
        );
      }
    }
    const sourceFiles = new Set<string>();
    const joinedFiles = new Set<string>();
    for (const file of shard.files) {
      assertText(file, "joined file");
      if (joinedFiles.has(file)) {
        throw new Error(
          `repository context protocol: duplicate joined file ${file}`,
        );
      }
      joinedFiles.add(file);
    }
    for (const source of shard.sources) {
      assertText(source.file, "source file");
      assertDigest(source.digest, "source");
      if (sourceFiles.has(source.file)) {
        throw new Error(
          `repository context protocol: duplicate source ${source.file}`,
        );
      }
      sourceFiles.add(source.file);
    }
  }

  function assertSnapshot(snapshot: ISnapshot): void {
    const nodes = new Set<string>();
    for (const node of snapshot.nodes) {
      if (nodes.has(node.id)) {
        throw new Error(
          `repository context protocol: duplicate assembled node ${node.id}`,
        );
      }
      nodes.add(node.id);
    }
    const files = new Set(snapshot.files);
    const edges = new Set<string>();
    for (const edge of snapshot.edges) {
      const key = `${edge.kind}\0${edge.from}\0${edge.to}`;
      if (edges.has(key)) {
        throw new Error(
          `repository context protocol: duplicate assembled edge ${edge.kind}`,
        );
      }
      edges.add(key);
      if (
        !nodes.has(edge.from) ||
        (edge.kind === "joins-file"
          ? !files.has(edge.to)
          : !nodes.has(edge.to))
      ) {
        throw new Error(
          `repository context protocol: absent edge endpoint ${edge.from} -> ${edge.to}`,
        );
      }
    }
  }

  function normalizeShard(shard: IShard): IShard {
    return {
      ...clone(shard),
      nodes: [...shard.nodes].sort((left, right) => compare(left.id, right.id)),
      edges: [...shard.edges].sort(compareEdges),
      coverage: [...shard.coverage].sort(compareCoverage),
      files: [...shard.files].sort(compare),
      sources: [...shard.sources].sort((left, right) =>
        compare(left.file, right.file),
      ),
    };
  }

  function compareEdges(
    left: ISamchonRepositoryContextDump.IEdge,
    right: ISamchonRepositoryContextDump.IEdge,
  ): number {
    return (
      compare(left.kind, right.kind) ||
      compare(left.from, right.from) ||
      compare(left.to, right.to)
    );
  }

  function compareCoverage(
    left: ISamchonRepositoryContextDump.ICoverage,
    right: ISamchonRepositoryContextDump.ICoverage,
  ): number {
    return (
      compare(left.provider, right.provider) ||
      compare(left.ecosystem, right.ecosystem) ||
      compare(left.target, right.target) ||
      compare(left.family, right.family)
    );
  }

  function sameIdentity(left: IHello, right: IHello): boolean {
    return canonical(left) === canonical(right);
  }

  function assertEvidence(
    evidence: ISamchonRepositoryContextDump.IEvidence | undefined,
  ): void {
    if (evidence === undefined) return;
    assertText(evidence.file, "evidence file");
    for (const value of [
      evidence.startLine,
      evidence.startColumn,
      evidence.endLine,
      evidence.endColumn,
    ]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new Error("repository context protocol: invalid evidence span");
      }
    }
    /* c8 ignore start -- V8 attributes an implicit iterator-completion arm to
     * this closing line; valid, absent and invalid evidence fields are tested. */
  }
  /* c8 ignore stop */

  function assertText(value: string, label: string): void {
    if (value.trim() === "" || value.includes("\0")) {
      throw new Error(`repository context protocol: invalid ${label}`);
    }
  }

  function assertDigest(value: string, label: string): void {
    if (!/^[a-f0-9]{64}$/.test(value)) {
      throw new Error(`repository context protocol: invalid ${label} digest`);
    }
  }

  function assertUniqueText(values: readonly string[], label: string): void {
    const seen = new Set<string>();
    for (const value of values) {
      assertText(value, label);
      if (seen.has(value)) {
        throw new Error(`repository context protocol: duplicate ${label}`);
      }
      seen.add(value);
    }
  }

  function assertUniqueClosed<T extends string>(
    values: readonly T[],
    allowed: readonly T[],
    label: string,
  ): void {
    assertUniqueText(values, label);
    for (const value of values) {
      if (!allowed.includes(value)) {
        throw new Error(`repository context protocol: unknown ${label}`);
      }
    }
  }

  function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new Error("repository context protocol: transaction cancelled");
    }
  }

  function canonical(value: unknown): string {
    return JSON.stringify(sortValue(value));
  }

  function sortValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => compare(left, right))
          .map(([key, child]) => [key, sortValue(child)]),
      );
    }
    return value;
  }

  function compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function clone<T>(value: T): T {
    return structuredClone(value);
  }

  function freeze(value: unknown): void {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
      return;
    }
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
}
