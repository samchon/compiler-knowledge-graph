import { GraphEdgeKind } from "./GraphEdgeKind";

/** Every relationship family in deterministic protocol order. */
export const GRAPH_EDGE_KINDS: readonly GraphEdgeKind[] = [
  "contains",
  "exports",
  "imports",
  "calls",
  "accesses",
  "instantiates",
  "type_ref",
  "extends",
  "implements",
  "overrides",
  "dispatches",
  "decorates",
  "renders",
  "tests",
  "references",
];
