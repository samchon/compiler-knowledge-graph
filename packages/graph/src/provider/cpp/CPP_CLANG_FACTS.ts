import { GRAPH_EDGE_KINDS, GraphEdgeKind } from "../../typings";

export const CPP_CLANG_FACTS: readonly GraphEdgeKind[] =
  GRAPH_EDGE_KINDS.filter(
    (kind) => !["decorates", "renders", "tests"].includes(kind),
  );
