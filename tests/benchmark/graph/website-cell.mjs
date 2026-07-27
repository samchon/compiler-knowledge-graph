/**
 * The identity of a published agent cell.
 *
 * `tests/benchmark/results/graph.json` accumulates across runs: a run that
 * re-measures a cell must replace it, not append a second one. The key is what
 * decides that, so it must name exactly the axes the website renders — harness,
 * tool, repo, prompt, model, daemon — and nothing else.
 *
 * Metadata that rides along with a measurement (the fixture branch it was
 * cloned from, the reasoning effort the model ran at, the tool's setup time) is
 * not an axis. Keying on it silently turns a re-measurement into a duplicate
 * cell: the grid then shows the same model twice, once per stale label. Two
 * runs of the same cell are the same cell, whatever the runner happened to
 * record about them.
 */
export function websiteCellKey(cell) {
  return JSON.stringify([
    cell.harness,
    cell.tool ?? "samchon-graph",
    cell.repo,
    cell.promptId ?? "",
    cell.promptFamily ?? "project-specific",
    cell.model,
    cell.daemon === true ? "daemon" : "single",
  ]);
}

const PUBLISHED_SAMPLE_KEYS = [
  "ok",
  "tokens",
  "cached",
  "reasoning",
  "tokensWithReasoning",
  "turns",
  "tools",
  "reads",
  "grep",
  "shell",
  "web",
  "graph",
  "other",
  "sourceTouches",
  "shellSource",
  "cost",
  "durMs",
  "run",
  "attempts",
];

/** A completed paid sample, before publication strips runner-only fields. */
export function isSuccessfulMeasuredSample(sample) {
  return sample?.ok !== false && Number(sample?.tokens ?? 0) > 0;
}

/** Keep the stable website schema without hiding failures from the gate. */
export function sanitizeWebsiteSamples(samples) {
  const sanitize = (sample) => {
    const out = {};
    for (const key of PUBLISHED_SAMPLE_KEYS) {
      if (sample[key] !== undefined) out[key] = sample[key];
    }
    return out;
  };
  return {
    baseline: (samples?.baseline ?? []).map(sanitize),
    graph: (samples?.graph ?? []).map(sanitize),
  };
}

/**
 * Reject a cell before it can replace the website's trusted measurement.
 *
 * A graph-arm answer is a graph measurement only when every requested run
 * actually called the MCP and did not fall back to shell/source inspection.
 * Failed and zero-token runs are invalid on either arm; otherwise a one-turn
 * tool failure can masquerade as an exceptional token saving.
 */
export function invalidWebsiteCellReason(cell) {
  if (!cell || !cell.samples) return "missing benchmark samples";
  const expected = Number(cell.runs ?? 0);
  for (const arm of ["baseline", "graph"]) {
    const samples = cell.samples[arm] ?? [];
    if (samples.length === 0) continue;
    if (expected > 0 && samples.length !== expected) {
      return `${arm} arm has ${samples.length}/${expected} requested samples`;
    }
    const failed = samples.filter(
      (sample) => sample?.ok === false || Number(sample?.tokens ?? 0) <= 0,
    ).length;
    if (failed > 0) return `${arm} arm has ${failed} failed sample(s)`;
    if (arm === "graph") {
      const withoutMcp = samples.filter(
        (sample) => Number(sample?.graph ?? 0) <= 0,
      ).length;
      if (withoutMcp > 0) {
        return `graph arm has ${withoutMcp} sample(s) with no MCP call`;
      }
      const withShell = samples.filter(
        (sample) =>
          Number(sample?.shell ?? 0) > 0 ||
          Number(sample?.sourceTouches ?? 0) > 0 ||
          Number(sample?.web ?? 0) > 0,
      ).length;
      if (withShell > 0) {
        return `graph arm has ${withShell} shell/source/web-fallback sample(s)`;
      }
    }
  }
  if (
    (cell.samples.baseline?.length ?? 0) === 0 &&
    (cell.samples.graph?.length ?? 0) === 0
  ) {
    return "benchmark cell contains no samples";
  }
  return null;
}
