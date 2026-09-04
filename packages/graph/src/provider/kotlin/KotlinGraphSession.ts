import { CompilerGraphSession } from "../compiler/CompilerGraphSession";
import { KotlinGraphSnapshotAdapter } from "./KotlinGraphSnapshotAdapter";

/** Kotlin specialization of the shared resident compiler session. */
export class KotlinGraphSession extends CompilerGraphSession {
  public constructor(options: KotlinGraphSession.IOptions) {
    super({
      ...options,
      adapter: new KotlinGraphSnapshotAdapter(options.root),
      serverCommand: "kotlin-graph-server",
      label: "Kotlin graph",
      artifactName: "graph.json",
    });
  }
}

export namespace KotlinGraphSession {
  export type IOptions = Omit<
    CompilerGraphSession.IOptions,
    "adapter" | "serverCommand" | "label" | "artifactName"
  >;
}
