/**
 * Fold the content-minimal LSP request log into evidence a timeout can use.
 *
 * Requests with a start and no end are the server calls still outstanding when
 * the outer diagnostic process stopped. Completed counts and durations show
 * whether the client lane continued making progress around them.
 */
export function summarizeLspRequestTrace(log) {
  const requests = new Map();
  const methods = new Map();
  for (const line of log.split(/\r?\n/)) {
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
    };
    methods.set(method, aggregate);
    if (phase === "start") {
      aggregate.started += 1;
      requests.set(id, { id, method });
      continue;
    }
    const durationMs = Number(match[5]);
    aggregate.completed += 1;
    aggregate.errors += match[4] === "error" ? 1 : 0;
    aggregate.totalDurationMs += durationMs;
    aggregate.maxDurationMs = Math.max(
      aggregate.maxDurationMs,
      durationMs,
    );
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
    requestCount,
    completedCount,
    inFlight: [...requests.values()].sort((left, right) => left.id - right.id),
    methods: methodRows,
  };
}
