import { GraphLanguage } from "../../typings";
import { BatchGraphSession } from "../BatchGraphSession";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { IGraphProvider } from "../IGraphProvider";
import { CompilerGraphSession } from "../compiler/CompilerGraphSession";
import { ScalaGraphSnapshotAdapter } from "./ScalaGraphSnapshotAdapter";

/** Resident BSP session backed by the paired Scala compiler plugins. */
export class ScalaGraphSession implements IBulkGraphSession {
  public readonly kind = "bulk" as const;
  public readonly ownsProviderTopology = true;
  public readonly languages: readonly GraphLanguage[];
  public readonly root: string;

  private readonly session: CompilerGraphSession;

  public constructor(options: ScalaGraphSession.IOptions) {
    this.session = new CompilerGraphSession({
      ...options,
      adapter: new ScalaGraphSnapshotAdapter(options.root),
      serverCommand: "graph-server",
      label: "Scala graph",
      artifactName: "scala-graph.json",
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

export namespace ScalaGraphSession {
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
