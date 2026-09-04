/** Aggregate artifact committed by the BSP-driven Scala graph producer. */
export interface IScalaGraphSnapshot {
  schemaVersion: number;
  projectRoot: string;
  producer: IScalaGraphSnapshot.IProducer;
  targets: IScalaGraphSnapshot.ITarget[];
}

export namespace IScalaGraphSnapshot {
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
    bsp: boolean;
    semanticdb: boolean;
    typedPlugins: boolean;
    zinc: boolean;
  }

  /** One BSP build target and its independently invalidated Scala universe. */
  export interface ITarget {
    name: string;
    generation: string;
    universe: string;
    bspUri: string;
    scalaVersion: string;
    scalaBinaryVersion: string;
    platform: string;
    sourceEncoding: string;
    scalacOptionsDigest: string;
    classpathDigest: string;
    sourceRootsDigest: string;
    semanticdbOptionsDigest: string;
    compilerPluginsDigest: string;
    zincAnalysisDigest: string;
    generatedSourcesDigest: string;
    coverage: Record<string, string>;
    shards: IShard[];
  }

  /** One source emitted by the typed plugin and cross-checked with SemanticDB. */
  export interface IShard {
    schemaVersion: number;
    language: string;
    source: string;
    checkerDigest: string;
    diskDigest: string;
    target: string;
    compilerVersion: string;
    compilerPlugin: "scala2" | "scala3";
    compilerPluginVersion: string;
    semanticdbSchema: number;
    semanticdbUri: string;
    semanticdbMd5: string;
    semanticdbBuildTarget: string;
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
    /** Stable structural identity, never a SemanticDB overload ordinal. */
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
  export const SEMANTICDB_SCHEMA = 4;
}
