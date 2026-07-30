import { GraphEdgeKind, GraphLanguage } from "../typings";
import { ISamchonGraphEvidence } from "./ISamchonGraphEvidence";

/**
 * One relationship site a semantic producer could not resolve exactly.
 *
 * Candidates remain evidence, not executed edges. In particular, a possible
 * dynamic receiver target must not become `dispatches` until the selected
 * universe proves it is the one runtime target.
 */
export interface ISamchonGraphUnresolved {
  /** Stable registry identity of the producer that encountered the site. */
  provider: string;

  /** Source language of the unresolved expression or declaration. */
  language: GraphLanguage;

  /** Same semantic target/configuration coordinate used by coverage. */
  target: string;

  /** Exact build-universe digest in which this uncertainty was observed. */
  universe: string;

  /** Relationship family the producer could not settle. */
  family: GraphEdgeKind;

  /** Source location that grounds the uncertainty. */
  evidence: ISamchonGraphEvidence;

  /** Stable, closed reason understood by consumers. */
  reason:
    | "dynamic"
    | "reflection"
    | "macro-or-generated"
    | "conditional-build"
    | "external-boundary"
    | "analysis-error"
    | "excluded-input"
    | "identity-unstable"
    | "provider-gap";

  /** Compiler-proven possibilities, never guessed names. */
  candidates?: string[];
}
