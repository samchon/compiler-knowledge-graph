import { ISamchonGraphUnresolved } from "./ISamchonGraphUnresolved";

/** Bounded, operation-scoped uncertainty returned beside MCP audit. */
export interface ISamchonGraphUnresolvedSummary {
  /**
   * Number of relevant sites the producer explicitly published.
   *
   * Zero does not upgrade a `partial` coverage row to `complete`: legacy and
   * fallback producers may know their analysis is partial without being able
   * to enumerate the exact unresolved locations.
   */
  count: number;

  /** Stable counts by machine-readable reason. */
  reasons: {
    reason: ISamchonGraphUnresolved["reason"];
    count: number;
  }[];

  /** Deterministic first slice; `count` says whether more published sites exist. */
  examples: ISamchonGraphUnresolved[];
}
