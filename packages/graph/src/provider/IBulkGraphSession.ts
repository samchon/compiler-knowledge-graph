import {
  ISamchonGraphDiagnostic,
  ISamchonGraphEdge,
  ISamchonGraphNode,
} from "../structures";
import {
  GraphEdgeKind,
  GraphLanguage,
  GraphProviderAuthority,
} from "../typings";

/**
 * One compiler-owned whole-graph session.
 *
 * Unlike an editor LSP session, a bulk session publishes one complete language
 * slice at a time. A changed slice is therefore safe to swap only after its
 * entire response has been parsed and validated; an unchanged response reuses
 * the last snapshot and generation verbatim.
 */
export interface IBulkGraphSession {
  readonly kind: "bulk";

  /**
   * Every language this session publishes as one atomic slice. Never empty.
   *
   * A list rather than a single language because one compilation universe can
   * span several: a Clang provider that indexes a project's C and C++
   * translation units resolves edges that cross the boundary, and publishing
   * them as two independently produced slices would claim an atomicity that
   * never existed. A single-language provider is the one-element case of the
   * same contract, not a different one.
   */
  readonly languages: readonly GraphLanguage[];

  readonly root: string;
  readonly generation: number;
  readonly current: IBulkGraphSession.ISnapshot | undefined;

  refresh(options?: {
    signal?: AbortSignal;
  }): Promise<IBulkGraphSession.IRefresh>;
  close(): Promise<void>;
}

export namespace IBulkGraphSession {
  /**
   * A complete strict fact slice from one compiler snapshot.
   *
   * A producer builds one of these and hands it over; from that moment it is
   * evidence. Evidence a later caller can edit is not evidence: a validator that
   * kept its argument could otherwise append an unclaimed edge after the
   * generation was published, and nothing would revalidate it. So the two
   * publication owners in this package — `BatchGraphSession`, which every SCIP
   * and sidecar provider builds on, and `TtscGraphClient` — freeze the whole
   * tree before any contract gate or reader sees it, and publish `sources`
   * through a view that has no writer at all.
   *
   * The fields stay writable in the type because building one requires that;
   * writing through a published snapshot throws. A provider that publishes
   * without going through either owner owes its consumers the same guarantee.
   *
   * Hand one over as a plain object with own data properties. The publication
   * boundary copies what it was given into the envelope it publishes, so a
   * field reachable only through a prototype accessor is not carried, and the
   * contract gate rejects the result rather than publishing a partial slice.
   */
  export interface ISnapshot {
    /** Every language this slice replaces atomically. Never empty. */
    languages: GraphLanguage[];

    nodes: ISamchonGraphNode[];
    edges: ISamchonGraphEdge[];

    /**
     * What the compiler said about the same generation that produced the facts.
     *
     * Empty means the producer reported none — not that none were collected.
     * Only {@link IProvenance.capabilities} distinguishes those, which is why
     * it is not enough to hand back the list and let a reader draw conclusions
     * from its length.
     */
    diagnostics: ISamchonGraphDiagnostic[];

    /**
     * The complete manifest of files this snapshot's facts were computed from.
     * Schema-v6 relative identities, including `../` siblings, are resolved to
     * absolute paths. Virtual `bundled:///` identities retain the producer's
     * canonical spelling.
     *
     * This used to be the files' text, read off the disk by the client after
     * the compiler had answered. That is what a bulk provider must not do: the
     * bytes a later read returns are not the bytes the checker resolved
     * against, and no amount of asking the server again closes the gap — a
     * write that lands and reverts in between is invisible to both questions.
     * The producer is the only party that can state this, so it states it, and
     * the graph never ships the text at all. A digest is the opposite of
     * inlining a body: it is what lets a reader prove byte-identity against
     * text it read itself, without this package ever carrying that text.
     */
    sources: ReadonlyMap<string, ISourceDigest>;

    /** Which program produced everything above, and what it can prove. */
    provenance: IProvenance;

    warnings: string[];
  }

  /**
   * The manifest entry for one file in the snapshot's program.
   *
   * Two digests, because "the bytes the checker read" and "the bytes on disk"
   * are not always the same string, and a reader needs to know which one it is
   * comparing against. A TypeScript source-preamble plugin injects text ahead
   * of a file before it is parsed, and then a reader that opens the file gets
   * something the checker never saw. Conflating the two would silently pick one
   * meaning and be wrong under exactly that plugin.
   */
  export interface ISourceDigest {
    /**
     * Hex-encoded SHA-256 of the text the checker resolved against — the ground
     * truth for the facts. Every node, edge, and span attributed to this file
     * was computed from these bytes.
     */
    checkerDigest: string;

    /**
     * Hex-encoded SHA-256 of the file's on-disk bytes at snapshot time, or `""`
     * when the producer could not read it or it has no on-disk identity.
     *
     * This is the one a reader that opens the file itself can reproduce. When
     * it equals {@link checkerDigest}, a matching read proves byte-identity
     * with the facts; when it does not, the checker saw augmented text and that
     * proof is simply unavailable for this file — a thing to report rather than
     * paper over. Read it only when {@link IProvenance.capabilities} claims
     * `diskDigests`; without that claim every entry is `""` because the
     * producer never hashed the disk, which is a different fact from a file it
     * could not read.
     */
    diskDigest: string;
  }

  /**
   * What a snapshot knows about its own origin, in terms every bulk provider
   * can answer — not just `ttscgraph`.
   *
   * A bulk provider's claim is that its nodes, edges, spans, and diagnostics
   * all came from one program. That claim is only worth anything if the
   * response carries the evidence for it; otherwise a consumer can do nothing
   * but re-read the disk afterwards and hope, which is the unsound
   * reconstruction this contract exists to make unnecessary.
   */
  export interface IProvenance {
    /**
     * Registry name of the provider that opened this session.
     *
     * Separate from {@link tool} because the two answer different questions.
     * `tool` is what the producer calls itself on the wire; `provider` is which
     * registered entry this graph selected, and it is the one a fallback
     * warning names and a publication guard checks. One registry entry can
     * drive more than one producer build, and one producer can back more than
     * one entry.
     */
    provider: string;

    /**
     * What these facts are grounded in, as the registry declared for the
     * provider — not as the payload's shape suggests.
     *
     * A consumer degrades against this. "The compiler resolved this" and "an
     * index built from a navigation skeleton reports this" are different
     * claims, and a reader that cannot tell them apart cannot know whether a
     * missing edge means absent or unproven.
     */
    authority: GraphProviderAuthority;

    /**
     * The edge families this provider is registered to prove.
     *
     * The coordinator holds a snapshot to exactly this list: publishing an
     * edge of an unclaimed family rejects the snapshot rather than being
     * quietly accepted. That is the difference between a provider that cannot
     * prove calls and one that proves there are none.
     */
    facts: GraphEdgeKind[];

    /** The version of the dump body contract the producer emitted. */
    schemaVersion: number;

    /** The producing tool's name, such as `ttscgraph`. */
    tool: string;

    /**
     * The producing tool's build version, or `""` when it carries none.
     *
     * Separate from {@link tool} because a consumer that parses a version must
     * not be handed a tool name, and separate from {@link compilerVersion}
     * because the tool and the checker it embeds do not share a version line.
     */
    toolVersion: string;

    /** The language version the producer's checker implements. */
    compilerVersion: string;

    /** The wire protocol version the producer spoke. */
    protocolVersion: number;

    /**
     * A fingerprint of the inputs that decide which files are in the program at
     * all — for TypeScript, the tsconfig chain and the resolved root set.
     *
     * It is a digest rather than the inputs themselves because the only
     * question a consumer asks of it is whether it is the same one as last
     * time, and because every language's answer to "what decides the file set"
     * has a different shape. A change to it can add or drop whole files, so
     * facts must never be carried across a snapshot whose fingerprint moved.
     */
    universe: string;

    /**
     * What this snapshot proves, as the producer names it.
     *
     * A consumer degrades against this rather than guessing from a field's
     * emptiness, because an empty list and an uncollected one look identical on
     * the wire. Stays `string[]` rather than a union: a producer that proves
     * something this client has not heard of must not be rejected for it.
     */
    capabilities: string[];
  }

  /** Result of polling a resident compiler session. */
  export interface IRefresh {
    changed: boolean;
    generation: number;

    /**
     * What the producer did, as the producer reported it.
     *
     * Never inferred. A generation counter cannot tell a reuse from a full
     * rebuild after the fact — both move it by one — so anything derived from
     * generations here would be a guess wearing a fact's clothes.
     */
    mode: Mode;

    snapshot: ISnapshot;
  }

  /**
   * What a bulk producer did to answer one refresh.
   *
   * - `initial`: the session's first snapshot.
   * - `reload`: the build universe moved, so the program was reloaded whole.
   * - `unchanged`: nothing moved; the previous snapshot still holds.
   * - `incremental`: edits applied onto the reused resident program.
   * - `rebuild`: edits applied, but the program could not be reused.
   *
   * There is no `error` member, though the `ttscgraph` wire has one. A failed
   * refresh rejects; it does not resolve to an {@link IRefresh} carrying a
   * snapshot that does not exist. The wire needs the extra literal because a
   * frame must describe itself even when it failed — a caller that cannot parse
   * the rest still learns why — but that is a transport state, and admitting it
   * here would oblige every reader of {@link IRefresh.snapshot} to first ask
   * whether the refresh happened at all.
   */
  export type Mode =
    | "initial"
    | "reload"
    | "unchanged"
    | "incremental"
    | "rebuild";
}
