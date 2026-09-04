import { GraphEdgeKind } from "../../typings";

export const CSHARP_ROSLYN_FACTS = [
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
  "tests",
  "references",
] as const satisfies readonly GraphEdgeKind[];
