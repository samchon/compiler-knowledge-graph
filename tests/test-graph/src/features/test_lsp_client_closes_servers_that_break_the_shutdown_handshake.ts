import { TestValidator } from "@nestia/e2e";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { GraphPaths } from "../internal/GraphPaths";
import { waitForProcessId } from "../internal/waitForProcessId";

interface ILspClient {
  request<T>(
    method: string,
    params: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T>;
  notify(method: string, params: unknown): void;
  close(): Promise<void>;
}

interface ILspClientInternals {
  pending: Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout | undefined;
      signal?: AbortSignal;
      abort?: () => void;
    }
  >;
  handleMessage(message: unknown): void;
  write(payload: unknown): void;
  process: {
    stdin: {
      destroy(error?: Error): void;
      write: (...args: unknown[]) => boolean;
    };
  };
}

type LspRequestTrace =
  | {
      phase: "start";
      id: number;
      method: string;
    }
  | {
      phase: "end";
      id: number;
      method: string;
      status: "success" | "error";
      durationMs: number;
    };

interface IOwnedProcess {
  command(
    command: string,
    args: readonly string[],
    windowsVerbatimArguments?: boolean,
  ): {
    command: string;
    args: string[];
    windowsVerbatimArguments?: boolean;
    windowsLaunch?: {
      command: string;
      args: string[];
      windowsVerbatimArguments?: boolean;
    };
  };
  group(): boolean;
  stdio(
    command: ReturnType<IOwnedProcess["command"]>,
    standard: readonly ("ignore" | "pipe")[],
  ): import("node:child_process").StdioOptions;
  start(
    child: ChildProcess,
    command: ReturnType<IOwnedProcess["command"]>,
  ): void;
  exit(child: ChildProcess): Promise<void>;
}

type LspClientConstructor = new (
  command: string,
  args: readonly string[],
  timeoutMs?: number,
  cwd?: string,
  maxMessageBytes?: number,
  windowsVerbatimArguments?: boolean,
  requestObserver?: (event: LspRequestTrace) => void,
  serverRequestHandler?: (method: string, params: unknown) => unknown,
) => ILspClient;

/** `LspClient` is internal transport, reached through the shipped artifact. */
const importLib = <T>(relative: string): Promise<T> =>
  import(
    pathToFileURL(path.join(GraphPaths.graphPackageRoot, "lib", relative)).href
  ) as Promise<T>;

/**
 * A language server that misbehaves during teardown leaves nothing behind in
 * the graph, so no result-shaped assertion can notice it; the evidence is a
 * process that outlives its session, or wall clock nobody can account for.
 *
 * The two servers below break the handshake in opposite directions, and each
 * inline comment states its own case. What is worth saying once, here, is why
 * both are needed: the correct response to one is escalation and to the other
 * is refusing to escalate, so a client that handled only the first would still
 * pass a suite that only asked about leaks.
 *
 * The case then continues into the rest of the client's process and transport
 * surface.
 */
export const test_lsp_client_closes_servers_that_break_the_shutdown_handshake =
  async () => {
    const { LspClient } = await importLib<{
      LspClient: LspClientConstructor;
    }>("lsp/LspClient.js");

    // A frame larger than a pipe's chunk, delivered in pieces.
    //
    // This transport carries graph snapshot pages, which are tens of megabytes,
    // and the operating system hands those over in chunks of about sixty-four
    // kibibytes. Joining the accumulation with every chunk is quadratic in the
    // frame: five hundred chunks copy the whole of it five hundred times, which
    // was most of what paging a real C project cost. Chunks now accumulate
    // unjoined until the frame the header declared has arrived.
    //
    // The server below writes its header and then dribbles the body out in
    // pieces, so the client has to hold an incomplete frame across many reads
    // and assemble it byte-exact. A body that arrives in one chunk would prove
    // none of that.
    const SIZE = 2 * 1024 * 1024;
    const pieces = new LspClient(process.execPath, [
      "-e",
      [
        "let buf = Buffer.alloc(0);",
        "process.stdin.on('data', (d) => {",
        "  buf = Buffer.concat([buf, d]);",
        "  for (;;) {",
        "    const head = buf.indexOf('\\r\\n\\r\\n');",
        "    if (head < 0) return;",
        "    const len = Number(/Content-Length: (\\d+)/.exec(buf.slice(0, head).toString())[1]);",
        "    if (buf.length < head + 4 + len) return;",
        "    const msg = JSON.parse(buf.slice(head + 4, head + 4 + len).toString());",
        "    buf = buf.slice(head + 4 + len);",
        "    if (msg.id === undefined) continue;",
        `    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { blob: 'x'.repeat(${SIZE}) } }));`,
        "    process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');",
        "    for (let i = 0; i < body.length; i += 65536)",
        "      process.stdout.write(body.subarray(i, i + 65536));",
        "  }",
        "});",
      ].join("\n"),
    ]);
    try {
      const assembled = await pieces.request<{ blob: string }>(
        "initialize",
        {},
        30_000,
      );
      TestValidator.equals(
        "a frame delivered in pieces is assembled byte-exact",
        [assembled.blob.length, assembled.blob === "x".repeat(SIZE)],
        [SIZE, true],
      );
    } finally {
      await pieces.close();
    }

    // A language server that acknowledges `shutdown` and then ignores `exit` is
    // the leak this teardown exists to prevent: nothing else ends that process,
    // so an orphaned server would outlive the session that spawned it, holding
    // a whole Gradle or solution load resident behind a session nobody is
    // talking to. The client waits briefly, then kills it.
    const stubborn = new LspClient(process.execPath, [
      GraphPaths.fakeLspServer,
      "--hang-method=exit",
    ]);
    await stubborn.request("initialize", {});
    // An `exit` request is never answered by this server, so it is still in
    // flight when the child dies — which is what makes the rejection below
    // evidence of how the child died rather than of how it replied.
    let stranded: Error | undefined;
    const settled = stubborn
      .request("exit", null)
      .catch((error: Error) => void (stranded = error));
    await stubborn.close();
    await settled;
    // A request the server can no longer answer must be told so. Left pending,
    // it would hang whatever awaited it for the life of the process.
    TestValidator.predicate(
      "a server that ignores exit is killed, and its in-flight requests are told",
      stranded !== undefined &&
        stranded.message.includes("Language server exited"),
    );
    // `null` exit code with a signal is precisely the fingerprint of a process
    // the client terminated, as opposed to one that chose to leave.
    TestValidator.predicate(
      "the stranded request names the signal the client had to send",
      stranded !== undefined && /\(null, SIG[A-Z]+\)/.test(stranded.message),
    );

    // The opposite break: a server that treats `shutdown` as the end and exits
    // instead of replying. It is already gone before `exit` is written, so a
    // close that still waited out its exit grace would stall every teardown by
    // a full second for nothing.
    const abrupt = new LspClient(process.execPath, [
      GraphPaths.fakeLspServer,
      "--exit-on-shutdown",
    ]);
    await abrupt.request("initialize", {});
    const started = Date.now();
    await abrupt.close();
    TestValidator.predicate(
      "a server that exits on shutdown is not waited on again",
      Date.now() - started < 900,
    );

    // Teardown is idempotent: the resident source closes its sessions, and a
    // second close from a racing shutdown path must settle rather than start a
    // new handshake with a process that is gone.
    await abrupt.close();
    await stubborn.close();

    await assertStubbornProcessTreeIsOwned(LspClient);
    await assertExitedLeaderDoesNotLeakItsProcessGroup(LspClient);
    await assertWindowsCommandWaitsForOwnership();
    await assertWindowsOwnershipPreservesTheOriginalCommandLine();
    await assertClosedInputRejectsRequests(LspClient);
    await assertSynchronousWriteFailureRejectsRequests(LspClient);
    await assertStdinStreamErrorRejectsRequests(LspClient);
    await assertPerRequestDeadlineCleansUpTheTransport(LspClient);
    await assertOversizedFrameTerminatesTransport(LspClient);
    await assertOversizedHeadersTerminateTransport(LspClient);
    await assertRequestTracing(LspClient);
    await assertRequestTraceFormatting();
    await assertServerRequestFailureAndBareResponse(LspClient);
    await assertServerLogIsPassedThroughWhenAsked(LspClient);

    // An already-cancelled request never enters the wire or waits for the
    // otherwise-unlimited default deadline. The client still owns its child and
    // closes it normally, which is the negative twin of aborting an in-flight
    // request in the resident-source regression.
    const cancelled = new LspClient(process.execPath, [
      GraphPaths.fakeLspServer,
    ]);
    const controller = new AbortController();
    controller.abort();
    let cancellation: Error | undefined;
    await cancelled
      .request("initialize", {}, undefined, controller.signal)
      .catch((error: Error) => void (cancellation = error));
    TestValidator.equals(
      "an already-cancelled unlimited request rejects as an abort",
      cancellation?.name,
      "AbortError",
    );
    await cancelled.close();
  };

/**
 * A stalled language server's only witness is its own log.
 *
 * A producer that spends twenty minutes saying it is still discovering
 * changes has said nothing a consumer can act on, and the words that would
 * explain it go to stderr, which this client drops by default because a
 * healthy server's log is noise. The switch passes them through; a sink that
 * throws must not end the session it was only watching.
 */
const assertServerLogIsPassedThroughWhenAsked = async (
  LspClient: LspClientConstructor,
): Promise<void> => {
  const CRLF2 = "String.fromCharCode(13, 10, 13, 10)";
  const server = [
    "const eol = String.fromCharCode(13, 10);",
    "process.stderr.write('background index: 3 files' + String.fromCharCode(10));",
    "let buf = Buffer.alloc(0);",
    "process.stdin.on('data', (d) => {",
    "  buf = Buffer.concat([buf, d]);",
    "  for (;;) {",
    `    const head = buf.indexOf(${CRLF2});`,
    "    if (head < 0) return;",
    "    const header = buf.slice(0, head).toString();",
    "    const at = header.toLowerCase().indexOf('content-length:');",
    "    const len = Number(header.slice(at + 15).trim().split(eol)[0]);",
    "    if (buf.length < head + 4 + len) return;",
    "    const msg = JSON.parse(buf.slice(head + 4, head + 4 + len).toString());",
    "    buf = buf.slice(head + 4 + len);",
    "    if (msg.id === undefined) continue;",
    "    process.stderr.write('answered ' + msg.method + String.fromCharCode(10));",
    "    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));",
    `    process.stdout.write('Content-Length: ' + body.length + ${CRLF2});`,
    "    process.stdout.write(body);",
    "  }",
    "});",
  ].join(String.fromCharCode(10));
  const captured: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  let sink: (text: string) => void = (text) => void captured.push(text);
  (process.stderr as { write: unknown }).write = (chunk: unknown): boolean => {
    sink(String(chunk));
    return true;
  };
  process.env.SAMCHON_GRAPH_LSP_SERVER_LOG = "1";
  const client = new LspClient(process.execPath, ["-e", server]);
  try {
    await client.request("initialize", {}, 30_000);
    while (!captured.some((line) => line.includes("background index")))
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    // A sink that throws is still a sink this client must survive.
    sink = () => {
      throw new Error("fixture stderr sink is gone");
    };
    const answered = await client.request("fixture/again", {}, 30_000);
    sink = (text) => void captured.push(text);
    TestValidator.equals(
      "a server's log reaches the run that asked for it, and a sink that fails does not end it",
      [
        captured.some((line) => line.includes("background index: 3 files")),
        captured.every((line) => line.startsWith(`[${process.execPath}] `)),
        answered,
      ],
      [true, true, {}],
    );
  } finally {
    delete process.env.SAMCHON_GRAPH_LSP_SERVER_LOG;
    (process.stderr as { write: unknown }).write = original;
    await client.close();
  }
};

const assertServerRequestFailureAndBareResponse = async (
  LspClient: LspClientConstructor,
): Promise<void> => {
  const client = new LspClient(
    process.execPath,
    [GraphPaths.fakeLspServer],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (method) => {
      if (method === "fixture/failure") {
        throw "fixture server-request failure";
      }
      return undefined;
    },
  );
  const internals = client as unknown as ILspClientInternals;
  const written: unknown[] = [];
  const originalWrite = internals.write.bind(client);
  try {
    internals.write = (payload) => void written.push(payload);
    internals.handleMessage({
      jsonrpc: "2.0",
      id: 7001,
      method: "fixture/failure",
      params: {},
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    TestValidator.equals(
      "a rejected server-request handler returns a normalized JSON-RPC error",
      written,
      [
        {
          jsonrpc: "2.0",
          id: 7001,
          error: {
            code: -32603,
            message: "fixture server-request failure",
          },
        },
      ],
    );

    internals.handleMessage({
      jsonrpc: "2.0",
      id: 7002,
      method: "fixture/undefined",
      params: {},
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    TestValidator.equals(
      "an undefined server-request handler result remains valid JSON-RPC",
      written[1],
      { jsonrpc: "2.0", id: 7002, result: null },
    );

    let bare: Error & { code?: number } | undefined;
    internals.pending.set(7003, {
      resolve: () => undefined,
      reject: (error) => void (bare = error as Error & { code?: number }),
      timer: undefined,
    });
    internals.handleMessage({ jsonrpc: "2.0", id: 7003, error: {} });
    TestValidator.equals(
      "a bare LSP response error receives the protocol defaults",
      [bare?.name, bare?.code, bare?.message],
      ["LspResponseError", -32603, "LSP request failed."],
    );
  } finally {
    internals.write = originalWrite;
    await client.close();
  }
};

const assertRequestTracing = async (
  LspClient: LspClientConstructor,
): Promise<void> => {
  const events: LspRequestTrace[] = [];
  const client = new LspClient(
    process.execPath,
    [GraphPaths.fakeLspServer],
    undefined,
    undefined,
    undefined,
    undefined,
    (event) => events.push(event),
  );
  let serializationFailure: Error | undefined;
  await client
    .request("workspace/executeCommand", { argument: 1n })
    .catch((error: Error) => void (serializationFailure = error));
  TestValidator.predicate(
    "an unserializable request rejects through its own promise",
    serializationFailure?.message.includes("BigInt") === true,
  );
  let nonErrorSerializationFailure: Error | undefined;
  const throwingParams = Object.defineProperty({}, "argument", {
    enumerable: true,
    get: () => {
      throw "synthetic serialization failure";
    },
  });
  await client
    .request("workspace/executeCommand", throwingParams)
    .catch(
      (error: Error) =>
        void (nonErrorSerializationFailure = error),
    );
  TestValidator.predicate(
    "a non-Error serialization failure is normalized on the same boundary",
    nonErrorSerializationFailure?.message ===
      "synthetic serialization failure",
  );
  TestValidator.equals(
    "an unserializable request removes its pending transport state",
    (client as unknown as ILspClientInternals).pending.size,
    0,
  );
  await client.request("initialize", {});
  await client.close();
  const unserializable = events.filter(
    (event) => event.method === "workspace/executeCommand",
  );
  TestValidator.equals(
    "a synchronous serialization failure still closes its trace",
    unserializable.map((event) => [
      event.phase,
      event.id,
      event.phase === "end" ? event.status : undefined,
    ]),
    [
      ["start", 1, undefined],
      ["end", 1, "error"],
      ["start", 2, undefined],
      ["end", 2, "error"],
    ],
  );
  const initialize = events.filter(
    (event) => event.method === "initialize",
  );
  TestValidator.equals(
    "request tracing pairs the exact request identity and outcome",
    initialize.map((event) => [
      event.phase,
      event.id,
      event.phase === "end" ? event.status : undefined,
    ]),
    [
      ["start", 3, undefined],
      ["end", 3, "success"],
    ],
  );
  TestValidator.predicate(
    "a completed request trace carries a finite non-negative duration",
    initialize[1]?.phase === "end" &&
      Number.isFinite(initialize[1].durationMs) &&
      initialize[1].durationMs >= 0,
  );

  const throwingObserver = new LspClient(
    process.execPath,
    [GraphPaths.fakeLspServer],
    undefined,
    undefined,
    undefined,
    undefined,
    () => {
      throw new Error("diagnostic observer failed");
    },
  );
  await throwingObserver.request("initialize", {});
  await throwingObserver.close();
};

const assertRequestTraceFormatting = async (): Promise<void> => {
  const { lspRequestTrace } = await importLib<{
    lspRequestTrace(
      env?: NodeJS.ProcessEnv,
      write?: (line: string) => unknown,
      signal?: AbortSignal,
    ): ((event: LspRequestTrace) => void) | undefined;
  }>("lsp/lspRequestTrace.js");
  const LSP_REQUEST_TRACE_ENV = "SAMCHON_GRAPH_LSP_REQUEST_TRACE";
  const previous = process.env[LSP_REQUEST_TRACE_ENV];
  delete process.env[LSP_REQUEST_TRACE_ENV];
  try {
    TestValidator.equals(
      "request timing is silent unless explicitly enabled",
      lspRequestTrace(),
      undefined,
    );
  } finally {
    if (previous === undefined) delete process.env[LSP_REQUEST_TRACE_ENV];
    else process.env[LSP_REQUEST_TRACE_ENV] = previous;
  }

  const lines: string[] = [];
  const cutoff = new AbortController();
  const trace = lspRequestTrace(
    { [LSP_REQUEST_TRACE_ENV]: "1" },
    (line) => lines.push(line),
    cutoff.signal,
  );
  trace?.({
    phase: "start",
    id: 7,
    method: "textDocument/references",
  });
  trace?.({
    phase: "end",
    id: 7,
    method: "textDocument/references",
    status: "success",
    durationMs: 12.3456,
  });
  cutoff.abort();
  const traceClient = /client=(\d+)/.exec(lines[0] ?? "")?.[1];
  TestValidator.predicate(
    "request timing gives each client a trace identity",
    traceClient !== undefined,
  );
  TestValidator.equals(
    "request timing names no parameters or paths and marks the abort cutoff",
    lines,
    [
      `@samchon/graph: lsp-request client=${traceClient} id=7 method="textDocument/references" phase=start\n`,
      `@samchon/graph: lsp-request client=${traceClient} id=7 method="textDocument/references" phase=end status=success durationMs=12.346\n`,
      "@samchon/graph: lsp-request phase=cutoff\n",
    ],
  );
  const secondTrace = lspRequestTrace(
    { [LSP_REQUEST_TRACE_ENV]: "1" },
    (line) => lines.push(line),
    cutoff.signal,
  );
  secondTrace?.({
    phase: "start",
    id: 7,
    method: "shutdown",
  });
  secondTrace?.({
    phase: "end",
    id: 7,
    method: "shutdown",
    status: "success",
    durationMs: 1,
  });
  const secondClient = /client=(\d+)/.exec(lines[3] ?? "")?.[1];
  TestValidator.equals(
    "one abort signal emits one cutoff while request identities stay unique across clients",
    [
      lines.filter(
        (line) => line === "@samchon/graph: lsp-request phase=cutoff\n",
      ).length,
      traceClient !== secondClient,
      lines.at(-1),
    ],
    [
      1,
      true,
      `@samchon/graph: lsp-request client=${secondClient} id=7 method="shutdown" phase=end status=success durationMs=1.000\n`,
    ],
  );

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const alreadyAbortedLines: string[] = [];
  lspRequestTrace(
    { [LSP_REQUEST_TRACE_ENV]: "1" },
    (line) => alreadyAbortedLines.push(line),
    alreadyAborted.signal,
  );
  TestValidator.equals(
    "an already-aborted trace marks its cutoff immediately",
    alreadyAbortedLines,
    ["@samchon/graph: lsp-request phase=cutoff\n"],
  );

  const unbounded = lspRequestTrace(
    { [LSP_REQUEST_TRACE_ENV]: "1" },
    () => undefined,
  );
  TestValidator.predicate(
    "an enabled trace does not require a cutoff signal",
    unbounded !== undefined,
  );

  const resilientCutoff = new AbortController();
  lspRequestTrace(
    { [LSP_REQUEST_TRACE_ENV]: "1" },
    () => {
      throw new Error("diagnostic cutoff failed");
    },
    resilientCutoff.signal,
  );
  resilientCutoff.abort();
  TestValidator.predicate(
    "a cutoff observer cannot change abort behavior",
    resilientCutoff.signal.aborted,
  );

  const traceModule = pathToFileURL(
    path.join(
      GraphPaths.graphPackageRoot,
      "lib",
      "lsp",
      "lspRequestTrace.js",
    ),
  ).href;
  const immediateExit = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        `const { lspRequestTrace } = await import(${JSON.stringify(traceModule)});`,
        "const cutoff = new AbortController();",
        `lspRequestTrace({ ${LSP_REQUEST_TRACE_ENV}: "1" }, undefined, cutoff.signal);`,
        "cutoff.abort();",
        "process.exit(0);",
      ].join("\n"),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  TestValidator.equals(
    "the default cutoff writer survives an immediate process exit",
    [immediateExit.status, immediateExit.signal, immediateExit.stderr],
    [0, null, "@samchon/graph: lsp-request phase=cutoff\n"],
  );

  const worker = new Worker(
    [
      "(async () => {",
      `  const { lspRequestTrace } = await import(${JSON.stringify(traceModule)});`,
      "  const cutoff = new AbortController();",
      `  lspRequestTrace({ ${LSP_REQUEST_TRACE_ENV}: "1" }, undefined, cutoff.signal);`,
      "  cutoff.abort();",
      "})().catch((error) => { throw error; });",
    ].join("\n"),
    {
      eval: true,
      stderr: true,
    },
  );
  worker.stderr.setEncoding("utf8");
  let workerStderr = "";
  worker.stderr.on("data", (chunk: string) => {
    workerStderr += chunk;
  });
  const workerExitPromise = new Promise<number>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", resolve);
  });
  const workerStderrEnd = new Promise<void>((resolve, reject) => {
    worker.stderr.once("error", reject);
    worker.stderr.once("end", resolve);
  });
  const [workerExit] = await Promise.all([
    workerExitPromise,
    workerStderrEnd,
  ]);
  TestValidator.equals(
    "a Worker without process.stderr.fd preserves its redirected trace",
    [workerExit, workerStderr],
    [0, "@samchon/graph: lsp-request phase=cutoff\n"],
  );
};

const assertWindowsOwnershipPreservesTheOriginalCommandLine =
  async (): Promise<void> => {
    if (process.platform !== "win32") return;
    const { ownedProcess } = await importLib<{
      ownedProcess: IOwnedProcess;
    }>("utils/ownedProcess.js");
    const payload = "x".repeat(10_000);
    const owned = ownedProcess.command(process.execPath, [
      "-e",
      "process.stdout.write(String(process.argv[1].length))",
      payload,
    ]);
    TestValidator.equals(
      "Windows ownership keeps the real long argv off the gate command line",
      [
        owned.command,
        owned.args.some((argument) => argument.includes(payload)),
        owned.windowsLaunch?.args.at(-1),
      ],
      [process.execPath, false, payload],
    );
    const child = spawn(owned.command, owned.args, {
      detached: ownedProcess.group(),
      stdio: ownedProcess.stdio(owned, ["ignore", "pipe", "pipe"]),
      windowsHide: true,
      windowsVerbatimArguments: owned.windowsVerbatimArguments,
    });
    ownedProcess.start(child, owned);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await ownedProcess.exit(child);
    TestValidator.equals(
      "Windows Job ownership preserves a long argv that direct spawn accepts",
      [child.exitCode, stdout, stderr],
      [0, "10000", ""],
    );
  };

const assertWindowsCommandWaitsForOwnership = async (): Promise<void> => {
  if (process.platform !== "win32") return;
  const { ownedProcess } = await importLib<{
    ownedProcess: IOwnedProcess;
  }>("utils/ownedProcess.js");
  const root = GraphPaths.createTempDirectory(
    "samchon-graph-windows-process-gate-",
  );
  const marker = path.join(root, "started");
  const owned = ownedProcess.command(process.execPath, [
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], 'started')",
    marker,
  ]);
  const child = spawn(owned.command, owned.args, {
    detached: ownedProcess.group(),
    stdio: ownedProcess.stdio(owned, ["ignore", "pipe", "pipe"]),
    windowsHide: true,
    windowsVerbatimArguments: owned.windowsVerbatimArguments,
  });
  await delay(100);
  TestValidator.equals(
    "the Windows gate cannot launch a command before Job assignment",
    fs.existsSync(marker),
    false,
  );
  ownedProcess.start(child, owned);
  await ownedProcess.exit(child);
  TestValidator.equals(
    "Job assignment releases the waiting Windows command",
    [child.exitCode, fs.readFileSync(marker, "utf8")],
    [0, "started"],
  );
};

const assertExitedLeaderDoesNotLeakItsProcessGroup = async (
  LspClient: LspClientConstructor,
): Promise<void> => {
  const root = GraphPaths.createTempDirectory(
    "samchon-graph-exited-lsp-leader-",
  );
  const pidFile = path.join(root, "descendant.pid");
  const client = new LspClient(process.execPath, [
    GraphPaths.fakeLspServer,
    `--stubborn-descendant=${pidFile}`,
  ]);
  let pid: number | undefined;
  try {
    await client.request("initialize", {});
    pid = await waitForProcessId(pidFile);
    await settleWithin(client.close(), 5_000, () => terminate(pid!));
    TestValidator.equals(
      "close waits for a process group after its cooperative leader exits",
      isProcessAlive(pid),
      false,
    );
  } finally {
    if (pid !== undefined) terminate(pid);
    await Promise.allSettled([client.close()]);
  }
};

const assertOversizedFrameTerminatesTransport = async (
  LspClient: LspClientConstructor,
): Promise<void> => {
  TestValidator.error(
    "an unsafe LSP message limit is rejected before spawn",
    () =>
      new LspClient(
        process.execPath,
        [GraphPaths.fakeLspServer],
        undefined,
        undefined,
        Number.MAX_SAFE_INTEGER + 1,
      ),
  );
  const client = new LspClient(
    process.execPath,
    [GraphPaths.fakeLspServer, "--oversized-frame=4096"],
    undefined,
    undefined,
    128,
  );
  try {
    const rejection = await rejectionWithin(
      client.request("initialize", {}),
      2_000,
    );
    TestValidator.predicate(
      "a declared oversized frame rejects the pending request promptly",
      rejection.message.includes("oversized LSP frame") &&
        rejection.message.includes("4096"),
    );
  } finally {
    await settleWithin(client.close(), 5_000, () => undefined);
  }
};

const assertOversizedHeadersTerminateTransport = async (
  LspClient: LspClientConstructor,
): Promise<void> => {
  for (const mode of ["unterminated", "terminated"] as const) {
    const client = new LspClient(process.execPath, [
      GraphPaths.fakeLspServer,
      `--oversized-header=${mode}`,
    ]);
    try {
      const rejection = await rejectionWithin(
        client.request("initialize", {}),
        2_000,
      );
      TestValidator.predicate(
        `an ${mode} oversized LSP header retires the transport`,
        rejection.message.includes("LSP header limit"),
      );
    } finally {
      await settleWithin(client.close(), 5_000, () => undefined);
    }
  }
};

const assertStubbornProcessTreeIsOwned = async (
  LspClient: LspClientConstructor,
): Promise<void> => {
  const root = GraphPaths.createTempDirectory("samchon-graph-stubborn-lsp-");
  const pidFile = path.join(root, "stubborn.pid");
  const sigtermFile = path.join(root, "stubborn.sigterm");
  const previousPidFile = process.env.SAMCHON_GRAPH_FAKE_LSP_PID_FILE;
  const previousSigtermFile =
    process.env.SAMCHON_GRAPH_FAKE_LSP_SIGTERM_FILE;
  process.env.SAMCHON_GRAPH_FAKE_LSP_PID_FILE = pidFile;
  process.env.SAMCHON_GRAPH_FAKE_LSP_SIGTERM_FILE = sigtermFile;
  const fakeArgs = [GraphPaths.fakeLspServer, "--ignore-termination"];
  const wrapper = path.join(root, "stubborn-lsp.cmd");
  if (process.platform === "win32") {
    fs.writeFileSync(
      wrapper,
      `@echo off\r\n"${process.execPath}" "${fakeArgs[0]}" ${fakeArgs[1]}\r\n`,
    );
  }
  const command = process.platform === "win32" ? "cmd.exe" : process.execPath;
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", wrapper]
      : fakeArgs;
  const client = new LspClient(command, args);
  const unrelated = spawn(
    process.execPath,
    ["-e", "setInterval(() => undefined, 1_000)"],
    { stdio: "ignore", windowsHide: true },
  );
  let pid: number | undefined;
  try {
    await client.request("initialize", {});
    pid = await waitForProcessId(pidFile);
    await settleWithin(client.close(), 5_000, () => terminate(pid!));
    TestValidator.equals(
      "close returns only after a signal-resistant LSP child exits",
      isProcessAlive(pid),
      false,
    );
    TestValidator.equals(
      "closing one LSP process tree preserves an unrelated process",
      isProcessAlive(unrelated.pid!),
      true,
    );
    if (process.platform !== "win32") {
      TestValidator.equals(
        "POSIX shutdown escalates through SIGTERM before SIGKILL",
        fs.existsSync(sigtermFile),
        true,
      );
    }
  } finally {
    if (pid !== undefined) terminate(pid);
    await Promise.allSettled([client.close(), stop(unrelated)]);
    restoreEnv("SAMCHON_GRAPH_FAKE_LSP_PID_FILE", previousPidFile);
    restoreEnv("SAMCHON_GRAPH_FAKE_LSP_SIGTERM_FILE", previousSigtermFile);
  }
};

const assertClosedInputRejectsRequests = async (
  LspClient: LspClientConstructor,
): Promise<void> => {
  const root = GraphPaths.createTempDirectory("samchon-graph-closed-lsp-input-");
  const marker = path.join(root, "input.closed");
  const previousMarker =
    process.env.SAMCHON_GRAPH_FAKE_LSP_INPUT_CLOSED_FILE;
  if (process.platform !== "win32") {
    process.env.SAMCHON_GRAPH_FAKE_LSP_INPUT_CLOSED_FILE = marker;
  }
  const client = new LspClient(process.execPath, [
    GraphPaths.fakeLspServer,
    process.platform === "win32"
      ? "--hang-method=workspace/symbol"
      : "--close-input-after-initialize",
  ]);
  try {
    await client.request("initialize", {});
    if (process.platform !== "win32") await waitForFile(marker);
    const pending = client.request("workspace/symbol", {});
    if (process.platform === "win32") {
      // Windows keeps the child-side inherited named-pipe handle alive until
      // process exit even after fd 0 is closed. Destroy the exact client stream
      // with the error that the OS defers, while the real peer-close path above
      // remains exercised on POSIX.
      (client as unknown as ILspClientInternals).process.stdin.destroy(
        new Error("synthetic closed request pipe"),
      );
    }
    const rejection = await rejectionWithin(
      pending,
      2_000,
    );
    TestValidator.predicate(
      "a closed LSP input rejects pending requests without an unhandled stream error",
      rejection.message.includes("stdin") ||
        rejection.message.includes("write"),
    );
    const later = await rejectionWithin(
      client.request("workspace/symbol", {}),
      100,
    );
    TestValidator.equals(
      "transport failure rejects later requests before they enter the wire",
      later.message,
      rejection.message,
    );
    client.notify("workspace/didChangeConfiguration", {});
    await settleWithin(client.close(), 5_000, () => undefined);
  } finally {
    await Promise.allSettled([client.close()]);
    restoreEnv("SAMCHON_GRAPH_FAKE_LSP_INPUT_CLOSED_FILE", previousMarker);
  }
};

const assertSynchronousWriteFailureRejectsRequests = async (
  LspClient: LspClientConstructor,
): Promise<void> => {
  const client = new LspClient(process.execPath, [
    GraphPaths.fakeLspServer,
    "--hang-method=workspace/symbol",
  ]);
  try {
    await client.request("initialize", {});
    (client as unknown as ILspClientInternals).process.stdin.write = () => {
      throw "synthetic synchronous write failure";
    };
    const rejection = await rejectionWithin(
      client.request("workspace/symbol", {}),
      2_000,
    );
    TestValidator.predicate(
      "a synchronous non-Error stdin failure rejects the request",
      rejection.message.includes("stdin") &&
        rejection.message.includes("synthetic synchronous write failure"),
    );
    await settleWithin(client.close(), 5_000, () => undefined);
  } finally {
    await Promise.allSettled([client.close()]);
  }
};

/**
 * A stream-level stdin error is the handle failure surface: destroying the
 * write stream with an error emits it on every platform, whereas the real
 * peer-close path only reaches the write callback on POSIX. Exercising it
 * cross-platform keeps the client's stdin `error` listener honest everywhere.
 */
const assertStdinStreamErrorRejectsRequests = async (
  LspClient: LspClientConstructor,
): Promise<void> => {
  const client = new LspClient(process.execPath, [
    GraphPaths.fakeLspServer,
    "--hang-method=workspace/symbol",
  ]);
  try {
    await client.request("initialize", {});
    const pending = client.request("workspace/symbol", {});
    (client as unknown as ILspClientInternals).process.stdin.destroy(
      new Error("synthetic stdin stream error"),
    );
    const rejection = await rejectionWithin(pending, 2_000);
    TestValidator.predicate(
      "a stdin stream error rejects pending requests",
      rejection.message.includes("stdin"),
    );
  } finally {
    await settleWithin(client.close(), 5_000, () => undefined);
  }
};

const assertPerRequestDeadlineCleansUpTheTransport = async (
  LspClient: LspClientConstructor,
): Promise<void> => {
  const timeoutMs = 60_000;
  const root = GraphPaths.createTempDirectory("samchon-graph-lsp-timeout-");
  const marker = path.join(root, "request-received");
  const previousMarker = process.env.SAMCHON_GRAPH_FAKE_LSP_HANG_FILE;
  const originalSetTimeout = globalThis.setTimeout;
  let timeoutCallback: (() => void) | undefined;
  process.env.SAMCHON_GRAPH_FAKE_LSP_HANG_FILE = marker;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === timeoutMs) {
      timeoutCallback = () => callback(...args);
      // `deletePending` must clear this handle after the captured callback runs.
      return originalSetTimeout(() => undefined, timeoutMs);
    }
    return Reflect.apply(originalSetTimeout, globalThis, [callback, delay, ...args]) as NodeJS.Timeout;
  }) as typeof setTimeout;
  const client = new LspClient(process.execPath, [
    GraphPaths.fakeLspServer,
    "--hang-method=workspace/symbol",
  ]);
  try {
    await client.request("initialize", {});
    const pending = client.request("workspace/symbol", {}, timeoutMs);
    await waitForFile(marker);
    if (timeoutCallback === undefined)
      throw new Error("LspClient did not install its per-request deadline");
    timeoutCallback();
    const rejection = await rejectionWithin(pending, 2_000);
    TestValidator.equals(
      "a per-request deadline rejects an unanswered request",
      rejection.message,
      "LSP request timed out: workspace/symbol",
    );
    TestValidator.equals(
      "a timed-out request leaves no stale pending transport entry",
      (client as unknown as ILspClientInternals).pending.size,
      0,
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    await Promise.allSettled([client.close()]);
    restoreEnv("SAMCHON_GRAPH_FAKE_LSP_HANG_FILE", previousMarker);
  }
};

const rejectionWithin = async (
  task: Promise<unknown>,
  timeoutMs: number,
): Promise<Error> => {
  const result = await settleWithin(
    task.then(
      () => ({ error: undefined }),
      (error: unknown) => ({
        error: error instanceof Error ? error : new Error(String(error)),
      }),
    ),
    timeoutMs,
    () => undefined,
  );
  if (result.error !== undefined) return result.error;
  throw new Error("expected LSP request to reject");
};

const settleWithin = async <T>(
  task: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`LSP lifecycle exceeded ${String(timeoutMs)} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const waitForFile = async (file: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`fake LSP did not announce ${file}`);
    await delay(10);
  }
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const terminate = (pid: number): void => {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
};

const stop = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGKILL");
  await exited;
};

const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
