import type { IRustGraphCheckpointSource } from "./IRustGraphCheckpointSource";
import type { IRustGraphManifestEntry } from "./IRustGraphManifestEntry";
import type { IRustGraphProducer } from "./IRustGraphProducer";
import type { IRustGraphShard } from "./IRustGraphShard";

export interface IRustGraphCheckpoint {
  protocolVersion: number;
  schemaVersion: number;
  producer: IRustGraphProducer;
  universe: string;
  generation: string;
  manifest: IRustGraphManifestEntry[];
  sources: IRustGraphCheckpointSource[];
  shards: IRustGraphShard[];
}
