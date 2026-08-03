import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareOrdinal as compareText } from "@samchon/graph-sitter";

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
  GraphLanguage,
  GraphNodeKind,
} from "../../typings";
import { GraphSnapshotProtocol } from "../GraphSnapshotProtocol";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { semanticGraphNodeId } from "../semanticIdentity";
import { CPP_CLANG_FACTS } from "./CPP_CLANG_FACTS";
import { CPP_CLANG_PROVIDER } from "./CPP_CLANG_PROVIDER";
import { ICppGraphSnapshot } from "./ICppGraphSnapshot";

const SHA256 = /^[a-f0-9]{64}$/u;
const ROLE = {
  declaration: 1 << 0,
  definition: 1 << 1,
  reference: 1 << 2,
  read: 1 << 3,
  write: 1 << 4,
  call: 1 << 5,
  dynamic: 1 << 6,
  childOf: 1 << 10,
  baseOf: 1 << 11,
  overrideOf: 1 << 12,
  calledBy: 1 << 14,
  extendedBy: 1 << 15,
  accessorOf: 1 << 16,
  containedBy: 1 << 17,
  specializationOf: 1 << 19,
  nameReference: 1 << 20,
} as const;
const TYPE_KINDS = new Set([6, 7, 8, 9, 10, 11, 12, 28, 29, 31]);
const CAPABILITIES = [
  "coverage",
  "diagnostics",
  "diskDigests",
  "incremental",
  "sourceDigests",
  "universe",
  "unresolved",
];

/** Converts one validated native clangd generation into the common protocol. */
export class CppGraphSnapshotAdapter {
  public readonly store: GraphSnapshotProtocol.Store;
  private readonly selectedLanguages: ReadonlySet<GraphLanguage>;
  private rawShards = new Map<string, ICppGraphSnapshot.IShard>();
  private graphShards = new Map<string, GraphSnapshotProtocol.IShard>();
  private rawGeneration: string | undefined;

  public constructor(
    private readonly root: string,
    private readonly producerCommit: string,
    languages: readonly GraphLanguage[] = ["c", "cpp"],
  ) {
    this.store = new GraphSnapshotProtocol.Store(root);
    this.selectedLanguages = new Set(languages);
  }

  public get generation(): string | undefined {
    return this.rawGeneration;
  }

  public apply(
    raw: ICppGraphSnapshot,
    validate: (snapshot: IBulkGraphSession.ISnapshot) => void,
  ): CppGraphSnapshotAdapter.IResult {
    assertSnapshot(raw, this.producerCommit);
    if (
      raw.baseGeneration !== null &&
      raw.baseGeneration !== this.rawGeneration
    ) {
      throw new Error("C/C++ clang graph: stale producer base generation");
    }
    const prior = this.store.current;
    if (
      prior !== undefined &&
      raw.generation === this.rawGeneration &&
      raw.baseGeneration === this.rawGeneration &&
      raw.upserts.length === 0 &&
      raw.deletes.length === 0 &&
      raw.manifest.length === 0 &&
      raw.page.total === 0 &&
      raw.phases.cacheHit &&
      raw.universe.digest === prior.provenance.universe
    ) {
      assertNativeGeneration(
        raw,
        nativeManifest(this.rawShards),
        this.rawShards,
      );
      return { changed: false, mode: "unchanged", snapshot: prior };
    }
    const nextRaw =
      raw.baseGeneration === null
        ? new Map<string, ICppGraphSnapshot.IShard>()
        : new Map(this.rawShards);
    const touched = new Set<string>();
    for (const key of raw.deletes) {
      if (touched.has(key) || !nextRaw.delete(key)) {
        throw new Error(`C/C++ clang graph: invalid delete ${key}`);
      }
      touched.add(key);
    }
    for (const shard of raw.upserts) {
      assertShard(shard, producerFingerprint(raw.producer));
      if (touched.has(shard.key)) {
        throw new Error(`C/C++ clang graph: duplicate delta ${shard.key}`);
      }
      touched.add(shard.key);
      nextRaw.set(shard.key, structuredClone(shard));
    }
    const expectedManifest = nativeManifest(nextRaw);
    if (
      expectedManifest.length !== raw.manifest.length ||
      expectedManifest.some(
        (entry, index) =>
          entry.key !== raw.manifest[index]?.key ||
          entry.digest !== raw.manifest[index]?.digest,
      )
    ) {
      throw new Error("C/C++ clang graph: producer manifest mismatch");
    }
    assertNativeGeneration(raw, expectedManifest, nextRaw);

    const hello = helloOf(raw, nextRaw, this.selectedLanguages);
    const languagesChanged =
      prior !== undefined &&
      JSON.stringify(prior.languages) !== JSON.stringify(hello.languages);
    const universeChanged =
      prior !== undefined && raw.universe.digest !== prior.provenance.universe;
    const requiresReload = languagesChanged || universeChanged;
    const nextGraph =
      raw.baseGeneration === null || requiresReload
        ? new Map<string, GraphSnapshotProtocol.IShard>()
        : new Map(this.graphShards);
    const graphUpserts = requiresReload ? [...nextRaw.values()] : raw.upserts;
    for (const key of raw.deletes) nextGraph.delete(graphKey(key));
    for (const shard of graphUpserts) {
      const key = graphKey(shard.key);
      const language = shard.graph.language;
      if (
        (language !== "c" && language !== "cpp") ||
        !this.selectedLanguages.has(language)
      ) {
        nextGraph.delete(key);
        continue;
      }
      nextGraph.set(key, adaptShard(this.root, raw, shard, hello.languages));
    }
    const sequence = (prior?.protocol?.sequence ?? 0) + 1;
    const manifest = [...nextGraph]
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, shard]) => ({
        key,
        digest: GraphSnapshotProtocol.shardDigest(shard),
      }));
    const ordered = manifest.map((entry) => nextGraph.get(entry.key)!);
    const targets = [...new Set(ordered.map((shard) => shard.target))].sort(
      compareText,
    );
    const begin: GraphSnapshotProtocol.IBegin = {
      type: "begin",
      sequence,
      generation: raw.generation,
      ...(raw.baseGeneration !== null && prior !== undefined && !requiresReload
        ? {
            baseSequence: prior.protocol!.sequence,
            baseGeneration: prior.protocol!.generation,
          }
        : {}),
      universe: raw.universe.digest,
      manifest: GraphSnapshotProtocol.manifestDigest(
        ordered.flatMap((shard) => shard.sources),
      ),
      targets,
    };
    const facts = factsOf(hello, begin, ordered);
    const commit: GraphSnapshotProtocol.ICommit = {
      type: "commit",
      sequence,
      generation: raw.generation,
      shards: manifest,
      factDigest: GraphSnapshotProtocol.factDigest(facts),
    };
    const frames = framesOf(hello, begin, commit, manifest, nextGraph, prior);
    const fullBegin: GraphSnapshotProtocol.IBegin = {
      ...begin,
      baseSequence: undefined,
      baseGeneration: undefined,
    };
    const fullFrames: GraphSnapshotProtocol.Frame[] = [hello, fullBegin];
    for (const entry of manifest) {
      fullFrames.push({
        type: "upsertShard",
        digest: entry.digest,
        shard: structuredClone(nextGraph.get(entry.key)!),
      });
    }
    fullFrames.push(commit);
    new GraphSnapshotProtocol.Store(this.root).apply(fullFrames, { validate });
    const snapshot = this.store.apply(frames, { validate });
    this.rawShards = nextRaw;
    this.graphShards = nextGraph;
    this.rawGeneration = raw.generation;
    return {
      changed: true,
      mode:
        prior === undefined
          ? "initial"
          : begin.baseGeneration === undefined
            ? "reload"
            : "incremental",
      snapshot,
    };
  }
}

export namespace CppGraphSnapshotAdapter {
  export interface IResult {
    changed: boolean;
    mode: IBulkGraphSession.Mode;
    snapshot: IBulkGraphSession.ISnapshot;
  }
}

function framesOf(
  hello: GraphSnapshotProtocol.IHello,
  begin: GraphSnapshotProtocol.IBegin,
  commit: GraphSnapshotProtocol.ICommit,
  manifest: readonly IBulkGraphSession.IShard[],
  shards: ReadonlyMap<string, GraphSnapshotProtocol.IShard>,
  prior: IBulkGraphSession.ISnapshot | undefined,
): GraphSnapshotProtocol.Frame[] {
  const frames: GraphSnapshotProtocol.Frame[] = [hello, begin];
  if (begin.baseGeneration === undefined) {
    for (const entry of manifest) {
      frames.push({
        type: "upsertShard",
        digest: entry.digest,
        shard: structuredClone(shards.get(entry.key)!),
      });
    }
  } else {
    const old = new Map(
      prior!.protocol!.shards.map((entry) => [entry.key, entry.digest]),
    );
    for (const entry of manifest) {
      if (old.get(entry.key) === entry.digest) continue;
      frames.push({
        type: "upsertShard",
        digest: entry.digest,
        shard: structuredClone(shards.get(entry.key)!),
      });
    }
  }
  frames.push(commit);
  return frames;
}

interface IContext {
  root: string;
  raw: ICppGraphSnapshot;
  shard: ICppGraphSnapshot.IShard;
  graph: ICppGraphSnapshot.ITU;
  language: GraphLanguage;
  target: string;
  nodes: Map<string, ISamchonGraphNode>;
  ids: Map<string, string>;
  files: Map<string, string>;
  edges: Map<string, ISamchonGraphEdge>;
  unresolved: ISamchonGraphUnresolved[];
}

function adaptShard(
  root: string,
  raw: ICppGraphSnapshot,
  shard: ICppGraphSnapshot.IShard,
  snapshotLanguages: readonly GraphLanguage[],
): GraphSnapshotProtocol.IShard {
  const graph = shard.graph;
  const language = graph.language as GraphLanguage;
  const context: IContext = {
    root,
    raw,
    shard,
    graph,
    language,
    target: `${graph.targetTriple}#${graph.commandDigest}`,
    nodes: new Map(),
    ids: new Map(),
    files: new Map(),
    edges: new Map(),
    unresolved: [],
  };
  for (const source of graph.sources) fileNode(context, source.uri);
  for (const symbol of graph.symbols) symbolNode(context, symbol);
  for (const macro of graph.macros) macroNode(context, macro);
  for (const module of graph.modules) {
    moduleNode(context, module.name, module.evidence);
  }

  for (const symbol of graph.symbols) {
    const id = endpoint(context, symbol.id);
    const owner =
      symbol.ownerUsr === "" ? undefined : endpoint(context, symbol.ownerUsr);
    const location = preferredRange(symbol);
    addEdge(
      context,
      owner ?? fileNode(context, location.file),
      id,
      "contains",
      location,
    );
    if (symbol.exported) {
      addEdge(
        context,
        fileNode(context, location.file),
        id,
        "exports",
        location,
      );
    }
  }
  for (const include of graph.includes) {
    addEdge(
      context,
      fileNode(context, include.source),
      fileNode(context, include.target),
      "imports",
      include.evidence,
    );
  }
  for (const module of graph.modules) {
    addEdge(
      context,
      fileNode(context, module.evidence.file || graph.mainFileUri),
      moduleNode(context, module.name, module.evidence),
      "imports",
      module.evidence,
    );
  }
  for (const occurrence of graph.occurrences) {
    adaptOccurrence(context, occurrence);
  }
  // Occurrences carry the exact use-site span. Add them before the coarser
  // semantic relation lane so endpoint-pair deduplication retains that span.
  for (const relation of graph.relations) adaptRelation(context, relation);
  for (const macro of graph.macros) adaptMacro(context, macro);

  const coverageByFamily = new Map(
    shard.coverage.map((row) => [row.family, row.state]),
  );
  const advertised = new Set(CPP_CLANG_FACTS);
  const coverage: ISamchonGraphCoverage[] = snapshotLanguages.flatMap(
    (coverageLanguage) =>
      GRAPH_EDGE_KINDS.map((family) => ({
        provider: CPP_CLANG_PROVIDER,
        language: coverageLanguage,
        target: context.target,
        family,
        state:
          coverageLanguage === language && advertised.has(family)
            ? (coverageByFamily.get(
                family,
              )! as ISamchonGraphCoverage["state"])
            : "unsupported",
      })),
  );
  const fallbackEvidence = evidenceOf(root, {
    file: graph.mainFileUri,
    startLine: 0,
    startColumn: 0,
    endLine: 0,
    endColumn: 0,
  });
  for (const row of coverage) {
    if (
      row.language !== language ||
      row.state !== "partial" ||
      context.unresolved.some((site) => site.family === row.family)
    ) {
      continue;
    }
    context.unresolved.push({
      provider: CPP_CLANG_PROVIDER,
      language,
      target: context.target,
      universe: raw.universe.digest,
      family: row.family,
      evidence: fallbackEvidence,
      reason: "provider-gap",
    });
  }
  const diagnostics: ISamchonGraphDiagnostic[] = graph.diagnostics.map(
    (row) => ({
      file: graphFile(root, row.range.file),
      line: row.range.file === "" ? 0 : row.range.startLine + 1,
      column: row.range.file === "" ? 0 : row.range.startColumn + 1,
      code: row.code,
      message: row.message,
      severity: row.severity as ISamchonGraphDiagnostic["severity"],
    }),
  );
  return {
    key: graphKey(shard.key),
    target: context.target,
    languages: [language],
    nodes: [...context.nodes.values()].sort((left, right) =>
      compareText(left.id, right.id),
    ),
    edges: [...context.edges.values()].sort(compareEdge),
    diagnostics,
    coverage,
    unresolved: context.unresolved,
    sources: graph.sources.map((source) => ({
      file: sourceFile(root, source.uri),
      checkerDigest: source.digest,
      diskDigest: source.diskDigest,
    })),
  };
}

function symbolNode(
  context: IContext,
  symbol: ICppGraphSnapshot.ISymbol,
): string {
  const range = preferredRange(symbol);
  const file = graphFile(
    context.root,
    range.file || context.graph.mainFileUri,
  );
  const kind = nodeKind(symbol.kind);
  const display = symbol.qualifiedName || symbol.name;
  const id = semanticGraphNodeId(
    {
      version: 2,
      language: context.language,
      symbol: symbol.id,
      role: kind,
      native: { key: symbol.id, stability: "semantic" },
      scope: {
        target: context.shard.configuration,
        translationUnit: graphFile(
          context.root,
          context.graph.mainFileUri,
        ),
        document: file,
      },
      stability: "persistent",
    },
    display,
  );
  const node: ISamchonGraphNode = {
    id,
    kind,
    language: context.language,
    name: symbol.name,
    ...(symbol.qualifiedName !== "" && symbol.qualifiedName !== symbol.name
      ? { qualifiedName: symbol.qualifiedName }
      : {}),
    file,
    external: isExternal(file),
    exported: symbol.exported,
    ...(symbol.signature === "" ? {} : { signature: symbol.signature }),
    ...(validRange(range)
      ? { evidence: evidenceOf(context.root, range) }
      : {}),
    ...(symbol.attributes.length === 0
      ? {}
      : {
          decorators: symbol.attributes.map((attribute) => ({
            name: attribute.name,
            arguments: [],
          })),
        }),
  };
  context.ids.set(symbol.id, id);
  context.nodes.set(id, node);
  return id;
}

function macroNode(context: IContext, macro: ICppGraphSnapshot.IMacro): string {
  const found = context.ids.get(macro.id);
  if (found !== undefined) return found;
  const file = graphFile(
    context.root,
    macro.definition.file ||
      macro.spelling.file ||
      macro.expansion.file ||
      context.graph.mainFileUri,
  );
  const id = semanticGraphNodeId(
    {
      version: 2,
      language: context.language,
      symbol: macro.id,
      role: "variable",
      native: { key: macro.id, stability: "semantic" },
      scope: {
        target: context.shard.configuration,
        translationUnit: graphFile(
          context.root,
          context.graph.mainFileUri,
        ),
        document: file,
      },
      stability: "persistent",
    },
    macro.name,
  );
  context.ids.set(macro.id, id);
  context.nodes.set(id, {
    id,
    kind: "variable",
    language: context.language,
    name: macro.name,
    file,
    external: isExternal(file),
    ...(validRange(macro.definition)
      ? { evidence: evidenceOf(context.root, macro.definition) }
      : {}),
  });
  return id;
}

function moduleNode(
  context: IContext,
  name: string,
  range: ICppGraphSnapshot.IRange,
): string {
  const raw = `module:${name}`;
  const found = context.ids.get(raw);
  if (found !== undefined) return found;
  const file = graphFile(
    context.root,
    range.file || context.graph.mainFileUri,
  );
  const id = semanticGraphNodeId(
    {
      version: 2,
      language: context.language,
      symbol: raw,
      role: "module",
      native: { key: raw, stability: "semantic" },
      scope: {
        target: context.shard.configuration,
        translationUnit: graphFile(
          context.root,
          context.graph.mainFileUri,
        ),
      },
      stability: "persistent",
    },
    name,
  );
  context.ids.set(raw, id);
  context.nodes.set(id, {
    id,
    kind: "module",
    language: context.language,
    name,
    file,
    external: isExternal(file),
  });
  return id;
}

function fileNode(context: IContext, uri: string): string {
  const key = uri || context.graph.mainFileUri;
  const found = context.files.get(key);
  if (found !== undefined) return found;
  const file = graphFile(context.root, key);
  const id = semanticGraphNodeId(
    {
      version: 2,
      language: context.language,
      symbol: `file:${key}`,
      role: "file",
      native: { key, stability: "semantic" },
      scope: {
        target: context.shard.configuration,
        translationUnit: graphFile(
          context.root,
          context.graph.mainFileUri,
        ),
        document: file,
      },
      stability: "persistent",
    },
    file,
  );
  context.files.set(key, id);
  context.nodes.set(id, {
    id,
    kind: "file",
    language: context.language,
    name: path.posix.basename(file),
    qualifiedName: file,
    file,
    external: isExternal(file),
  });
  return id;
}

function endpoint(context: IContext, raw: string): string {
  const found = context.ids.get(raw);
  if (found !== undefined) return found;
  const name = raw;
  const id = semanticGraphNodeId(
    {
      version: 2,
      language: context.language,
      symbol: name,
      role: "external_symbol",
      native: { key: name, stability: "semantic" },
      scope: {
        target: context.shard.configuration,
        translationUnit: graphFile(
          context.root,
          context.graph.mainFileUri,
        ),
      },
      stability: "persistent",
    },
    name,
  );
  context.ids.set(raw, id);
  context.nodes.set(id, {
    id,
    kind: "external_symbol",
    language: context.language,
    name,
    file: "bundled:///clang/external",
    external: true,
  });
  return id;
}

function adaptRelation(
  context: IContext,
  relation: ICppGraphSnapshot.IRelation,
): void {
  const subject = endpoint(context, relation.subjectId);
  const object = endpoint(context, relation.objectId);
  if (relation.roles & (ROLE.childOf | ROLE.containedBy)) {
    addEdge(context, object, subject, "contains", relation.evidence);
  }
  if (relation.roles & ROLE.baseOf) {
    addEdge(context, object, subject, "extends", relation.evidence);
  }
  if (relation.roles & ROLE.extendedBy) {
    addEdge(context, object, subject, "extends", relation.evidence);
  }
  if (relation.roles & ROLE.overrideOf) {
    addEdge(context, subject, object, "overrides", relation.evidence);
  }
  if (relation.roles & ROLE.calledBy) {
    addEdge(context, object, subject, "calls", relation.evidence);
  }
  if (relation.roles & ROLE.accessorOf) {
    addEdge(context, subject, object, "accesses", relation.evidence);
  }
  if (relation.roles & ROLE.specializationOf) {
    addEdge(context, subject, object, "instantiates", relation.evidence);
  }
}

function adaptOccurrence(
  context: IContext,
  occurrence: ICppGraphSnapshot.IOccurrence,
): void {
  const target = endpoint(context, occurrence.id);
  const range = validRange(occurrence.expansion)
    ? occurrence.expansion
    : occurrence.spelling;
  const owner =
    occurrence.containerId === ""
      ? fileNode(context, range.file)
      : endpoint(context, occurrence.containerId);
  if (occurrence.roles & ROLE.call) {
    addEdge(context, owner, target, "calls", range);
  }
  if ((occurrence.roles & ROLE.call) && occurrence.targetKind === 23) {
    addEdge(context, owner, target, "instantiates", range);
  }
  if (occurrence.roles & (ROLE.read | ROLE.write)) {
    addEdge(context, owner, target, "accesses", range);
  }
  if (occurrence.roles & ROLE.reference) {
    addEdge(context, owner, target, "references", range);
  }
  if (
    (occurrence.roles & (ROLE.reference | ROLE.nameReference)) &&
    TYPE_KINDS.has(occurrence.targetKind)
  ) {
    addEdge(context, owner, target, "type_ref", range);
  }
  if ((occurrence.roles & ROLE.dynamic) && validRange(range)) {
    context.unresolved.push({
      provider: CPP_CLANG_PROVIDER,
      language: context.language,
      target: context.target,
      universe: context.raw.universe.digest,
      family: "dispatches",
      evidence: evidenceOf(context.root, range),
      reason: "dynamic",
      candidates: [target],
    });
  }
}

function adaptMacro(context: IContext, macro: ICppGraphSnapshot.IMacro): void {
  const target = macroNode(context, macro);
  const range = validRange(macro.expansion)
    ? macro.expansion
    : macro.spelling;
  const definitionFile =
    macro.definition.file || context.graph.mainFileUri;
  if (macro.roles & ROLE.reference) {
    addEdge(
      context,
      fileNode(context, range.file || definitionFile),
      target,
      "references",
      range,
    );
  }
  if (macro.roles & (ROLE.declaration | ROLE.definition)) {
    addEdge(
      context,
      fileNode(context, definitionFile),
      target,
      "contains",
      macro.definition,
    );
  }
}

function addEdge(
  context: IContext,
  from: string,
  to: string,
  kind: GraphEdgeKind,
  range: ICppGraphSnapshot.IRange,
): void {
  if (from === to) return;
  const key = `${from}\0${to}\0${kind}`;
  if (context.edges.has(key)) return;
  context.edges.set(key, {
    from,
    to,
    kind,
    ...(validRange(range)
      ? { evidence: evidenceOf(context.root, range) }
      : {}),
  });
}

function preferredRange(
  symbol: ICppGraphSnapshot.ISymbol,
): ICppGraphSnapshot.IRange {
  return validRange(symbol.definition) ? symbol.definition : symbol.declaration;
}

function evidenceOf(
  root: string,
  range: ICppGraphSnapshot.IRange,
): ISamchonGraphEvidence {
  return {
    file: graphFile(root, range.file),
    startLine: range.startLine + 1,
    startCol: range.startColumn + 1,
    endLine: range.endLine + 1,
    endCol: range.endColumn + 1,
  };
}

function graphFile(root: string, source: string): string {
  if (source === "") return "";
  assertSupportedSource(source);
  let absolute = source;
  if (source.startsWith("file:")) {
    absolute = fileURLToPath(source);
  }
  if (!path.isAbsolute(absolute)) return absolute.replaceAll("\\", "/");
  const relative = path.relative(root, absolute).replaceAll("\\", "/");
  return path.isAbsolute(relative)
    ? externalGraphFile(absolute)
    : relative;
}

/* c8 ignore next -- only Windows cross-volume or UNC sources reach this helper. */
function externalGraphFile(source: string): string {
  const normalized = path.normalize(source);
  /* c8 ignore next 3 -- only one platform's path-identity arm runs per host. */
  const identity = process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
  /* c8 ignore next -- a producer source is a file, never a filesystem root. */
  const basename = encodeURIComponent(path.basename(normalized) || "source");
  return `bundled:///clang/filesystem/${sha256(identity)}/${basename}`;
}

function sourceFile(root: string, source: string): string {
  assertSupportedSource(source);
  if (source.startsWith("bundled:///")) return source;
  if (source.startsWith("file:")) {
    return path.normalize(fileURLToPath(source));
  }
  return path.normalize(
    path.isAbsolute(source) ? source : path.resolve(root, source),
  );
}

function assertSupportedSource(source: string): void {
  /* c8 ignore next 3 -- assertGraph validates every native source before adaptation. */
  if (!isSupportedSource(source)) {
    throw new Error(`unsupported C/C++ graph source URI: ${source}`);
  }
}

function isSupportedSource(source: string): boolean {
  if (source.startsWith("bundled:///")) {
    const relative = source.slice("bundled:///".length);
    return (
      relative !== "" &&
      !relative.includes("\\") &&
      path.posix.normalize(relative) === relative &&
      relative
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== "..")
    );
  }
  if (source.startsWith("file:")) {
    try {
      return path.isAbsolute(fileURLToPath(source));
    } catch {
      return false;
    }
  }
  return (
    path.isAbsolute(source) ||
    !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(source)
  );
}

function graphKey(raw: string): string {
  return `cpp-shard:${sha256(raw)}`;
}

function isExternal(file: string): boolean {
  return file.startsWith("../") || file.startsWith("bundled:///");
}

function validRange(range: ICppGraphSnapshot.IRange): boolean {
  return range.file !== "";
}

function nodeKind(kind: number): GraphNodeKind {
  return NODE_KINDS[kind] ?? "external_symbol";
}

const NODE_KINDS: Record<number, GraphNodeKind> = {
  1: "module",
  2: "namespace",
  3: "namespace",
  4: "variable",
  5: "file",
  6: "enum",
  7: "class",
  8: "class",
  9: "interface",
  10: "type",
  11: "type",
  12: "type",
  13: "function",
  14: "variable",
  15: "field",
  16: "field",
  17: "method",
  18: "method",
  19: "method",
  20: "property",
  21: "property",
  22: "property",
  23: "constructor",
  24: "method",
  25: "method",
  26: "parameter",
  27: "type",
  28: "type",
  29: "type",
  30: "parameter",
  31: "interface",
};

function helloOf(
  raw: ICppGraphSnapshot,
  shards: ReadonlyMap<string, ICppGraphSnapshot.IShard>,
  selectedLanguages: ReadonlySet<GraphLanguage>,
): GraphSnapshotProtocol.IHello {
  const languages = new Set<GraphLanguage>();
  for (const shard of shards.values()) {
    if (
      (shard.graph.language === "c" || shard.graph.language === "cpp") &&
      selectedLanguages.has(shard.graph.language)
    ) {
      languages.add(shard.graph.language);
    }
  }
  return {
    type: "hello",
    protocolVersion: 1,
    schemaVersion: 1,
    producerSchemaVersion: raw.schemaVersion,
    provider: CPP_CLANG_PROVIDER,
    producer: raw.producer.name,
    producerVersion: `${raw.producer.version} (${raw.producer.commit})`,
    compilerVersion: raw.producer.version,
    languages: [...languages].sort(compareText),
    authority: "compiler",
    supportedFacts: [...CPP_CLANG_FACTS],
    capabilities: [...CAPABILITIES],
  };
}

function factsOf(
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

function assertSnapshot(raw: ICppGraphSnapshot, commit: string): void {
  if (
    raw === null ||
    typeof raw !== "object" ||
    raw.protocolVersion !== 1 ||
    raw.schemaVersion !== 1
  ) {
    throw new Error("C/C++ clang graph: unsupported producer protocol/schema");
  }
  if (
    raw.producer?.name !== "samchon-clangd" ||
    typeof raw.producer.version !== "string" ||
    typeof raw.producer.commit !== "string" ||
    !raw.producer.commit.includes(commit) ||
    raw.producer.version === ""
  ) {
    throw new Error("C/C++ clang graph: producer identity/commit mismatch");
  }
  if (
    !SHA256.test(raw.universe?.digest) ||
    !SHA256.test(raw.generation) ||
    !Number.isSafeInteger(raw.sequence) ||
    raw.sequence < 1 ||
    !Array.isArray(raw.upserts) ||
    !Array.isArray(raw.deletes) ||
    !Array.isArray(raw.manifest) ||
    !isRecord(raw.page) ||
    !isRecord(raw.phases)
  ) {
    throw new Error("C/C++ clang graph: malformed generation envelope");
  }
  if (raw.baseGeneration !== null && !SHA256.test(raw.baseGeneration)) {
    throw new Error("C/C++ clang graph: malformed base generation");
  }
  if (
    !isRecord(raw.universe) ||
    !canonicalStrings(raw.universe.targets, false) ||
    raw.universe.targets.length === 0 ||
    !canonicalStrings(raw.universe.workspaceRoots, true) ||
    !canonicalStrings(raw.universe.toolchains, false) ||
    !canonicalStrings(raw.universe.configurations, false)
  ) {
    throw new Error("C/C++ clang graph: malformed universe");
  }
  if (!canonicalStrings(raw.deletes, false)) {
    throw new Error("C/C++ clang graph: malformed delete set");
  }
  if (
    !nonnegativeInteger(raw.page.offset) ||
    !nonnegativeInteger(raw.page.count) ||
    !nonnegativeInteger(raw.page.total) ||
    raw.page.offset !== 0 ||
    raw.page.count !== raw.upserts.length ||
    raw.page.total !== raw.upserts.length ||
    raw.page.nextCursor !== null
  ) {
    throw new Error("C/C++ clang graph: malformed assembled page");
  }
  const manifestKeys = new Set<string>();
  for (const entry of raw.manifest) {
    if (
      !isRecord(entry) ||
      typeof entry.key !== "string" ||
      entry.key === "" ||
      manifestKeys.has(entry.key) ||
      typeof entry.digest !== "string" ||
      !SHA256.test(entry.digest)
    ) {
      throw new Error("C/C++ clang graph: malformed native manifest");
    }
    manifestKeys.add(entry.key);
  }
  if (
    !nonnegativeInteger(raw.phases.validationMillis) ||
    !nonnegativeInteger(raw.phases.semanticMillis) ||
    !nonnegativeInteger(raw.phases.shardMillis) ||
    !nonnegativeInteger(raw.phases.encodeMillis) ||
    !nonnegativeInteger(raw.phases.totalMillis) ||
    typeof raw.phases.cacheHit !== "boolean" ||
    raw.phases.totalMillis !==
      raw.phases.validationMillis +
        raw.phases.semanticMillis +
        raw.phases.shardMillis +
        raw.phases.encodeMillis
  ) {
    throw new Error("C/C++ clang graph: malformed phase telemetry");
  }
}

function assertShard(
  shard: ICppGraphSnapshot.IShard,
  expectedProducerFingerprint: string,
): void {
  if (
    !isRecord(shard) ||
    typeof shard.key !== "string" ||
    shard.key === "" ||
    typeof shard.source !== "string" ||
    shard.source === "" ||
    typeof shard.configuration !== "string" ||
    !SHA256.test(shard.digest) ||
    !SHA256.test(shard.checkerDigest) ||
    !SHA256.test(shard.interfaceFingerprint) ||
    !Array.isArray(shard.coverage) ||
    !isRecord(shard.graph) ||
    shard.configuration !== shard.graph.commandDigest ||
    shard.graph.hadErrors
  ) {
    throw new Error(`C/C++ clang graph: malformed shard ${shard.key}`);
  }
  assertGraph(shard.graph, shard.key);
  if (shard.graph.producerFingerprint !== expectedProducerFingerprint) {
    throw new Error(
      `C/C++ clang graph: compiler fingerprint mismatch ${shard.key}`,
    );
  }
  const source = shard.graph.sources.find(
    (entry) => entry.uri === shard.graph.mainFileUri,
  );
  if (
    source?.digest !== shard.checkerDigest ||
    shard.source !== shard.graph.mainFile
  ) {
    throw new Error(`C/C++ clang graph: mismatched main source ${shard.key}`);
  }
  const expected = sha256(
    `${shard.key}\n${shard.checkerDigest}\n${shard.interfaceFingerprint}\n${JSON.stringify(shard.graph)}`,
  );
  if (expected !== shard.digest) {
    throw new Error(`C/C++ clang graph: shard digest mismatch ${shard.key}`);
  }
  const families = new Set<string>();
  for (const row of shard.coverage) {
    if (
      families.has(row.family) ||
      !GRAPH_EDGE_KINDS.includes(row.family as GraphEdgeKind) ||
      !["complete", "partial", "unsupported"].includes(row.state)
    ) {
      throw new Error(`C/C++ clang graph: invalid coverage ${shard.key}`);
    }
    families.add(row.family);
  }
  if (families.size !== GRAPH_EDGE_KINDS.length) {
    throw new Error(`C/C++ clang graph: incomplete coverage ${shard.key}`);
  }
}

function assertGraph(graph: ICppGraphSnapshot.ITU, key: string): void {
  if (
    typeof graph.producerFingerprint !== "string" ||
    !SHA256.test(graph.producerFingerprint) ||
    typeof graph.mainFileUri !== "string" ||
    graph.mainFileUri === "" ||
    !isSupportedSource(graph.mainFileUri) ||
    typeof graph.mainFile !== "string" ||
    graph.mainFile === "" ||
    !isSupportedSource(graph.mainFile) ||
    typeof graph.directory !== "string" ||
    !canonicalStrings(graph.commandLine, true, false) ||
    typeof graph.output !== "string" ||
    typeof graph.commandDigest !== "string" ||
    !SHA256.test(graph.commandDigest) ||
    typeof graph.toolchainFingerprint !== "string" ||
    !SHA256.test(graph.toolchainFingerprint) ||
    typeof graph.targetTriple !== "string" ||
    graph.targetTriple === "" ||
    (graph.language !== "c" && graph.language !== "cpp") ||
    typeof graph.hadErrors !== "boolean" ||
    !Array.isArray(graph.sources) ||
    !Array.isArray(graph.symbols) ||
    !Array.isArray(graph.occurrences) ||
    !Array.isArray(graph.relations) ||
    !Array.isArray(graph.macros) ||
    !Array.isArray(graph.includes) ||
    !Array.isArray(graph.missingIncludes) ||
    graph.missingIncludes.length !== 0 ||
    !Array.isArray(graph.modules) ||
    !Array.isArray(graph.diagnostics)
  ) {
    throw new Error(`C/C++ clang graph: malformed graph ${key}`);
  }
  const sources = new Set<string>();
  for (const source of graph.sources) {
    if (
      !isRecord(source) ||
      typeof source.uri !== "string" ||
      source.uri === "" ||
      !isSupportedSource(source.uri) ||
      sources.has(source.uri) ||
      typeof source.digest !== "string" ||
      !SHA256.test(source.digest) ||
      typeof source.diskDigest !== "string" ||
      (source.diskDigest !== "" && !SHA256.test(source.diskDigest)) ||
      !nonnegativeInteger(source.flags)
    ) {
      throw new Error(`C/C++ clang graph: malformed source ${key}`);
    }
    sources.add(source.uri);
  }
  const symbols = new Set<string>();
  for (const symbol of graph.symbols) {
    if (
      !isRecord(symbol) ||
      typeof symbol.usr !== "string" ||
      symbol.usr === "" ||
      typeof symbol.id !== "string" ||
      symbol.id === "" ||
      symbols.has(symbol.id) ||
      typeof symbol.name !== "string" ||
      symbol.name === "" ||
      typeof symbol.qualifiedName !== "string" ||
      typeof symbol.ownerUsr !== "string" ||
      typeof symbol.signature !== "string" ||
      !nonnegativeInteger(symbol.kind) ||
      !nonnegativeInteger(symbol.subKind) ||
      !nonnegativeInteger(symbol.properties) ||
      typeof symbol.local !== "boolean" ||
      typeof symbol.internal !== "boolean" ||
      typeof symbol.anonymous !== "boolean" ||
      typeof symbol.exported !== "boolean" ||
      !validNativeRange(symbol.declaration) ||
      !validNativeRange(symbol.definition) ||
      !Array.isArray(symbol.attributes) ||
      symbol.attributes.some(
        (attribute) =>
          !isRecord(attribute) ||
          typeof attribute.name !== "string" ||
          attribute.name === "" ||
          !validNativeRange(attribute.range),
      )
    ) {
      throw new Error(`C/C++ clang graph: malformed symbol ${key}`);
    }
    symbols.add(symbol.id);
  }
  for (const occurrence of graph.occurrences) {
    if (
      !isRecord(occurrence) ||
      typeof occurrence.usr !== "string" ||
      occurrence.usr === "" ||
      typeof occurrence.id !== "string" ||
      occurrence.id === "" ||
      typeof occurrence.containerId !== "string" ||
      !nonnegativeInteger(occurrence.roles) ||
      !nonnegativeInteger(occurrence.targetKind) ||
      !validNativeRange(occurrence.spelling) ||
      !validNativeRange(occurrence.expansion)
    ) {
      throw new Error(`C/C++ clang graph: malformed occurrence ${key}`);
    }
  }
  for (const relation of graph.relations) {
    if (
      !isRecord(relation) ||
      typeof relation.subjectId !== "string" ||
      relation.subjectId === "" ||
      typeof relation.objectId !== "string" ||
      relation.objectId === "" ||
      !nonnegativeInteger(relation.roles) ||
      !validNativeRange(relation.evidence)
    ) {
      throw new Error(`C/C++ clang graph: malformed relation ${key}`);
    }
  }
  // Macro rows are occurrences. Definition and reference rows intentionally
  // share the stable macro endpoint ID.
  for (const macro of graph.macros) {
    if (
      !isRecord(macro) ||
      typeof macro.usr !== "string" ||
      macro.usr === "" ||
      typeof macro.id !== "string" ||
      macro.id === "" ||
      typeof macro.name !== "string" ||
      macro.name === "" ||
      !nonnegativeInteger(macro.roles) ||
      !validNativeRange(macro.definition) ||
      !validNativeRange(macro.spelling) ||
      !validNativeRange(macro.expansion)
    ) {
      throw new Error(`C/C++ clang graph: malformed macro ${key}`);
    }
  }
  for (const include of graph.includes) {
    if (
      !isRecord(include) ||
      typeof include.source !== "string" ||
      include.source === "" ||
      !isSupportedSource(include.source) ||
      typeof include.target !== "string" ||
      include.target === "" ||
      !isSupportedSource(include.target) ||
      typeof include.spelling !== "string" ||
      typeof include.angled !== "boolean" ||
      typeof include.moduleImported !== "boolean" ||
      !validNativeRange(include.evidence)
    ) {
      throw new Error(`C/C++ clang graph: malformed include ${key}`);
    }
  }
  for (const module of graph.modules) {
    if (
      !isRecord(module) ||
      typeof module.name !== "string" ||
      module.name === "" ||
      !nonnegativeInteger(module.roles) ||
      !validNativeRange(module.evidence)
    ) {
      throw new Error(`C/C++ clang graph: malformed module ${key}`);
    }
  }
  for (const diagnostic of graph.diagnostics) {
    if (
      !isRecord(diagnostic) ||
      typeof diagnostic.message !== "string" ||
      diagnostic.message === "" ||
      typeof diagnostic.code !== "string" ||
      diagnostic.code === "" ||
      !["error", "warning", "info", "hint"].includes(diagnostic.severity) ||
      !validNativeRange(diagnostic.range)
    ) {
      throw new Error(`C/C++ clang graph: malformed diagnostic ${key}`);
    }
  }
}

function nativeManifest(
  shards: ReadonlyMap<string, ICppGraphSnapshot.IShard>,
): Array<{ key: string; digest: string }> {
  return [...shards.values()]
    .sort((left, right) => {
      const mainFile = Buffer.compare(
        Buffer.from(left.graph.mainFile, "utf8"),
        Buffer.from(right.graph.mainFile, "utf8"),
      );
      if (mainFile !== 0) return mainFile;
      return Buffer.compare(
        Buffer.from(left.configuration, "utf8"),
        Buffer.from(right.configuration, "utf8"),
      );
    })
    .map((shard) => ({ key: shard.key, digest: shard.digest }));
}

function assertNativeGeneration(
  raw: ICppGraphSnapshot,
  manifest: Array<{ key: string; digest: string }>,
  shards: ReadonlyMap<string, ICppGraphSnapshot.IShard>,
): void {
  const configurations = [
    ...new Set([...shards.values()].map((shard) => shard.configuration)),
  ].sort(compareText);
  const targets = [
    ...new Set([...shards.values()].map((shard) => shard.graph.targetTriple)),
  ].sort(compareText);
  const toolchains = [
    ...new Set(
      [...shards.values()].map(
        (shard) => shard.graph.toolchainFingerprint,
      ),
    ),
  ].sort(compareText);
  if (
    JSON.stringify(configurations) !==
      JSON.stringify(raw.universe.configurations) ||
    JSON.stringify(targets) !== JSON.stringify(raw.universe.targets) ||
    JSON.stringify(toolchains) !== JSON.stringify(raw.universe.toolchains)
  ) {
    throw new Error("C/C++ clang graph: universe does not describe its shards");
  }
  const generationMaterial = manifest
    .map(
      (entry) =>
        `${Buffer.byteLength(entry.key, "utf8")}:${entry.key}${entry.digest}`,
    )
    .join("");
  let universeMaterial = coordinate(
    "producer",
    producerFingerprint(raw.producer),
  );
  for (const target of raw.universe.targets)
    universeMaterial += coordinate("target", target);
  for (const root of raw.universe.workspaceRoots)
    universeMaterial += coordinate("root", root);
  for (const toolchain of raw.universe.toolchains)
    universeMaterial += coordinate("toolchain", toolchain);
  for (const configuration of raw.universe.configurations)
    universeMaterial += coordinate("configuration", configuration);
  const universe = sha256(universeMaterial);
  if (
    universe !== raw.universe.digest ||
    sha256(universe + generationMaterial) !== raw.generation
  ) {
    throw new Error("C/C++ clang graph: generation digest mismatch");
  }
}

function coordinate(label: string, value: string): string {
  return `${label}:${Buffer.byteLength(value, "utf8")}:${value}`;
}

function producerFingerprint(
  producer: ICppGraphSnapshot.IProducer,
): string {
  return sha256(
    `samchon-graph-schema:1\nversion:${producer.version}\nrepository:${producer.commit}`,
  );
}

function validNativeRange(
  value: unknown,
): value is ICppGraphSnapshot.IRange {
  if (
    !isRecord(value) ||
    typeof value.file !== "string" ||
    !nonnegativeInteger(value.startLine) ||
    !nonnegativeInteger(value.startColumn) ||
    !nonnegativeInteger(value.endLine) ||
    !nonnegativeInteger(value.endColumn)
  ) {
    return false;
  }
  if (value.file === "") {
    return (
      value.startLine === 0 &&
      value.startColumn === 0 &&
      value.endLine === 0 &&
      value.endColumn === 0
    );
  }
  return (
    isSupportedSource(value.file) &&
    (value.endLine > value.startLine ||
      (value.endLine === value.startLine &&
        value.endColumn >= value.startColumn))
  );
}

function canonicalStrings(
  value: unknown,
  allowEmpty: boolean,
  canonical = true,
): value is string[] {
  if (!Array.isArray(value)) return false;
  let prior: string | undefined;
  for (const entry of value) {
    if (typeof entry !== "string" || (!allowEmpty && entry === "")) {
      return false;
    }
    if (canonical && prior !== undefined && entry <= prior) return false;
    prior = entry;
  }
  return true;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareEdge(
  left: ISamchonGraphEdge,
  right: ISamchonGraphEdge,
): number {
  return compareText(
    `${left.from}\0${left.to}\0${left.kind}`,
    `${right.from}\0${right.to}\0${right.kind}`,
  );
}
