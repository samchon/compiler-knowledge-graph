import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "./GraphPaths";

/**
 * The executable definition of "this product is a faithful multi-language
 * reproduction of `ITtscGraphApplication`".
 *
 * The product began as a port of the TypeScript-only `@ttsc/graph`. That origin
 * is a contract, not history: the MCP request/result union, the
 * question/draft/review/request workflow, and the audit/next/result output shape
 * must stay structurally identical to the reference, while only the fact-
 * production layer underneath is free to change. Hand comparison cannot hold
 * that line — source, schema, unions, requiredness, and nesting drift
 * independently and silently.
 *
 * The gate is a rewrite, not a diff. Every difference between the reference and
 * this product must be spelled out as a named, reviewed rule; applying those
 * rules to the reference must reproduce this product's contract *exactly*. An
 * exact match means every difference is accounted for. Anything else — a field
 * added here, a union member dropped there, an unreviewed edit, or drift in the
 * reference itself — fails closed, because no rule explains it.
 *
 * The two fidelities stay separate. {@link normalize} strips comments for the
 * structural gate so wording cannot mask a shape change, while the prose gate
 * keeps JSDoc and defaults and applies only explicitly prose-scoped rules.
 */
export namespace ContractParity {
  /** Where a canonical fixture was derived from. */
  export interface IReference {
    /** The upstream repository the contract was ported from. */
    repository: string;

    /** The exact commit the canonical text was derived from. */
    commit: string;

    /** Directory within the reference repository holding the contract. */
    directory: string;
  }

  /** A checked-in canonical contract, so tests need no second repository. */
  export interface ICanonical {
    reference: IReference;

    /**
     * Contract name to its reference text, at two fidelities.
     *
     * `structure` is comment-stripped: it freezes the request/result shape and
     * fails on a field, union, requiredness, or nesting change. `prose` is the
     * whole file, comments included: it freezes the JSDoc a caller reads and the
     * `@default` values that decide behaviour, so a reworded instruction or a
     * silent default bump — the drift a structure diff cannot see — fails too.
     */
    contracts: Record<string, IContract>;
  }

  /** The reference text of one contract at both fidelities. */
  export interface IContract {
    /** Comment-stripped reference text: the request/result shape. */
    structure: string;

    /** Whole reference text with comments: the JSDoc and `@default` values. */
    prose: string;
  }

  /**
   * One reviewed difference between the reference and this product.
   *
   * `from` and `to` are exact text. A rule that no longer matches is itself a
   * failure: it means the shape it was reviewed against has moved.
   *
   * `layer` says where the rule applies, and the choice follows from a fact about
   * the two texts: prose *contains* structure — it is the same file, comments and
   * all. So a rule that touches a code line (a relocated import, an added
   * vocabulary member) shows up in both texts and is `"both"`, the default. A
   * rule that touches a comment — reworded instruction, changed `@default` — is
   * `"prose"`, because the structure text has already dropped the comment it
   * lives in. Rarely a code-shape rule is `"structure"`: when its prose form
   * must include JSDoc between the same fields, the prose rule owns that richer
   * text instead of a prior structural rewrite consuming its source.
   */
  export interface IDeviation {
    /** Why this difference is intentional. */
    reason: string;

    /** Exact reference text. */
    from: string;

    /** Exact text it must become here. */
    to: string;

    /** Which layers the rule applies to. `"both"` unless stated. */
    layer?: "both" | Layer;

    /** Exact number of reference occurrences this rule reviewed. @default 1 */
    occurrences?: number;
  }

  /**
   * Contract name to its file in the reference and its file here.
   *
   * The node/edge vocabulary moved from `structures/` to `typings/` when the
   * product stopped being TypeScript-only, so the two sides are not a pure name
   * substitution and each side names its own path.
   */
  export const CONTRACTS: Record<string, { reference: string; product: string }> = {
    Application: {
      reference: "structures/ITtscGraphApplication.ts",
      product: "structures/ISamchonGraphApplication.ts",
    },
    Decorator: {
      reference: "structures/ITtscGraphDecorator.ts",
      product: "structures/ISamchonGraphDecorator.ts",
    },
    Details: {
      reference: "structures/ITtscGraphDetails.ts",
      product: "structures/ISamchonGraphDetails.ts",
    },
    Dump: {
      reference: "structures/ITtscGraphDump.ts",
      product: "structures/ISamchonGraphDump.ts",
    },
    Edge: {
      reference: "structures/ITtscGraphEdge.ts",
      product: "structures/ISamchonGraphEdge.ts",
    },
    Entrypoints: {
      reference: "structures/ITtscGraphEntrypoints.ts",
      product: "structures/ISamchonGraphEntrypoints.ts",
    },
    Escape: {
      reference: "structures/ITtscGraphEscape.ts",
      product: "structures/ISamchonGraphEscape.ts",
    },
    Evidence: {
      reference: "structures/ITtscGraphEvidence.ts",
      product: "structures/ISamchonGraphEvidence.ts",
    },
    Lookup: {
      reference: "structures/ITtscGraphLookup.ts",
      product: "structures/ISamchonGraphLookup.ts",
    },
    Next: {
      reference: "structures/ITtscGraphNext.ts",
      product: "structures/ISamchonGraphNext.ts",
    },
    Node: {
      reference: "structures/ITtscGraphNode.ts",
      product: "structures/ISamchonGraphNode.ts",
    },
    Overview: {
      reference: "structures/ITtscGraphOverview.ts",
      product: "structures/ISamchonGraphOverview.ts",
    },
    Span: {
      reference: "structures/ITtscGraphSpan.ts",
      product: "structures/ISamchonGraphSpan.ts",
    },
    Tour: {
      reference: "structures/ITtscGraphTour.ts",
      product: "structures/ISamchonGraphTour.ts",
    },
    Trace: {
      reference: "structures/ITtscGraphTrace.ts",
      product: "structures/ISamchonGraphTrace.ts",
    },
    NodeModifier: {
      reference: "structures/TtscGraphNodeModifier.ts",
      product: "structures/SamchonGraphNodeModifier.ts",
    },
    NodeKind: {
      reference: "structures/TtscGraphNodeKind.ts",
      product: "typings/GraphNodeKind.ts",
    },
    EdgeKind: {
      reference: "structures/TtscGraphEdgeKind.ts",
      product: "typings/GraphEdgeKind.ts",
    },
  };

  /**
   * Product identity, applied to the whole reference before anything else.
   *
   * This is the only broad structural substitution the gate allows, and it
   * renames nothing but the product: a type's prefix, the MCP method. A field,
   * union member, requiredness, or nesting change can never ride this list —
   * those have to be spelled out one at a time in {@link DEVIATIONS}. Prose has
   * its separate authority vocabulary in {@link PROSE_SUBSTITUTIONS}.
   */
  export const IDENTIFIERS: readonly IDeviation[] = [
    {
      reason: "Structure types carry the product prefix.",
      from: "ITtscGraph",
      to: "ISamchonGraph",
    },
    {
      reason: "Vocabulary types carry the product prefix.",
      from: "TtscGraph",
      to: "SamchonGraph",
    },
    {
      reason:
        "The tool is named for what it indexes. The reference indexes only TypeScript; this one indexes sixteen languages, so naming the method for one of them would be untrue.",
      from: "inspect_typescript_graph",
      to: "inspect_code_graph",
    },
  ];

  /**
   * Authority substitutions the whole prose shares.
   *
   * The reference is a TypeScript compiler; this product is a multi-language
   * index, so its instructions must say so — a compiler resolves, an index
   * checks; the reference is TypeScript-specific, this one is language-neutral.
   * These are the product's standing identity, not tied to any one ttsc commit,
   * so they live here as one list rather than being repeated per contract.
   *
   * Applied to prose only — a comment-stripped structure never contains this
   * wording — and applied in order, because a longer phrase must rewrite before
   * the shorter word inside it (`non-TypeScript` before `TypeScript`). What one
   * of these cannot express as a single word or phrase becomes a contract's own
   * reviewed prose deviation in {@link DEVIATIONS}.
   */
  export const PROSE_SUBSTITUTIONS: readonly IDeviation[] = [
    {
      reason:
        "The reference escapes to non-TypeScript files; this product escapes to files outside the languages it indexes.",
      from: "non-TypeScript files",
      to: "files outside the indexed languages",
    },
    {
      reason: "The product names the language a session indexes, not TypeScript.",
      from: "TypeScript",
      to: "__LANG__",
    },
    {
      reason:
        "The reference derives facts from the compiler; this product derives them from its index. The article moves with the noun: `a compiler` becomes `an index`.",
      from: "a compiler-derived",
      to: "an index-derived",
    },
    {
      reason:
        "The reference's graph is built by the compiler; this product's is built by its index. The article moves with the noun, exactly as for the `-derived` form above.",
      from: "a compiler-built",
      to: "an index-built",
    },
    {
      reason:
        "The reference derives facts from the compiler; this product derives them from its index.",
      from: "compiler-derived",
      to: "index-derived",
    },
    {
      reason:
        "The reference is backed by a compiler; this product is backed by an index.",
      from: "compiler-backed",
      to: "index-backed",
    },
    {
      reason: "A compiler resolves a symbol; an index checks it.",
      from: "the compiler resolved",
      to: "the index resolved",
    },
    {
      reason:
        "`checker` and `compiler` are the reference's two names for the one resolving authority; where it resolved a symbol, this product's index checked it. Sibling of the `compiler resolved` rewrite above.",
      from: "the checker resolved",
      to: "the index resolved",
    },
  ];

  // The reference's dump now embeds proof for one TypeScript Program. This
  // product already consumes that proof at the strict-provider boundary, but
  // its public dump can combine several providers and cannot truthfully present
  // one provider's universe as authority for all languages. Issue #66 owns the
  // provider registry and the eventual multi-provider public provenance shape.
  //
  // These constants keep the temporary omission exact at both fidelities. The
  // prose rule first reduces the reviewed comment-bearing block to the same
  // code-only text the structure layer sees; the following ordinary rule then
  // removes that exact text from both. Any upstream field or wording change
  // makes one of the two replacements stale instead of broadening the omission.
  const DUMP_METADATA_STRUCTURE: string = [
    "provenance: ISamchonGraphDump.IProvenance;",
    "diagnostics: ISamchonGraphDump.IDiagnostic[];",
  ].join("\n").concat("\n");

  const DUMP_METADATA_PROSE: string = [
    "/** Evidence about the one program that produced everything below. */",
    "provenance: ISamchonGraphDump.IProvenance;",
    "/** The compiler's findings for the same generation that produced the facts. Empty means the program reported none. It does not mean they were not collected — `provenance.capabilities` is what says whether they were. */",
    "diagnostics: ISamchonGraphDump.IDiagnostic[];",
  ].join("\n").concat("\n");

  const DUMP_PROVENANCE_STRUCTURE: string = [
    "export interface IProvenance {",
    "schemaVersion: number;",
    "capabilities: string[];",
    "producer: IProducer;",
    "universe: IUniverse;",
    "sources: ISourceDigest[];",
    "}",
    "export interface IProducer {",
    "tool: string;",
    "version: string;",
    "typescript: string;",
    "}",
    "export interface IUniverse {",
    "configs: IFileDigest[];",
    "roots: IRootFile[];",
    "}",
    "export interface IRootFile {",
    "config: string;",
    "file: string;",
    "}",
    "export interface IFileDigest {",
    "file: string;",
    "digest: string;",
    "}",
    "export interface ISourceDigest {",
    "file: string;",
    "checkerDigest: string;",
    "diskDigest: string;",
    "}",
    "export interface IDiagnostic {",
    "file: string;",
    "line: number;",
    "column: number;",
    "code: number;",
    'category: "error" | "warning";',
    "message: string;",
    "}",
  ].join("\n").concat("\n");

  const DUMP_PROVENANCE_PROSE: string = [
    "/** What a snapshot knows about its own origin. The graph's claim is that its nodes, edges, spans, and diagnostics all came from one `Program`. Without this the claim is unprovable from the response: a consumer could only re-read the disk afterwards and hope nothing moved, which is not sound — a write that lands and reverts in between is invisible to it, and a re-read proves what the disk says now, never what the index resolved against. This carries no source text. A digest is the opposite of inlining: it is what lets a consumer prove byte-identity against text it read itself, without the graph ever shipping that text. */",
    "export interface IProvenance {",
    "/** The dump body's schema version, moved when a field is added, removed, or redefined. Independent of the serve protocol's version: a dump written to a file has a schema but never rode the protocol. */",
    "schemaVersion: number;",
    "/** What this snapshot proves. A consumer degrades against this rather than guessing from a field's emptiness, because an empty list and an uncollected one look identical on the wire. The known members are `universe`, `sourceDigests`, `diskDigests`, and `diagnostics`. The type stays `string[]` rather than a union of those on purpose: a union would make `typia.assert` reject a newer producer for naming a capability this client has not heard of, turning \"proves more than you know about\" into a hard failure. An unknown capability is exactly the case a consumer should ignore. */",
    "capabilities: string[];",
    "/** What built the snapshot. */",
    "producer: IProducer;",
    "/** The inputs that decide which files are in the program at all. */",
    "universe: IUniverse;",
    "/** One entry per file the program loaded, ordered by file. */",
    "sources: ISourceDigest[];",
    "}",
    "/** Identifies the binary and the checker behind the facts. `tool` and `version` are separate because more than one binary can produce a dump and they do not share a version line — the shipped `ttscgraph` is stamped at release, the internal viewer tool is not versioned at all — so folding the name in would hand a consumer that parses a version a tool name. */",
    "export interface IProducer {",
    "/** The producing binary's name, such as `ttscgraph`. */",
    "tool: string;",
    '/** The producing binary\'s build version, as its `--version` prints it. A local build reports the dev placeholder; a tool that carries no version reports `""`. */',
    "version: string;",
    "/** The __LANG__ version typescript-go implements. */",
    "typescript: string;",
    "}",
    "/** The build universe: the inputs that decide which files the program contains, as opposed to what is inside them. A change to any of them can add or drop whole files, so a consumer reusing facts across snapshots must treat a universe change as invalidating everything. */",
    "export interface IUniverse {",
    "/** The tsconfig chain — the project's config and everything it extends. It stays an input regardless of what any source contains: compiler options change the meaning of code the checker resolves without any source file changing. */",
    "configs: IFileDigest[];",
    "/** The resolved root file set, one entry per (config, file) pair. A root a config names but that does not exist is still listed: its absence is part of the fingerprint, and creating it later changes the program. */",
    "roots: IRootFile[];",
    "}",
    "/** A root file attributed to the config that named it. */",
    "export interface IRootFile {",
    "/** The tsconfig that named this root, in the dump's path vocabulary. */",
    "config: string;",
    "/** The root file, in the dump's path vocabulary. */",
    "file: string;",
    "}",
    "/** A file and the hex-encoded SHA-256 of its on-disk bytes. */",
    "export interface IFileDigest {",
    "/** In the dump's path vocabulary. */",
    "file: string;",
    "/** Hex-encoded SHA-256. */",
    "digest: string;",
    "}",
    '/** The manifest entry for one source file the program loaded. Two digests, because "the bytes the checker read" and "the bytes on disk" are not always the same string and a consumer needs to know which one it compares against. They diverge when a source-preamble plugin injects text ahead of the file before tsgo parses it, which a real plugin project does on every build. */',
    "export interface ISourceDigest {",
    "/** In the dump's path vocabulary. */",
    "file: string;",
    "/** Hex-encoded SHA-256 of the text the index resolved against — the ground truth for the facts. Every node, edge, and span attributed to this file was computed from these bytes. */",
    "checkerDigest: string;",
    '/** Hex-encoded SHA-256 of the file\'s on-disk bytes at snapshot time, or `""` when it could not be read: it vanished mid-load, or it is a virtual source with no on-disk identity. This is the one a consumer that opens the file itself can reproduce. When it equals `checkerDigest`, a matching read proves byte-identity with the facts. When it does not, the checker saw augmented text and that proof is simply not available for this file — which is a thing to report, not to paper over. Read it only when `provenance.capabilities` lists `diskDigests`. Without that claim every one of these is empty because the producer never hashed the disk, which is a different fact from a file that could not be read. */',
    "diskDigest: string;",
    "}",
    "/** One compiler diagnostic from the generation that produced the facts. */",
    "export interface IDiagnostic {",
    "/** In the dump's path vocabulary. */",
    "file: string;",
    "/** 1-based line. */",
    "line: number;",
    "/** 1-based column. */",
    "column: number;",
    "/** The __LANG__ diagnostic code, such as 2322. */",
    "code: number;",
    "/** Whether the finding fails a build. */",
    'category: "error" | "warning";',
    "/** The diagnostic text, without the code prefix. */",
    "message: string;",
    "}",
  ].join("\n").concat("\n");

  /**
   * Every reviewed difference beyond product identity, per contract.
   *
   * A contract absent from this map must match both fidelities exactly once the
   * blanket identity and authority substitutions are applied. At the structure
   * layer, twelve of the eighteen contracts match exactly; four of those carry
   * prose-only rules here. The structural multi-language extensions remain
   * confined to the dump envelope and node/edge vocabulary. That is the invariant
   * this campaign rests on, so it is worth stating where it is enforced rather
   * than only where it is documented.
   */
  export const DEVIATIONS: Record<string, readonly IDeviation[]> = {
    // The tool's own instruction manual. Structurally the request/output shape is
    // byte-identical to the reference, but the JSDoc a caller reads is rewritten
    // throughout for an index: a compiler resolves-and-verifies a fact, the index
    // checks it; the reference's audit names a type-checked program, this one names
    // the LSP/static/hybrid index that built the snapshot. A handful of edits carry
    // no such authority — they only trim or reword an unchanged meaning; each says
    // so in its reason rather than borrowing an authority it does not have.
    Application: [
      {
        reason:
          "#63 adds the operation-scoped coverage summary and provider-universe provenance to the public application output, so the application imports their public structures.",
        from:
          'import { ISamchonGraphOverview } from "./ISamchonGraphOverview";',
        to: [
          'import { ISamchonGraphOverview } from "./ISamchonGraphOverview";',
          'import { ISamchonGraphCoverageSummary } from "./ISamchonGraphCoverageSummary";',
          'import { ISamchonGraphDump } from "./ISamchonGraphDump";',
        ].join("\n"),
      },
      {
        reason:
          "#63 adds the bounded unresolved summary to the same versioned application output.",
        from: 'import { ISamchonGraphTrace } from "./ISamchonGraphTrace";',
        to: [
          'import { ISamchonGraphTrace } from "./ISamchonGraphTrace";',
          'import { ISamchonGraphUnresolvedSummary } from "./ISamchonGraphUnresolvedSummary";',
        ].join("\n"),
      },
      {
        reason:
          "#159 adds a typed repository-topology branch while keeping its fact plane separate from code-semantic structures.",
        from: [
          'import { ISamchonGraphTrace } from "./ISamchonGraphTrace";',
          'import { ISamchonGraphUnresolvedSummary } from "./ISamchonGraphUnresolvedSummary";',
        ].join("\n"),
        to: [
          'import { ISamchonGraphTrace } from "./ISamchonGraphTrace";',
          'import { ISamchonGraphTopology } from "./ISamchonGraphTopology";',
          'import { ISamchonGraphUnresolvedSummary } from "./ISamchonGraphUnresolvedSummary";',
        ].join("\n"),
      },
      {
        reason:
          "#159 documents topology as the request for declared or owning-tool repository orientation, distinct from symbol semantics.",
        layer: "prose",
        from:
          "- `overview`: project layers and folder structure. - `escape`: the answer is outside the graph",
        to:
          "- `overview`: project layers and folder structure. - `topology`: workspace, package, target, task, source-root, entrypoint, and project-dependency orientation from declared or owning-tool models. - `escape`: the answer is outside the graph",
      },
      {
        reason:
          "#159 lists the new typed branch in the public method's operation guide.",
        layer: "prose",
        from:
          "- `overview`: the project's layers and folder structure Every fact",
        to:
          "- `overview`: the project's layers and folder structure - `topology`: repository workspaces, packages, roots, targets, tasks, and dependencies Every fact",
      },
      {
        reason:
          "The method guide keeps the unchanged tour meaning within the MCP schema generator's description limit.",
        layer: "prose",
        from:
          "- `tour`: architecture, the runtime flow from the public API to the code that does the work, nearby paths, and the tests to read — a whole orientation in one call - `trace`:",
        to:
          "- `tour`: architecture, runtime flow, nearby paths, and tests - `trace`:",
      },
      {
        reason:
          "#159 adds the versioned repository-topology request to the existing single MCP tool.",
        from: "| ISamchonGraphEscape.IRequest;",
        to: [
          "| ISamchonGraphTopology.IRequest",
          "| ISamchonGraphEscape.IRequest;",
        ].join("\n"),
      },
      {
        reason:
          "#159 returns the typed repository-topology result beside the existing code-semantic result branches.",
        from: "| ISamchonGraphEscape;",
        to: [
          "| ISamchonGraphTopology",
          "| ISamchonGraphEscape;",
        ].join("\n"),
      },
      {
        reason:
          "The compiler resolves a fact and verifies it; the index checks it. The same guarantee, named for the authority that gives it.",
        layer: "prose",
        from: "is compiler-resolved and verified for the snapshot",
        to: "is checked against the index for the snapshot",
      },
      {
        reason:
          "A compiler verifies; an index checks. The facts under a ranked shortlist stay checked — only the selection around them is heuristic.",
        layer: "prose",
        from: "the facts stay verified but the selection",
        to: "the facts stay checked but the selection",
      },
      {
        reason:
          "The compiler resolves-and-verifies; the index checks against the snapshot its `audit` names. The `named by audit` clause is pulled forward here so the later sentence need not repeat it.",
        layer: "prose",
        from: "every returned fact is compiler-resolved and verified. Never use",
        to: "every returned fact has been checked against the index named by `audit`. Never use",
      },
      {
        reason:
          "A compiler resolves each fact to its type-checked program; this product checks it against the current index. The reference's `and audit says so on every result` is dropped because the opening sentence already named the index as the one `audit` names.",
        layer: "prose",
        from: "The server resolved each one to the type-checked program for the snapshot the call synced to, and `audit` says so on every result.",
        to: "The server checked each one against the current index for the snapshot the call synced to.",
      },
      {
        reason:
          "No authority: `Selection is the separate question` is trimmed to `Selection is separate`, with no change of meaning.",
        layer: "prose",
        from: "Selection is the separate question.",
        to: "Selection is separate.",
      },
      {
        reason:
          "A compiler verifies; an index checks. `are still` becomes `stay` to read alongside the other `stay checked` above.",
        layer: "prose",
        from: "their facts are still verified, but whether",
        to: "their facts stay checked, but whether",
      },
      {
        reason: "A compiler resolves a fact; an index checks it.",
        layer: "prose",
        from: "re-confirming a fact the graph already resolved is not.",
        to: "re-confirming a fact the graph already checked is not.",
      },
      {
        reason: "A compiler resolves a fact; an index has already checked it.",
        layer: "prose",
        from: "do not re-confirm what the graph resolved.",
        to: "do not re-confirm what the graph already checked.",
      },
      {
        reason:
          "There is no compiler to own the index; the repository's own program index answers the question.",
        layer: "prose",
        from: "Answer a __LANG__ question from the compiler's own index of this repository.",
        to: "Answer a __LANG__ question from the repository's program index.",
      },
      {
        reason:
          "The checker's resolution, audited, becomes a check against the index — the product has a checker nowhere, an index everywhere.",
        layer: "prose",
        from: "Every fact in a result is the checker's own resolution, audited before return, so no fact needs verifying",
        to: "Every fact in a result is checked against the index before return, so no fact needs verifying",
      },
      {
        reason:
          "No authority: the sentence is shortened without changing the boundary between graph facts and source text.",
        layer: "prose",
        from: "Read a file for what the graph does not carry: a body, the text in a span.",
        to: "Read source only for a body or span text.",
      },
      {
        reason:
          "The `audit` string is what the server actually returns, and this product's differs: it names the LSP, static, or hybrid index that built the snapshot rather than a type-checked program the reference's checker resolved every fact to.",
        layer: "prose",
        from: "What the server audited this result against before returning it, in its own words: every node, span, edge, signature, member, and step in it resolves to the type-checked program for the snapshot the call synced to, so opening a file it cites only returns a fact already in it.",
        to: "What the server checked this result against before returning it, in its own words. The audit names the LSP, static, or hybrid index that built the current snapshot.",
      },
      {
        reason:
          "The operation-aware audit says the same thing with the product's actual compact wording: a walk returns the held structure for its named handles, and details splits whole identity from sliced fan-out.",
        layer: "prose",
        from: "For the walks from a named handle (`trace`, `overview`) it reports the result as the structure the graph holds, bounded where `truncated` says. For `details` it reports the two halves of a resolved symbol: its own shape returned whole, its fan-out returned as a slice with `trace` for the rest.",
        to: "For the walks from a named handle (`trace`, `overview`) it reports the structure held for the named handles, bounded where `truncated` says. For `details` it reports the two halves of a resolved symbol: its own shape returned whole unless the caller explicitly capped members, and its fan-out returned as a slice with `trace` for the rest.",
      },
      {
        reason:
          "Documents this product's real ranked-operation `audit` string: the facts are checked rather than verified (authority), and the rest is reworded with no change of meaning (`the caller's` becomes `yours`).",
        layer: "prose",
        from: "For the ranked operations (`lookup`, `entrypoints`, `tour`) it adds that the selection is heuristic — matched, scored, ranked, and limited against the question — so the facts are verified but the shortlist's coverage is the caller's to judge.",
        to: "For ranked operations (`lookup`, `entrypoints`, `tour`) it additionally says that selection was matched, scored, ranked, and limited against the question, so the facts are checked but shortlist coverage is yours to judge.",
      },
      {
        reason:
          "#63 replaces the compiler-completeness overclaim with the exact contract: returned facts are proved, while coverage and uncertainty say whether missing facts are meaningful.",
        layer: "prose",
        from:
          "The graph holds every symbol, call, type, decorator and test, each with its file and line, resolved from the source on disk now. Submit exactly one request:",
        to:
          "The graph returns proved facts with coverage and uncertainty. Submit one request:",
      },
      {
        reason:
          "#63 version 1 adds provider/universe identity plus operation-scoped coverage and unresolved summaries beside `audit`; optionality preserves escape and legacy dump compatibility.",
        from: "audit: string;",
        to: [
          "audit: string;",
          "provenance?: ISamchonGraphDump.IProvenance[];",
          "coverage?: ISamchonGraphCoverageSummary;",
          "unresolved?: ISamchonGraphUnresolvedSummary;",
        ].join("\n"),
      },
      {
        reason:
          "The structure rule above adds the versioned trust fields; this prose rule records their exact public semantics without hiding them behind the English audit.",
        layer: "prose",
        from: [
          "audit: string;",
          "provenance?: ISamchonGraphDump.IProvenance[];",
          "coverage?: ISamchonGraphCoverageSummary;",
          "unresolved?: ISamchonGraphUnresolvedSummary;",
        ].join("\n"),
        to: [
          "audit: string;",
          "/** Strict producer, authority, compiler and build-universe identity for the synchronized graph. Absent only for `escape` or a legacy/fallback-only dump with no strict producer. */",
          "provenance?: ISamchonGraphDump.IProvenance[];",
          "/** Machine-readable completeness for the relationship families relevant to this operation. Absent only for `escape`. */",
          "coverage?: ISamchonGraphCoverageSummary;",
          "/** Bounded structured uncertainty for the same operation-scoped families. Absent only for `escape`. */",
          "unresolved?: ISamchonGraphUnresolvedSummary;",
        ].join("\n"),
      },
    ],
    Details: [
      {
        reason:
          "The multi-language product names the active provider rather than claiming every lane has TypeScript-checker authority; unproved enumerable sets remain absent.",
        layer: "prose",
        from: "/** The complete value set a type alias or enum admits, in __LANG__ source form (`\"a\"`, `1`, `true`, `null`) — the checker's resolved union members, not the quoted tokens that happened to fit in `signature`. Absent when the type has no enumerable value set. A `signature` is capped at the declaration head, so for a union or enum written across several lines this is the field that carries the members. */",
        to: "/** The complete value set a type alias or enum admits, in __LANG__ source form (`\"a\"`, `1`, `true`, `null`) — the provider-resolved union members, not quoted tokens scraped from `signature`. Absent when the active index cannot prove an enumerable value set. */",
      },
      {
        reason:
          "Schema v6 retains portable project coordinates, including `../` siblings and virtual sources, so selected declarations describe the complete path vocabulary.",
        layer: "prose",
        from: "/** Project-relative path of the file that declares this node. */",
        to: "/** Schema-v6 declaration identity: project-relative (including `../`) or `bundled:///`. */",
        occurrences: 2,
      },
      {
        reason:
          "A dependency neighbor carries the same portable schema-v6 identity as its graph node.",
        layer: "prose",
        from: "/** Project-relative declaration file for the neighbor. */",
        to: "/** Schema-v6 neighbor identity: project-relative (including `../`) or `bundled:///`. */",
      },
    ],
    Entrypoints: [
      {
        reason:
          "An entrypoint candidate can name a schema-v6 sibling or virtual declaration.",
        layer: "prose",
        from: "/** Project-relative path of the declaration file. */",
        to: "/** Schema-v6 declaration identity: project-relative (including `../`) or `bundled:///`. */",
      },
      {
        reason:
          "An entrypoint dependency neighbor preserves its graph node's schema-v6 coordinate.",
        layer: "prose",
        from: "/** Project-relative declaration file for the neighbor. */",
        to: "/** Schema-v6 neighbor identity: project-relative (including `../`) or `bundled:///`. */",
      },
    ],
    Evidence: [
      {
        reason:
          "Evidence cites the portable schema-v6 coordinate that produced the fact, including sibling and virtual sources.",
        layer: "prose",
        from: "/** Project-relative path of the file the span lives in. */",
        to: "/** Schema-v6 graph file identity of the span, relative to the dump project (including `../` siblings) or `bundled:///` for a virtual library. */",
      },
    ],
    Lookup: [
      {
        reason:
          "A lookup result can select a sibling or virtual declaration and must describe its schema-v6 identity honestly.",
        layer: "prose",
        from: "/** Project-relative path of the declaration file. */",
        to: "/** Schema-v6 declaration identity: project-relative (including `../`) or `bundled:///`. */",
      },
    ],
    Dump: [
      {
        reason:
          "The dump gained a language set, an indexer authority, diagnostics, warnings, and per-provider provenance, so it imports the language, edge-family, and provider-authority vocabularies plus the diagnostic structure the reference never needed.",
        from: 'import { ISamchonGraphEdge } from "./ISamchonGraphEdge";',
        to: [
          'import { GraphEdgeKind } from "../typings/GraphEdgeKind";',
          'import { GraphLanguage } from "../typings/GraphLanguage";',
          'import { GraphProviderAuthority } from "../typings/GraphProviderAuthority";',
          'import { ISamchonGraphDiagnostic } from "./ISamchonGraphDiagnostic";',
          'import { ISamchonGraphEdge } from "./ISamchonGraphEdge";',
        ].join("\n"),
      },
      {
        reason:
          "A tsconfig is the TypeScript-only input. A multi-language dump instead names the languages it holds and the strategy that produced them, because a caller cannot judge a fact without knowing what resolved it.",
        from: "tsconfig: string;",
        to: [
          "languages: GraphLanguage[];",
          'indexer: "lsp" | "static" | "hybrid";',
        ].join("\n"),
      },
      {
        reason:
          "#159 adds a deterministic code-input generation so an MCP request can fence a topology load between two code refreshes before admitting file joins.",
        from: 'indexer: "lsp" | "static" | "hybrid";',
        to: [
          'indexer: "lsp" | "static" | "hybrid";',
          "generation?: {",
          "input: string;",
          "};",
        ].join("\n"),
      },
      {
        reason:
          "The generation shape above is structural; this prose rule records that it exists for cross-plane fencing and remains optional only for legacy dumps.",
        layer: "prose",
        from: [
          "generation?: {",
          "input: string;",
          "};",
        ].join("\n"),
        to: [
          "/** Complete coordinator input generation used to fence code/topology joins. Absent only on dumps written before cross-plane generation fencing. */",
          "generation?: {",
          "input: string;",
          "};",
        ].join("\n"),
      },
      {
        reason:
          "The reference proves one TypeScript Program. The public multi-language dump cannot present one provider's proof as authority for every language; #66 owns the provider registry and its eventual public provenance shape. Reduce the reviewed prose block to its code before removing the same exact structure at both fidelities.",
        layer: "prose",
        from: DUMP_METADATA_PROSE,
        to: DUMP_METADATA_STRUCTURE,
      },
      {
        reason:
          "#66 replaced the reference's single-Program claim in the same position, but not with its shape. One TypeScript Program resolves the reference's whole dump; this product's can be owned in part by a compiler, a Clang compilation universe, and a semantic index at once, so the claim is a list with one row per contributing provider. It is optional because the generic and static lanes make no such claim, and the compiler-only diagnostic row is dropped because diagnostics arrive from every lane and are declared further down.",
        from: DUMP_METADATA_STRUCTURE,
        to: "provenance?: ISamchonGraphDump.IProvenance[];\n",
      },
      {
        reason:
          "The provenance-list swap above is a code rule the structure layer sees; the field's JSDoc, which that layer drops, is documented here. Runs after that rule, on the line it produced.",
        layer: "prose",
        from: "provenance?: ISamchonGraphDump.IProvenance[];",
        to: [
          "/** What each strict provider proved about the slice it contributed, one row per provider, ordered by provider name so an unchanged checkout stays byte-identical. Absent when no strict provider served the build, and absent from dumps written before this field existed. Computation mode is deliberately not here: it belongs to one refresh rather than to the facts, so recording it would make two dumps of the same unedited checkout differ. */",
          "provenance?: ISamchonGraphDump.IProvenance[];",
        ].join("\n"),
      },
      {
        reason:
          "A language server has something to say about the source it indexed, and a build can hit non-fatal trouble worth reporting. The reference had neither channel.",
        from: [
          "edges: ISamchonGraphDump.IEdge[];",
          "}",
          "export namespace ISamchonGraphDump {",
        ].join("\n"),
        to: [
          "edges: ISamchonGraphDump.IEdge[];",
          "diagnostics?: ISamchonGraphDiagnostic[];",
          "warnings?: string[];",
          "}",
          "export namespace ISamchonGraphDump {",
        ].join("\n"),
      },
      {
        reason:
          "The omitted top-level single-program proof leaves its TypeScript-only namespace unused. Reduce its exact reviewed prose to the structure text so the next rule removes the same block at both fidelities without hiding upstream drift.",
        layer: "prose",
        from: DUMP_PROVENANCE_PROSE,
        to: DUMP_PROVENANCE_STRUCTURE,
      },
      {
        reason:
          "#66 replaced these helpers rather than deleting them. The reference's universe, root, file-digest, source-digest, and diagnostic rows describe one TypeScript Program's own manifest; the product publishes a fingerprint per provider instead, because every language answers 'what decides the file set' with a different shape and a reader only ever asks whether it moved. The producer row keeps its tool and version, gains the schema and protocol generations a multi-provider reader needs to tell two producers apart, and renames `typescript` to `compiler` for the same reason. Diagnostics are declared on the dump body, not here, because they no longer come from one program.",
        from: DUMP_PROVENANCE_STRUCTURE,
        to: [
          "export interface IProvenance {",
          "provider: string;",
          "languages: GraphLanguage[];",
          "authority: GraphProviderAuthority;",
          "facts: GraphEdgeKind[];",
          "capabilities: string[];",
          "producer: IProducer;",
          "universe: string;",
          "manifest: string;",
          "content: string;",
          "}",
          "export interface IProducer {",
          "tool: string;",
          "version: string;",
          "compiler: string;",
          "schemaVersion: number;",
          "protocolVersion: number;",
          "}",
        ].join("\n").concat("\n"),
      },
      {
        reason:
          "The provider-set helpers above are a code rule the structure layer sees; the JSDoc that layer drops is documented here. Runs after that rule, on the block it produced.",
        layer: "prose",
        from: [
          "export interface IProvenance {",
          "provider: string;",
          "languages: GraphLanguage[];",
          "authority: GraphProviderAuthority;",
          "facts: GraphEdgeKind[];",
          "capabilities: string[];",
          "producer: IProducer;",
          "universe: string;",
          "manifest: string;",
          "content: string;",
          "}",
          "export interface IProducer {",
          "tool: string;",
          "version: string;",
          "compiler: string;",
          "schemaVersion: number;",
          "protocolVersion: number;",
          "}",
        ].join("\n"),
        to: [
          "/** One strict provider's claim about the slice it contributed. The reference contract carries a single provenance object, because one TypeScript `Program` produced its whole dump. A multi-language graph has no such single program: TypeScript's checker, a Clang compilation universe, and a Go semantic index can each own part of one dump, and collapsing them into one row would have to invent a tool name, a version, and a build fingerprint that describe none of them. So the claim is per provider, and a reader asks which slice it is reading before trusting a fingerprint. */",
          "export interface IProvenance {",
          "/** Registry name of the provider that produced this slice. */",
          "provider: string;",
          "/** The languages it replaced atomically, in the order it published them. */",
          "languages: GraphLanguage[];",
          "/** What its facts are grounded in. */",
          "authority: GraphProviderAuthority;",
          '/** The edge families it is registered to prove. A reader distinguishes "this provider proved there are no calls here" from "this provider cannot prove calls at all" by asking whether `calls` appears here — a question an empty edge list cannot answer. */',
          "facts: GraphEdgeKind[];",
          "/** What the producer claims it collected, in the producer's own words. */",
          "capabilities: string[];",
          "/** Which program produced the facts. */",
          "producer: IProducer;",
          "/** Fingerprint of the inputs that decided which files are in the program. Facts must never be carried across a snapshot whose fingerprint moved: a change to it can add or drop whole files, so the two generations are not two views of one program. */",
          "universe: string;",
          "/** Digest over the exact input manifest the facts were computed from. */",
          "manifest: string;",
          "/** Digest over the facts this slice published, in publication order. */",
          "content: string;",
          "}",
          "/** The program that produced one slice. */",
          "export interface IProducer {",
          "/** The producing tool's name, such as `ttscgraph`. */",
          "tool: string;",
          '/** The tool\'s build version, or `""` when it carries none. */',
          "version: string;",
          "/** The language version the tool's checker implements. Separate from {@link version} because a tool and the checker it embeds do not share a version line, and a consumer comparing language behaviour needs the checker's. */",
          "compiler: string;",
          "/** The version of the dump body contract the producer emitted. */",
          "schemaVersion: number;",
          "/** The wire protocol version the producer spoke. */",
          "protocolVersion: number;",
          "}",
        ].join("\n"),
      },
      {
        reason:
          "Formatting only. The shorter product prefix lets the `Omit` fit differently; the declaration is the same.",
        from: [
          "export interface INode extends Omit<",
          "ISamchonGraphNode,",
          '"evidence" | "implementation"',
          "> {",
        ].join("\n"),
        to: [
          "export interface INode",
          'extends Omit<ISamchonGraphNode, "evidence" | "implementation"> {',
        ].join("\n"),
      },
      {
        reason:
          "The CLI is named for the product, the fact-builder is no longer a separate Go program but this product's indexer, and a multi-language engine cannot name one language: `__LANG__ graph engine` becomes `code graph engine`.",
        layer: "prose",
        from: "The whole-graph export `ttscgraph dump` writes and the MCP server loads — the wire contract between the Go fact-builder and the __LANG__ graph engine.",
        to: "The whole-graph export `samchon-graph dump` writes and the MCP server loads — the wire contract between the indexer and the code graph engine.",
      },
      {
        reason:
          "#66 gave the combined dump a provenance claim, but not the reference's singular one: one TypeScript Program resolved the reference's whole dump, while this product's can be owned in part by a compiler, a Clang compilation universe, and a semantic index at once. The claim is therefore per contributing provider, and optional because the generic and static lanes make no such claim at all.",
        layer: "prose",
        from: "every node and edge the build resolved, plus the `provenance` that says which program resolved them.",
        to: "every node and edge the build resolved.",
      },
      {
        reason:
          "The reference's snapshot is a native (Go) artifact; this product's is just the snapshot the indexer parses.",
        layer: "prose",
        from: "The server parses each changed native snapshot",
        to: "The server parses each changed snapshot",
      },
      {
        reason:
          "No authority: the reference closes on its bundled 3D viewer; this product documents its own dump invariant instead — a deterministic, timestamp-free function of the source, which is a closed product decision, not a compiler-vs-index difference.",
        layer: "prose",
        from: "while project inputs stay unchanged; the bundled 3D viewer reduces the same dump.",
        to: "while project inputs stay unchanged. It is a pure function of its source: two dumps of the same unedited checkout are byte-identical, so a graph can be cached, diffed, and trusted. Nothing here records when it was built — a timestamp would move under an unchanged source, which is exactly the property a cache and a diff depend on.",
      },
      {
        reason:
          "The public multi-language dump uses the reference's schema-v6 path vocabulary and additionally states that the same coordinate survives every product result boundary.",
        layer: "prose",
        from: "`project` is the producer-local absolute locator. Every identity-bearing path uses one schema-v6 coordinate relative to it: project files are ordinary relative paths; same-filesystem siblings use `../` segments; package files keep their full resolution context (including version/peer-store segments); and a virtual compiler source stays `bundled:///…`. Raw absolute identities are never emitted. A source on another drive or UNC share makes the producer fail unless a future contract supplies a logical root for it.",
        to: "`project` is the producer-local absolute locator. Every identity-bearing path uses one schema-v6 coordinate relative to it: project files are ordinary relative paths; same-filesystem siblings use `../` segments; package files keep their full resolution context (including version/peer-store segments); and a virtual compiler source stays `bundled:///…`. Raw absolute identities are never emitted. A source on another drive or UNC share makes the producer fail unless a future contract supplies a logical root for it. The same coordinate flows through nodes, edges, evidence, diagnostics, and results.",
      },
      {
        reason:
          "The `tsconfig`-to-`languages`/`indexer` swap above is a code rule the structure layer sees; each new field's JSDoc, which that layer drops, is documented here.",
        layer: "prose",
        from: [
          "/** The tsconfig the program was loaded from, in the dump's path vocabulary. */",
          "languages: GraphLanguage[];",
          'indexer: "lsp" | "static" | "hybrid";',
        ].join("\n"),
        to: [
          "/** The source languages present in this dump. */",
          "languages: GraphLanguage[];",
          "/** Which indexing strategy produced the graph. */",
          'indexer: "lsp" | "static" | "hybrid";',
        ].join("\n"),
      },
      {
        reason:
          "The `diagnostics` and `warnings` additions above are code rules; their JSDoc lives only in the prose layer.",
        layer: "prose",
        from: [
          "edges: ISamchonGraphDump.IEdge[];",
          "diagnostics?: ISamchonGraphDiagnostic[];",
          "warnings?: string[];",
        ].join("\n"),
        to: [
          "edges: ISamchonGraphDump.IEdge[];",
          "/** What the language server said about the source while it indexed it. Absent when the dump was built without one — a static parse has nobody to ask. */",
          "diagnostics?: ISamchonGraphDiagnostic[];",
          "/** Non-fatal problems encountered while building the graph. */",
          "warnings?: string[];",
        ].join("\n"),
      },
      {
        reason:
          "The node/edge wire rows are emitted by this product's indexer, not the reference's separate builder process. Applies to both the `INode` and `IEdge` namespace docs.",
        layer: "prose",
        from: "the builder sends it",
        to: "the indexer sends it",
        occurrences: 2,
      },
      {
        reason:
          "Opaque semantic ids do not encode a source path, so edge span compression recovers the source node file from the finalized node map rather than interpreting `from`.",
        layer: "prose",
        from: "/** An edge as the indexer sends it. Its span is in the file its `from` id names — the id is `path#Qualified.Name:kind` — so the path rode the wire a second time on every edge, and edges outnumber nodes several times over. */",
        to: "/** An edge as the indexer sends it. Its span is in its source node's file, looked up by the opaque id when necessary, so the path need not ride the wire a second time on every edge. */",
      },
      {
        reason:
          "A wire edge obtains its omitted evidence file from its source node; only legacy ids expose that path directly.",
        layer: "prose",
        from: "/** Expression span; its file is the one embedded in `from`. */",
        to: "/** Expression span; its file is the source node's declaration file. */",
      },
      {
        reason:
          "#63 makes normalized completeness part of the public dump contract.",
        from: 'import { ISamchonGraphEdge } from "./ISamchonGraphEdge";',
        to: [
          'import { ISamchonGraphEdge } from "./ISamchonGraphEdge";',
          'import { ISamchonGraphCoverage } from "./ISamchonGraphCoverage";',
        ].join("\n"),
      },
      {
        reason:
          "#63 preserves structured unresolved sites in the public dump.",
        from: 'import { ISamchonGraphSpan } from "./ISamchonGraphSpan";',
        to: [
          'import { ISamchonGraphSpan } from "./ISamchonGraphSpan";',
          'import { ISamchonGraphUnresolved } from "./ISamchonGraphUnresolved";',
        ].join("\n"),
      },
      {
        reason:
          "#63 adds additive optional coverage and unresolved fields after provider provenance so older dumps remain loadable during protocol migration.",
        from: "provenance?: ISamchonGraphDump.IProvenance[];",
        to: [
          "provenance?: ISamchonGraphDump.IProvenance[];",
          "coverage?: ISamchonGraphCoverage[];",
          "unresolved?: ISamchonGraphUnresolved[];",
        ].join("\n"),
      },
      {
        reason:
          "The structure rule above adds dump trust fields; their prose distinguishes migration absence from explicit empty uncertainty.",
        layer: "prose",
        from: [
          "provenance?: ISamchonGraphDump.IProvenance[];",
          "coverage?: ISamchonGraphCoverage[];",
          "unresolved?: ISamchonGraphUnresolved[];",
        ].join("\n"),
        to: [
          "provenance?: ISamchonGraphDump.IProvenance[];",
          "/** Exhaustive per-provider, language, target and relationship-family completeness rows. Absent only on dumps written before protocol version 1. */",
          "coverage?: ISamchonGraphCoverage[];",
          "/** Structured relationship sites that a producer could not resolve exactly. An empty list is meaningful only together with exhaustive coverage. */",
          "unresolved?: ISamchonGraphUnresolved[];",
        ].join("\n"),
      },
    ],
    Edge: [
      {
        reason:
          "The edge vocabulary is no longer TypeScript-specific, so it moved out of the structures barrel into the shared typings.",
        from: 'import { SamchonGraphEdgeKind } from "./SamchonGraphEdgeKind";',
        to: 'import { GraphEdgeKind } from "../typings/GraphEdgeKind";',
      },
      {
        reason: "Follows the vocabulary relocation.",
        from: "kind: SamchonGraphEdgeKind;",
        to: "kind: GraphEdgeKind;",
      },
      {
        reason:
          "A compiler resolves every edge, so the reference can call the whole graph a single checker-resolved fact. This product's edges are resolved by whichever index built the graph, so the graph is one kind of fact and each result's `audit` names which kind.",
        layer: "prose",
        from: "Every edge is compiler-resolved, so there is no per-edge trust flag: the whole graph is checker-resolved fact.",
        to: "Every edge is resolved by the index that built the graph, so there is no per-edge trust flag: the whole graph is one kind of fact, and a result's `audit` names which kind.",
      },
    ],
    Node: [
      {
        reason:
          "The node vocabulary moved to the shared typings, and a node now names the language it came from. Both imports sort ahead of the structure imports.",
        from: [
          'import { ISamchonGraphDecorator } from "./ISamchonGraphDecorator";',
          'import { ISamchonGraphEvidence } from "./ISamchonGraphEvidence";',
          'import { SamchonGraphNodeKind } from "./SamchonGraphNodeKind";',
          'import { SamchonGraphNodeModifier } from "./SamchonGraphNodeModifier";',
        ].join("\n"),
        to: [
          'import { GraphLanguage } from "../typings/GraphLanguage";',
          'import { GraphNodeKind } from "../typings/GraphNodeKind";',
          'import { ISamchonGraphDecorator } from "./ISamchonGraphDecorator";',
          'import { ISamchonGraphEvidence } from "./ISamchonGraphEvidence";',
          'import { SamchonGraphNodeModifier } from "./SamchonGraphNodeModifier";',
        ].join("\n"),
      },
      {
        reason:
          "A node carries its language. In a single-language graph the answer was the whole graph's; here two nodes in one dump can disagree.",
        from: "kind: SamchonGraphNodeKind;",
        to: ["kind: GraphNodeKind;", "language: GraphLanguage;"].join("\n"),
      },
      {
        reason:
          "The `language` field the rule above added is a code line the structure layer sees; its JSDoc, which that layer drops, is documented here. Runs after that rule, on the line it produced.",
        layer: "prose",
        from: "language: GraphLanguage;",
        to: [
          "/** The source language this node was declared in. */",
          "language: GraphLanguage;",
        ].join("\n"),
      },
      {
        reason:
          "No authority: the example is reworded with no change of meaning (indefinite articles added before `Prisma client` and `codegen output`).",
        layer: "prose",
        from: "git-ignored generated code (Prisma client, codegen output)",
        to: "git-ignored generated code (a Prisma client, a codegen output)",
      },
      {
        reason:
          "Enum members keep producer order, but the producer may be a compiler, language server, or static index rather than a TypeScript checker.",
        layer: "prose",
        from: "in checker order",
        to: "in index order",
      },
      {
        reason:
          "The index is the product-wide authority that attempts constant folding; not every supported language uses a checker.",
        layer: "prose",
        from: "the checker could not fold",
        to: "the index could not fold",
      },
      {
        reason:
          "A node can represent a schema-v6 sibling or virtual source, so the field documents the full portable coordinate vocabulary.",
        layer: "prose",
        from: "/** Project-relative path of the file that declares this node. */",
        to: "/** Schema-v6 graph file identity of the declaration, relative to the dump project (including `../` siblings) or `bundled:///` for a virtual library. */",
      },
      {
        reason:
          "The declaration boundary belongs to the active producer, which may be a compiler, semantic index, or language server.",
        layer: "prose",
        from: "cut by the producer where the compiler says the body opens",
        to: "cut by the producer where the producer says the body opens",
      },
      {
        reason:
          "Non-TypeScript providers use opaque semantic identities while TypeScript retains its ttsc-compatible legacy handles.",
        layer: "prose",
        from: "/** One node in the graph: a declared symbol or a structural container (file, package). The `id` is position-invariant: `path#qualifiedName:kind` (e.g. `src/order.ts#OrderService.create:method`), so inserting a line above a declaration does not re-key it. Line and span live in `evidence` and are never part of identity. */",
        to: "/** One node in the graph: a declared symbol or a structural container (file, package). A TypeScript node keeps its position-invariant `path#qualifiedName:kind` id (e.g. `src/order.ts#OrderService.create:method`) for ttsc parity. Other providers may carry an opaque semantic id instead. Neither form puts declaration coordinates in the identity; they live in `evidence`. */",
      },
      {
        reason:
          "The public identity can now be a provider-owned opaque semantic key instead of a legacy file-qualified spelling.",
        layer: "prose",
        from: "/** Position-invariant identity (see the interface doc for the id grammar). */",
        to: "/** Provider-owned stable identity (see the interface doc for its grammar). */",
      },
    ],
    Overview: [
      {
        reason:
          "Overview layers use the schema-v6 directory coordinate relative to the dump project.",
        layer: "prose",
        from: "/** Directory, project-relative. */",
        to: "/** Schema-v6 directory identity, relative to the dump project. */",
      },
      {
        reason:
          "Overview declarations preserve portable sibling and virtual coordinates across the public result boundary.",
        layer: "prose",
        from: "/** Project-relative path of the file that declares it. */",
        to: "/** Schema-v6 declaration identity: project-relative (including `../`) or `bundled:///`. */",
      },
    ],
    NodeModifier: [
      {
        reason:
          "C and C++ internal linkage has no TypeScript equivalent: a declaration can be confined to its translation unit, which is a visibility the reference's vocabulary could not express.",
        from: ['| "protected"', '| "optional";'].join("\n"),
        to: ['| "protected"', '| "internal"', '| "optional";'].join("\n"),
      },
    ],
    NodeKind: [
      {
        reason: "Follows the vocabulary relocation to the shared typings.",
        from: "export type SamchonGraphNodeKind =",
        to: "export type GraphNodeKind =",
      },
      {
        reason:
          "Declaration kinds a TypeScript-only vocabulary never needed. TypeScript models both as properties; Java, C#, and their peers distinguish a field from a property, and a constructor from a method.",
        from: ['| "parameter"', '| "external_symbol";'].join("\n"),
        to: [
          '| "parameter"',
          '| "field"',
          '| "constructor"',
          '| "external_symbol";',
        ].join("\n"),
      },
      {
        reason:
          "Follows the enum extension above: the symbol kinds now run `file` through `constructor`, not `file` through `parameter`, because `field` and `constructor` were added after `parameter`.",
        layer: "prose",
        from: "`file` through `parameter`",
        to: "`file` through `constructor`",
      },
      {
        reason:
          "The reference's TypeScript program owns the declarations and its checker resolves them; this product's language server both owns and resolves them.",
        layer: "prose",
        from: "declarations the __LANG__ program owns and the checker resolves",
        to: "declarations the language server owns and resolves",
      },
    ],
    EdgeKind: [
      {
        reason: "Follows the vocabulary relocation to the shared typings.",
        from: "export type SamchonGraphEdgeKind =",
        to: "export type GraphEdgeKind =",
      },
      {
        reason:
          "A relationship a language server reports without classifying it further. The compiler-backed reference always knew which kind it was; a generic LSP lane does not, and inventing a stronger kind would overclaim.",
        from: '| "tests";',
        to: ['| "tests"', '| "references";'].join("\n"),
      },
      {
        reason:
          "The reference's checker resolves the value and type edges and the dispatch target; this product's language server does. `the checker` appears twice in this doc, both times the language server.",
        layer: "prose",
        from: "the checker",
        to: "the language server",
        occurrences: 2,
      },
      {
        reason:
          "JSX is a TypeScript/React form; this product indexes many languages, so `renders` names a generic component use, not a JSX one.",
        layer: "prose",
        from: "`renders` is a JSX component use",
        to: "`renders` is a component use",
      },
    ],
    Span: [
      {
        reason:
          "The reference's wire shape sits between its Go builder and the loader; this product's sits between its indexer and the loader.",
        layer: "prose",
        from: "This shape exists only between the Go builder and the loader.",
        to: "This shape exists only between the indexer and the loader.",
      },
      {
        reason:
          "An implementation can live in a sibling or virtual source and keeps the same portable schema-v6 coordinate as complete evidence.",
        layer: "prose",
        from: "/** Present only when it cannot be derived: an `implementation` can live in a different file from the declaration that owns it. */",
        to: "/** Present only when it cannot be derived: an `implementation` can live in a different file from the declaration that owns it. Uses the same schema-v6 project-relative (including `../` siblings) or `bundled:///` identity as a complete graph evidence span. */",
      },
      {
        reason:
          "An opaque source id cannot be parsed for its file, but the loader can reconstruct an edge span from the finalized source node.",
        layer: "prose",
        from: "an edge's span is in the file its `from` id names. Sending the path a second and a third time",
        to: "an edge's span is in its source node's file. Sending the path a second and a third time",
      },
    ],
    Tour: [
      {
        reason:
          "A tour candidate can cite a schema-v6 sibling or virtual declaration and preserves its portable coordinate.",
        layer: "prose",
        from: "/** Project-relative declaration file. */",
        to: "/** Schema-v6 declaration identity: project-relative (including `../`) or `bundled:///`. */",
      },
      {
        reason:
          "Tour anchors preserve the schema-v6 coordinate that backs their citation, including sibling and virtual sources.",
        layer: "prose",
        from: "/** Project-relative file. */",
        to: "/** Schema-v6 graph identity: project-relative (including `../`) or `bundled:///`. */",
        occurrences: 2,
      },
      {
        reason:
          "Opaque semantic identities carry no location syntax, so a reached tour handle includes its declaration file and kind only in that case.",
        layer: "structure",
        from: ["id: string;", "name: string;", "line?: number;"].join("\n"),
        to: [
          "id: string;",
          "name: string;",
          "file?: string;",
          "kind?: string;",
          "line?: number;",
        ].join("\n"),
      },
      {
        reason:
          "A reached tour node must retain its location only when its provider-owned identity is opaque; legacy ids remain compact file-qualified handles.",
        layer: "prose",
        from: "/** A node a flow reached, as its handle and its declaration line. A node id _is_ its coordinates — `path/to/file.ts#Owner.member:kind` — so a reached node carrying `file` and `kind` beside it bought the same fact three times. Across the benchmark corpus that repetition was 15% of every tour, and a tour is re-sent whole on every turn of the conversation it opened. */",
        to: "/** A node a flow reached, as its handle and its declaration line. Legacy ids carry their location as `path/to/file.ts#Owner.member:kind`; opaque semantic ids deliberately do not. Only those opaque ids therefore retain their declaring `file` and `kind` here, so every reached handle remains inspectable. */",
      },
      {
        reason:
          "A reached tour id can be opaque rather than the legacy file-qualified spelling.",
        layer: "prose",
        from: "/** Stable node id for later graph calls: `file#Qualified.Name:kind`. */",
        to: "/** Stable node id for later graph calls. */",
      },
      {
        reason:
          "The optional file and kind on a reached node are the declaration identity needed to inspect an opaque semantic handle.",
        layer: "prose",
        from: [
          "/** Qualified symbol name when available, otherwise the simple name. */",
          "name: string;",
          "/** 1-based declaration line, when known. */",
          "line?: number;",
        ].join("\n"),
        to: [
          "/** Qualified symbol name when available, otherwise the simple name. */",
          "name: string;",
          "/** Declaration file when this node has an opaque semantic id. */",
          "file?: string;",
          "/** Declaration kind when this node has an opaque semantic id. */",
          "kind?: string;",
          "/** 1-based declaration line, when known. */",
          "line?: number;",
        ].join("\n"),
      },
    ],
    Trace: [
      {
        reason:
          "The public contract uses a neutral event-emitter example so shipped instructions cannot reveal a benchmark corpus or its answer symbols.",
        layer: "prose",
        from:
          "/** Symbols both ends touch, when no call path runs between them. Nothing calls across the gap because in an event-driven codebase nothing does: a handler registers a listener on an emitter, the emitter's `emit()` runs whatever a registration put in an array, and no call edge crosses that array. But both ends touch the emitter, and that is an edge, not a guess — Excalidraw's pointer handler and its store's emit both reference `Store.onDurableIncrementEmitter`, which is exactly the seam the call graph cannot walk. A junction is not a path. It is the symbol to look at next, and the edges that say why. */",
        to:
          "/** Symbols both ends touch, when no call path runs between them. Nothing calls across the gap because in an event-driven codebase nothing does: a handler registers a listener on an emitter, the emitter's `emit()` runs whatever a registration put in an array, and no call edge crosses that array. But both ends touch the emitter, and that is an edge, not a guess: a request handler and a state store's emit both reference `StateStore.onCommit`, which is exactly the seam the call graph cannot walk. A junction is not a path. It is the symbol to look at next, and the edges that say why. */",
      },
      {
        reason:
          "Trace nodes preserve portable sibling and virtual declaration coordinates across the public result boundary.",
        layer: "prose",
        from: "/** Project-relative path of the file that declares it. */",
        to: "/** Schema-v6 declaration identity: project-relative (including `../`) or `bundled:///`. */",
      },
      {
        reason:
          "Trace omissions name the same schema-v6 declaration coordinate as the omitted graph node.",
        layer: "prose",
        from: "/** Project-relative path of the declaration file. */",
        to: "/** Schema-v6 declaration identity: project-relative (including `../`) or `bundled:///`. */",
      },
      {
        reason:
          "Path mode now reports bounded depth and dispatch-hub omissions instead of falsely proving that no connection exists, so truncation applies to both trace forms.",
        layer: "prose",
        from: "/** In an open trace, true when a bound omitted an eligible node or hop. */",
        to: "/** True when a walk or path-search bound omitted an eligible node or hop. */",
      },
    ],
  };

  /** The two fidelities a contract is frozen at. */
  export type Layer = "structure" | "prose";

  /**
   * Reduce a contract to one fidelity.
   *
   * `structure` strips comments first, so wording can never mask a shape change
   * nor a shape change hide behind reworded prose. `prose` keeps the comments —
   * the JSDoc a caller reads and the `@default` values that decide behaviour are
   * the whole point of that layer. Both trim each line and drop blank lines, so
   * indentation and spacing are never the gate's business; the prose layer folds
   * hard line wrapping too, because where a sentence breaks is a formatter's
   * choice, not a contract, and the reference and this product wrap independently.
   */
  export function normalize(source: string, layer: Layer = "structure"): string {
    if (layer === "structure")
      return source
        .replace(/\r/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .join("\n");
    // Prose keeps every comment; it folds each comment block's internal wrapping
    // first (see below), then trims each line and drops blank lines — so where a
    // sentence wraps and how the file is spaced are never the gate's business,
    // while the words and the `@default` values are.
    return foldCommentWrapping(source.replace(/\r/g, ""))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join("\n");
  }

  // Collapse the internal line breaks of one `/** ... */` block to single
  // spaces, so a re-wrapped sentence reads as one line. The `*` margin and the
  // opening/closing fences stay, so a *reworded* sentence still differs — only
  // *where it wraps* is normalized away.
  function foldCommentWrapping(source: string): string {
    return source.replace(/\/\*\*[\s\S]*?\*\//g, (block) =>
      block
        .split("\n")
        .map((line) => {
          const trimmed: string = line.trim();
          return trimmed === "*/"
            ? trimmed
            : trimmed.replace(/^\*\s?/, "").trimEnd();
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    );
  }

  /** Apply one reviewed rule, failing when it no longer matches. */
  export function rewrite(source: string, deviation: IDeviation): string {
    const expectedOccurrences: number = deviation.occurrences ?? 1;
    const actualOccurrences: number = source.split(deviation.from).length - 1;
    if (actualOccurrences !== expectedOccurrences) {
      throw new Error(
        `contract parity: a reviewed rule no longer matches the reference.\n` +
          `  reason: ${deviation.reason}\n` +
          `  expected ${expectedOccurrences} occurrence(s), found ${actualOccurrences}:\n${deviation.from}\n` +
          `The reference moved under a rule that was reviewed against its old shape. ` +
          `Re-review the rule rather than deleting it.`,
      );
    }
    return source.split(deviation.from).join(deviation.to);
  }

  /**
   * The contract this product must have, derived from the reference.
   *
   * Identity first, then that contract's own reviewed rules.
   *
   * The two are enforced differently, and the asymmetry is the point. Identity
   * is a blanket product rename: a contract that never mentions the product
   * simply has nothing to rename, so a miss is silence. A reviewed deviation
   * describes one specific shape; if that shape is gone, the review behind it is
   * stale and {@link rewrite} says so rather than quietly producing a contract
   * nobody reviewed.
   */
  export function expected(
    contract: string,
    canonicalText: string,
    layer: Layer = "structure",
  ): string {
    let result: string = canonicalText;
    for (const identifier of IDENTIFIERS)
      result = result.split(identifier.from).join(identifier.to);
    // The authority substitutions are prose's blanket rename, the way the
    // identifiers are structure's: applied everywhere they appear, in order, and
    // only to the prose layer where the wording lives.
    if (layer === "prose")
      for (const sub of PROSE_SUBSTITUTIONS)
        result = result.split(sub.from).join(sub.to);
    // A `"both"` rule names a code line, present in both texts, and runs in
    // either layer. A scoped rule runs only in its named layer: `"prose"` owns
    // comments and `"structure"` owns a shape whose prose variant is an explicit
    // richer rule. Running either against the other layer would be a stale-rule
    // failure for a target that is legitimately absent. Every rule still fails
    // closed if its target moved within the layer it does apply to.
    const applies = (deviation: IDeviation): boolean =>
      (deviation.layer ?? "both") === "both" || deviation.layer === layer;
    for (const deviation of DEVIATIONS[contract] ?? [])
      if (applies(deviation)) result = rewrite(result, deviation);
    return result;
  }

  /** This product's actual contract text at one fidelity, read from source. */
  export function actual(contract: string, layer: Layer = "structure"): string {
    const entry = CONTRACTS[contract];
    if (entry === undefined)
      throw new Error(`contract parity: unknown contract ${contract}`);
    return normalize(
      fs.readFileSync(
        path.join(GraphPaths.graphPackageRoot, "src", entry.product),
        "utf8",
      ),
      layer,
    );
  }

  /** The checked-in canonical contract and the commit it came from. */
  export function canonical(): ICanonical {
    return JSON.parse(
      fs.readFileSync(GraphPaths.ttscCanonicalContract, "utf8"),
    ) as ICanonical;
  }
}
