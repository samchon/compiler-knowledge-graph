import { GraphEdgeKind, GraphLanguage } from "../typings";

/**
 * What one producer can prove for one relationship family in one build target.
 *
 * Coverage is explicit because an empty edge list has two incompatible
 * meanings: either the producer proved there are no such relationships, or it
 * did not know how to collect them. Consumers must never infer which from the
 * payload shape.
 */
export interface ISamchonGraphCoverage {
  /** Stable registry identity of the producer that owns this row. */
  provider: string;

  /** Source language whose facts the row describes. */
  language: GraphLanguage;

  /**
   * Producer-defined build target/configuration coordinate.
   *
   * This is not a display label. Equal values mean facts belong to the same
   * semantic universe; incompatible source sets, features, triples or execution
   * environments must use different values.
   */
  target: string;

  /** Relationship family whose absence or uncertainty this row qualifies. */
  family: GraphEdgeKind;

  /**
   * `complete` makes absence meaningful in the named universe; `partial`
   * publishes proven facts while unresolved/excluded sites remain;
   * `unsupported` says the producer cannot prove the family.
   */
  state: "complete" | "partial" | "unsupported";
}
