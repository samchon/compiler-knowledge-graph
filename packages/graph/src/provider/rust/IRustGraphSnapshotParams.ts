import type { IRustGraphCheckpoint } from "./IRustGraphCheckpoint";

export interface IRustGraphSnapshotParams {
  knownGeneration?: string;
  checkpoint?: IRustGraphCheckpoint;
}
