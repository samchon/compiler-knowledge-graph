import type { IRustGraphCoverage } from "./IRustGraphCoverage";
import type { IRustGraphDiagnostic } from "./IRustGraphDiagnostic";
import type { IRustGraphEdge } from "./IRustGraphEdge";
import type { IRustGraphEvidence } from "./IRustGraphEvidence";
import type { IRustGraphNode } from "./IRustGraphNode";

export interface IRustGraphShard {
  key: string;
  source: string;
  checkerDigest: string;
  interfaceFingerprint: string;
  digest: string;
  nodes: IRustGraphNode[];
  edges: IRustGraphEdge[];
  diagnostics: IRustGraphDiagnostic[];
  coverage: IRustGraphCoverage[];
  unresolved: IRustGraphShard.Unresolved[];
}

export declare namespace IRustGraphShard {
  export interface Unresolved {
    family: string;
    evidence: IRustGraphEvidence;
    reason: string;
    candidates: string[];
  }
}
