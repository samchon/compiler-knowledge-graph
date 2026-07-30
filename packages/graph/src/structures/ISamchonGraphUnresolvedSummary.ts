import { ISamchonGraphUnresolved } from "./ISamchonGraphUnresolved";

/** Bounded, operation-scoped uncertainty returned beside MCP audit. */
export interface ISamchonGraphUnresolvedSummary {
  /** Number of relevant unresolved sites in the complete resident graph. */
  count: number;

  /** Stable counts by machine-readable reason. */
  reasons: {
    reason: ISamchonGraphUnresolved["reason"];
    count: number;
  }[];

  /** Deterministic first slice; `count` says whether more exist. */
  examples: ISamchonGraphUnresolved[];
}
