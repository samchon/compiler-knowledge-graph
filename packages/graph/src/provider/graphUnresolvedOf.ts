import { ISamchonGraphUnresolved } from "../structures";
import { IBulkGraphSession } from "./IBulkGraphSession";

/** Structured uncertainty retained from a protocol-aware producer. */
export function graphUnresolvedOf(
  snapshot: IBulkGraphSession.ISnapshot,
): ISamchonGraphUnresolved[] {
  return (snapshot.unresolved ?? []).map((row) => ({
    ...row,
    evidence: { ...row.evidence },
    ...(row.candidates !== undefined
      ? { candidates: [...row.candidates] }
      : {}),
  }));
}
