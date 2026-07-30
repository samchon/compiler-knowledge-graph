import { GraphEdgeKind } from "../typings";
import { ISamchonGraphCoverage } from "./ISamchonGraphCoverage";

/** Operation-scoped machine-readable completeness returned beside MCP audit. */
export interface ISamchonGraphCoverageSummary {
  /** Version of this additive MCP trust contract. */
  schemaVersion: 1;

  /** Relationship families relevant to the selected operation. */
  families: GraphEdgeKind[];

  /** Provider/target rows for those families. */
  rows: ISamchonGraphCoverage[];
}
