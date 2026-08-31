import { ISamchonGraphDetails } from "./ISamchonGraphDetails";
import { ISamchonGraphEntrypoints } from "./ISamchonGraphEntrypoints";
import { ISamchonGraphEscape } from "./ISamchonGraphEscape";
import { ISamchonGraphLookup } from "./ISamchonGraphLookup";
import { ISamchonGraphNext } from "./ISamchonGraphNext";
import { ISamchonGraphOverview } from "./ISamchonGraphOverview";
import { ISamchonGraphCoverageSummary } from "./ISamchonGraphCoverageSummary";
import { ISamchonGraphDump } from "./ISamchonGraphDump";
import { ISamchonGraphTour } from "./ISamchonGraphTour";
import { ISamchonGraphTrace } from "./ISamchonGraphTrace";
import { ISamchonGraphTopology } from "./ISamchonGraphTopology";
import { ISamchonGraphUnresolvedSummary } from "./ISamchonGraphUnresolvedSummary";

/**
 * ## Code Graph MCP
 *
 * `inspect_code_graph` returns an index-built __LANG__ graph contract for the
 * current on-disk source snapshot.
 *
 * Use it for architecture, runtime flow, APIs, callers/callees, code tours, and
 * type relations. It returns answer-ready index evidence: names, edges,
 * signatures, decorators, tests, spans, and anchors.
 *
 * Every returned fact — each name, edge, signature, and span — is checked
 * against the index for the snapshot that call synchronized, so trust it
 * without re-checking against files. Where an operation ranks a shortlist
 * against your question (`lookup`, `entrypoints`, `tour`), the facts stay
 * checked but the selection is heuristic: judge whether its coverage answers
 * you, and a follow-up request or a read of a cited span is fair when it does
 * not.
 *
 * ## Requests
 *
 * A request is a union: pick the single type below that best fits the question,
 * and submit exactly that one.
 *
 * - `tour`: architecture, runtime flow, orientation, or a code tour. One call is
 *   the whole answer; do not split it. Name the machinery you expect it to be
 *   made of in its `reinterpretations`, or send none.
 * - `entrypoints`: find where execution starts when entry points are unknown.
 * - `lookup`: locate a named symbol.
 * - `trace`: follow calls or data flow forward or backward from a symbol, or —
 *   with `to` — the path between two symbols when both ends are known, which is
 *   the one call that answers "how does A reach B".
 * - `details`: signatures, members, and relations of named symbols — including
 *   the classes that implement an interface, which is the one call that answers
 *   "what actually implements this".
 * - `overview`: project layers and folder structure.
 * - `topology`: workspace, package, target, task, source-root, entrypoint, and
 *   project-dependency orientation from declared or owning-tool models.
 * - `escape`: the answer is outside the graph (source body text, files outside
 *   the indexed languages, exact search).
 *
 * ## Chain of Thought
 *
 * Fill these fields in order before the call; each one narrows the reasoning
 * toward the single request you submit.
 *
 * - `question`: the code question, in the user's own words.
 * - `draft`: `{ reason, type }` — why the smallest request that could answer it,
 *   then that request's `type`.
 * - `review`: fix a broad, stale, or duplicate draft. If the graph already
 *   answered, or the evidence is outside it, escape.
 * - `request`: the final choice. Each branch documents its own fields; fill them
 *   from what the branch says, not from what another branch wanted.
 *
 * ## What to trust
 *
 * Before source edits, every returned fact has been checked against the index
 * named by `audit`. Never use extra graph calls, repository search, or file
 * reads to doubt, fact-check, re-derive, re-narrate, or re-confirm a returned
 * node, span, edge, signature, decorator, test, reference, step, or anchor. The
 * server checked each one against the current index for the snapshot the call
 * synced to.
 *
 * Selection is separate. `lookup`, `entrypoints`, and `tour` match your
 * question and return a scored, ranked, per-file-capped, limited shortlist;
 * their facts stay checked, but whether the shortlist covers what you asked is
 * yours to judge, and their `audit` says that instead of claiming completeness.
 * A follow-up request or a read of a cited span for missed coverage is
 * legitimate — re-confirming a fact the graph already checked is not.
 *
 * ## Stop
 *
 * Let the result's `next` set the pace, and do not re-confirm what the graph
 * already checked.
 *
 * - A span is a citation, not a cue to open the file to re-check a fact.
 * - Follow the result's `next`: `answer` means stop and answer from it, `inspect`
 *   means make exactly the one request it names, `outside` means escape,
 *   `clarify` means restate the request.
 * - For a ranked shortlist (`lookup`, `entrypoints`, `tour`), `next` and
 *   `truncated` say whether coverage is settled; when it is not, one more
 *   request is the right move — not a file read to re-verify facts already
 *   given.
 */
export interface ISamchonGraphApplication {
  /**
   * Answer a __LANG__ question from the repository's program index.
   *
   * The graph returns proved facts with coverage and uncertainty. Submit one
   * request:
   *
   * - `tour`: architecture, runtime flow, nearby paths, and tests
   * - `trace`: what a symbol calls, what calls it, or the path from A to B
   * - `details`: signatures, members, and what implements an interface
   * - `lookup`: where a named symbol is declared
   * - `entrypoints`: where execution starts, when the entry is unknown
   * - `overview`: the project's layers and folder structure
   * - `topology`: repository workspaces, packages, roots, targets, tasks, and
   *   dependencies
   *
   * Every fact in a result is checked against the index before return, so no
   * fact needs verifying; for the ranked operations (`lookup`, `entrypoints`,
   * `tour`), judge whether the shortlist covers your question. Read source only
   * for a body or span text.
   *
   * @param props Reasoning plus one graph request
   * @returns Matching `result` union member
   */
  inspect_code_graph(
    props: ISamchonGraphApplication.IProps,
  ): Promise<ISamchonGraphApplication.IOutput>;
}

export namespace ISamchonGraphApplication {
  /** Draft, review, then submit exactly one graph request or escape. */
  export interface IProps {
    /**
     * The code question, in the user's own words.
     *
     * Cut a long message down to the sentences that state the ask, but keep
     * their terms: the graph ranks against these words, so a rewrite ranks a
     * different answer.
     */
    question: string;

    /** The smallest request that could answer, and why. */
    draft: IDraft;

    /**
     * Correct the draft. Escape if the graph already answered, or the next
     * evidence is outside the graph.
     */
    review: string;

    /** Final graph request chosen after review, or a no-op escape. */
    request:
      | ISamchonGraphEntrypoints.IRequest
      | ISamchonGraphLookup.IRequest
      | ISamchonGraphTrace.IRequest
      | ISamchonGraphDetails.IRequest
      | ISamchonGraphOverview.IRequest
      | ISamchonGraphTour.IRequest
      | ISamchonGraphTopology.IRequest
      | ISamchonGraphEscape.IRequest;
  }

  /** First-pass plan; `reason` precedes `type` so it is written first. */
  export interface IDraft {
    /** Why this is the smallest useful next step. */
    reason: string;

    /** The request type being considered. */
    type: IProps["request"]["type"];
  }

  /** The selected request's output. `result.type` mirrors `request.type`. */
  export interface IOutput {
    /**
     * What the server checked this result against before returning it, in its
     * own words. The audit names the LSP, static, or hybrid index that built the
     * current snapshot.
     *
     * The audit is operation-aware. For the walks from a named handle (`trace`,
     * `overview`) it reports the structure held for the named handles, bounded
     * where `truncated` says. For `details` it reports the two halves of a
     * resolved symbol: its own shape returned whole unless the caller explicitly
     * capped members, and its fan-out returned as a slice with `trace` for the
     * rest. For ranked operations (`lookup`,
     * `entrypoints`, `tour`) it additionally says that selection was matched,
     * scored, ranked, and limited against the question, so the facts are checked
     * but shortlist coverage is yours to judge.
     */
    audit: string;

    /**
     * Strict producer, authority, compiler and build-universe identity for the
     * synchronized graph. Absent for `escape`, for `topology` whose facts come
     * from the repository plane and carry their own provenance, and for a
     * legacy or fallback-only dump with no strict producer.
     */
    provenance?: ISamchonGraphDump.IProvenance[];

    /**
     * Machine-readable completeness for the relationship families relevant to
     * this operation. Absent for `escape` and for `topology`, which reports
     * its own relation coverage inside the result.
     */
    coverage?: ISamchonGraphCoverageSummary;

    /**
     * Bounded structured uncertainty for the same operation-scoped families.
     * Absent for `escape` and for `topology`, whose plane publishes none.
     */
    unresolved?: ISamchonGraphUnresolvedSummary;

    /** What to do with `result`: answer, inspect one named request, or escape. */
    next: ISamchonGraphNext;

    /** Result branch matching the submitted `request.type`. */
    result:
      | ISamchonGraphEntrypoints
      | ISamchonGraphLookup
      | ISamchonGraphTrace
      | ISamchonGraphDetails
      | ISamchonGraphOverview
      | ISamchonGraphTour
      | ISamchonGraphTopology
      | ISamchonGraphEscape;
  }
}
