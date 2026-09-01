import { GRAPH_EDGE_KINDS } from "@samchon/graph";

const UNRESOLVED_REASONS = [
  "dynamic",
  "reflection",
  "macro-or-generated",
  "conditional-build",
  "external-boundary",
  "analysis-error",
  "excluded-input",
  "identity-unstable",
  "provider-gap",
];

/** All fifteen relationship families, compacted to state counts. */
export function summarizeCoverage(dump, provider) {
  const rows = (dump.coverage ?? []).filter(
    (row) => provider === undefined || row.provider === provider,
  );
  return {
    provider: provider ?? null,
    families: GRAPH_EDGE_KINDS.map((family) => {
      const familyRows = rows.filter((row) => row.family === family);
      return {
        family,
        complete: familyRows.filter((row) => row.state === "complete").length,
        partial: familyRows.filter((row) => row.state === "partial").length,
        unsupported: familyRows.filter((row) => row.state === "unsupported")
          .length,
      };
    }),
  };
}

/** Stable uncertainty totals without copying any unbounded evidence sites. */
export function summarizeUnresolved(dump, provider) {
  const sites = (dump.unresolved ?? []).filter(
    (site) => provider === undefined || site.provider === provider,
  );
  return {
    provider: provider ?? null,
    total: sites.length,
    byFamily: GRAPH_EDGE_KINDS.map((family) => ({
      family,
      count: sites.filter((site) => site.family === family).length,
    })),
    byReason: UNRESOLVED_REASONS.map((reason) => ({
      reason,
      count: sites.filter((site) => site.reason === reason).length,
    })),
  };
}
