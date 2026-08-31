import { ISamchonGraphEdge, ISamchonGraphNode } from "../structures";
import { GraphLanguage } from "../typings";
import { dedupeEdges } from "../indexer/dedupeEdges";
import { dedupeNodes } from "../indexer/dedupeNodes";
import { finalizeGraph } from "../indexer/finalizeGraph";
import {
  isSemanticGraphNodeId,
  validateSemanticGraphNode,
} from "./semanticIdentity";

/**
 * Merge ordinary LSP/static facts with compiler-owned strict slices.
 *
 * The generic lane still needs lexical structural derivations and duplicate
 * cleanup. Strict providers already resolved those facts and must pass through
 * unchanged. Cross-lane identity collisions are rejected rather than allowing
 * either lane to overwrite compiler truth.
 *
 * Endpoint closure is checked over the strict facts as a whole rather than per
 * provider, and deliberately: a provider that owns C and C++ resolves calls
 * that cross between them, and #66 exists precisely so those edges can be
 * published. Requiring each slice to close over itself would reject exactly the
 * cross-language facts a shared compilation universe is worth having.
 */
export function mergeGraphSlices(options: {
  root: string;
  files: readonly string[];
  genericNodes: ISamchonGraphNode[];
  genericEdges: ISamchonGraphEdge[];
  strictNodes: ISamchonGraphNode[];
  strictEdges: ISamchonGraphEdge[];
}): {
  nodes: ISamchonGraphNode[];
  edges: ISamchonGraphEdge[];
  warnings: string[];
} {
  assertStrictSlice(options.strictNodes, options.strictEdges);
  const strictNodes = normalizeStrictNodes(options.strictNodes);
  const strictEdges = normalizeStrictEdges(options.strictEdges);
  const generic = finalizeGraph(
    options.root,
    options.files,
    options.genericNodes,
    options.genericEdges,
  );
  const warnings = [...generic.warnings];
  const genericNodes = dedupeNodes(generic.nodes, (id, count) =>
    warnings.push(
      `@samchon/graph: generic semantic declaration has ${count} locations; retaining canonical declaration and implementation spans: ${id}`,
    ),
  );
  const genericEdges = dedupeEdges(generic.edges);
  const nodeIds = new Set(strictNodes.map((node) => node.id));
  const duplicateNode = genericNodes.find((node) => nodeIds.has(node.id));
  if (duplicateNode !== undefined) {
    throw new Error(
      `@samchon/graph: strict provider node collides with another lane: ${duplicateNode.id}`,
    );
  }
  const edgeKeys = new Set(strictEdges.map(edgeKey));
  const duplicateEdge = genericEdges.find((edge) => edgeKeys.has(edgeKey(edge)));
  if (duplicateEdge !== undefined) {
    throw new Error(
      `@samchon/graph: strict provider edge collides with another lane: ${edgeKey(duplicateEdge)}`,
    );
  }
  return {
    nodes: [...strictNodes, ...genericNodes],
    edges: [...strictEdges, ...genericEdges],
    warnings,
  };
}

function normalizeStrictNodes(
  nodes: ISamchonGraphNode[],
): ISamchonGraphNode[] {
  const legacy = nodes.filter((node) => !isSemanticGraphNodeId(node.id));
  const semantic = nodes
    .filter((node) => isSemanticGraphNodeId(node.id))
    .sort((left, right) => compareText(left.id, right.id));
  return [...legacy, ...semantic];
}

function normalizeStrictEdges(
  edges: ISamchonGraphEdge[],
): ISamchonGraphEdge[] {
  const legacy: ISamchonGraphEdge[] = [];
  const semantic: ISamchonGraphEdge[] = [];
  for (const edge of edges) {
    (isSemanticGraphNodeId(edge.from) || isSemanticGraphNodeId(edge.to)
      ? semantic
      : legacy
    ).push(edge);
  }
  semantic.sort((left, right) =>
    compareText(edgeOrderKey(left), edgeOrderKey(right)),
  );
  return [...legacy, ...semantic];
}

function assertStrictSlice(
  nodes: readonly ISamchonGraphNode[],
  edges: readonly ISamchonGraphEdge[],
): void {
  // These arrays are now every strict provider's slices concatenated, not one
  // provider's output. A duplicate can therefore mean two things, and the two
  // need different answers: one provider publishing an id twice is that
  // provider's defect, while two providers publishing the same id means the
  // registry let both own the same declaration — a collision no merge can
  // resolve, because neither slice is wrong on its own and picking either one
  // silently discards facts the other proved.
  //
  // Both are refused. Distinguishing them in the message is what makes the
  // second diagnosable: a reader who is only told "duplicated node" will look
  // for the bug inside one provider and not find it.
  const nodeIds = new Map<string, GraphLanguage>();
  for (const node of nodes) {
    validateSemanticGraphNode(node);
    const owner = nodeIds.get(node.id);
    if (owner !== undefined) {
      throw new Error(
        owner === node.language
          ? `@samchon/graph: strict provider duplicated node: ${node.id}`
          : `@samchon/graph: strict ${owner} and ${node.language} slices both publish node ${node.id}; one declaration cannot have two owners`,
      );
    }
    nodeIds.set(node.id, node.language);
  }
  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (edgeKeys.has(key)) {
      throw new Error(
        `@samchon/graph: strict provider duplicated edge: ${key}`,
      );
    }
    edgeKeys.add(key);
    if (!nodeIds.has(edge.from) && edge.from.includes("#")) {
      throw new Error(
        `@samchon/graph: strict provider edge has unknown from endpoint: ${edge.from}`,
      );
    }
    if (!nodeIds.has(edge.to)) {
      throw new Error(
        `@samchon/graph: strict provider edge has unknown to endpoint: ${edge.to}`,
      );
    }
  }
}

function edgeKey(edge: ISamchonGraphEdge): string {
  return `${edge.kind}\0${edge.from}\0${edge.to}`;
}

function edgeOrderKey(edge: ISamchonGraphEdge): string {
  return [
    edgeKey(edge),
    edge.evidence?.file ?? "",
    edge.evidence?.startLine ?? 0,
    edge.evidence?.startCol ?? 0,
  ].join("\0");
}

function compareText(left: string, right: string): number {
  // Two-way: sort keys include distinct node or edge identities, so the equal
  // arm cannot run, and an ignore directive over it would take the two
  // reachable arms out of the coverage gate with it -- which is how a reversed
  // ordering stops being a failing test.
  return left < right ? -1 : 1;
}
