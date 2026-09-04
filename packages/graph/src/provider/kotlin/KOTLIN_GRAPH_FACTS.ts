import { GRAPH_EDGE_KINDS, GraphEdgeKind } from "../../typings";

/** Relationship families the pinned K2 exporter may publish. */
export const KOTLIN_GRAPH_FACTS: readonly GraphEdgeKind[] =
  GRAPH_EDGE_KINDS.filter((kind) => kind !== "renders");
