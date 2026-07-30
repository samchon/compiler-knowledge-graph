import { ISamchonGraphCoverage } from "../structures";
import { IBulkGraphSession } from "./IBulkGraphSession";
import { coverageRows } from "./coverageRows";

/**
 * Normalize one strict snapshot to an exhaustive coverage matrix.
 *
 * Protocol-aware producers publish their exact rows. Legacy strict producers
 * are deliberately conservative during migration: a registered family is
 * `partial`, never silently `complete`, and every other family is
 * `unsupported`.
 */
export function graphCoverageOf(
  snapshot: IBulkGraphSession.ISnapshot,
): ISamchonGraphCoverage[] {
  return snapshot.coverage === undefined
    ? coverageRows(
        snapshot.provenance.provider,
        snapshot.languages,
        snapshot.provenance.universe,
        new Set(snapshot.provenance.facts),
      )
    : snapshot.coverage.map((row) => ({ ...row }));
}
