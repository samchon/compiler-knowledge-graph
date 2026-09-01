/** Emit one opt-in timing row for repository-orientation experiments. */
export function topologyPhaseTrace(
  provider: string,
  phase: "tool-startup" | "model-query" | "normalization" | "join",
  started: number,
  details: Record<string, unknown> = {},
): void {
  if (process.env.SAMCHON_GRAPH_TOPOLOGY_TRACE !== "1") return;
  process.stderr.write(
    `@samchon/graph: topology-phase=${JSON.stringify({
      schemaVersion: 1,
      provider,
      phase,
      durationMs: Math.max(0, performance.now() - started),
      ...details,
    })}\n`,
  );
}
