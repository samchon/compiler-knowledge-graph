/**
 * Fold the content-minimal LSP request log into evidence a timeout can use.
 *
 * A cutoff marker freezes the server calls outstanding when the outer
 * diagnostic stopped. Later error ends belong to graceful process cleanup, not
 * to server progress before the deadline, so they are retained separately.
 */
export function summarizeLspRequestTrace(log) {
  const requests = new Map();
  const started = new Set();
  const methods = new Map();
  let cutoffInFlight;
  let postCutoffEndCount = 0;
  let postCutoffErrorCount = 0;
  let cleanupRequestCount = 0;
  let cleanupCompletedCount = 0;
  let cleanupErrorCount = 0;
  for (const line of log.split(/\r?\n/)) {
    if (line === "@samchon/graph: lsp-request phase=cutoff") {
      if (cutoffInFlight !== undefined) {
        throw new Error("duplicate LSP request cutoff marker");
      }
      cutoffInFlight = new Map(requests);
      continue;
    }
    const start =
      /^@samchon\/graph: lsp-request client=(\d+) id=(\d+) method=("(?:\\.|[^"\\])*") phase=start$/.exec(
        line,
      );
    const end =
      /^@samchon\/graph: lsp-request client=(\d+) id=(\d+) method=("(?:\\.|[^"\\])*") phase=end status=(success|error) durationMs=(\d+(?:\.\d+)?)$/.exec(
        line,
      );
    if (start === null && end === null) {
      if (line.startsWith("@samchon/graph: lsp-request ")) {
        throw new Error(`malformed LSP request trace: ${line}`);
      }
      continue;
    }
    const match = start ?? end;
    const client = safeTraceInteger(match[1], "client");
    const id = safeTraceInteger(match[2], "id");
    const method = JSON.parse(match[3]);
    const key = `${String(client)}:${String(id)}`;
    const aggregate = methods.get(method) ?? {
      started: 0,
      completed: 0,
      errors: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      postCutoffEnds: 0,
      postCutoffErrors: 0,
      postCutoffMaxDurationMs: 0,
      cleanupStarted: 0,
      cleanupCompleted: 0,
      cleanupErrors: 0,
      cleanupTotalDurationMs: 0,
      cleanupMaxDurationMs: 0,
    };
    methods.set(method, aggregate);
    if (start !== null) {
      if (started.has(key)) {
        throw new Error(
          `duplicate LSP request start: client=${String(client)} id=${String(id)}`,
        );
      }
      started.add(key);
      const beforeCutoff = cutoffInFlight === undefined;
      if (beforeCutoff) aggregate.started += 1;
      else {
        cleanupRequestCount += 1;
        aggregate.cleanupStarted += 1;
      }
      requests.set(key, { client, id, method, beforeCutoff });
      continue;
    }
    const request = requests.get(key);
    if (request === undefined) {
      throw new Error(
        `orphan LSP request end: client=${String(client)} id=${String(id)}`,
      );
    }
    if (request.method !== method) {
      throw new Error(
        `LSP request end changed method: client=${String(client)} id=${String(id)}`,
      );
    }
    const status = end[4];
    const durationMs = Number(end[5]);
    if (cutoffInFlight !== undefined) {
      if (request.beforeCutoff) {
        postCutoffEndCount += 1;
        postCutoffErrorCount += status === "error" ? 1 : 0;
        aggregate.postCutoffEnds += 1;
        aggregate.postCutoffErrors += status === "error" ? 1 : 0;
        aggregate.postCutoffMaxDurationMs = Math.max(
          aggregate.postCutoffMaxDurationMs,
          durationMs,
        );
      } else {
        cleanupCompletedCount += 1;
        cleanupErrorCount += status === "error" ? 1 : 0;
        aggregate.cleanupCompleted += 1;
        aggregate.cleanupErrors += status === "error" ? 1 : 0;
        aggregate.cleanupTotalDurationMs += durationMs;
        aggregate.cleanupMaxDurationMs = Math.max(
          aggregate.cleanupMaxDurationMs,
          durationMs,
        );
      }
    } else {
      aggregate.completed += 1;
      aggregate.errors += status === "error" ? 1 : 0;
      aggregate.totalDurationMs += durationMs;
      aggregate.maxDurationMs = Math.max(
        aggregate.maxDurationMs,
        durationMs,
      );
    }
    requests.delete(key);
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
    cleanupRequestCount,
    cleanupCompletedCount,
    cleanupErrorCount,
    inFlight: [...(cutoffInFlight ?? requests).values()]
      .sort(compareRequest)
      .map(publicRequest),
    cleanupInFlight:
      cutoffInFlight === undefined
        ? []
        : [...requests.values()]
            .filter((request) => !request.beforeCutoff)
            .sort(compareRequest)
            .map(publicRequest),
    methods: methodRows,
  };
}

function safeTraceInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`invalid LSP request ${label}: ${value}`);
  }
  return parsed;
}

function compareRequest(left, right) {
  return left.client - right.client || left.id - right.id;
}

function publicRequest(request) {
  return {
    client: request.client,
    id: request.id,
    method: request.method,
  };
}
