/**
 * The aggregate artifact `scip-java index --kotlin-graph-output` writes.
 *
 * The producer lives in another repository and ships as a released launcher,
 * so this file states what this adapter pins rather than importing a shared
 * type. Every field is restated because the pin is the contract: a producer
 * that adds a field is compatible, one that changes what a field means is not,
 * and only the version numbers below can say which happened.
 */
export interface IKotlinGraphSnapshot {
  /** The artifact schema, equal to {@link IKotlinGraphSnapshot.SCHEMA_VERSION}. */
  schemaVersion: number;

  /** Absolute directory the producer indexed. */
  projectRoot: string;

  producer: IKotlinGraphSnapshot.IProducer;

  /**
   * One entry per committed build target, sorted by name.
   *
   * A multi-module Gradle build commits each Kotlin/JVM target separately, and
   * they are separate universes: two targets can compile the same source
   * against different classpaths and neither reading is wrong.
   */
  targets: IKotlinGraphSnapshot.ITarget[];
}

export namespace IKotlinGraphSnapshot {
  export interface IProducer {
    /** Equal to the pinned K2 producer identity; any other build is declined. */
    name: string;

    /** The launcher release that aggregated the generation. */
    version: string;

    /** Equal to {@link IKotlinGraphSnapshot.PROTOCOL_VERSION}. */
    protocolVersion: number;

    capabilities: ICapabilities;
  }

  /**
   * What the producer states it can do, as booleans rather than a name list.
   *
   * A missing key is a producer this adapter has not been taught to read, so
   * every one is required and no default is assumed.
   */
  export interface ICapabilities {
    atomicGenerations: boolean;
    incremental: boolean;
    diagnostics: boolean;
  }

  export interface ITarget {
    /** Build-target coordinate: a Gradle project, JVM target and compilation. */
    name: string;

    /** SHA-256 the producer committed this target's generation under. */
    generation: string;

    /** SHA-256 of the build universe the target compiled against. */
    universe: string;

    /** One state per relationship family; every family is present. */
    coverage: Record<string, string>;

    shards: IShard[];
  }

  /** One compilation unit's facts, as the kotlinc plugin wrote them. */
  export interface IShard {
    schemaVersion: number;
    language: string;
    /** Project-relative source path. */
    source: string;
    /** SHA-256 of the bytes kotlinc compiled. */
    checkerDigest: string;
    /** SHA-256 of the same file on disk. */
    diskDigest: string;
    /** The target this unit was compiled for; equal to its owner's name. */
    target: string;
    /** The Kotlin compiler's `kotlin.version`. */
    compilerVersion: string;
    nodes: INode[];
    edges: IEdge[];
    unresolved: IUnresolved[];
    diagnostics: IDiagnostic[];
  }

  export interface IEvidence {
    file: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }

  export interface INode {
    /** Canonical Kotlin semantic symbol; the endpoint every edge names. */
    symbol: string;
    kind: string;
    name: string;
    /** Owner-qualified name, or `""` for a top-level declaration. */
    qualifiedName: string;
    file: string;
    exported: boolean;
    modifiers: string[];
    /** Structural signature, or `""` when the declaration has none. */
    signature: string;
    /** FIR/compiler origin of handwritten, generated, or synthetic declarations. */
    origin: string;
    evidence: IEvidence;
  }

  export interface IEdge {
    from: string;
    to: string;
    kind: string;
    /** `read`/`write` for an access, otherwise null. */
    access: string | null;
    /** How the producer settled the endpoint, or null. */
    provenance: string | null;
    /** The endpoint's kind when it is outside this compilation unit. */
    targetKind: string | null;
    targetName: string | null;
    targetQualifiedName: string | null;
    evidence: IEvidence;
  }

  export interface IUnresolved {
    family: string;
    reason: string;
    evidence: IEvidence;
    candidates: string[];
  }

  export interface IDiagnostic {
    severity: string;
    message: string;
    evidence: IEvidence;
  }

  /**
   * The artifact schema this adapter reads.
   *
   * Equal to `KotlinGraphShard.SCHEMA_VERSION` and the aggregator's own literal
   * in scip-java. Equality is exact: upstream moves this number when a field
   * is added, removed or given a new meaning, and validating field types
   * cannot detect a semantic change whose JSON shape stayed the same.
   */
  export const SCHEMA_VERSION = 1;

  /** The producer protocol version this adapter speaks. */
  export const PROTOCOL_VERSION = 1;
}
