import { isDeepStrictEqual } from "node:util";

import {
  IGraphSemanticIdentity,
  callableBaseOf,
  isSemanticGraphNodeId,
  semanticGraphNodeId,
} from "../provider/semanticIdentity";
import {
  ISamchonGraphEdge,
  ISamchonGraphEvidence,
  ISamchonGraphNode,
} from "../structures";
import { fileOfNodeId } from "../utils/fileOfNodeId";

const MAX_AMBIGUOUS_EDGE_WARNING_EXAMPLES = 10;

/**
 * Give best-effort generic declarations intrinsic ids before dedupe.
 *
 * A generic LSP/static producer has no durable native symbol handle. A
 * decorated callable signature is still persistent; an undecorated callable,
 * local, or anonymous declaration is explicitly generation-scoped instead of
 * pretending its source coordinate is stable.
 */
export function assignSemanticIdentities(
  nodes: ISamchonGraphNode[],
  edges: ISamchonGraphEdge[] = [],
  warnings: string[] = [],
): void {
  let omittedAmbiguousEdgeCount = 0;
  const omittedAmbiguousEdgeWarnings: string[] = [];
  const omittedAmbiguousEdgeExamples = new Set<string>();
  const idCounts = new Map<string, number>();
  for (const node of nodes) {
    idCounts.set(node.id, (idCounts.get(node.id) ?? 0) + 1);
  }
  const remap = new Map<string, IRemappedNode[]>();
  const candidates: Array<{
    node: ISamchonGraphNode;
    identity: IGraphSemanticIdentity;
  }> = [];
  for (const node of nodes) {
    // ttsc's strict slice preserves its exact legacy ids, and its generic
    // fallback has the same public convention when it is unambiguous. Promote
    // only a real fallback collision ??an overload or otherwise ambiguous
    // declaration ??so the fallback separates it without re-keying every
    // ordinary TypeScript handle.
    if (
      node.language === "typescript" &&
      idCounts.get(node.id) === 1
    ) {
      const parsed = fileOfNodeId.parseLegacy(node.id);
      if (
        parsed !== undefined &&
        parsed.file === node.file &&
        parsed.kind !== undefined &&
        parsed.kind !== node.kind
      ) {
        const oldId = node.id;
        node.id = fileOfNodeId.write(
          node.file,
          parsed.name,
          node.kind,
        );
        push(remap, oldId, { node, id: node.id });
      }
      continue;
    }
    const identity = genericIdentityOf(node);
    if (identity === undefined) continue;
    candidates.push({ node, identity });
  }
  const collisionGroups = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const id = semanticGraphNodeId(
      candidate.identity,
      candidate.node.qualifiedName ?? candidate.node.name,
    );
    const group = collisionGroups.get(id);
    if (group === undefined) collisionGroups.set(id, [candidate]);
    else group.push(candidate);
  }
  for (const group of collisionGroups.values()) {
    const representative = group[0]!.node;
    const conflicted = group.some(
      ({ node }) => !sameSemanticFact(representative, node),
    );
    for (const candidate of group) {
      const identity = conflicted
        ? {
            ...candidate.identity,
            stability: "generation" as const,
            generation: generationOf(
              candidate.node,
              canonicalSemanticFactKey(candidate.node),
            ),
          }
        : candidate.identity;
      const { node } = candidate;
      const oldId = node.id;
      node.id = semanticGraphNodeId(identity, node.qualifiedName ?? node.name);
      push(remap, oldId, { node, id: node.id });
    }
  }
  for (let index = edges.length - 1; index >= 0; index--) {
    const edge = edges[index]!;
    const from = endpointOf(
      edge.from,
      remap.get(edge.from),
      edge.evidence,
      "from",
    );
    const to = endpointOf(edge.to, remap.get(edge.to), edge.evidence, "to");
    if (from === undefined || to === undefined) {
      const warning =
        `@samchon/graph: omitted an ambiguous generic edge without provider endpoint proof: ` +
        `${edge.kind} ${edge.from} -> ${edge.to}`;
      omittedAmbiguousEdgeCount += 1;
      if (
        omittedAmbiguousEdgeCount <=
        MAX_AMBIGUOUS_EDGE_WARNING_EXAMPLES
      ) {
        omittedAmbiguousEdgeWarnings.push(warning);
      }
      omittedAmbiguousEdgeExamples.add(warning);
      if (
        omittedAmbiguousEdgeExamples.size >
        MAX_AMBIGUOUS_EDGE_WARNING_EXAMPLES
      ) {
        omittedAmbiguousEdgeExamples.delete(
          [...omittedAmbiguousEdgeExamples]
            .sort(
              (left, right) => Number(left > right) - Number(left < right),
            )
            .pop()!,
        );
      }
      edges.splice(index, 1);
      continue;
    }
    edge.from = from;
    edge.to = to;
  }
  if (
    omittedAmbiguousEdgeCount <=
    MAX_AMBIGUOUS_EDGE_WARNING_EXAMPLES
  ) {
    warnings.push(...omittedAmbiguousEdgeWarnings);
  } else {
    warnings.push(
      `@samchon/graph: omitted ${String(omittedAmbiguousEdgeCount)} ambiguous generic edges without provider endpoint proof; up to ${String(MAX_AMBIGUOUS_EDGE_WARNING_EXAMPLES)} distinct examples follow`,
      ...[...omittedAmbiguousEdgeExamples].sort(
        (left, right) => Number(left > right) - Number(left < right),
      ),
    );
  }
}

/**
 * Two generic observations may represent one declaration at separate spans.
 * Their portable symbol facts must agree; otherwise the producer has no
 * durable discriminator and each observation is explicitly generation-scoped.
 */
function sameSemanticFact(
  left: ISamchonGraphNode,
  right: ISamchonGraphNode,
): boolean {
  return isDeepStrictEqual(semanticFactOf(left), semanticFactOf(right));
}

function semanticFactOf(node: ISamchonGraphNode): Omit<ISamchonGraphNode, "id"> {
  const {
    id: _id,
    file: _file,
    evidence: _evidence,
    implementation: _implementation,
    ignored: _ignored,
    exported: _exported,
    closure: _closure,
    ...fact
  } = node;
  return { ...fact, file: "" };
}

function genericIdentityOf(
  node: ISamchonGraphNode,
): IGraphSemanticIdentity | undefined {
  if (
    isSemanticGraphNodeId(node.id) ||
    node.language === "unknown" ||
    node.kind === "file" ||
    node.kind === "package" ||
    node.kind === "external_symbol"
  ) {
    return undefined;
  }
  const qualified = node.qualifiedName ?? node.name;
  const callable = CALLABLE_KINDS.has(node.kind);
  const overload = callable ? overloadOf(qualified) : undefined;
  const generationScoped =
    node.closure === true ||
    anonymousName(node.name) ||
    (callable && overload === undefined) ||
    (node.kind === "parameter" && !qualified.includes("("));
  const scope = scopeOf(node);
  return {
    version: 2,
    language: node.language,
    symbol: callable ? callableBaseOf(qualified) : qualified,
    role: node.kind,
    ...(scope === undefined ? {} : { scope }),
    ...(overload === undefined ? {} : { overload }),
    stability: generationScoped ? "generation" : "persistent",
    ...(generationScoped ? { generation: generationOf(node) } : {}),
  };
}

function scopeOf(
  node: ISamchonGraphNode,
): IGraphSemanticIdentity.IScope | undefined {
  if (node.file === "") return undefined;
  if (node.language === "c" || node.language === "cpp") {
    return { translationUnit: node.file };
  }
  return { document: node.file };
}

function overloadOf(name: string): string | undefined {
  const open = name.indexOf("(");
  if (open < 0) return undefined;
  return name.slice(open).replace(/\s+/g, " ").trim();
}

function generationOf(
  node: ISamchonGraphNode,
  semanticFactKey?: string,
): string {
  const evidence = node.evidence;
  return [
    evidence?.file ?? node.file,
    evidence?.startLine ?? 0,
    evidence?.startCol ?? 0,
    node.qualifiedName ?? node.name,
    ...(semanticFactKey === undefined ? [] : [semanticFactKey]),
  ].join("\0");
}

/**
 * A provider can emit conflicting observations at exactly the same coordinate.
 * Keep their final generation identities distinct without letting object-key
 * insertion order make the graph move between equivalent producer payloads.
 */
function canonicalSemanticFactKey(node: ISamchonGraphNode): string {
  return JSON.stringify(canonicalize(semanticFactOf(node)))!;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => Number(left > right) - Number(left < right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function anonymousName(name: string): boolean {
  return (
    /anonymous/i.test(name) ||
    /^new\s.+\{/.test(name) ||
    /^<.+>$/.test(name) ||
    /^\$\d+$/.test(name)
  );
}

function endpointOf(
  current: string,
  candidates: readonly IRemappedNode[] | undefined,
  evidence: ISamchonGraphEvidence | undefined,
  side: "from" | "to",
): string | undefined {
  if (candidates === undefined || candidates.length === 0) return current;
  if (candidates.length === 1) return candidates[0]!.id;
  const ids = new Set(candidates.map(({ id }) => id));
  if (ids.size === 1) return candidates[0]!.id;
  const exact = candidates.filter(({ node }) =>
    sameStart(node.evidence, evidence),
  );
  if (exact.length === 1) return exact[0]!.id;
  if (side === "from" && evidence !== undefined) {
    const owner = candidates.filter(({ node }) => contains(node, evidence));
    if (owner.length === 1) return owner[0]!.id;
  }
  return undefined;
}

function sameStart(
  left: ISamchonGraphEvidence | undefined,
  right: ISamchonGraphEvidence | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.file === right.file &&
    left.startLine === right.startLine &&
    (left.startCol ?? 0) === (right.startCol ?? 0)
  );
}

function contains(
  owner: ISamchonGraphNode,
  evidence: ISamchonGraphEvidence,
): boolean {
  const span = owner.evidence;
  return (
    span !== undefined &&
    span.file === evidence.file &&
    span.startLine <= evidence.startLine &&
    (span.endLine ?? span.startLine) >= evidence.startLine
  );
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}

interface IRemappedNode {
  node: ISamchonGraphNode;
  id: string;
}

const CALLABLE_KINDS = new Set(["function", "method", "constructor"]);
