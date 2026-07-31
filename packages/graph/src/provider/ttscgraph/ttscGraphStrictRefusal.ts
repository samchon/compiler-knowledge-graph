import { IBuildGraphOptions } from "../../indexer/IBuildGraphOptions";

/**
 * Why the strict `ttscgraph` provider cannot serve this build, or `undefined`
 * when it can.
 *
 * The strict lane used to be skipped by a condition folded into the indexer's
 * language loop — `server === undefined && maxFiles === undefined &&
 * lspReferenceLimit === undefined` — with no `else`. So a caller that passed any
 * of them fell through to the generic LSP/static lanes with no warning: a
 * fallback success, indistinguishable from the compiler-owned result it
 * silently replaced. The real-language experiment
 * passes `maxFiles` and `lspReferenceLimit` on every run, so the one place that
 * was supposed to prove this provider against a real project had never once
 * launched it, and reported success each time.
 *
 * The decision belongs here rather than in the loop for the same reason the
 * provenance does: whether a provider can honour a caller's options is the
 * provider's own statement about itself, and a condition inlined at the call
 * site is a statement nobody can find, test, or contradict.
 *
 * These options are refused rather than approximated. Each one asks for a
 * *bounded* index — fewer files, fewer references — and `ttscgraph serve`
 * publishes whole-program snapshots by construction: the compiler resolves the
 * program its tsconfig describes, and there is no partial `Program` to ask for.
 * Honouring a cap would mean loading everything and then deleting facts, which
 * costs exactly what the cap was meant to save and yields a graph whose missing
 * edges are indistinguishable from absent ones. A bounded mode with its own
 * provenance is a real design — it is why the issue offers it as the
 * alternative — but it is not this one, and pretending a truncated snapshot is
 * a compiler-owned one is the failure this function exists to stop.
 */
export function ttscGraphStrictRefusal(
  options: IBuildGraphOptions,
): string | undefined {
  const refused: string[] = [];
  if (options.server !== undefined) refused.push("server");
  if (options.maxFiles !== undefined) refused.push("maxFiles");
  if (options.lspReferenceLimit !== undefined) refused.push("lspReferenceLimit");
  if (refused.length === 0) return undefined;
  // One warning naming every refused option at once. One per option would let a
  // caller fix `maxFiles`, see the lane still refuse, and conclude the fix did
  // nothing — the reader needs the whole reason, not the first clause of it.
  return (
    `typescript: ttscgraph bulk indexing is disabled by ${refused.join(", ")}; ` +
    `the compiler-owned provider publishes whole-program generations and has no bounded mode, ` +
    `so this language falls through to the generic ttscserver LSP lane (and static fallback if that lane cannot answer). ` +
    `These facts are not compiler-owned. Drop ${
      refused.length === 1 ? "that option" : "those options"
    } for a strict TypeScript index.`
  );
}
