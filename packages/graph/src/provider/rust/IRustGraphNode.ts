import type { IRustGraphEvidence } from "./IRustGraphEvidence";

export interface IRustGraphNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string | null;
  file: string;
  external: boolean;
  exported: boolean;
  signature: string | null;
  evidence: IRustGraphEvidence | null;
}
