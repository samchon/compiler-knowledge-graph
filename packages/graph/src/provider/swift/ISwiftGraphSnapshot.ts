/** Aggregate artifact committed by the SwiftPM/IndexStoreDB producer. */
export interface ISwiftGraphSnapshot {
  schemaVersion: number;
  projectRoot: string;
  producer: ISwiftGraphSnapshot.IProducer;
  targets: ISwiftGraphSnapshot.ITarget[];
}

export namespace ISwiftGraphSnapshot {
  export interface IProducer {
    name: string;
    version: string;
    protocolVersion: number;
    capabilities: ICapabilities;
  }

  export interface ICapabilities {
    atomicGenerations: boolean;
    incremental: boolean;
    diagnostics: boolean;
    explicitOutputUnits: boolean;
    indexStoreDB: boolean;
    sourceEnrichment: boolean;
    swiftpm: boolean;
    sourceKitResident: boolean;
  }

  /** One Swift module, build triple and configuration universe. */
  export interface ITarget {
    name: string;
    generation: string;
    universe: string;
    moduleName: string;
    targetTriple: string;
    sdk: string;
    configuration: string;
    swiftLanguageVersion: string;
    compilerFlagsDigest: string;
    moduleDependenciesDigest: string;
    packageResolutionDigest: string;
    pluginsDigest: string;
    generatedSourcesDigest: string;
    indexStoreDBCommit: string;
    outputUnits: IOutputUnit[];
    coverage: Record<string, string>;
    shards: IShard[];
  }

  /** Exact compiler output admitted to the explicit IndexStoreDB view. */
  export interface IOutputUnit {
    path: string;
    digest: string;
  }

  /** One source queried from the frozen store and enriched exactly once. */
  export interface IShard {
    schemaVersion: number;
    language: string;
    source: string;
    checkerDigest: string;
    diskDigest: string;
    target: string;
    compilerVersion: string;
    moduleName: string;
    targetTriple: string;
    sourceEnrichmentPasses: number;
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
    /** Swift/Clang USR from the compiler index, including local USRs. */
    symbol: string;
    kind: string;
    name: string;
    qualifiedName: string;
    file: string;
    exported: boolean;
    modifiers: string[];
    signature: string;
    origin: string;
    evidence: IEvidence;
  }

  export interface IEdge {
    from: string;
    to: string;
    kind: string;
    access: string | null;
    provenance: string | null;
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

  export const SCHEMA_VERSION = 1;
  export const PROTOCOL_VERSION = 1;
  export const INDEX_STORE_DB_COMMIT =
    "f4d7f08f6a078050d86aed10a06bf1fc871a8ded";
}
