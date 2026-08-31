/**
 * One response frame of the `ttscgraph serve` protocol, as this client pins it.
 *
 * Mirrored by hand from `serveResponse` and `serveGraphSnapshot` in ttsc's
 * `packages/ttsc/cmd/ttscgraph`. There is no generator between the Go structs
 * and this file, and there cannot be one this repository owns: the producer
 * lives in another repository and ships as a prebuilt binary whose version the
 * target project — not this package — chooses. That is why the envelope and
 * native transaction have independent version pins, and why every field is
 * validated on arrival instead of cast.
 *
 * This is the envelope only. The native `snapshot` stays `unknown` here on
 * purpose: {@link TtscGraphSnapshotStore} validates its transaction and shard
 * fields before adapting changed shards into the product protocol. Restating
 * that wire shape as a trusted TypeScript type would add a duplicate contract
 * that can drift without protecting the runtime boundary.
 */
export type ITtscGraphSnapshot =
  | ITtscGraphSnapshot.IFailure
  | ITtscGraphSnapshot.IResult;

export namespace ITtscGraphSnapshot {
  /** What every frame owes its caller, whatever became of the request. */
  export interface IBase {
    /** Echoes the request's id, so a response finds its caller. */
    id: number;

    /**
     * The protocol version the producer speaks.
     *
     * It rides every frame rather than a handshake, error frames included. The
     * binary and this package version independently — {@link
     * resolveTtscGraphCommand} runs whichever `ttscgraph` the target project
     * installed, or whatever `TTSC_GRAPH_BINARY` points at — so a mismatched
     * pair is reachable, and before this field existed nothing detected it: the
     * first symptom was a misparsed dump or a silently absent value.
     */
    protocolVersion: number;

    /** What this producer claims it can prove about the snapshots it publishes. */
    capabilities: string[];
  }

  /**
   * A request that produced no snapshot.
   *
   * `mode` and `error` are correlated here rather than left as two independent
   * optional fields, so that a reader who has ruled out failure has also ruled
   * out `"error"` as a mode — and cannot be asked to map a transport state onto
   * a computation one. {@link parseTtscGraphSnapshot} refuses any frame where
   * the two disagree, which is what earns this type.
   */
  export interface IFailure extends IBase {
    mode: "error";
    error: string;
    changed: false;
    dump?: undefined;
    snapshot?: undefined;
  }

  /** A request the producer answered, whether or not the graph moved. */
  export interface IResult extends IBase {
    /**
     * What the producer did to answer this request.
     *
     * Required, and never absent. The producer is the only party that can know
     * it: a generation counter moves by one for a reuse and for a full rebuild
     * alike, so nothing downstream can recover the distinction after the fact.
     */
    mode: ComputationMode;

    error?: undefined;

    /** Whether the graph moved since the last snapshot. */
    changed: boolean;

    /** The native shard transaction, present exactly when `changed` is true. */
    snapshot?: unknown;

    /** Legacy full dumps are refused by this incremental client. */
    dump?: undefined;
  }
  /**
   * The serve protocol version this client speaks.
   *
   * Equal to `serveProtocolVersion` in
   * `packages/ttsc/cmd/ttscgraph/serve.go`. A producer below it is rejected
   * with a precise error rather than parsed: a v0 frame carried no manifest, no
   * universe, and no diagnostics, so it cannot answer the questions this client
   * now asks of it, and reading one would mean guessing at exactly the evidence
   * the pin exists to establish.
   *
   * Equality is exact. Upstream moves this number when a field is added,
   * removed, or given a new meaning; validating field types cannot detect a
   * semantic change whose JSON shape stayed the same. The target project picks
   * the binary independently of this package, so rejecting the mismatched pair
   * is the only fail-closed reading.
   */
  export const PROTOCOL_VERSION = 1;

  /** Native graph-shard transaction requested from compatible producers. */
  export const GRAPH_SNAPSHOT_VERSION = 1;

  /**
   * The version of the compiler fact schema carried by native shards.
   *
   * Independent of {@link PROTOCOL_VERSION}: one versions the NDJSON envelope,
   * the other the graph document inside a changed frame. Keep this equal to
   * `DumpSchemaVersion` in ttsc's `internal/graph/provenance.go` at canonical
   * release `v0.20.1` (`5a63e0ba1f495eda5da748de4c8970a00479136b`).
   * Schema v6 gives every identity-bearing path one portable coordinate
   * relative to the producer-local absolute project locator, including `../`
   * siblings, and carries compiler-bounded declaration signatures.
   */
  export const DUMP_SCHEMA_VERSION = 6;

  /**
   * Body schemas whose manifest proves every fact the adapter receives.
   *
   * Schema 3 can emit facts absent from its source manifest. Schema 5 completes
   * that manifest but still publishes machine-local absolute paths outside the
   * project. Schema 6 is the first complete, portable, injective contract and
   * the only body this current adapter accepts.
   */
  export const SUPPORTED_DUMP_SCHEMA_VERSIONS: readonly number[] = [6];

  /**
   * What the compiler did, as opposed to what the transport did.
   *
   * - `initial`: the session's first snapshot.
   * - `reload`: the build universe moved, so the program was reloaded whole.
   * - `unchanged`: nothing moved; no dump rides it and the last one still holds.
   * - `incremental`: edits applied onto the reused resident program.
   * - `rebuild`: edits applied, but the program could not be reused.
   *
   * These are exactly {@link IBulkGraphSession.Mode}, and the provider assigns
   * one to the other without a mapping table. That is not an accident to be
   * tidied away behind a converter: the two vocabularies are separately owned —
   * one by a Go constant block, one by this product's provider contract — and
   * writing the identity as a plain assignment makes the type checker the thing
   * that notices if they ever stop agreeing. A converter with a `default` case
   * would silently absorb the same drift.
   */
  export type ComputationMode =
    | "initial"
    | "reload"
    | "unchanged"
    | "incremental"
    | "rebuild";

  /**
   * The computation modes, plus the transport's `error`.
   *
   * `error` is not a computation mode. It exists so that `mode` is never absent
   * — the producer's `omitempty` used to drop it on exactly the path a consumer
   * most needed it — and a frame carrying it produced no snapshot at all.
   */
  export type Mode = ComputationMode | "error";

  /** Every {@link Mode} the wire may carry, for validating one. */
  export const MODES: readonly Mode[] = [
    "initial",
    "reload",
    "unchanged",
    "incremental",
    "rebuild",
    "error",
  ];

  /**
   * The capability names this client reads.
   *
   * A producer may name others, and an unknown name is ignored rather than
   * rejected — "proves more than you have heard of" is precisely the case a
   * consumer should shrug at. What a consumer must not do is infer a capability
   * from a field's emptiness: an empty diagnostics list and an uncollected one
   * are the same bytes on the wire, and only this list tells them apart.
   */
  export const CAPABILITY_UNIVERSE = "universe";
  export const CAPABILITY_SOURCE_DIGESTS = "sourceDigests";
  export const CAPABILITY_DISK_DIGESTS = "diskDigests";
  export const CAPABILITY_DIAGNOSTICS = "diagnostics";
}
