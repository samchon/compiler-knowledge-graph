import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { ownedProcess } from "../utils/ownedProcess";
import { LspResponseError } from "./LspResponseError";

const SHUTDOWN_GRACE_MS = 1_000;
const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

interface IRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
  signal?: AbortSignal;
  abort?: () => void;
}

export class LspClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly exit: Promise<void>;
  private readonly pending = new Map<number, IRequest>();
  private readonly events = new EventEmitter();
  private readonly maxMessageBytes: number;
  private buffer = Buffer.alloc(0);
  // Chunks that have arrived since `buffer` was last joined, and how many
  // bytes they hold. See `onData`.
  private chunks: Buffer[] = [];
  private chunkBytes = 0;
  // Total bytes the frame being read needs, header included, or zero when the
  // next header has not been parsed yet.
  private needed = 0;
  private nextId = 1;
  private exited = false;
  private failure: Error | undefined;
  private termination: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  public constructor(
    command: string,
    args: readonly string[],
    private readonly timeoutMs?: number,
    cwd?: string,
    maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
    windowsVerbatimArguments?: boolean,
    private readonly requestObserver?: LspClient.IRequestObserver,
    private readonly serverRequestHandler?: LspClient.IServerRequestHandler,
  ) {
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) {
      throw new TypeError(
        "LSP maxMessageBytes must be a positive safe integer.",
      );
    }
    this.maxMessageBytes = maxMessageBytes;
    const owned = ownedProcess.command(
      command,
      args,
      windowsVerbatimArguments,
    );
    this.process = spawn(owned.command, owned.args, {
      cwd,
      detached: ownedProcess.group(),
      stdio: ownedProcess.stdio(owned, ["pipe", "pipe", "pipe"]),
      windowsVerbatimArguments: owned.windowsVerbatimArguments,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    ownedProcess.start(this.process, owned);
    this.exit = ownedProcess.exit(this.process);
    this.process.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    // Language servers log to stderr, and a server that is busy says so
    // there and nowhere else. It is dropped by default because the log of a
    // healthy run is noise -- but a run that stalls has exactly one witness,
    // and dropping it left a producer that spent twenty minutes 'discovering
    // changes' with nothing to say for itself. The same switch that turns on
    // this consumer's own trace passes the server's words through.
    const echo = process.env["SAMCHON_GRAPH_LSP_SERVER_LOG"] === "1";
    this.process.stderr.on("data", (chunk: Buffer) => {
      if (!echo) return;
      try {
        process.stderr.write(`[${owned.command}] ${chunk.toString("utf8")}`);
      } catch {
        // A trace must never end a session it was only watching.
      }
    });
    /* c8 ignore start -- direct POSIX spawn failures are exercised on POSIX.
     * Windows starts a stable Job Object supervisor first and reports a nested
     * language-server launch failure through that process instead. */
    this.process.on("error", (error) => {
      this.exited = true;
      this.fail(error);
    });
    /* c8 ignore stop */
    this.process.on("exit", (code, signal) => {
      this.exited = true;
      this.fail(
        new Error(
          `Language server exited (${String(code)}, ${String(signal)}).`,
        ),
      );
    });
    this.process.stdin.on("error", (error) => {
      this.failTransport(stdinError(error));
    });
  }

  public async request<T>(
    method: string,
    params: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw abortedError(method);
    if (this.failure !== undefined) throw this.failure;
    // Requests are unlimited when neither the client nor this call specifies a
    // deadline or cancellation signal. Bounded callers can still prevent a
    // non-answering server from holding an experiment or resident shutdown
    // forever without changing the normal unlimited request contract.
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const started = process.hrtime.bigint();
    this.observeRequest({ phase: "start", id, method });
    let pending!: IRequest;
    const promise = new Promise<T>((resolve, reject) => {
      const effectiveTimeoutMs = timeoutMs ?? this.timeoutMs;
      pending = {
        resolve: (value) => resolve(value as T),
        reject,
        timer: undefined,
        signal,
      };
      this.pending.set(id, pending);
      if (effectiveTimeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          this.deletePending(id, pending);
          reject(new Error(`LSP request timed out: ${method}`));
        }, effectiveTimeoutMs);
      }
      if (signal !== undefined) {
        pending.abort = () => {
          this.deletePending(id, pending);
          reject(abortedError(method));
        };
        signal.addEventListener("abort", pending.abort, { once: true });
      }
    });
    try {
      this.write(payload);
    } catch (error) {
      // JSON serialization can fail synchronously for a cyclic value, BigInt,
      // or throwing accessor. The request already has an identity, observer
      // start event, timeout, and abort listener at this point, so settle that
      // same promise rather than escaping around all four cleanup owners.
      this.deletePending(id, pending);
      pending.reject(asError(error));
    }
    try {
      const result = await promise;
      this.observeRequest({
        phase: "end",
        id,
        method,
        status: "success",
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
      });
      return result;
    } catch (error) {
      this.observeRequest({
        phase: "end",
        id,
        method,
        status: "error",
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
      });
      throw error;
    }
  }

  public notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  public onNotification(
    method: string,
    listener: (params: unknown) => void,
  ): void {
    this.events.on(method, listener);
  }

  public close(): Promise<void> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }

  private observeRequest(event: LspClient.IRequestTrace): void {
    try {
      this.requestObserver?.(event);
    } catch {
      // Diagnostics must never change transport behavior.
    }
  }

  private async closeOnce(): Promise<void> {
    // A process that already exited (crashed, or exited in response to a
    // request it was never meant to answer, e.g. a bad `initialize`) cannot
    // answer `shutdown`; sending it anyway would just wait out the full
    // request timeout for nothing.
    if (!this.exited && this.failure === undefined) {
      // Teardown is the one bounded place: indexing requests wait forever, but a
      // `shutdown` that never comes back must not leak the child process. Wait
      // briefly for a graceful shutdown, then fall through to the kill below.
      await Promise.race([
        this.request("shutdown", null).catch(() => {}),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
          timer.unref?.();
        }),
      ]);
      /* c8 ignore start */
      if (!this.exited && this.failure === undefined) {
        try {
          this.notify("exit", null);
        } catch {
          // Ignore close errors.
        }
      }
      /* c8 ignore stop */
      await waitForExit(this.exit, SHUTDOWN_GRACE_MS);
    }
    // The group may outlive a server that exited cooperatively or crashed.
    // terminate() is a cheap liveness check when the whole tree is already gone
    // and the only path that can retire a descendant after its leader exits.
    await this.terminate();
  }

  private write(payload: unknown): void {
    if (this.failure !== undefined) return;
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const header = Buffer.from(
      `Content-Length: ${body.length}\r\n\r\n`,
      "ascii",
    );
    try {
      this.process.stdin.write(Buffer.concat([header, body]), (error) => {
        /* c8 ignore start -- Windows keeps the inherited named-pipe read
         * handle until child exit. This callback-specific EPIPE path is
         * POSIX-only and is exercised there. */
        if (error !== null && error !== undefined) {
          this.failTransport(stdinError(error));
        }
        /* c8 ignore stop */
      });
    } catch (error) {
      this.failTransport(stdinError(error));
    }
  }

  /**
   * Take one stdout chunk, and join only when a frame can be read.
   *
   * Concatenating the accumulated buffer with every chunk is quadratic in the
   * size of a frame, and this transport carries frames that are tens of
   * megabytes: a graph snapshot page. Node hands stdout over in chunks of
   * about sixty-four kibibytes, so a thirty megabyte response arrives in some
   * five hundred of them and the naive form copies the whole accumulation five
   * hundred times -- gigabytes of memcpy, and gigabytes of garbage, to move
   * thirty megabytes.
   *
   * That was most of the cost of paging a real C project. The producer
   * accounted for sixteen per cent of what the client spent waiting on it; the
   * rest was here, in this line, and it grew as the heap it churned did.
   *
   * So chunks accumulate unjoined. Once a header has been read the frame's
   * total size is known, and until that many bytes have arrived there is
   * nothing to look at -- the arithmetic is two integers. When the frame is
   * complete the chunks are joined once. One copy per frame instead of one per
   * chunk.
   */
  private onData(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.chunkBytes += chunk.length;
    if (
      this.needed !== 0 &&
      this.buffer.length + this.chunkBytes < this.needed
    ) {
      return;
    }
    if (this.chunks.length !== 0) {
      this.buffer = Buffer.concat(
        [this.buffer, ...this.chunks],
        this.buffer.length + this.chunkBytes,
      );
      this.chunks = [];
      this.chunkBytes = 0;
    }
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (this.buffer.length > MAX_HEADER_BYTES) {
          this.failTransport(
            new Error(
              `Language server exceeded the ${String(MAX_HEADER_BYTES)} byte LSP header limit.`,
            ),
          );
          this.reset();
        }
        return;
      }
      if (headerEnd > MAX_HEADER_BYTES) {
        this.failTransport(
          new Error(
            `Language server exceeded the ${String(MAX_HEADER_BYTES)} byte LSP header limit.`,
          ),
        );
        this.reset();
        return;
      }
      const header = this.buffer.slice(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (match === null) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > this.maxMessageBytes
      ) {
        this.failTransport(
          new Error(
            `Language server declared an invalid or oversized LSP frame (${String(length)} bytes; limit ${String(this.maxMessageBytes)}).`,
          ),
        );
        this.reset();
        return;
      }
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) {
        // Remember what the rest of this frame costs, so the chunks that carry
        // it accumulate without being joined or searched again.
        this.needed = bodyEnd;
        return;
      }
      this.needed = 0;
      const body = this.buffer.slice(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.slice(bodyEnd);
      // A malformed frame must not throw out of the stdout `data` listener as an
      // uncaught exception; drop it and keep draining the buffer.
      let message;
      try {
        message = JSON.parse(body) as {
          id?: number;
          method?: string;
          params?: unknown;
          result?: unknown;
          error?: { code?: number; message?: string; data?: unknown };
        };
      } catch {
        continue;
      }
      this.handleMessage(message);
    }
  }

  /** Drop everything buffered, joined or not, after a transport failure. */
  private reset(): void {
    this.buffer = Buffer.alloc(0);
    this.chunks = [];
    this.chunkBytes = 0;
    this.needed = 0;
  }

  private handleMessage(message: {
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code?: number; message?: string; data?: unknown };
  }): void {
    // A server-initiated request carries both an id and a method. It must be
    // answered or some servers block: gopls, for instance, withholds
    // documentSymbol until its `window/workDoneProgress/create` request is
    // acknowledged. A null result satisfies the acknowledgements we advertise.
    if (message.id !== undefined && message.method !== undefined) {
      if (this.serverRequestHandler === undefined) {
        this.write({ jsonrpc: "2.0", id: message.id, result: null });
        return;
      }
      void Promise.resolve()
        .then(() => this.serverRequestHandler!(message.method!, message.params))
        .then((result) =>
          this.write({ jsonrpc: "2.0", id: message.id, result: result ?? null }),
        )
        .catch((error: unknown) =>
          this.write({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: asError(error).message },
          }),
        );
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.deletePending(message.id, pending);
      if (message.error !== undefined) {
        pending.reject(
          new LspResponseError(
            message.error.code ?? -32603,
            message.error.message ?? "LSP request failed.",
            message.error.data,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method !== undefined) this.events.emit(
      message.method,
      message.params,
    );
  }

  private rejectAll(error: Error): void {
    for (const [id, request] of this.pending) {
      this.deletePending(id, request);
      request.reject(error);
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.rejectAll(this.failure);
  }

  private failTransport(error: Error): void {
    this.fail(error);
    /* c8 ignore start -- an exit event and a transport callback can race after
     * both have already rejected the same pending requests. */
    if (this.exited) return;
    /* c8 ignore stop */
    void this.terminate().catch(() => undefined);
  }

  private terminate(): Promise<void> {
    if (this.termination === undefined) {
      // Terminating the Windows Job Object supervisor reports an ordinary
      // numeric exit for that wrapper. Preserve the transport's
      // forced-termination contract for pending requests while the promise
      // below still waits for the exact owned process tree to disappear.
      /* c8 ignore start -- Windows-only forced-termination contract: POSIX
       * hosts short-circuit at `win32` and never fail here, while the Windows
       * lifecycle integration test exercises this branch. */
      if (process.platform === "win32" && this.failure === undefined) {
        this.fail(new Error("Language server exited (null, SIGKILL)."));
      }
      /* c8 ignore stop */
      this.termination = ownedProcess.terminate(
        this.process,
        this.exit,
        "Language server",
      );
    }
    return this.termination;
  }

  private deletePending(id: number, request: IRequest): void {
    this.pending.delete(id);
    if (request.timer !== undefined) clearTimeout(request.timer);
    if (request.abort !== undefined) {
      request.signal!.removeEventListener("abort", request.abort);
    }
  }
}

export namespace LspClient {
  export type IRequestObserver = (event: IRequestTrace) => void;
  export type IServerRequestHandler = (
    method: string,
    params: unknown,
  ) => unknown;

  export type IRequestTrace =
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
}

function abortedError(method: string): Error {
  const error = new Error(`LSP request aborted: ${method}`);
  error.name = "AbortError";
  return error;
}

function stdinError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Language server stdin failed: ${message}`);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function waitForExit(exit: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      /* c8 ignore next -- the timer and child-exit promise may race after the
       * first one has already settled this bounded wait. */
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    void exit.then(() => finish(true));
  });
}
