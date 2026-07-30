import {
  isSemanticGraphNodeId,
  legacyGraphNodeIds,
  validateSemanticGraphNode,
} from "./provider/semanticIdentity";
import { normalizeGraphNodeKinds } from "./indexer/normalizeGraphNodeKinds";
import {
  ISamchonGraphDiagnostic,
  ISamchonGraphDump,
  ISamchonGraphEdge,
  ISamchonGraphEvidence,
  ISamchonGraphCoverage,
  ISamchonGraphNode,
  ISamchonGraphSpan,
  ISamchonGraphUnresolved,
} from "./structures";
import { GraphLanguage } from "./typings";
import { basename } from "./utils/path";
import { fileOfNodeId } from "./utils/fileOfNodeId";
import { SamchonGraphSourceReader } from "./SamchonGraphSourceReader";

/**
 * The in-memory resident graph the MCP tools answer from.
 *
 * It loads one dump — the indexer-resolved fact graph — then synthesizes the
 * structural layer the dump deliberately leaves to this layer: `file` container
 * nodes and the `contains` ownership tree, plus class-member property
 * refinement. Export and member implementation relationships are producer
 * facts already present in the dump. Every tool call is then a lookup or a
 * traversal over the indexes built here; nothing re-indexes.
 */
export class SamchonGraphMemory {
  private readonly byId: Map<string, ISamchonGraphNode>;
  private readonly outEdges: Map<string, ISamchonGraphEdge[]>;
  private readonly inEdges: Map<string, ISamchonGraphEdge[]>;
  private readonly bySymbolIndex: Map<string, ISamchonGraphNode[]>;
  private readonly byLegacyId: Map<string, ISamchonGraphNode[]>;

  /** The absolute project root the dump was built for. */
  public readonly project: string;
  /** The source languages present in the dump. */
  public readonly languages: readonly string[];
  /** Which indexing strategy produced the graph. */
  public readonly indexer: ISamchonGraphDump["indexer"];
  /** Every node, raw plus synthesized (file containers). */
  public readonly nodes: readonly ISamchonGraphNode[];
  /** Every edge, raw plus synthesized containment. */
  public readonly edges: readonly ISamchonGraphEdge[];
  /** Fused compiler and plugin diagnostics, when the build collected any. */
  public readonly diagnostics: readonly ISamchonGraphDiagnostic[];
  /** Non-fatal problems encountered while building the graph. */
  public readonly warnings: readonly string[];
  /** Strict-provider provenance retained from the exact dump generation. */
  public readonly provenance: readonly ISamchonGraphDump.IProvenance[];
  /** Machine-readable completeness of every strict relationship family. */
  public readonly coverage: readonly ISamchonGraphCoverage[];
  /** Exact sites whose relationships remain unresolved. */
  public readonly unresolved: readonly ISamchonGraphUnresolved[];
  /** Provenance-gated source display facts owned by this exact snapshot. */
  public readonly source: SamchonGraphSourceReader;

  private constructor(
    dump: ISamchonGraphDump,
    nodes: ISamchonGraphNode[],
    edges: ISamchonGraphEdge[],
    source: SamchonGraphSourceReader,
  ) {
    this.project = dump.project;
    this.languages = dump.languages;
    this.indexer = dump.indexer;
    this.nodes = nodes;
    this.edges = edges;
    this.diagnostics = dump.diagnostics ?? [];
    this.warnings = dump.warnings ?? [];
    this.provenance = dump.provenance ?? [];
    this.coverage = dump.coverage ?? [];
    this.unresolved = dump.unresolved ?? [];
    this.source = source;

    this.byId = indexNodesById(nodes);
    this.outEdges = new Map();
    this.inEdges = new Map();
    this.bySymbolIndex = new Map();
    this.byLegacyId = new Map();

    for (const node of nodes) {
      if (node.kind !== "file") {
        push(this.bySymbolIndex, node.name, node);
        if (node.qualifiedName !== undefined) {
          push(this.bySymbolIndex, node.qualifiedName, node);
        }
      }
      for (const legacyId of legacyGraphNodeIds(node)) {
        push(this.byLegacyId, legacyId, node);
      }
    }
    for (const candidates of this.byLegacyId.values()) {
      candidates.sort((left, right) => compareText(left.id, right.id));
    }
    for (const edge of edges) {
      push(this.outEdges, edge.from, edge);
      push(this.inEdges, edge.to, edge);
    }
  }

  /**
   * Build a model from a parsed dump, synthesizing structural relationships.
   * A caller that has only a dump has no proof for current disk bytes, so
   * source-derived display facts fail closed unless an explicit reader is
   * supplied.
   */
  public static from(
    dump: ISamchonGraphDump,
    source: SamchonGraphSourceReader = SamchonGraphSourceReader.none(dump.project),
  ): SamchonGraphMemory {
    const { nodes, edges } = synthesize(dump);
    return new SamchonGraphMemory(dump, nodes, edges, source);
  }

  /** The node with this id, or undefined. */
  public node(id: string): ISamchonGraphNode | undefined {
    return this.byId.get(id);
  }

  /** Edges leaving a node (the node is the `from`). */
  public outgoing(id: string): readonly ISamchonGraphEdge[] {
    return this.outEdges.get(id) ?? [];
  }

  /** Edges entering a node (the node is the `to`). */
  public incoming(id: string): readonly ISamchonGraphEdge[] {
    return this.inEdges.get(id) ?? [];
  }

  /** Every non-file node whose simple or owner-qualified symbol handle matches. */
  public symbols(handle: string): readonly ISamchonGraphNode[] {
    return this.bySymbolIndex.get(handle) ?? [];
  }

  /** Every semantic node that used to have this file-qualified identity. */
  public legacyNodes(id: string): readonly ISamchonGraphNode[] {
    return this.byLegacyId.get(id) ?? [];
  }

  /** Every workspace node on its module's export surface. */
  public exported(): ISamchonGraphNode[] {
    return this.nodes.filter((node) => node.exported && !node.external);
  }
}

/** Append value to the slice stored at key, creating the slice on first use. */
function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}

/** Build an exact node index, rejecting corrupt dumps instead of overwriting. */
function indexNodesById(
  nodes: readonly ISamchonGraphNode[],
): Map<string, ISamchonGraphNode> {
  const indexed = new Map<string, ISamchonGraphNode>();
  for (const node of nodes) {
    validateSemanticGraphNode(node);
    // A semantic id must be unique — a collision is a producer defect. A legacy
    // id may legitimately repeat (same-named locals, ambiguous handles the
    // name index and legacy-candidate resolver disambiguate), so it is kept,
    // last one winning the exact-id slot, rather than rejecting the dump.
    if (indexed.has(node.id) && isSemanticGraphNodeId(node.id)) {
      throw new Error(`@samchon/graph: duplicate node id in dump: ${node.id}`);
    }
    indexed.set(node.id, node);
  }
  return indexed;
}

/**
 * The within-file identity of a node: its owner-qualified name when it has one
 * (`Class.method`), else its simple name. Two nodes in one file never share a
 * key, so it is the handle the ownership synthesis looks owners up by.
 */
function keyOf(node: ISamchonGraphNode): string {
  return node.qualifiedName ?? node.name;
}

/** The owner key of a dotted key (`A.B.c` -> `A.B`), or "" for a top-level key. */
function ownerKey(key: string): string {
  const dot = key.lastIndexOf(".");
  return dot >= 0 ? key.slice(0, dot) : "";
}

/**
 * A wire span with its file put back: the one the indexer left out because the
 * reader has it, or the one it kept because it could not be derived (an
 * implementation in another file).
 */
function spanIn(span: ISamchonGraphSpan, file: string): ISamchonGraphEvidence {
  return { ...span, file: span.file ?? file };
}

/**
 * The source file a legacy node id names. Semantic ids deliberately carry no
 * file coordinate, so their declaring node must be consulted first.
 */
function fileOfLegacyNodeId(id: string): string | undefined {
  if (isSemanticGraphNodeId(id)) return undefined;
  return fileOfNodeId(id);
}

/** Resolve an edge source file without interpreting an opaque semantic id. */
function fileOfEdgeSource(
  id: string,
  byId: ReadonlyMap<string, ISamchonGraphNode>,
): string {
  const file = byId.get(id)?.file ?? fileOfLegacyNodeId(id);
  if (file !== undefined) return file;
  throw new Error(
    `@samchon/graph: semantic edge source is absent from the dump: ${id}`,
  );
}

/**
 * Derive the structural layer from a dump's faithful facts: refine class-member
 * variables to properties, put back the file the indexer left out of every
 * span, add a `file` node per workspace source, and connect the `contains`
 * ownership tree.
 *
 * `exports` edges are not synthesized here. The indexer resolves them from the
 * project's own export syntax and follows them through its barrels (§4k), so
 * they say which module puts a symbol on the wire. Deriving them from the
 * `exported` flag instead would say only that the declaring file made it public,
 * which is the fact that cannot tell a package's front door from its legacy
 * subpath.
 */
function synthesize(dump: ISamchonGraphDump): {
  nodes: ISamchonGraphNode[];
  edges: ISamchonGraphEdge[];
} {
  // Clone nodes so the ownership synthesis does not mutate the caller's dump,
  // and put back the file the indexer left out of every span: a node's span is
  // in the node's file, an edge's span is in its source node's file. The
  // indexer omits both because they are exactly reconstructible and they are
  // not small — the two copies are 17% of the document, 55 MB of VS Code's 323
  // MB, paid again in the encode, the pipe, the parse and the validation.
  // Nothing downstream of this line sees a span without its file.
  const nodes: ISamchonGraphNode[] = dump.nodes.map((node) => {
    const { evidence, implementation, ...rest } = node;
    return {
      ...rest,
      ...(evidence !== undefined
        ? { evidence: spanIn(evidence, node.file) }
        : {}),
      ...(implementation !== undefined
        ? { implementation: spanIn(implementation, node.file) }
        : {}),
      };
  });
  normalizeGraphNodeKinds(nodes);
  const byId = indexNodesById(nodes);
  const edges: ISamchonGraphEdge[] = dump.edges.map((edge) => {
    const { evidence, ...rest } = edge;
    return {
      ...rest,
      ...(evidence !== undefined
        ? {
            evidence: spanIn(
              evidence,
              evidence.file ?? fileOfEdgeSource(edge.from, byId),
            ),
          }
        : {}),
    };
  });

  // Index workspace declarations by (file, within-file key) so ownership can
  // resolve a member to its declaring class/namespace. A strict provider may
  // already carry canonical file nodes for compiler modules; those are
  // containers, never symbol owners.
  const byFileKey = new Map<string, ISamchonGraphNode>();
  for (const node of nodes) {
    if (!node.external && node.kind !== "file") {
      byFileKey.set(`${node.file}\0${keyOf(node)}`, node);
    }
  }
  const owner = (node: ISamchonGraphNode): ISamchonGraphNode | undefined => {
    const parentKey = ownerKey(keyOf(node));
    return parentKey === ""
      ? undefined
      : byFileKey.get(`${node.file}\0${parentKey}`);
  };

  // One file container node per distinct workspace source file, plus every bare
  // file id an edge leaves from. A module-scope edge is already folded onto its
  // file id by the indexer, and that may be the file's only trace in the dump: a
  // declaration-free bootstrap calls into the program, an import-only file names
  // only a dependency, and a barrel only exports. Keeping the folded endpoint
  // here means every such edge remains traversable without inventing a symbol.
  const files = new Map<string, ISamchonGraphNode>();
  const addFileNode = (file: string, language: GraphLanguage): void => {
    if (file === "" || byId.has(file) || files.has(file)) return;
    files.set(file, {
      id: file,
      kind: "file",
      language,
      name: basename(file),
      file,
      external: false,
    });
  };
  for (const node of nodes) {
    if (node.external || node.kind === "file") continue;
    addFileNode(node.file, node.language);
  }
  for (const edge of edges) {
    const file = fileOfLegacyNodeId(edge.from);
    if (byId.has(edge.from) || file === undefined || file !== edge.from)
      continue;
    addFileNode(file, byId.get(edge.to)?.language ?? "unknown");
  }

  const edgeKeys = new Set(
    edges.map((edge) => `${edge.kind}\0${edge.from}\0${edge.to}`),
  );
  const structural: ISamchonGraphEdge[] = [];
  for (const node of nodes) {
    if (node.external || node.file === "" || node.kind === "file") continue;
    const parent = owner(node);
    const container = parent?.id ?? node.file;
    const key = `contains\0${container}\0${node.id}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    structural.push({
      from: container,
      to: node.id,
      kind: "contains",
    });
  }

  return {
    nodes: [...nodes, ...files.values()],
    edges: [...edges, ...structural],
  };
}

function compareText(left: string, right: string): number {
  return Number(left > right) - Number(left < right);
}
