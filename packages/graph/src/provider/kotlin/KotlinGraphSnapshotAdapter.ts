import { CompilerGraphSnapshotAdapter } from "../compiler/CompilerGraphSnapshotAdapter";
import { IKotlinGraphSnapshot } from "./IKotlinGraphSnapshot";
import { KOTLIN_GRAPH_FACTS } from "./KOTLIN_GRAPH_FACTS";
import { KOTLIN_GRAPH_PRODUCER } from "./KOTLIN_GRAPH_PRODUCER";
import { KOTLIN_GRAPH_PROVIDER } from "./KOTLIN_GRAPH_PROVIDER";

const KOTLIN_CONTRACT: CompilerGraphSnapshotAdapter.IContract = {
  label: "Kotlin graph",
  language: "kotlin",
  provider: KOTLIN_GRAPH_PROVIDER,
  producer: KOTLIN_GRAPH_PRODUCER,
  facts: KOTLIN_GRAPH_FACTS,
  diagnosticCode: "kotlinc",
  shardKeyPrefix: "kotlin",
  schemaVersion: IKotlinGraphSnapshot.SCHEMA_VERSION,
  protocolVersion: IKotlinGraphSnapshot.PROTOCOL_VERSION,
};

/** Kotlin specialization of the shared strict snapshot adapter. */
export class KotlinGraphSnapshotAdapter extends CompilerGraphSnapshotAdapter {
  public constructor(root: string) {
    super(root, KOTLIN_CONTRACT);
  }
}
