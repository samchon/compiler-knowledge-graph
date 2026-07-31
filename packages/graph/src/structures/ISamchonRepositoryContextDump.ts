import {
  RepositoryContextAuthority,
  RepositoryContextCoverageState,
  RepositoryContextNodeKind,
  RepositoryContextRelationKind,
} from "../typings";

/**
 * A repository-topology snapshot kept beside, never inside, the language graph.
 */
export interface ISamchonRepositoryContextDump {
  /** Absolute repository root whose owning tools were queried. */
  project: string;

  /** Version of this normalized repository-context body. */
  schemaVersion: 1;

  /** Complete source/configuration generation fenced around this snapshot. */
  inputGeneration: string;

  /** Monotonic resident publication identity. */
  generation: ISamchonRepositoryContextDump.IGeneration;

  /** One claim per contributing repository-context provider. */
  provenance: ISamchonRepositoryContextDump.IProvenance[];

  /** Exhaustive family coverage for every published provider target. */
  coverage: ISamchonRepositoryContextDump.ICoverage[];

  /** Every normalized workspace, project, target, root, task and entrypoint. */
  nodes: ISamchonRepositoryContextDump.INode[];

  /** Every normalized repository-topology relation and file join. */
  edges: ISamchonRepositoryContextDump.IEdge[];

  /** Normalized code-file identities that `joins-file` edges may target. */
  files: string[];

  /** Exact declared/model inputs consumed by this snapshot. */
  sources: ISamchonRepositoryContextDump.ISource[];

  /** Non-fatal unavailable-model or partial-coverage explanations. */
  warnings: string[];
}

export namespace ISamchonRepositoryContextDump {
  export interface IGeneration {
    sequence: number;
    token: string;
    shards: IShard[];
    contentDigest: string;
  }

  export interface IShard {
    key: string;
    digest: string;
  }

  export interface IProvenance {
    provider: string;
    ecosystem: string;
    authority: RepositoryContextAuthority;
    tool: string;
    toolVersion: string;
    schemaVersion: number;
    protocolVersion: number;
    universe: string;
    manifest: string;
    content: string;
    capabilities: string[];
  }

  export interface ICoverage {
    provider: string;
    ecosystem: string;
    target: string;
    family: RepositoryContextRelationKind;
    state: RepositoryContextCoverageState;
  }

  export interface INode {
    id: string;
    kind: RepositoryContextNodeKind;
    name: string;
    ecosystem: string;
    coordinate: string;
    configuration: string;
    external: boolean;
    /** Exact normalized source root whose current code files may be joined. */
    root?: string;
    /** Exact normalized code file this node may join. */
    file?: string;
    evidence?: IEvidence;
  }

  export interface IEdge {
    kind: RepositoryContextRelationKind;
    from: string;
    to: string;
    evidence?: IEvidence;
  }

  export interface IEvidence {
    file: string;
    startLine?: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
  }

  export interface ISource {
    file: string;
    digest: string;
  }
}
