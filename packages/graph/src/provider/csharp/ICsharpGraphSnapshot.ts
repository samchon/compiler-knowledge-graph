import { GraphSnapshotProtocol } from "../GraphSnapshotProtocol";
import { IBulkGraphSession } from "../IBulkGraphSession";

/** Envelope returned by the resident Roslyn service. */
export interface ICsharpGraphSnapshot {
  protocolVersion: 1;
  mode: IBulkGraphSession.Mode;
  sequence: number;
  generation: string;
  universe: string;
  frames: GraphSnapshotProtocol.Frame[];
}
