import { RepositoryContextProtocol } from "./RepositoryContextProtocol";

/** One resident repository-context provider session. */
export interface IRepositoryContextSession {
  readonly kind: "repository-context";
  readonly provider: string;
  readonly ecosystem: string;
  readonly root: string;
  readonly generation: number;
  readonly current: RepositoryContextProtocol.ISnapshot | undefined;

  refresh(options?: {
    signal?: AbortSignal;
  }): Promise<IRepositoryContextSession.IRefresh>;
  close(): Promise<void>;
}

export namespace IRepositoryContextSession {
  export interface IRefresh {
    changed: boolean;
    generation: number;
    mode: "initial" | "unchanged" | "incremental" | "reload";
    snapshot: RepositoryContextProtocol.ISnapshot;
    warnings: string[];
  }
}
