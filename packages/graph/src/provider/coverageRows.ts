import { ISamchonGraphCoverage } from "../structures";
import {
  GRAPH_EDGE_KINDS,
  GraphEdgeKind,
  GraphLanguage,
} from "../typings";

/** Build one deterministic exhaustive coverage matrix. */
export function coverageRows(
  provider: string,
  languages: readonly GraphLanguage[],
  target: string,
  supported: ReadonlySet<GraphEdgeKind>,
): ISamchonGraphCoverage[] {
  return [...languages]
    .sort(compareText)
    .flatMap((language) =>
      GRAPH_EDGE_KINDS.map((family) => ({
        provider,
        language,
        target,
        family,
        state: supported.has(family) ? "partial" : "unsupported",
      })),
    );
}

function compareText(left: string, right: string): number {
  // Two-way: a normalized language set holds distinct values, so the equal arm
  // is unreachable and an ignore directive over it would stop enforcing the
  // two that are not.
  return left < right ? -1 : 1;
}
