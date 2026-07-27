/**
 * Fold the content-minimal LSP request log into evidence a timeout can use.
 *
 * A cutoff marker freezes the server calls outstanding when the outer
 * diagnostic stopped. Later error ends belong to graceful process cleanup, not
 * to server progress before the deadline, so they are retained separately.
 */
export function summarizeLspRequestTrace(log) {
  const requests = new Map();
  const methods = new Map();
  let cutoffInFlight;
  let postCutoffEndCount = 0;
  let postCutoffErrorCount = 0;
  for (const line of log.split(/\r?\n/)) {
    if (
      line === "@samchon/graph: lsp-request phase=cutoff" &&
      cutoffInFlight === undefined
    ) {
      cutoffInFlight = new Map(requests);
      continue;
    }
    const match =
      /^@samchon\/graph: lsp-request id=(\d+) method=("(?:\\.|[^"\\])*") phase=(start|end)(?: status=(success|error) durationMs=([0-9.]+))?$/.exec(
        line,
      );
    if (match === null) continue;
    const id = Number(match[1]);
    const method = JSON.parse(match[2]);
    const phase = match[3];
    const aggregate = methods.get(method) ?? {
      started: 0,
      completed: 0,
      errors: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      postCutoffEnds: 0,
      postCutoffErrors: 0,
      postCutoffMaxDurationMs: 0,
    };
    methods.set(method, aggregate);
    if (phase === "start") {
      if (cutoffInFlight === undefined) aggregate.started += 1;
      requests.set(id, { id, method });
      continue;
    }
    const durationMs = Number(match[5]);
    if (cutoffInFlight !== undefined) {
      postCutoffEndCount += 1;
      postCutoffErrorCount += match[4] === "error" ? 1 : 0;
      aggregate.postCutoffEnds += 1;
      aggregate.postCutoffErrors += match[4] === "error" ? 1 : 0;
      aggregate.postCutoffMaxDurationMs = Math.max(
        aggregate.postCutoffMaxDurationMs,
        durationMs,
      );
    } else {
      aggregate.completed += 1;
      aggregate.errors += match[4] === "error" ? 1 : 0;
      aggregate.totalDurationMs += durationMs;
      aggregate.maxDurationMs = Math.max(
        aggregate.maxDurationMs,
        durationMs,
      );
    }
    requests.delete(id);
  }
  const methodRows = Object.fromEntries(
    [...methods.entries()]
      .sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )
      .map(([method, aggregate]) => [method, aggregate]),
  );
  const requestCount = Object.values(methodRows).reduce(
    (sum, method) => sum + method.started,
    0,
  );
  const completedCount = Object.values(methodRows).reduce(
    (sum, method) => sum + method.completed,
    0,
  );
  return {
    cutoffObserved: cutoffInFlight !== undefined,
    requestCount,
    completedCount,
    postCutoffEndCount,
    postCutoffErrorCount,
    inFlight: [...(cutoffInFlight ?? requests).values()].sort(
      (left, right) => left.id - right.id,
    ),
    methods: methodRows,
  };
}
