export interface IRustGraphDiagnostic {
  file: string;
  line: number;
  column: number | null;
  code: string;
  message: string;
  severity: string | null;
}
