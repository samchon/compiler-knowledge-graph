import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { ownedProcess } from "../../utils/ownedProcess";
import { spawnableCommand } from "../../utils/spawnableCommand";
import { IGraphProvider } from "../IGraphProvider";

const PROTOCOL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;
const MAX_TIMER_MS = 2_147_483_647;

interface Child {
  process: ChildProcessWithoutNullStreams;
  response: string;
  responseBytes: number;
  stderr: string;
  exit: Promise<void>;
  termination?: Promise<void>;
}

interface Pending {
  child: Child;
  resolve: (value: undefined) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
}

/** Restartable NDJSON client for `scip-java kotlin-graph-server`. */
export class KotlinGraphProducerClient {
  private readonly root: string;
  private readonly provider: string;
  private readonly command: IGraphProvider.ICommand;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private child: Child | undefined;
  private readonly ownedChildren = new Set<Child>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private closing: Promise<void> | undefined;

  public constructor(options: KotlinGraphProducerClient.IOptions) {
    this.root = options.root;
    this.provider = options.provider;
    this.command = options.command;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 1 ||
      this.requestTimeoutMs > MAX_TIMER_MS
    ) {
      throw new TypeError(
        `${this.provider}: requestTimeoutMs must be an integer between 1 and ${String(MAX_TIMER_MS)}`,
      );
    }
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) {
      throw new TypeError(
        `${this.provider}: maxResponseBytes must be a positive safe integer`,
      );
    }
  }

  public produce(
    artifact: string,
    signal: AbortSignal | undefined,
  ): Promise<undefined> {
    if (this.closed) {
      return Promise.reject(new Error(`${this.provider}: session is closed`));
    }
    if (signal?.aborted === true) return Promise.reject(cancelled(this.provider));
    const child = this.ensureChild();
    child.stderr = "";
    const id = this.nextId++;
    return new Promise<undefined>((resolve, reject) => {
      const pending: Pending = {
        child,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.failChild(
            child,
            new Error(
              `${this.provider}: Kotlin graph request timed out after ${String(this.requestTimeoutMs)} ms${stderrSuffix(child)}`,
            ),
          );
        }, this.requestTimeoutMs),
        signal,
      };
      pending.timer.unref();
      this.pending.set(id, pending);
      if (signal !== undefined) {
        pending.abort = () => this.failChild(child, cancelled(this.provider));
        signal.addEventListener("abort", pending.abort, { once: true });
      }
      if (signal?.aborted === true) {
        pending.abort!();
        return;
      }
      child.process.stdin.write(
        `${JSON.stringify({ id, protocolVersion: PROTOCOL_VERSION, output: artifact })}\n`,
      );
    });
  }

  public close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    const failure = new Error(`${this.provider}: session is closed`);
    this.failPending(failure);
    this.child = undefined;
    this.closing = Promise.all(
      [...this.ownedChildren].map((child) => this.terminate(child)),
    ).then(() => undefined);
    return this.closing;
  }

  private ensureChild(): Child {
    /* c8 ignore next -- produce rejects a closed client before it can call here. */
    if (this.closed) throw new Error(`${this.provider}: session is closed`);
    if (
      this.child !== undefined &&
      this.child.process.exitCode === null &&
      this.child.process.signalCode === null
    ) {
      return this.child;
    }
    const invocation = spawnableCommand.append(
      { ...this.command, args: [...this.command.args] },
      ["kotlin-graph-server", "--cwd", this.root],
    );
    const command = ownedProcess.command(
      invocation.command,
      invocation.args,
      invocation.windowsVerbatimArguments,
    );
    const process = spawn(command.command, command.args, {
      cwd: this.root,
      env: globalThis.process.env,
      detached: ownedProcess.group(),
      shell: false,
      stdio: ownedProcess.stdio(command, ["pipe", "pipe", "pipe"]),
      windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
    }) as ChildProcessWithoutNullStreams;
    ownedProcess.start(process, command);
    const child: Child = {
      process,
      response: "",
      responseBytes: 0,
      stderr: "",
      exit: ownedProcess.exit(process),
    };
    this.child = child;
    this.ownedChildren.add(child);
    process.stdout.setEncoding("utf8");
    process.stderr.setEncoding("utf8");
    process.stdout.on("data", (chunk: string) => this.consume(child, chunk));
    process.stderr.on("data", (chunk: string) => {
      child.stderr = (child.stderr + chunk).slice(-MAX_STDERR_CHARS);
    });
    /* c8 ignore start -- the Windows process-group shim reports a failed
     * launch through stderr and exit; POSIX emits this direct child event. */
    process.on("error", (error) =>
      this.failChild(
        child,
        new Error(`${this.provider}: Kotlin graph server failed: ${error.message}`),
      ),
    );
    /* c8 ignore stop */
    process.stdin.on("error", (error) =>
      this.failChild(
        child,
        new Error(
          `${this.provider}: Kotlin graph server stdin failed: ${error.message}${stderrSuffix(child)}`,
        ),
      ),
    );
    process.on("exit", (code, signal) =>
      this.failChild(
        child,
        new Error(
          `${this.provider}: Kotlin graph server exited (${String(signal ?? code)})${stderrSuffix(child)}`,
        ),
      ),
    );
    return child;
  }

  private consume(child: Child, chunk: string): void {
    // Only a buffered event delivered after retirement can name an old child;
    // owned termination discards it and has no state effect.
    /* c8 ignore next */
    if (this.child !== child) return;
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      if (newline === -1) {
        if (start < chunk.length) this.append(child, chunk.slice(start));
        return;
      }
      if (!this.append(child, chunk.slice(start, newline))) return;
      const line = child.response.trim();
      child.response = "";
      child.responseBytes = 0;
      start = newline + 1;
      if (line === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        this.failChild(
          child,
          new Error(
            `${this.provider}: invalid Kotlin graph server response: ${asError(error).message}`,
          ),
        );
        return;
      }
      let response: IResponse;
      try {
        response = parseResponse(value, this.provider);
      } catch (error) {
        this.failChild(child, asError(error));
        return;
      }
      const pending = this.pending.get(response.id);
      if (pending === undefined) {
        this.failChild(
          child,
          new Error(
            `${this.provider}: unexpected Kotlin graph response id ${String(response.id)}`,
          ),
        );
        return;
      }
      // Request IDs never repeat and a pending request is inserted only with
      // the one current child that receives its response.
      /* c8 ignore start */
      if (pending.child !== child) {
        this.failChild(
          child,
          new Error(
            `${this.provider}: Kotlin graph response crossed producer processes`,
          ),
        );
        return;
      }
      /* c8 ignore stop */
      if (response.ok) this.settle(response.id, pending);
      else {
        this.settle(
          response.id,
          pending,
          new Error(`${this.provider}: ${response.error}${stderrSuffix(child)}`),
        );
      }
    }
  }

  private append(child: Child, chunk: string): boolean {
    child.responseBytes += Buffer.byteLength(chunk, "utf8");
    if (child.responseBytes > this.maxResponseBytes) {
      this.failChild(
        child,
        new Error(
          `${this.provider}: Kotlin graph response exceeded the ${String(this.maxResponseBytes)} byte limit`,
        ),
      );
      return false;
    }
    child.response += chunk;
    return true;
  }

  private settle(id: number, pending: Pending, error?: Error): void {
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.abort !== undefined) {
      pending.signal?.removeEventListener("abort", pending.abort);
    }
    if (error === undefined) pending.resolve(undefined);
    else pending.reject(error);
  }

  private failChild(child: Child, error: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.failPending(error, child);
    void this.terminate(child)
      .then(() => this.ownedChildren.delete(child))
      .catch(() => undefined);
  }

  private failPending(error: Error, child?: Child): void {
    for (const [id, pending] of this.pending) {
      if (child !== undefined) {
        // One current producer owns every pending request; a replacement starts
        // only after this synchronous loop settles it.
        /* c8 ignore next */
        if (pending.child !== child) continue;
      }
      this.settle(id, pending, error);
    }
  }

  private terminate(child: Child): Promise<void> {
    child.termination ??= ownedProcess.terminate(
      child.process,
      child.exit,
      this.provider,
      { cooperativeStdin: true },
    );
    return child.termination;
  }
}

function parseResponse(value: unknown, provider: string): IResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${provider}: Kotlin graph response must be an object`);
  }
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.id) || row.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`${provider}: invalid Kotlin graph response identity`);
  }
  if (row.ok === true) return { id: row.id as number, ok: true };
  if (row.ok === false && typeof row.error === "string" && row.error !== "") {
    return { id: row.id as number, ok: false, error: row.error };
  }
  throw new Error(`${provider}: invalid Kotlin graph response result`);
}

function cancelled(provider: string): Error {
  const error = new Error(`${provider}: Kotlin graph request was aborted`);
  error.name = "AbortError";
  return error;
}

function stderrSuffix(child: Child): string {
  const text = child.stderr.trim();
  return text === "" ? "" : `\nstderr:\n${text}`;
}

function asError(error: unknown): Error {
  /* c8 ignore next -- JSON.parse and parseResponse throw Error instances. */
  return error instanceof Error ? error : new Error(String(error));
}

type IResponse =
  | { id: number; ok: true }
  | { id: number; ok: false; error: string };

export namespace KotlinGraphProducerClient {
  export interface IOptions {
    root: string;
    provider: string;
    command: IGraphProvider.ICommand;
    requestTimeoutMs?: number;
    maxResponseBytes?: number;
  }
}
