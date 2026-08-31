import type { IRustGraphEvidence } from "./IRustGraphEvidence";

export interface IRustGraphEdge {
  from: string;
  to: string;
  kind: string;
  evidence: IRustGraphEvidence | null;
}
