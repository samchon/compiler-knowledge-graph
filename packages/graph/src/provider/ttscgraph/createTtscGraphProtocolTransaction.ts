import path from "node:path";

import { ISamchonGraphCoverage } from "../../structures";
import { GRAPH_EDGE_KINDS } from "../../typings";
import { GraphSnapshotProtocol } from "../GraphSnapshotProtocol";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { adaptTtscGraphDump } from "./adaptTtscGraphDump";

type IAdaptedTtscGraphDump = ReturnType<typeof adaptTtscGraphDump>;

/**
 * Normalize one complete compiler dump into a Graph Snapshot Protocol
 * transaction. The native process still owns semantic incrementality; this
 * adapter adds content-addressed file shards so the graph store can reuse every
 * unchanged part of the last committed generation.
 */
export function createTtscGraphProtocolTransaction(
  input: IAdaptedTtscGraphDump,
  options: {
    root: string;
    sequence: number;
    previous?: IBulkGraphSession.ISnapshot;
  },
): GraphSnapshotProtocol.Frame[] {
  const hello: GraphSnapshotProtocol.IHello = {
    type: "hello",
    protocolVersion: GraphSnapshotProtocol.VERSION,
    schemaVersion: GraphSnapshotProtocol.SCHEMA_VERSION,
    producerSchemaVersion: input.provenance.schemaVersion,
    provider: input.provenance.provider,
    producer: input.provenance.tool,
    producerVersion: input.provenance.toolVersion,
    compilerVersion: input.provenance.compilerVersion,
    languages: ["typescript"],
    authority: input.provenance.authority,
    supportedFacts: [...input.provenance.facts],
    capabilities: [...input.provenance.capabilities],
  };
  const sources = [...input.sources].map(([file, digest]) => ({
    file,
    checkerDigest: digest.checkerDigest,
    diskDigest: digest.diskDigest,
  }));
  const manifest = GraphSnapshotProtocol.manifestDigest(sources);
  const shards = shardTtscGraph(input, options.root, sources);
  const ordered = [...shards].sort(([left], [right]) =>
    compareText(left, right),
  );
  const shardManifest = ordered.map(([key, shard]) => ({
    key,
    digest: GraphSnapshotProtocol.shardDigest(shard),
  }));
  const previous = options.previous;
  const canReuse =
    previous?.protocol !== undefined &&
    previous.provenance.universe === input.provenance.universe &&
    sameList(previous.protocol.targets, [input.target]) &&
    sameProducer(previous.provenance, input.provenance);
  const begin: GraphSnapshotProtocol.IBegin = {
    type: "begin",
    sequence: options.sequence,
    generation: "",
    ...(canReuse
      ? {
          baseSequence: previous.protocol!.sequence,
          baseGeneration: previous.protocol!.generation,
        }
      : {}),
    universe: input.provenance.universe,
    manifest,
    targets: [input.target],
  };
  const snapshot = assembledSnapshot(hello, begin, ordered);
  const factDigest = GraphSnapshotProtocol.factDigest(snapshot);
  begin.generation = factDigest;

  const previousShards = new Map(
    canReuse
      ? previous.protocol!.shards.map((entry) => [entry.key, entry.digest])
      : [],
  );
  const nextKeys = new Set(shards.keys());
  const deltas: GraphSnapshotProtocol.Frame[] = [];
  if (canReuse) {
    for (const key of previousShards.keys()) {
      if (!nextKeys.has(key)) deltas.push({ type: "deleteShard", key });
    }
  }
  for (const [key, shard] of ordered) {
    const digest = GraphSnapshotProtocol.shardDigest(shard);
    if (!canReuse || previousShards.get(key) !== digest) {
      deltas.push({ type: "upsertShard", digest, shard });
    }
  }
  return [
    hello,
    begin,
    ...deltas,
    {
      type: "commit",
      sequence: begin.sequence,
      generation: begin.generation,
      shards: shardManifest,
      factDigest,
    },
  ];
}

function shardTtscGraph(
  input: IAdaptedTtscGraphDump,
  root: string,
  sources: readonly GraphSnapshotProtocol.ISource[],
): Map<string, GraphSnapshotProtocol.IShard> {
  const output = new Map<string, GraphSnapshotProtocol.IShard>();
  const sourceShardByFile = new Map<string, GraphSnapshotProtocol.IShard>();
  const sourceFileByNode = new Map(
    input.nodes.map((node) => [node.id, sourceFile(root, node.file)]),
  );
  for (const source of sources) {
    const key = sourceShardKey(input, root, source);
    const shard: GraphSnapshotProtocol.IShard = {
      key,
      target: input.target,
      languages: ["typescript"],
      nodes: [],
      edges: [],
      diagnostics: [],
      coverage: [],
      unresolved: [],
      sources: [{ ...source }],
    };
    output.set(key, shard);
    sourceShardByFile.set(source.file, shard);
  }

  for (const node of input.nodes) {
    sourceShard(sourceShardByFile, sourceFile(root, node.file)).nodes.push(node);
  }
  for (const edge of input.edges) {
    // adaptTtscGraphDump already proved every edge source is a published node.
    const file = sourceFileByNode.get(edge.from)!;
    sourceShard(sourceShardByFile, file).edges.push(edge);
  }

  const coverageShard: GraphSnapshotProtocol.IShard = {
    key: metadataShardKey(input),
    target: input.target,
    languages: ["typescript"],
    nodes: [],
    edges: [],
    diagnostics: [],
    coverage: coverageOf(input),
    unresolved: unresolvedOf(input),
    sources: [],
  };
  for (const diagnostic of input.diagnostics) {
    if (diagnostic.file === "") coverageShard.diagnostics.push(diagnostic);
    else
      sourceShard(
        sourceShardByFile,
        sourceFile(root, diagnostic.file),
      ).diagnostics.push(diagnostic);
  }
  output.set(coverageShard.key, coverageShard);
  return output;
}

function coverageOf(
  input: IAdaptedTtscGraphDump,
): ISamchonGraphCoverage[] {
  const supported = new Set(input.provenance.facts);
  return GRAPH_EDGE_KINDS.map((family) => ({
    provider: input.provenance.provider,
    language: "typescript",
    target: input.target,
    family,
    state: supported.has(family) ? "partial" : "unsupported",
  }));
}

function unresolvedOf(
  input: IAdaptedTtscGraphDump,
): GraphSnapshotProtocol.IShard["unresolved"] {
  return input.provenance.facts.map((family) => ({
    provider: input.provenance.provider,
    language: "typescript",
    target: input.target,
    universe: input.provenance.universe,
    family,
    evidence: {
      file: input.target,
      startLine: 1,
      startCol: 1,
    },
    reason: "provider-gap",
  }));
}

function assembledSnapshot(
  hello: GraphSnapshotProtocol.IHello,
  begin: GraphSnapshotProtocol.IBegin,
  shards: readonly [string, GraphSnapshotProtocol.IShard][],
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

function sourceShard(
  shards: ReadonlyMap<string, GraphSnapshotProtocol.IShard>,
  file: string,
): GraphSnapshotProtocol.IShard {
  // adaptTtscGraphDump already bound every fact file to this exact manifest.
  return shards.get(file)!;
}

function sourceFile(root: string, file: string): string {
  return file.startsWith("bundled:///") ? file : path.resolve(root, file);
}

function sourceShardKey(
  input: IAdaptedTtscGraphDump,
  root: string,
  source: GraphSnapshotProtocol.ISource,
): string {
  const bundled = source.file.startsWith("bundled:///");
  const identity = bundled
    ? source.file
    : path.relative(root, source.file).replaceAll("\\", "/");
  return `${bundled ? "2" : "1"}:source:${JSON.stringify([
    GraphSnapshotProtocol.VERSION,
    input.provenance.provider,
    input.provenance.toolVersion,
    input.provenance.compilerVersion,
    "typescript",
    input.target,
    input.provenance.universe,
    identity,
    source.checkerDigest,
  ])}`;
}

function metadataShardKey(input: IAdaptedTtscGraphDump): string {
  return `0:coverage:${JSON.stringify([
    GraphSnapshotProtocol.VERSION,
    input.provenance.provider,
    input.provenance.toolVersion,
    input.provenance.compilerVersion,
    "typescript",
    input.target,
    input.provenance.universe,
  ])}`;
}

function sameProducer(
  left: IBulkGraphSession.IProvenance,
  right: Omit<IBulkGraphSession.IProvenance, "protocolVersion">,
): boolean {
  return (
    left.provider === right.provider &&
    left.authority === right.authority &&
    left.schemaVersion === right.schemaVersion &&
    left.tool === right.tool &&
    left.toolVersion === right.toolVersion &&
    left.compilerVersion === right.compilerVersion &&
    sameList(left.facts, right.facts) &&
    sameList(left.capabilities, right.capabilities)
  );
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

function compareText(left: string, right: string): number {
  /* c8 ignore next -- shard keys are unique. */
  return left < right ? -1 : left > right ? 1 : 0;
}
