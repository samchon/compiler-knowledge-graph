import { GRAPH_EDGE_KINDS, GraphEdgeKind } from "../../typings";

/**
 * The relationship families the javac graph route may publish.
 *
 * `renders` is the one the producer marks `unsupported` in every generation:
 * it is a component-use fact with no Java counterpart. Everything else is a
 * family the attributed tree can carry, at the completeness the producer's own
 * coverage matrix states per target.
 */
export const JAVA_GRAPH_FACTS: readonly GraphEdgeKind[] =
  GRAPH_EDGE_KINDS.filter((kind) => kind !== "renders");
