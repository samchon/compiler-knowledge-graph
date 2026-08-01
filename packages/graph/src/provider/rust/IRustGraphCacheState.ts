import type { GraphSnapshotProtocol } from "../GraphSnapshotProtocol";
import type { IRustGraphCheckpoint } from "./IRustGraphCheckpoint";
import type { IRustGraphShard } from "./IRustGraphShard";

export interface IRustGraphCacheState {
  version: 1;
  producerCommit: string;
  checkpoint: IRustGraphCheckpoint;
  rawShards: IRustGraphShard[];
  frames: GraphSnapshotProtocol.Frame[];
}
