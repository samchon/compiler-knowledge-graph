import { RepositoryContextRelationKind } from "../typings";
import { ISamchonRepositoryContextDump } from "./ISamchonRepositoryContextDump";

/**
 * A bounded repository-topology projection kept separate from code semantics.
 */
export interface ISamchonGraphTopology {
  /** Discriminator for repository topology. */
  type: "topology";

  /** Version of this result contract. */
  schemaVersion: 1;

  /** Matching workspace, project, package, root, target, task and entry nodes. */
  nodes: ISamchonRepositoryContextDump.INode[];

  /** Matching repository relations, including compatible file joins. */
  edges: ISamchonRepositoryContextDump.IEdge[];

  /** Provider, authority, tool, universe and content claims for this result. */
  provenance: ISamchonRepositoryContextDump.IProvenance[];

  /** Operation-scoped completeness for requested relation families. */
  coverage: ISamchonRepositoryContextDump.ICoverage[];

  /** Topology publication generation that supplied this result. */
  generation: ISamchonRepositoryContextDump.IGeneration;

  /** Whether this result may join its file identities to the code generation. */
  join: ISamchonGraphTopology.IJoin;

  /** Whether more matching nodes existed beyond the requested limit. */
  truncated: boolean;
}

export namespace ISamchonGraphTopology {
  /** Ask for one bounded repository-context view. */
  export interface IRequest {
    type: "topology";
    /** Optional exact node id, name or coordinate to orient around. */
    query?: string;
    /** Optional relation families to retain. Empty or absent means all. */
    relations?: RepositoryContextRelationKind[];
    /** Maximum returned nodes. @default 100; maximum 500 */
    limit?: number;

    /** Maximum file joins returned after generation fencing. @default 50; maximum 500 */
    joinLimit?: number;
  }

  /** Compatibility proof for file-level joins into the language graph. */
  export interface IJoin {
    /** Whether file joins were admitted for this result. */
    state: "compatible" | "unavailable";

    /** Repository-context input generation inspected by this result. */
    topologyInputGeneration: string;

    /** Stable code input generation fenced around the topology load. */
    codeInputGeneration?: string;

    /** Why joins are unavailable. */
    reason?: string;
  }
}
