import { SamchonGraphMemory } from "../SamchonGraphMemory";
import {
  ISamchonGraphApplication,
  ISamchonGraphCoverageSummary,
  ISamchonGraphUnresolvedSummary,
} from "../structures";
import { GRAPH_EDGE_KINDS, GraphEdgeKind } from "../typings";
import { isStructural } from "./isStructural";

const LOOKUP_FAMILIES = GRAPH_EDGE_KINDS.filter(
  (family) => family === "exports" || !isStructural(family),
);

/** Structured trust envelope for one non-escape operation. */
export function graphTrust(
  graph: SamchonGraphMemory,
  type: Exclude<
    ISamchonGraphApplication.IProps["request"]["type"],
    "escape" | "topology"
  >,
): {
  provenance?: ISamchonGraphApplication.IOutput["provenance"];
  coverage: ISamchonGraphCoverageSummary;
  unresolved: ISamchonGraphUnresolvedSummary;
} {
  const families = familiesOf(type);
  const relevant = new Set(families);
  const sites = graph.unresolved.filter((row) => relevant.has(row.family));
  const reasonCounts = new Map<
    ISamchonGraphUnresolvedSummary["reasons"][number]["reason"],
    number
  >();
  for (const site of sites)
    reasonCounts.set(site.reason, (reasonCounts.get(site.reason) ?? 0) + 1);
  return {
    ...(graph.provenance.length > 0
      ? { provenance: graph.provenance.map((row) => cloneProvenance(row)) }
      : {}),
    coverage: {
      schemaVersion: 1,
      families,
      rows: graph.coverage
        .filter((row) => relevant.has(row.family))
        .map((row) => ({ ...row })),
    },
    unresolved: {
      count: sites.length,
      reasons: [...reasonCounts]
        .sort(([left], [right]) => compareText(left, right))
        .map(([reason, count]) => ({ reason, count })),
      examples: sites.slice(0, 20).map((site) => ({
        ...site,
        evidence: { ...site.evidence },
        ...(site.candidates !== undefined
          ? { candidates: [...site.candidates] }
          : {}),
      })),
    },
  };
}

function familiesOf(
  type: Exclude<
    ISamchonGraphApplication.IProps["request"]["type"],
    "escape" | "topology"
  >,
): GraphEdgeKind[] {
  switch (type) {
    case "entrypoints":
    case "lookup":
      return [...LOOKUP_FAMILIES];
    case "overview":
    case "trace":
    case "details":
    case "tour":
      return [...GRAPH_EDGE_KINDS];
  }
}

function cloneProvenance(
  row: NonNullable<ISamchonGraphApplication.IOutput["provenance"]>[number],
): NonNullable<ISamchonGraphApplication.IOutput["provenance"]>[number] {
  return {
    ...row,
    languages: [...row.languages],
    facts: [...row.facts],
    capabilities: [...row.capabilities],
    producer: { ...row.producer },
  };
}

function compareText(left: string, right: string): number {
  /* c8 ignore next 2 -- reason keys are distinct. */
  return left < right ? -1 : left > right ? 1 : 0;
}
