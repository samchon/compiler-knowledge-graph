import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import path from "node:path";

import { ISamchonGraphCoverage } from "../../structures";
import { GRAPH_EDGE_KINDS } from "../../typings";
import { GraphSnapshotProtocol } from "../GraphSnapshotProtocol";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { adaptTtscGraphDump } from "./adaptTtscGraphDump";
import { ITtscGraphSnapshot } from "./ITtscGraphSnapshot";

interface INativeShard {
  key: string;
  source?: Record<string, unknown>;
  config?: Record<string, unknown>;
  nodes: unknown[];
  edges: unknown[];
  diagnostics: unknown[];
}

interface INativeTransaction {
  protocolVersion: number;
  schemaVersion: number;
  project: string;
  tsconfig: string;
  producer: Record<string, unknown>;
  capabilities: string[];
  universe: Record<string, unknown>;
  sequence: number;
  generation: string;
  baseSequence?: number;
  baseGeneration?: string;
  upserts: {
    digest: string;
    shard: INativeShard;
    rawShard: Record<string, unknown>;
  }[];
  deletes: string[];
  manifest: { key: string; digest: string }[];
}

interface ICommittedNativeShard {
  digest: string;
  shard: INativeShard;
}

/** Validates native ttsc shards and maps only their deltas into common shards. */
export class TtscGraphSnapshotStore {
  public static readonly VERSION = 1;

  private sequence: number | undefined;
  private generation: string | undefined;
  private project: string | undefined;
  private tsconfig: string | undefined;
  private native = new Map<string, ICommittedNativeShard>();
  private normalized = new Map<string, GraphSnapshotProtocol.IShard>();

  public constructor(private readonly root: string) {}

  /** A new native child owns a new sequence space and must start completely. */
  public reset(): void {
    this.sequence = undefined;
    this.generation = undefined;
    this.project = undefined;
    this.tsconfig = undefined;
    this.native = new Map();
    this.normalized = new Map();
  }

  /**
   * Prepare one atomic common-protocol transaction without publishing native
   * state. The caller commits only after the common store and product validator
   * have accepted the same generation.
   */
  public prepare(
    input: unknown,
    options: {
      sequence: number;
      previous?: IBulkGraphSession.ISnapshot;
    },
  ): TtscGraphSnapshotStore.IPrepared {
    const transaction = transactionOf(input);
    this.assertCoordinates(transaction);
    const touched = new Set<string>();
    const nextNative =
      transaction.baseGeneration === undefined
        ? new Map<string, ICommittedNativeShard>()
        : new Map(this.native);
    for (const key of transaction.deletes) {
      assertShardKey(key);
      if (touched.has(key)) duplicateTouch(key);
      touched.add(key);
      if (!nextNative.delete(key)) {
        throw new Error(
          `ttscgraph: native transaction deletes unknown shard ${key}`,
        );
      }
    }
    for (const upsert of transaction.upserts) {
      assertShardKey(upsert.shard.key);
      if (touched.has(upsert.shard.key)) duplicateTouch(upsert.shard.key);
      touched.add(upsert.shard.key);
      const digest = nativeDigest(upsert.rawShard);
      if (digest !== upsert.digest) {
        throw new Error(
          `ttscgraph: native shard ${upsert.shard.key} digest ` +
            `${upsert.digest} does not match ${digest}`,
        );
      }
      nextNative.set(upsert.shard.key, {
        digest,
        shard: upsert.shard,
      });
    }
    assertNativeManifest(transaction, nextNative);
    assertNativeGeneration(transaction);
    const nodeById = assertNativeGenerationFacts(transaction, nextNative);

    const provenance = nativeProvenance(transaction, nextNative);
    const metadata = adaptTtscGraphDump(
      {
        project: transaction.project,
        tsconfig: transaction.tsconfig,
        provenance,
        diagnostics: [],
        nodes: [],
        edges: [],
      },
      this.root,
    );
    const nextNormalized =
      transaction.baseGeneration === undefined
        ? new Map<string, GraphSnapshotProtocol.IShard>()
        : new Map(this.normalized);
    for (const key of transaction.deletes) nextNormalized.delete(key);
    for (const upsert of transaction.upserts) {
      nextNormalized.set(
        upsert.shard.key,
        adaptNativeShard(
          upsert.shard,
          transaction,
          provenance,
          nodeById,
          metadata,
          this.root,
        ),
      );
    }

    const hello = helloOf(metadata, transaction.schemaVersion);
    const coverage = coverageShard(metadata, hello);
    if (nextNative.has(coverage.key)) {
      throw new Error(
        `ttscgraph: native shard uses reserved normalized key ${coverage.key}`,
      );
    }
    for (const key of nextNormalized.keys()) {
      if (key.startsWith("0:coverage:") && key !== coverage.key) {
        nextNormalized.delete(key);
      }
    }
    nextNormalized.set(coverage.key, coverage);

    const ordered = [...nextNormalized].sort(([left], [right]) =>
      compareText(left, right),
    );
    const manifest = ordered.map(([key, shard]) => ({
      key,
      digest: GraphSnapshotProtocol.shardDigest(shard),
    }));
    const sources = ordered.flatMap(([, shard]) => shard.sources);
    const canReuse =
      transaction.baseGeneration !== undefined &&
      options.previous?.protocol !== undefined;
    const begin: GraphSnapshotProtocol.IBegin = {
      type: "begin",
      sequence: options.sequence,
      generation: transaction.generation,
      ...(canReuse
        ? {
            baseSequence: options.previous!.protocol!.sequence,
            baseGeneration: options.previous!.protocol!.generation,
          }
        : {}),
      universe: metadata.provenance.universe,
      manifest: GraphSnapshotProtocol.manifestDigest(sources),
      targets: [metadata.target],
    };
    const assembled = assembledSnapshot(hello, begin, ordered);
    const factDigest = GraphSnapshotProtocol.factDigest(assembled);
    const frames: GraphSnapshotProtocol.Frame[] = [hello, begin];
    const previousNormalized = canReuse ? this.normalized : new Map();
    for (const key of previousNormalized.keys()) {
      if (!nextNormalized.has(key)) frames.push({ type: "deleteShard", key });
    }
    for (const [key, shard] of ordered) {
      const digest = GraphSnapshotProtocol.shardDigest(shard);
      const previous = previousNormalized.get(key);
      if (
        previous === undefined ||
        GraphSnapshotProtocol.shardDigest(previous) !== digest
      ) {
        frames.push({ type: "upsertShard", digest, shard });
      }
    }
    frames.push({
      type: "commit",
      sequence: begin.sequence,
      generation: begin.generation,
      shards: manifest,
      factDigest,
    });
    return {
      frames,
      capabilities: hello.capabilities,
      universe: begin.universe,
      warnings: metadata.warnings,
      commit: () => {
        this.sequence = transaction.sequence;
        this.generation = transaction.generation;
        this.project = transaction.project;
        this.tsconfig = transaction.tsconfig;
        this.native = nextNative;
        this.normalized = nextNormalized;
      },
    };
  }

  private assertCoordinates(transaction: INativeTransaction): void {
    if (transaction.protocolVersion !== TtscGraphSnapshotStore.VERSION) {
      throw new Error(
        "ttscgraph: native snapshot protocol " +
          `v${String(transaction.protocolVersion)} is incompatible with ` +
          `client v${String(TtscGraphSnapshotStore.VERSION)}`,
      );
    }
    if (
      !ITtscGraphSnapshot.SUPPORTED_DUMP_SCHEMA_VERSIONS.includes(
        transaction.schemaVersion,
      )
    ) {
      throw new Error(
        "ttscgraph: native snapshot uses unsupported dump schema " +
          `v${String(transaction.schemaVersion)}`,
      );
    }
    assertDigest(transaction.generation, "native transaction generation");
    if (this.sequence === undefined || this.generation === undefined) {
      if (
        transaction.sequence !== 1 ||
        transaction.baseSequence !== undefined ||
        transaction.baseGeneration !== undefined ||
        transaction.deletes.length !== 0
      ) {
        throw new Error(
          "ttscgraph: initial native transaction is not a complete generation",
        );
      }
      return;
    }
    if (
      transaction.sequence !== this.sequence + 1 ||
      transaction.baseSequence !== this.sequence ||
      transaction.baseGeneration !== this.generation
    ) {
      throw new Error(
        "ttscgraph: native transaction has stale base " +
          `${String(transaction.baseSequence)}/` +
          String(transaction.baseGeneration),
      );
    }
    if (
      transaction.project !== this.project ||
      transaction.tsconfig !== this.tsconfig
    ) {
      throw new Error(
        "ttscgraph: native transaction changed its resident project coordinates",
      );
    }
  }
}

export namespace TtscGraphSnapshotStore {
  export interface IPrepared {
    frames: GraphSnapshotProtocol.Frame[];
    capabilities: string[];
    universe: string;
    warnings: string[];
    commit: () => void;
  }
}

function adaptNativeShard(
  shard: INativeShard,
  transaction: INativeTransaction,
  provenance: Record<string, unknown>,
  nodeById: ReadonlyMap<string, unknown>,
  metadata: ReturnType<typeof adaptTtscGraphDump>,
  root: string,
): GraphSnapshotProtocol.IShard {
  const localIds = new Set(
    shard.nodes.map((node, index) =>
      stringOf(objectOf(node, `${shard.key}.nodes[${String(index)}]`).id, "node.id"),
    ),
  );
  const nodes = [...shard.nodes];
  const includedIds = new Set(localIds);
  for (let index = 0; index < shard.edges.length; index++) {
    const edge = objectOf(
      shard.edges[index],
      `${shard.key}.edges[${String(index)}]`,
    );
    const target = stringOf(edge.to, `${shard.key}.edges[${String(index)}].to`);
    if (!includedIds.has(target)) {
      nodes.push(nodeById.get(target)!);
      includedIds.add(target);
    }
  }
  const adapted = adaptTtscGraphDump(
    {
      project: transaction.project,
      tsconfig: transaction.tsconfig,
      provenance,
      diagnostics: shard.diagnostics,
      nodes,
      edges: shard.edges,
    },
    root,
  );
  const localModuleFiles = new Set<string>();
  for (const node of shard.nodes) {
    const raw = objectOf(node, `${shard.key}.node`);
    if (raw.kind === "module") {
      localModuleFiles.add(stringOf(raw.file, `${shard.key}.node.file`));
    }
  }
  const sourceFile = shard.source?.file ?? shard.config?.file;
  const sources: GraphSnapshotProtocol.ISource[] = [];
  if (sourceFile !== undefined) {
    const file = stringOf(sourceFile, `${shard.key}.source.file`);
    const canonical = file.startsWith("bundled:///")
      ? file
      : path.resolve(root, file);
    // `nativeProvenance` is derived from this same validated shard set, and
    // `adaptTtscGraphDump` adds its validated configuration universe.
    const digest = metadata.sources.get(canonical)!;
    sources.push({ file: canonical, ...digest });
  }
  return {
    key: shard.key,
    target: metadata.target,
    languages: ["typescript"],
    nodes: adapted.nodes.filter(
      (node) => localIds.has(node.id) || localModuleFiles.has(node.id),
    ),
    edges: adapted.edges,
    diagnostics: adapted.diagnostics,
    coverage: [],
    unresolved: [],
    sources,
  };
}

function nativeProvenance(
  transaction: INativeTransaction,
  shards: ReadonlyMap<string, ICommittedNativeShard>,
): Record<string, unknown> {
  const sources: Record<string, unknown>[] = [];
  for (const { shard } of shards.values()) {
    if (shard.source !== undefined) sources.push({ ...shard.source });
  }
  sources.sort((left, right) =>
    compareUtf8(stringOf(left.file, "source.file"), stringOf(right.file, "source.file")),
  );
  return {
    schemaVersion: transaction.schemaVersion,
    capabilities: [...transaction.capabilities],
    producer: transaction.producer,
    universe: transaction.universe,
    sources,
  };
}

function helloOf(
  metadata: ReturnType<typeof adaptTtscGraphDump>,
  schemaVersion: number,
): GraphSnapshotProtocol.IHello {
  return {
    type: "hello",
    protocolVersion: GraphSnapshotProtocol.VERSION,
    schemaVersion: GraphSnapshotProtocol.SCHEMA_VERSION,
    producerSchemaVersion: schemaVersion,
    provider: metadata.provenance.provider,
    producer: metadata.provenance.tool,
    producerVersion: metadata.provenance.toolVersion,
    compilerVersion: metadata.provenance.compilerVersion,
    languages: ["typescript"],
    authority: metadata.provenance.authority,
    supportedFacts: [...metadata.provenance.facts],
    capabilities: [...metadata.provenance.capabilities],
  };
}

function coverageShard(
  metadata: ReturnType<typeof adaptTtscGraphDump>,
  hello: GraphSnapshotProtocol.IHello,
): GraphSnapshotProtocol.IShard {
  const supported = new Set(hello.supportedFacts);
  const coverage: ISamchonGraphCoverage[] = GRAPH_EDGE_KINDS.map((family) => ({
    provider: hello.provider,
    language: "typescript",
    target: metadata.target,
    family,
    state: supported.has(family) ? "partial" : "unsupported",
  }));
  return {
    key: `0:coverage:${JSON.stringify([
      GraphSnapshotProtocol.VERSION,
      hello.provider,
      hello.producerVersion,
      hello.compilerVersion,
      "typescript",
      metadata.target,
      metadata.provenance.universe,
    ])}`,
    target: metadata.target,
    languages: ["typescript"],
    nodes: [],
    edges: [],
    diagnostics: [],
    coverage,
    unresolved: hello.supportedFacts.map((family) => ({
      provider: hello.provider,
      language: "typescript",
      target: metadata.target,
      universe: metadata.provenance.universe,
      family,
      evidence: { file: metadata.target, startLine: 1, startCol: 1 },
      reason: "provider-gap",
    })),
    sources: [],
  };
}

function assembledSnapshot(
  hello: GraphSnapshotProtocol.IHello,
  begin: GraphSnapshotProtocol.IBegin,
  shards: readonly [string, GraphSnapshotProtocol.IShard][],
): Parameters<typeof GraphSnapshotProtocol.factDigest>[0] {
  const values = shards.map(([, shard]) => shard);
  return {
    languages: [...hello.languages],
    nodes: values.flatMap((shard) => shard.nodes),
    edges: values.flatMap((shard) => shard.edges),
    diagnostics: values.flatMap((shard) => shard.diagnostics),
    coverage: values.flatMap((shard) => shard.coverage),
    unresolved: values.flatMap((shard) => shard.unresolved),
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

function assertNativeGenerationFacts(
  transaction: INativeTransaction,
  shards: ReadonlyMap<string, ICommittedNativeShard>,
): Map<string, unknown> {
  const nodeById = new Map<string, unknown>();
  const nodeOwners = new Map<string, string>();
  const sourceFiles = new Set<string>();
  const configs = new Map<string, string>();
  for (const [key, { shard }] of shards) {
    if (shard.source !== undefined && shard.config !== undefined) {
      throw new Error(`ttscgraph: native shard ${key} owns two input kinds`);
    }
    const sourceFile =
      shard.source === undefined
        ? undefined
        : stringOf(shard.source.file, `${key}.source.file`);
    const configFile =
      shard.config === undefined
        ? undefined
        : stringOf(shard.config.file, `${key}.config.file`);
    if (sourceFile !== undefined) {
      if (sourceFiles.has(sourceFile)) {
        throw new Error(`ttscgraph: native source ${sourceFile} has two shards`);
      }
      sourceFiles.add(sourceFile);
    }
    if (configFile !== undefined) {
      const digest = stringOf(shard.config!.digest, `${key}.config.digest`);
      if (configs.has(configFile)) {
        throw new Error(`ttscgraph: native config ${configFile} has two shards`);
      }
      configs.set(configFile, digest);
      if (shard.nodes.length !== 0 || shard.edges.length !== 0) {
        throw new Error(`ttscgraph: native config shard ${key} owns facts`);
      }
    }
    if (sourceFile === undefined && shard.edges.length !== 0) {
      throw new Error(`ttscgraph: native non-source shard ${key} owns edges`);
    }
    for (let index = 0; index < shard.nodes.length; index++) {
      const node = objectOf(shard.nodes[index], `${key}.nodes[${String(index)}]`);
      const id = stringOf(node.id, `${key}.nodes[${String(index)}].id`);
      const file = stringOf(node.file, `${key}.nodes[${String(index)}].file`);
      const external = booleanOf(
        node.external,
        `${key}.nodes[${String(index)}].external`,
      );
      if (
        (sourceFile !== undefined && (external || file !== sourceFile)) ||
        (sourceFile === undefined && !external)
      ) {
        throw new Error(`ttscgraph: native shard ${key} misowns node ${id}`);
      }
      if (nodeById.has(id)) {
        throw new Error(`ttscgraph: native node ${id} has two owners`);
      }
      nodeById.set(id, shard.nodes[index]);
      nodeOwners.set(id, key);
    }
    for (let index = 0; index < shard.diagnostics.length; index++) {
      const diagnostic = objectOf(
        shard.diagnostics[index],
        `${key}.diagnostics[${String(index)}]`,
      );
      const file = stringOf(
        diagnostic.file,
        `${key}.diagnostics[${String(index)}].file`,
      );
      if (
        (sourceFile !== undefined && file !== sourceFile) ||
        (configFile !== undefined && file !== configFile) ||
        (sourceFile === undefined && configFile === undefined && file !== "")
      ) {
        throw new Error(`ttscgraph: native shard ${key} misowns diagnostic`);
      }
    }
  }
  for (const [key, { shard }] of shards) {
    for (let index = 0; index < shard.edges.length; index++) {
      const edge = objectOf(shard.edges[index], `${key}.edges[${String(index)}]`);
      const from = stringOf(edge.from, `${key}.edges[${String(index)}].from`);
      const to = stringOf(edge.to, `${key}.edges[${String(index)}].to`);
      if (nodeOwners.get(from) !== key) {
        throw new Error(`ttscgraph: native shard ${key} misowns edge ${from}`);
      }
      if (!nodeById.has(to)) {
        throw new Error(`ttscgraph: native edge target is absent: ${to}`);
      }
    }
  }
  const universe = objectOf(transaction.universe, "native universe");
  const universeConfigs = arrayOf(universe.configs, "native universe.configs");
  if (universeConfigs.length !== configs.size) {
    throw new Error("ttscgraph: native config shards do not cover the universe");
  }
  for (let index = 0; index < universeConfigs.length; index++) {
    const config = objectOf(
      universeConfigs[index],
      `native universe.configs[${String(index)}]`,
    );
    const file = stringOf(config.file, "native config.file");
    const digest = stringOf(config.digest, "native config.digest");
    if (configs.get(file) !== digest || !configs.delete(file)) {
      throw new Error(`ttscgraph: native config shard disagrees at ${file}`);
    }
  }
  return nodeById;
}

function assertNativeManifest(
  transaction: INativeTransaction,
  shards: ReadonlyMap<string, ICommittedNativeShard>,
): void {
  if (transaction.manifest.length !== shards.size) {
    throw new Error("ttscgraph: native manifest does not cover the generation");
  }
  for (let index = 0; index < transaction.manifest.length; index++) {
    const entry = transaction.manifest[index]!;
    assertShardKey(entry.key);
    assertDigest(entry.digest, "native manifest digest");
    if (
      index !== 0 &&
      compareUtf8(transaction.manifest[index - 1]!.key, entry.key) >= 0
    ) {
      throw new Error("ttscgraph: native manifest is not strictly key-sorted");
    }
    if (shards.get(entry.key)?.digest !== entry.digest) {
      throw new Error(`ttscgraph: native manifest disagrees at ${entry.key}`);
    }
  }
}

function assertNativeGeneration(transaction: INativeTransaction): void {
  const generation = nativeDigest({
    tsconfig: transaction.tsconfig,
    producer: transaction.producer,
    capabilities: transaction.capabilities,
    universe: transaction.universe,
    manifest: transaction.manifest,
  });
  if (generation !== transaction.generation) {
    throw new Error(
      `ttscgraph: native generation ${transaction.generation} does not match ${generation}`,
    );
  }
}

function transactionOf(value: unknown): INativeTransaction {
  const raw = objectOf(value, "native snapshot");
  const transaction: INativeTransaction = {
    protocolVersion: integerOf(raw.protocolVersion, "native protocolVersion"),
    schemaVersion: integerOf(raw.schemaVersion, "native schemaVersion"),
    project: stringOf(raw.project, "native project"),
    tsconfig: stringOf(raw.tsconfig, "native tsconfig"),
    producer: objectOf(raw.producer, "native producer"),
    capabilities: arrayOf(raw.capabilities, "native capabilities").map(
      (entry, index) => stringOf(entry, `native capabilities[${String(index)}]`),
    ),
    universe: objectOf(raw.universe, "native universe"),
    sequence: integerOf(raw.sequence, "native sequence"),
    generation: stringOf(raw.generation, "native generation"),
    upserts: arrayOf(raw.upserts, "native upserts").map((entry, index) => {
      const upsert = objectOf(entry, `native upserts[${String(index)}]`);
      const rawShard = objectOf(
        upsert.shard,
        `native upserts[${String(index)}].shard`,
      );
      return {
        digest: stringOf(upsert.digest, "native upsert.digest"),
        shard: shardOf(rawShard, `native upserts[${String(index)}].shard`),
        rawShard,
      };
    }),
    deletes: arrayOf(raw.deletes, "native deletes").map((entry, index) =>
      stringOf(entry, `native deletes[${String(index)}]`),
    ),
    manifest: arrayOf(raw.manifest, "native manifest").map((entry, index) => {
      const reference = objectOf(entry, `native manifest[${String(index)}]`);
      return {
        key: stringOf(reference.key, "native manifest.key"),
        digest: stringOf(reference.digest, "native manifest.digest"),
      };
    }),
  };
  if (raw.baseSequence !== undefined) {
    transaction.baseSequence = integerOf(
      raw.baseSequence,
      "native baseSequence",
    );
  }
  if (raw.baseGeneration !== undefined) {
    transaction.baseGeneration = stringOf(
      raw.baseGeneration,
      "native baseGeneration",
    );
  }
  if (
    (transaction.baseSequence === undefined) !==
    (transaction.baseGeneration === undefined)
  ) {
    throw new Error("ttscgraph: native base coordinates are incomplete");
  }
  return transaction;
}

function shardOf(value: unknown, label: string): INativeShard {
  const raw = objectOf(value, label);
  const shard: INativeShard = {
    key: stringOf(raw.key, `${label}.key`),
    nodes: arrayOf(raw.nodes, `${label}.nodes`),
    edges: arrayOf(raw.edges, `${label}.edges`),
    diagnostics: arrayOf(raw.diagnostics, `${label}.diagnostics`),
  };
  if (raw.source !== undefined) {
    shard.source = objectOf(raw.source, `${label}.source`);
  }
  if (raw.config !== undefined) {
    shard.config = objectOf(raw.config, `${label}.config`);
  }
  return shard;
}

function nativeDigest(value: unknown): string {
  return createHash("sha256").update(goJSON(value)).digest("hex");
}

function goJSON(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareText(left: string, right: string): number {
  // Map keys are unique, so shard ordering never compares equal identities.
  return left < right ? -1 : 1;
}

function duplicateTouch(key: string): never {
  throw new Error(`ttscgraph: native transaction touches shard ${key} twice`);
}

function assertShardKey(key: string): void {
  if (key === "" || key.includes("\0")) {
    throw new Error(`ttscgraph: native shard key is invalid: ${key}`);
  }
}

function assertDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`ttscgraph: ${label} must be a SHA-256 digest`);
  }
}

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`ttscgraph: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayOf(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`ttscgraph: ${label} must be an array`);
  }
  return value;
}

function stringOf(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`ttscgraph: ${label} must be a string`);
  }
  return value;
}

function booleanOf(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`ttscgraph: ${label} must be boolean`);
  }
  return value;
}

function integerOf(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`ttscgraph: ${label} must be a positive safe integer`);
  }
  return value as number;
}
