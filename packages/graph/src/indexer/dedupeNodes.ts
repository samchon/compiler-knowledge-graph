import { isDeepStrictEqual } from "node:util";

import {
  isSemanticGraphNodeId,
  validateSemanticGraphNode,
} from "../provider/semanticIdentity";
import { ISamchonGraphEvidence, ISamchonGraphNode } from "../structures";

/**
 * Remove identical generic facts and merge all locations of one semantic
 * declaration through the public declaration/implementation representation.
 */
export function dedupeNodes(
  nodes: ISamchonGraphNode[],
  onSemanticLocationOverflow?: (id: string, count: number) => void,
): ISamchonGraphNode[] {
  const groups = new Map<string, ISamchonGraphNode[]>();
  for (const node of nodes) {
    validateSemanticGraphNode(node);
    const group = groups.get(node.id);
    if (group === undefined) groups.set(node.id, [node]);
    else group.push(node);
  }
  return [...groups.values()].map((group) =>
    mergeGroup(group, onSemanticLocationOverflow),
  );
}

/**
 * Merge only intrinsic semantic duplicates in a generic provider slice.
 * Legacy duplicates remain visible for the strict trust boundary to reject.
 */
export function mergeSemanticNodes(
  nodes: readonly ISamchonGraphNode[],
  onSemanticLocationOverflow?: (id: string, count: number) => void,
): ISamchonGraphNode[] {
  const semantic = new Map<string, ISamchonGraphNode[]>();
  const legacy: ISamchonGraphNode[] = [];
  for (const node of nodes) {
    validateSemanticGraphNode(node);
    if (!isSemanticGraphNodeId(node.id)) {
      legacy.push(node);
      continue;
    }
    const group = semantic.get(node.id);
    if (group === undefined) semantic.set(node.id, [node]);
    else group.push(node);
  }
  return [
    ...legacy,
    ...[...semantic.values()].map((group) =>
      mergeGroup(group, onSemanticLocationOverflow),
    ),
  ];
}

function mergeGroup(
  nodes: readonly ISamchonGraphNode[],
  onSemanticLocationOverflow: ((id: string, count: number) => void) | undefined,
): ISamchonGraphNode {
  const left = nodes[0]!;
  if (!isSemanticGraphNodeId(left.id)) {
    return nodes.slice(1).reduce(mergeLegacyDuplicate, left);
  }
  const leftFact = factWithoutLocations(left);
  for (const right of nodes.slice(1)) {
    if (!isDeepStrictEqual(leftFact, factWithoutLocations(right))) {
      throw new Error(
        `@samchon/graph: semantic node locations disagree on symbol facts: ${left.id}`,
      );
    }
  }
  const locations = uniqueLocations(
    nodes.flatMap((node) => [node.evidence, node.implementation]),
  );
  if (locations.length > 2) {
    onSemanticLocationOverflow?.(left.id, locations.length);
  }
  const [evidence, implementation] = locations;
  return {
    ...leftFact,
    file: evidence?.file ?? left.file,
    ...(nodes.some((node) => node.ignored === true) ? { ignored: true } : {}),
    ...(nodes.some((node) => node.exported === true) ? { exported: true } : {}),
    ...(nodes.some((node) => node.closure === true) ? { closure: true } : {}),
    ...(evidence === undefined ? {} : { evidence }),
    ...(implementation === undefined ? {} : { implementation }),
  };
}

function mergeLegacyDuplicate(
  left: ISamchonGraphNode,
  right: ISamchonGraphNode,
): ISamchonGraphNode {
  if (isDeepStrictEqual(left, right)) return left;
  // Two distinct declarations share a legacy id ??same-named locals a
  // generic/static producer cannot tell apart without a native symbol, and a
  // TypeScript id must stay `path#qualifiedName:kind` for parity so it cannot
  // be promoted here. The strict provider boundary still rejects such a
  // collision; the generic path keeps the last declaration, exactly as the
  // pre-identity dedupe did, rather than failing the whole graph.
  return right;
}

function factWithoutLocations(
  node: ISamchonGraphNode,
): ISamchonGraphNode {
  const {
    evidence: _evidence,
    implementation: _implementation,
    file: _file,
    ignored: _ignored,
    exported: _exported,
    closure: _closure,
    ...fact
  } = node;
  return { ...fact, file: "" };
}

function uniqueLocations(
  values: readonly (ISamchonGraphEvidence | undefined)[],
): ISamchonGraphEvidence[] {
  const map = new Map<string, ISamchonGraphEvidence>();
  for (const value of values) {
    if (value === undefined) continue;
    map.set(locationKey(value), value);
  }
  return [...map.values()].sort((left, right) =>
    compareText(locationKey(left), locationKey(right)),
  );
}

function locationKey(evidence: ISamchonGraphEvidence): string {
  return [
    evidence.file,
    evidence.startLine,
    evidence.startCol ?? 0,
    evidence.endLine ?? 0,
    evidence.endCol ?? 0,
  ].join("\0");
}

function compareText(left: string, right: string): number {
  // Two-way: uniqueLocations removes equal keys before sorting, so the equal
  // arm cannot run, and an ignore directive over it would take the two
  // reachable arms out of the coverage gate with it -- which is how a reversed
  // ordering stops being a failing test.
  return left < right ? -1 : 1;
}
