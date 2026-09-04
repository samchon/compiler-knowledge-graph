import { GRAPH_EDGE_KINDS, GraphEdgeKind } from "../../typings";

/** Families the typed plugins can publish; UI rendering and test intent need enrichers. */
export const SCALA_GRAPH_FACTS: readonly GraphEdgeKind[] =
  GRAPH_EDGE_KINDS.filter((kind) => !["renders", "tests"].includes(kind));
