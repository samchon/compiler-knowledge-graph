import { GRAPH_EDGE_KINDS, GraphEdgeKind } from "../../typings";

/** Families IndexStoreDB plus one source enrichment pass can publish. */
export const SWIFT_GRAPH_FACTS: readonly GraphEdgeKind[] =
  GRAPH_EDGE_KINDS.filter((kind) => kind !== "renders");
