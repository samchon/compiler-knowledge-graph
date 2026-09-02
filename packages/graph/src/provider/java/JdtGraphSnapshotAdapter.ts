import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ISamchonGraphCoverage,
  ISamchonGraphDiagnostic,
  ISamchonGraphEdge,
  ISamchonGraphEvidence,
  ISamchonGraphNode,
  SamchonGraphNodeModifier,
} from "../../structures";
import { GRAPH_EDGE_KINDS, GraphNodeKind } from "../../typings";
import { fileFromUri } from "../../utils/fileFromUri";
import { isSubPath } from "../../utils/isSubPath";
import { projectRelative } from "../../utils/projectRelative";
import { GraphSnapshotProtocol } from "../GraphSnapshotProtocol";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { semanticGraphNodeId } from "../semanticIdentity";
import { IJdtGraphSnapshot } from "./IJdtGraphSnapshot";
import { JDT_GRAPH_FACTS } from "./JDT_GRAPH_FACTS";
import { JDT_GRAPH_PROVIDER } from "./JDT_GRAPH_PROVIDER";
import { javaDeclarationSymbol } from "./javaDeclarationSymbol";

const SHA256 = /^[0-9a-f]{64}$/u;
const NODE_KINDS = new Set<GraphNodeKind>([
  "file",
  "package",
  "module",
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "variable",
  "method",
  "parameter",
  "field",
  "constructor",
]);
const RAW_MODIFIERS = new Set([
  "public",
  "protected",
  "private",
  "static",
  "abstract",
  "final",
]);
const CAPABILITIES = [
  "coverage",
  "diagnostics",
  "diskDigests",
  "incremental",
  "sourceDigests",
  "universe",
  "unsavedBuffers",
];
const TARGET = "jdt-workspace";

/** Validates and publishes one frozen JDT workspace generation. */
export class JdtGraphSnapshotAdapter {
  public readonly store: GraphSnapshotProtocol.Store;

  private sequence = 0;

  public constructor(private readonly root: string) {
    this.store = new GraphSnapshotProtocol.Store(root);
  }

  public get current(): IBulkGraphSession.ISnapshot | undefined {
    return this.store.current;
  }

  public apply(
    value: unknown,
    options: {
      signal?: AbortSignal;
      validate?: (snapshot: IBulkGraphSession.ISnapshot) => void;
    } = {},
  ): {
    changed: boolean;
    mode: IBulkGraphSession.Mode;
    snapshot: IBulkGraphSession.ISnapshot;
  } {
    const raw = assertSnapshot(value, this.root);
    if (!raw.complete || raw.mode === "error") {
      const errors = raw.diagnostics.filter(
        (diagnostic) => diagnostic.severity === "error",
      );
      const summary = errors
        .slice(0, 3)
        .map((diagnostic) => diagnostic.message)
        .join("; ");
      throw new Error(
        `JDT workspace graph: producer retained the prior strict generation after ${String(errors.length)} error(s): ${summary}`,
      );
    }
    const prior = this.store.current;
    if (prior?.protocol?.generation === raw.generation) {
      return { changed: false, mode: "unchanged", snapshot: prior };
    }

    const shard = adaptShard(this.root, raw);
    const digest = GraphSnapshotProtocol.shardDigest(shard);
    const manifest = [{ key: shard.key, digest }];
    const hello = helloOf(raw);
    const sequence = this.sequence + 1;
    const begin: GraphSnapshotProtocol.IBegin = {
      type: "begin",
      sequence,
      generation: raw.generation,
      universe: raw.universe,
      manifest: GraphSnapshotProtocol.manifestDigest(shard.sources),
      targets: [TARGET],
    };
    const body = assembled(hello, begin, shard);
    const frames: GraphSnapshotProtocol.Frame[] = [
      hello,
      begin,
      { type: "upsertShard", digest, shard },
      {
        type: "commit",
        sequence: begin.sequence,
        generation: begin.generation,
        shards: manifest,
        factDigest: GraphSnapshotProtocol.factDigest(body),
      },
    ];
    const snapshot = this.store.apply(frames, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.validate === undefined
        ? {}
        : { validate: options.validate }),
    });
    this.sequence = sequence;
    return {
      changed: true,
      mode:
        prior === undefined
          ? "initial"
          : prior.provenance.universe === raw.universe
            ? "incremental"
            : "reload",
      snapshot,
    };
  }
}

function adaptShard(
  root: string,
  raw: IJdtGraphSnapshot,
): GraphSnapshotProtocol.IShard {
  const ids = new Map<string, string>();
  const nodes = raw.nodes.map((node) => {
    const adapted = adaptNode(root, raw, node);
    ids.set(node.symbol, adapted.id);
    return adapted;
  });
  const edges: ISamchonGraphEdge[] = raw.edges.map((edge) => ({
    from: ids.get(edge.from)!,
    to: ids.get(edge.to)!,
    kind: "contains",
    evidence: adaptEvidence(root, edge.evidence),
  }));
  const diagnostics: ISamchonGraphDiagnostic[] = raw.diagnostics.map(
    (diagnostic) => ({
      file: graphFile(root, diagnostic.uri),
      line: diagnostic.evidence.startLine,
      column: diagnostic.evidence.startColumn,
      code: diagnostic.code,
      message: diagnostic.message,
      severity:
        diagnostic.severity === "information"
          ? "info"
          : diagnostic.severity,
    }),
  );
  const coverage: ISamchonGraphCoverage[] = GRAPH_EDGE_KINDS.map((family) => ({
    provider: JDT_GRAPH_PROVIDER,
    language: "java" as const,
    target: TARGET,
    family,
    state: family === "contains" ? "complete" : "unsupported",
  }));
  return {
    key: `jdt-workspace:${raw.universe}`,
    target: TARGET,
    languages: ["java"],
    nodes,
    edges,
    diagnostics,
    coverage,
    unresolved: [],
    sources: [
      ...raw.sources.map((source) => ({
        file: sourceFile(root, source.uri),
        checkerDigest: source.checkerDigest,
        diskDigest: source.diskDigest,
      })),
      {
        file: `bundled:///java/jdt-workspace/${digest(raw.projects)}`,
        checkerDigest: raw.universe,
        diskDigest: "",
      },
    ],
  };
}

function adaptNode(
  root: string,
  raw: IJdtGraphSnapshot,
  node: IJdtGraphSnapshot.INode,
): ISamchonGraphNode {
  const kind = node.kind as GraphNodeKind;
  const qualifiedName = node.qualifiedName === "" ? undefined : node.qualifiedName;
  const display = qualifiedName ?? node.name;
  const generationScoped = node.stability === "generation";
  const symbol =
    node.stability === "persistent"
      ? javaDeclarationSymbol({
          kind,
          name: node.name,
          ...(qualifiedName === undefined ? {} : { qualifiedName }),
          ...(node.signature === "" ? {} : { signature: node.signature }),
        })
      : node.symbol;
  const modifiers = node.modifiers.map((modifier) =>
    modifier === "final" ? "readonly" : modifier,
  ) as SamchonGraphNodeModifier[];
  return {
    id: semanticGraphNodeId(
      {
        version: 2,
        language: "java",
        symbol,
        role: kind,
        native: {
          key: symbol,
          stability: generationScoped ? "positional" : "semantic",
        },
        scope: { target: targetOf(root, raw, node.project, node.uri) },
        stability: generationScoped ? "generation" : "persistent",
        ...(generationScoped ? { generation: raw.generation } : {}),
      },
      display,
    ),
    kind,
    language: "java",
    name: node.name,
    ...(qualifiedName === undefined ? {} : { qualifiedName }),
    file: graphFile(root, node.uri),
    external: false,
    ...(node.exported ? { exported: true } : {}),
    ...(node.stability === "structural" ? { closure: true } : {}),
    ...(modifiers.length === 0 ? {} : { modifiers }),
    ...(node.signature === "" ? {} : { signature: node.signature }),
    evidence: adaptEvidence(root, node.evidence),
  };
}

function adaptEvidence(
  root: string,
  evidence: IJdtGraphSnapshot.IEvidence,
): ISamchonGraphEvidence {
  return {
    file: graphFile(root, evidence.uri),
    startLine: evidence.startLine,
    startCol: evidence.startColumn,
    endLine: evidence.endLine,
    endCol: evidence.endColumn,
  };
}

function graphFile(root: string, uri: string): string {
  return projectRelative(root, sourceFile(root, uri));
}

function sourceFile(root: string, uri: string): string {
  const file = path.normalize(fileFromUri(uri));
  if (!isSubPath(root, file)) {
    throw new Error(`JDT workspace graph: source escaped the project root: ${uri}`);
  }
  return file;
}

function targetOf(
  root: string,
  raw: IJdtGraphSnapshot,
  projectName: string,
  sourceUri: string,
): string {
  const project = raw.projects.find((candidate) => candidate.name === projectName)!;
  const directory = sourceFile(root, project.location);
  if (fs.existsSync(path.join(directory, "pom.xml"))) {
    const relative = projectRelative(root, directory);
    return `maven:${relative === "" ? "." : relative}`;
  }
  const gradleRoot = gradleRootOf(root, directory);
  const task = gradleJavaTask(directory, sourceFile(root, sourceUri));
  if (gradleRoot !== undefined && task !== undefined) {
    const relative = projectRelative(gradleRoot, directory);
    const projectPath =
      relative === "" ? "" : `:${relative.split("/").join(":")}`;
    return `${projectPath}:${task}`;
  }
  return `jdt:${projectName}`;
}

function gradleRootOf(root: string, project: string): string | undefined {
  for (let cursor = project; isSubPath(root, cursor); cursor = path.dirname(cursor)) {
    if (
      fs.existsSync(path.join(cursor, "settings.gradle")) ||
      fs.existsSync(path.join(cursor, "settings.gradle.kts"))
    ) {
      return cursor;
    }
    if (cursor === root || path.dirname(cursor) === cursor) break;
  }
  return fs.existsSync(path.join(project, "build.gradle")) ||
    fs.existsSync(path.join(project, "build.gradle.kts"))
    ? project
    : undefined;
}

function gradleJavaTask(
  project: string,
  source: string,
): "compileJava" | "compileTestJava" | undefined {
  const relative = projectRelative(project, source);
  if (relative.startsWith("src/main/java/")) return "compileJava";
  if (relative.startsWith("src/test/java/")) return "compileTestJava";
  return undefined;
}

function helloOf(
  raw: IJdtGraphSnapshot,
): GraphSnapshotProtocol.IHello {
  return {
    type: "hello",
    protocolVersion: 1,
    schemaVersion: 1,
    producerSchemaVersion: raw.schemaVersion,
    provider: JDT_GRAPH_PROVIDER,
    producer: raw.producer.name,
    producerVersion: raw.producer.version,
    compilerVersion: raw.producer.compilerVersion,
    languages: ["java"],
    authority: "compiler",
    supportedFacts: [...JDT_GRAPH_FACTS],
    capabilities: [...CAPABILITIES],
  };
}

function assembled(
  hello: GraphSnapshotProtocol.IHello,
  begin: GraphSnapshotProtocol.IBegin,
  shard: GraphSnapshotProtocol.IShard,
): Parameters<typeof GraphSnapshotProtocol.factDigest>[0] {
  return {
    languages: [...hello.languages],
    nodes: [...shard.nodes],
    edges: [...shard.edges],
    diagnostics: [...shard.diagnostics],
    coverage: [...shard.coverage],
    unresolved: [...shard.unresolved],
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

function assertSnapshot(value: unknown, root: string): IJdtGraphSnapshot {
  if (!isRecord(value)) {
    throw new Error("JDT workspace graph: snapshot is not an object");
  }
  const raw = value as unknown as IJdtGraphSnapshot;
  if (
    raw.schemaVersion !== IJdtGraphSnapshot.SCHEMA_VERSION ||
    raw.protocolVersion !== IJdtGraphSnapshot.PROTOCOL_VERSION ||
    raw.producer?.name !== IJdtGraphSnapshot.PRODUCER ||
    !nonempty(raw.producer?.version) ||
    !nonempty(raw.producer?.compilerVersion) ||
    !SHA256.test(raw.universe) ||
    !SHA256.test(raw.generation) ||
    typeof raw.complete !== "boolean" ||
    !["initial", "reload", "unchanged", "incremental", "error"].includes(
      raw.mode,
    ) ||
    !Number.isSafeInteger(raw.sequence) ||
    raw.sequence < 0 ||
    !Array.isArray(raw.projects) ||
    raw.projects.length === 0 ||
    !Array.isArray(raw.sources) ||
    !Array.isArray(raw.nodes) ||
    !Array.isArray(raw.edges) ||
    !Array.isArray(raw.diagnostics) ||
    !Array.isArray(raw.unresolved) ||
    raw.unresolved.length !== 0 ||
    !isRecord(raw.coverage) ||
    raw.coverage["contains"] !== "complete"
  ) {
    throw new Error("JDT workspace graph: malformed producer snapshot");
  }
  assertCapabilities(raw.capabilities);
  const projects = new Set<string>();
  for (const project of raw.projects) {
    if (
      !isRecord(project) ||
      !nonempty(project.name) ||
      projects.has(project.name) ||
      !nonempty(project.location) ||
      !nonempty(project.output) ||
      !nonempty(project.compilerVersion) ||
      !isRecord(project.options) ||
      !Array.isArray(project.classpath)
    ) {
      throw new Error("JDT workspace graph: malformed project universe");
    }
    projects.add(project.name);
    sourceFile(root, project.location);
  }
  const sourceUris = new Set<string>();
  for (const source of raw.sources) {
    if (
      !isRecord(source) ||
      !projects.has(source.project) ||
      !nonempty(source.uri) ||
      source.checkerEncoding !== IJdtGraphSnapshot.CHECKER_ENCODING ||
      !SHA256.test(source.checkerDigest) ||
      (source.diskDigest !== "" && !SHA256.test(source.diskDigest))
    ) {
      throw new Error("JDT workspace graph: malformed source manifest");
    }
    graphFile(root, source.uri);
    sourceUris.add(source.uri);
  }
  const symbols = new Set<string>();
  for (const node of raw.nodes) {
    if (
      !isRecord(node) ||
      !projects.has(node.project) ||
      !nonempty(node.symbol) ||
      symbols.has(node.symbol) ||
      !nonempty(node.nativeKey) ||
      !["persistent", "structural", "generation"].includes(node.stability) ||
      !sourceUris.has(node.uri) ||
      !nonempty(node.name) ||
      typeof node.qualifiedName !== "string" ||
      !NODE_KINDS.has(node.kind as GraphNodeKind) ||
      typeof node.signature !== "string" ||
      !nonempty(node.declarationKind) ||
      typeof node.exported !== "boolean" ||
      !Array.isArray(node.modifiers) ||
      node.modifiers.some(
        (modifier) => typeof modifier !== "string" || !RAW_MODIFIERS.has(modifier),
      ) ||
      !validEvidence(node.evidence, sourceUris)
    ) {
      throw new Error("JDT workspace graph: malformed declaration");
    }
    symbols.add(node.symbol);
  }
  for (const edge of raw.edges) {
    if (
      !isRecord(edge) ||
      edge.kind !== "contains" ||
      !symbols.has(edge.from) ||
      !symbols.has(edge.to) ||
      !validEvidence(edge.evidence, sourceUris)
    ) {
      throw new Error("JDT workspace graph: malformed containment edge");
    }
  }
  for (const diagnostic of raw.diagnostics) {
    if (
      !isRecord(diagnostic) ||
      !sourceUris.has(diagnostic.uri) ||
      !["error", "warning", "information"].includes(diagnostic.severity) ||
      !nonempty(diagnostic.code) ||
      !nonempty(diagnostic.message) ||
      !validEvidence(diagnostic.evidence, sourceUris)
    ) {
      throw new Error("JDT workspace graph: malformed diagnostic");
    }
  }
  if (
    raw.complete === raw.diagnostics.some(
      (diagnostic) => diagnostic.severity === "error",
    ) ||
    (raw.complete && raw.sequence < 1) ||
    (raw.complete && raw.mode === "error") ||
    (!raw.complete && raw.mode !== "error")
  ) {
    throw new Error("JDT workspace graph: contradictory completion state");
  }
  return raw;
}

function assertCapabilities(value: unknown): void {
  if (
    !isRecord(value) ||
    value["atomicGenerations"] !== true ||
    value["resident"] !== true ||
    value["sourceDigests"] !== true ||
    value["diskDigests"] !== true ||
    value["unsavedBuffers"] !== true ||
    value["diagnostics"] !== true ||
    !Array.isArray(value["facts"]) ||
    value["facts"].length !== 1 ||
    value["facts"][0] !== "contains"
  ) {
    throw new Error("JDT workspace graph: incompatible capabilities");
  }
}

function validEvidence(
  value: unknown,
  sources: ReadonlySet<string>,
): value is IJdtGraphSnapshot.IEvidence {
  if (!isRecord(value) || !sources.has(String(value["uri"]))) return false;
  return ["startLine", "startColumn", "endLine", "endColumn"].every(
    (key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 1,
  );
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !value.includes("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
