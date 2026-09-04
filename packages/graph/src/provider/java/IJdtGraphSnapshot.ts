/** Raw java.graph.snapshot response emitted by the pinned JDT workspace producer. */
export interface IJdtGraphSnapshot {
  schemaVersion: number;
  protocolVersion: number;
  producer: IJdtGraphSnapshot.IProducer;
  capabilities: IJdtGraphSnapshot.ICapabilities;
  universe: string;
  generation: string;
  complete: boolean;
  mode: IJdtGraphSnapshot.Mode;
  sequence: number;
  projects: IJdtGraphSnapshot.IProject[];
  sources: IJdtGraphSnapshot.ISource[];
  nodes: IJdtGraphSnapshot.INode[];
  edges: IJdtGraphSnapshot.IEdge[];
  diagnostics: IJdtGraphSnapshot.IDiagnostic[];
  coverage: Record<string, string>;
  unresolved: unknown[];
}

export namespace IJdtGraphSnapshot {
  export interface IProducer {
    name: string;
    version: string;
    compilerVersion: string;
  }

  export interface ICapabilities {
    atomicGenerations: boolean;
    resident: boolean;
    sourceDigests: boolean;
    diskDigests: boolean;
    unsavedBuffers: boolean;
    diagnostics: boolean;
    facts: string[];
  }

  export interface IProject {
    name: string;
    location: string;
    output: string;
    compilerVersion: string;
    options: Record<string, string>;
    classpath: unknown[];
  }

  export interface ISource {
    project: string;
    uri: string;
    checkerDigest: string;
    checkerEncoding: string;
    diskDigest: string;
  }

  export interface INode {
    project: string;
    symbol: string;
    nativeKey: string;
    stability: "persistent" | "structural" | "generation";
    uri: string;
    name: string;
    qualifiedName: string;
    kind: string;
    signature: string;
    declarationKind: string;
    exported: boolean;
    modifiers: string[];
    evidence: IEvidence;
  }

  export interface IEdge {
    from: string;
    to: string;
    kind: string;
    evidence: IEvidence;
  }

  export interface IDiagnostic {
    uri: string;
    severity: "error" | "warning" | "information";
    code: string;
    message: string;
    evidence: IEvidence;
  }

  export interface IEvidence {
    uri: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }

  export type Mode = "initial" | "reload" | "unchanged" | "incremental" | "error";

  export const SCHEMA_VERSION = 1;
  export const PROTOCOL_VERSION = 1;
  export const PRODUCER = "eclipse-jdtls-graph-snapshot";
  export const CHECKER_ENCODING = "jdt-utf16-code-units-v1";
}
