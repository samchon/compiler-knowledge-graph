import { GraphLanguage } from "../../typings";
import { BatchGraphSession } from "../BatchGraphSession";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { IGraphProvider } from "../IGraphProvider";
import { CompilerGraphSession } from "../compiler/CompilerGraphSession";
import { SwiftGraphSnapshotAdapter } from "./SwiftGraphSnapshotAdapter";

/** Resident sidecar process over repeated native SwiftPM index generations. */
export class SwiftGraphSession implements IBulkGraphSession {
  public readonly kind = "bulk" as const;
  public readonly ownsProviderTopology = true;
  public readonly languages: readonly GraphLanguage[];
  public readonly root: string;

  private readonly session: CompilerGraphSession;

  public constructor(options: SwiftGraphSession.IOptions) {
    this.session = new CompilerGraphSession({
      ...options,
      adapter: new SwiftGraphSnapshotAdapter(options.root),
      serverCommand: "graph-server",
      label: "Swift graph",
      artifactName: "swift-graph.json",
    });
    this.languages = this.session.languages;
    this.root = this.session.root;
  }

  public get generation(): number {
    return this.session.generation;
  }

  public get current(): IBulkGraphSession.ISnapshot | undefined {
    return this.session.current;
  }

  public refresh(
    options: { signal?: AbortSignal } = {},
  ): Promise<IBulkGraphSession.IRefresh> {
    return this.session.refresh(options);
  }

  public close(): Promise<void> {
    return this.session.close();
  }
}

export namespace SwiftGraphSession {
  export interface IOptions {
    root: string;
    languages: readonly GraphLanguage[];
    provider: string;
    command: IGraphProvider.ICommand;
    inputs: () => string[];
    configuration: NonNullable<BatchGraphSession.IOptions["configuration"]>;
    validate: (snapshot: IBulkGraphSession.ISnapshot) => void;
    maxArtifactBytes?: number;
  }
}
