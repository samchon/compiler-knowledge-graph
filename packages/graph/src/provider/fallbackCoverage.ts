import { ISamchonGraphCoverage } from "../structures";
import { GRAPH_EDGE_KINDS, GraphLanguage } from "../typings";
import { coverageRows } from "./coverageRows";

/**
 * Truthful coverage for a generic LSP or static lane.
 *
 * These lanes attempt multiple families heuristically and cannot make absence
 * meaningful. Every family is therefore partial in one explicitly named
 * fallback target.
 */
export function fallbackCoverage(
  provider: "@samchon/graph-lsp" | "@samchon/graph-sitter",
  languages: readonly GraphLanguage[],
): ISamchonGraphCoverage[] {
  return coverageRows(
    provider,
    languages,
    "fallback/default",
    new Set(GRAPH_EDGE_KINDS),
  );
}
