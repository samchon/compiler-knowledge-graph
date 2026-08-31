import type { IRustGraphManifestEntry } from "./IRustGraphManifestEntry";
import type { IRustGraphPhases } from "./IRustGraphPhases";
import type { IRustGraphProducer } from "./IRustGraphProducer";
import type { IRustGraphShard } from "./IRustGraphShard";
import type { IRustGraphUniverse } from "./IRustGraphUniverse";

export interface IRustGraphSnapshot {
  protocolVersion: number;
  schemaVersion: number;
  producer: IRustGraphProducer;
  universe: IRustGraphUniverse;
  sequence: number;
  generation: string;
  baseGeneration: string | null;
  upserts: IRustGraphShard[];
  deletes: string[];
  manifest: IRustGraphManifestEntry[];
  phases: IRustGraphPhases;
}
