import {
  RepositoryContextAuthority,
  RepositoryContextRelationKind,
} from "../typings";
import { IRepositoryContextSession } from "./IRepositoryContextSession";
import { RepositoryContextProtocol } from "./RepositoryContextProtocol";

/** One sibling repository-topology provider. */
export interface IRepositoryContextProvider {
  readonly name: string;
  readonly ecosystem: string;
  readonly authority: Exclude<RepositoryContextAuthority, "inferred">;
  readonly families: readonly RepositoryContextRelationKind[];
  readonly buildInputs: readonly string[];

  /** Whether this repository declares the ecosystem. */
  detect(root: string): boolean;

  /** Open a resident topology session without changing the project. */
  open(props: IRepositoryContextProvider.IOpenProps): IRepositoryContextSession;
}

export namespace IRepositoryContextProvider {
  export interface IOpenProps {
    root: string;
    env: NodeJS.ProcessEnv;
  }

  export interface ICollection {
    producerSchemaVersion: number;
    tool: string;
    toolVersion: string;
    capabilities: string[];
    universe: string;
    target: string;
    shards: RepositoryContextProtocol.IShard[];
    warnings: string[];
  }

  export type Collector = (
    props: IOpenProps & { signal?: AbortSignal },
  ) => Promise<ICollection> | ICollection;
}
