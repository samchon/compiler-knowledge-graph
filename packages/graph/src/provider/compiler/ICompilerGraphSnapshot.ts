/**
 * Shared wire shape for compiler-owned, target-scoped graph generations.
 *
 * Language adapters validate any additional producer metadata before this
 * common shape is converted to the Graph Snapshot Protocol.
 */
export interface ICompilerGraphSnapshot {
  schemaVersion: number;
  projectRoot: string;
  producer: ICompilerGraphSnapshot.IProducer;
  targets: ICompilerGraphSnapshot.ITarget[];
}

export namespace ICompilerGraphSnapshot {
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
  }

  export interface ITarget {
    name: string;
    generation: string;
    universe: string;
    coverage: Record<string, string>;
    shards: IShard[];
  }

  export interface IShard {
    schemaVersion: number;
    language: string;
    source: string;
    checkerDigest: string;
    diskDigest: string;
    target: string;
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
}
