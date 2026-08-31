/**
 * The aggregate artifact `scip-java index --graph-output` writes.
 *
 * The producer lives in another repository and ships as a released launcher,
 * so this file states what this adapter pins rather than importing a shared
 * type. Every field is restated because the pin is the contract: a producer
 * that adds a field is compatible, one that changes what a field means is not,
 * and only the version numbers below can say which happened.
 */
export interface IJavaGraphSnapshot {
  /** The artifact schema, equal to {@link IJavaGraphSnapshot.SCHEMA_VERSION}. */
  schemaVersion: number;

  /** Absolute directory the producer indexed. */
  projectRoot: string;

  producer: IJavaGraphSnapshot.IProducer;

  /**
   * One entry per committed build target, sorted by name.
   *
   * A multi-module Gradle or Maven build commits each target separately, and
   * they are separate universes: two targets can compile the same source
   * against different classpaths and neither reading is wrong.
   */
  targets: IJavaGraphSnapshot.ITarget[];
}

export namespace IJavaGraphSnapshot {
  export interface IProducer {
    /** Equal to {@link JAVA_GRAPH_PRODUCER}; any other build is declined. */
    name: string;

    /** The launcher release that aggregated the generation. */
    version: string;

    /** Equal to {@link IJavaGraphSnapshot.PROTOCOL_VERSION}. */
    protocolVersion: number;

    capabilities: ICapabilities;
  }

  /**
   * What the producer states it can do, as booleans rather than a name list.
   *
   * A missing key is a producer this adapter has not been taught to read, so
   * every one is required and no default is assumed. `diagnostics` is false in
   * the released producer: javac's messages are not carried by the graph
   * artifact, and an empty diagnostic list must not be read as a clean build.
   */
  export interface ICapabilities {
    atomicGenerations: boolean;
    incremental: boolean;
    diagnostics: boolean;
  }

  export interface ITarget {
    /** Build-target coordinate: a Gradle source set or a Maven module. */
    name: string;

    /** SHA-256 the producer committed this target's generation under. */
    generation: string;

    /** SHA-256 of the build universe the target compiled against. */
    universe: string;

    /** One state per relationship family; every family is present. */
    coverage: Record<string, string>;

    shards: IShard[];
  }

  /** One compilation unit's facts, as the javac plugin wrote them. */
  export interface IShard {
    schemaVersion: number;
    language: string;
    /** Project-relative source path. */
    source: string;
    /** SHA-256 of the bytes javac compiled. */
    checkerDigest: string;
    /** SHA-256 of the same file on disk, or `""` when it has no disk identity. */
    diskDigest: string;
    /** The target this unit was compiled for; equal to its owner's name. */
    target: string;
    /** The `java.version` of the JDK that ran the plugin. */
    compilerVersion: string;
    nodes: INode[];
    edges: IEdge[];
    unresolved: IUnresolved[];
  }

  export interface IEvidence {
    file: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }

  export interface INode {
    /** Canonical Java semantic symbol; the endpoint every edge names. */
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

  /**
   * The artifact schema this adapter reads.
   *
   * Equal to `JavaGraphShard.SCHEMA_VERSION` and the aggregator's own literal
   * in scip-java. Equality is exact: upstream moves this number when a field
   * is added, removed or given a new meaning, and validating field types
   * cannot detect a semantic change whose JSON shape stayed the same.
   */
  export const SCHEMA_VERSION = 1;

  /** The producer protocol version this adapter speaks. */
  export const PROTOCOL_VERSION = 1;
}
