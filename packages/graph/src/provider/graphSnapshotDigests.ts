import { createHash } from "node:crypto";

import { graphCoverageOf } from "./graphCoverageOf";
import { graphUnresolvedOf } from "./graphUnresolvedOf";
import { IBulkGraphSession } from "./IBulkGraphSession";

/**
 * The two digests that let a reader prove a published slice is the one a
 * provider produced, computed here rather than believed from the wire.
 *
 * A producer-reported hash proves nothing a consumer needs. It is computed by
 * the same party whose honesty is in question, over bytes only that party saw,
 * in a normalization only that party defines — so two providers' "content
 * digests" are not comparable, and neither can be recomputed by the coordinator
 * that has to decide whether a candidate is still the candidate it validated.
 * These are computed by the publisher, over the normalized facts it is about to
 * publish, in one shape shared by every provider.
 */
export namespace graphSnapshotDigests {
  /**
   * A digest over the exact input manifest the facts were computed from.
   *
   * The project transaction compares this before and after validating a
   * candidate: a manifest that moved means the candidate describes a program
   * that no longer exists, and committing it would publish facts about source
   * nobody has.
   */
  export function manifestOf(snapshot: IBulkGraphSession.ISnapshot): string {
    const hash = createHash("sha256");
    for (const file of [...snapshot.sources.keys()].sort(compareOrdinal)) {
      const digest = snapshot.sources.get(file)!;
      hash.update(`${file}\0${digest.checkerDigest}\0${digest.diskDigest}\n`);
    }
    return hash.digest("hex");
  }

  /**
   * A digest over the facts a slice publishes, in publication order.
   *
   * Order is part of the identity rather than sorted away, because the graph's
   * own contract is that an unchanged checkout produces byte-identical output:
   * a digest that hid a reordering would call two different dumps the same one.
   */
  export function contentOf(snapshot: IBulkGraphSession.ISnapshot): string {
    const hash = createHash("sha256");
    hash.update(`languages\0${snapshot.languages.join(",")}\n`);
    // Every field, not a chosen few. An earlier form hashed a node's id, kind,
    // name, file, and span offsets, which meant a slice that changed a node's
    // modifiers, export flag, qualified name, decorators, or enum members
    // digested identically to the one before it — and the transaction fence
    // and the dump's provenance both compare exactly this value to decide
    // whether anything moved. A digest over part of the facts is not a weaker
    // proof of the whole; it is a proof of something else.
    for (const node of snapshot.nodes) hash.update(`node\0${canonical(node)}\n`);
    for (const edge of snapshot.edges) hash.update(`edge\0${canonical(edge)}\n`);
    for (const diagnostic of snapshot.diagnostics) {
      hash.update(`diagnostic\0${canonical(diagnostic)}\n`);
    }
    for (const coverage of graphCoverageOf(snapshot)) {
      hash.update(`coverage\0${canonical(coverage)}\n`);
    }
    for (const unresolved of graphUnresolvedOf(snapshot)) {
      hash.update(`unresolved\0${canonical(unresolved)}\n`);
    }
    return hash.digest("hex");
  }

  /**
   * A digest over the complete normalized snapshot envelope.
   *
   * This is the conformance byte-identity check, not the content token used by
   * the transaction fence. Provenance, capabilities, warnings, and the source
   * manifest are observable publication bytes too: an unchanged provider that
   * changes any one of them did not reproduce the same snapshot, even when its
   * graph facts happened to stay equal.
   */
  export function snapshotOf(snapshot: IBulkGraphSession.ISnapshot): string {
    const sources = [...snapshot.sources]
      .sort(([left], [right]) => compareOrdinal(left, right))
      .map(([file, digest]) => ({ file, ...digest }));
    return createHash("sha256")
      .update(
        canonical({
          languages: snapshot.languages,
          nodes: snapshot.nodes,
          edges: snapshot.edges,
          diagnostics: snapshot.diagnostics,
          coverage: graphCoverageOf(snapshot),
          unresolved: graphUnresolvedOf(snapshot),
          sources,
          provenance: snapshot.provenance,
          protocol: snapshot.protocol,
          warnings: snapshot.warnings,
        }),
      )
      .digest("hex");
  }
}

/**
 * One value as a string that depends on its content and not on its key order.
 *
 * `JSON.stringify` would be shorter and wrong: it preserves insertion order, so
 * two structurally identical nodes built by different code paths — a strict
 * provider's and a fallback's — would digest differently while describing the
 * same declaration. Absent optional properties are dropped rather than
 * serialized as `null`, so a node that never had a `qualifiedName` and one
 * whose `qualifiedName` was cleared agree, which is what the graph means by
 * them. Inside an array is the one place an `undefined` survives that filter,
 * and it becomes `null` there for the reason `JSON` does the same: an array's
 * length is part of its meaning, so the hole must keep its place.
 */
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => compareOrdinal(left, right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function compareOrdinal(left: string, right: string): number {
  /* c8 ignore next 2 -- sort keys are distinct file identities or object keys. */
  return left < right ? -1 : left > right ? 1 : 0;
}
