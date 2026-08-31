import { GRAPH_EDGE_KINDS, GraphEdgeKind } from "../../typings";

export const RUST_HIR_FACTS: readonly GraphEdgeKind[] = GRAPH_EDGE_KINDS.filter(
  (kind) => kind !== "renders",
);
