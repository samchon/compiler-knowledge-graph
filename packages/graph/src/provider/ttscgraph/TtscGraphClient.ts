import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { freezeDeep } from "../../utils/freezeDeep";
import { sealedMap } from "../../utils/sealedMap";
import { ownedProcess } from "../../utils/ownedProcess";
import { spawnableCommand } from "../../utils/spawnableCommand";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { adaptTtscGraphDump } from "./adaptTtscGraphDump";
import { ITtscGraphSnapshot } from "./ITtscGraphSnapshot";
import { parseTtscGraphSnapshot } from "./parseTtscGraphSnapshot";

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
const MAX_TIMER_MS = 2_147_483_647;

interface NativeChild {
  process: ChildProcessWithoutNullStreams;
  stdoutChunks: string[];
  stdoutBytes: number;
  stderr: string;
  exit: Promise<void>;
  termination?: Promise<void>;
}

interface Pending {
  child: NativeChild;
  resolve: (value: ITtscGraphSnapshot) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
}

/** Resident, restartable NDJSON client for `ttscgraph serve`. */
export class TtscGraphClient implements IBulkGraphSession {
  public readonly kind = "bulk" as const;
  public readonly languages = ["typescript"] as const;
  public readonly root: string;

  private readonly command: string;
  private readonly args: readonly string[];
  private readonly windowsVerbatimArguments: boolean | undefined;
  private readonly windowsDoubleEscapeArguments: boolean | undefined;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly validate: (
    snapshot: IBulkGraphSession.ISnapshot,
  ) => void;
  private child: NativeChild | undefined;
  private readonly ownedChildren = new Set<NativeChild>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;
  private snapshot: IBulkGraphSession.ISnapshot | undefined;
  private childHasSnapshot = false;
  private version = 0;

  public constructor(options: TtscGraphClient.IOptions) {
    const requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs <= 0 ||
      requestTimeoutMs > MAX_TIMER_MS
    ) {
      throw new TypeError(
        `ttscgraph: requestTimeoutMs must be an integer between 1 and ${String(MAX_TIMER_MS)}`,
      );
    }
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
      throw new TypeError(
        "ttscgraph: maxResponseBytes must be a positive safe integer",
      );
    }
    this.root = options.root;
    this.command = options.command;
    this.args = options.args ?? [];
    this.windowsVerbatimArguments = options.windowsVerbatimArguments;
    this.windowsDoubleEscapeArguments =
      options.windowsDoubleEscapeArguments;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.validate = options.validate ?? (() => undefined);
  }

  public get generation(): number {
    return this.version;
  }

  public get current(): IBulkGraphSession.ISnapshot | undefined {
    return this.snapshot;
  }

  public refresh(
    options: TtscGraphClient.IRefreshOptions = {},
  ): Promise<IBulkGraphSession.IRefresh> {
    if (this.closed) {
      return Promise.reject(new Error("ttscgraph: session is closed"));
    }
    return this.enqueue(async () => {
      this.assertOpen();
      try {
        const response = await this.request(options.signal);
        if (response.mode === "error") {
          throw new Error(`ttscgraph: ${response.error}`);
        }
        const mode: IBulkGraphSession.Mode = response.mode;
        if (!response.changed) {
          if (this.snapshot === undefined || !this.childHasSnapshot) {
            throw new Error(
              "ttscgraph: first response was unchanged without a snapshot",
            );
          }
          assertCapabilitiesMatch(
            response.capabilities,
            this.snapshot.provenance.capabilities,
          );
          return {
            changed: false,
            generation: this.version,
            mode,
            snapshot: this.snapshot,
          };
        }

        const adapted = adaptTtscGraphDump(response.dump, this.root);
        const provenance: IBulkGraphSession.IProvenance = {
          ...adapted.provenance,
          protocolVersion: response.protocolVersion,
        };
        assertCapabilitiesMatch(response.capabilities, provenance.capabilities);
        if (
          mode === "incremental" &&
          this.snapshot !== undefined &&
          this.snapshot.provenance.universe !== provenance.universe
        ) {
          throw new Error(
            "ttscgraph: incremental snapshot reports a build universe that moved since the last generation, so its program cannot have been reused",
          );
        }
        const next: IBulkGraphSession.ISnapshot = {
          languages: ["typescript"],
          nodes: adapted.nodes,
          edges: adapted.edges,
          diagnostics: adapted.diagnostics,
          sources: adapted.sources,
          provenance,
          warnings: adapted.warnings,
        };
        next.sources = sealedMap(next.sources, "the ttscgraph snapshot");
        freezeDeep(next, "the ttscgraph snapshot");
        this.validate(next);
        this.snapshot = next;
        this.childHasSnapshot = true;
        this.version += 1;
        return {
          changed: true,
          generation: this.version,
          mode,
          snapshot: next,
        };
      } catch (error) {
        const child = this.child;
        if (child !== undefined) this.failChild(child, asError(error));
        throw error;
      }
    }, options.signal);
  }

  /** Begin shutdown immediately and settle after every owned child exits. */
  public close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    const error = new Error("ttscgraph: session is closed");
    const child = this.child;
    if (child !== undefined) this.failChild(child, error);
    this.failPending(error);
    this.closing = Promise.all(
      [...this.ownedChildren].map((owned) => this.terminate(owned)),
    ).then(() => undefined);
    return this.closing;
  }

  private request(signal?: AbortSignal): Promise<ITtscGraphSnapshot> {
    if (signal?.aborted) throw cancelledError(signal);
    const child = this.ensureChild();
    const id = this.nextId++;
    return new Promise<ITtscGraphSnapshot>((resolve, reject) => {
      const pending: Pending = {
        child,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.failChild(
            child,
            new Error(
              `ttscgraph: snapshot request timed out after ${String(this.requestTimeoutMs)} ms${stderrSuffix(child)}`,
            ),
          );
        }, this.requestTimeoutMs),
        signal,
      };
      pending.timer.unref();
      // Own the request before installing the listener. Abort dispatch is
      // synchronous, so a signal that aborts during registration must find and
      // settle this pending entry instead of retiring the child around an
      // orphaned promise.
      this.pending.set(id, pending);
      if (signal !== undefined) {
        pending.abort = () =>
          this.failChild(child, cancelledError(signal, child));
        signal.addEventListener("abort", pending.abort, { once: true });
      }
      if (signal?.aborted) {
        pending.abort!();
        return;
      }
      child.process.stdin.write(`${JSON.stringify({ id })}\n`, (error) => {
        /* c8 ignore start -- Windows keeps the inherited named-pipe read
         * handle until child exit. This callback-specific EPIPE path is
         * POSIX-only and is exercised there. */
        if (error === null || error === undefined) return;
        if (this.pending.get(id) !== pending) return;
        this.failChild(
          child,
          new Error(`ttscgraph: could not request snapshot: ${error.message}`),
        );
        /* c8 ignore stop */
      });
    });
  }

  private ensureChild(): NativeChild {
    this.assertOpen();
    if (
      this.child !== undefined &&
      this.child.process.exitCode === null &&
      this.child.process.signalCode === null
    ) {
      return this.child;
    }
    const spawnable = spawnableCommand.append(
      {
        command: this.command,
        args: [...this.args],
        windowsVerbatimArguments:
          this.windowsVerbatimArguments,
        windowsDoubleEscapeArguments:
          this.windowsDoubleEscapeArguments,
      },
      ["serve", "--cwd", this.root],
    );
    const ownedCommand = ownedProcess.command(
      spawnable.command,
      spawnable.args,
      spawnable.windowsVerbatimArguments,
    );
    const spawned = spawn(
      ownedCommand.command,
      ownedCommand.args,
      {
        cwd: this.root,
        env: process.env,
        detached: ownedProcess.group(),
        shell: false,
        stdio: ownedProcess.stdio(ownedCommand, [
          "pipe",
          "pipe",
          "pipe",
        ]),
        windowsVerbatimArguments:
          ownedCommand.windowsVerbatimArguments,
        windowsHide: true,
      },
    ) as ChildProcessWithoutNullStreams;
    ownedProcess.start(spawned, ownedCommand);
    const child: NativeChild = {
      process: spawned,
      stdoutChunks: [],
      stdoutBytes: 0,
      stderr: "",
      exit: ownedProcess.exit(spawned),
    };
    this.child = child;
    this.childHasSnapshot = false;
    this.ownedChildren.add(child);
    spawned.stdout.setEncoding("utf8");
    spawned.stderr.setEncoding("utf8");
    spawned.stdout.on("data", (chunk: string) => this.consume(child, chunk));
    spawned.stderr.on("data", (chunk: string) => {
      child.stderr = (child.stderr + chunk).slice(-64 * 1024);
    });
    /* c8 ignore start -- direct POSIX spawn failures are exercised on POSIX.
     * Windows starts a stable Job Object supervisor first and reports a nested
     * command launch failure through that process instead. */
    spawned.on("error", (error) =>
      this.failChild(
        child,
        new Error(`ttscgraph: process failed: ${error.message}`),
      ),
    );
    /* c8 ignore stop */
    /* c8 ignore start */
    spawned.stdin.on("error", (error) =>
      this.failChild(
        child,
        new Error(`ttscgraph: stdin failed: ${error.message}`),
      ),
    );
    /* c8 ignore stop */
    spawned.on("exit", (code, signal) => {
      const status = signal ?? code;
      this.failChild(
        child,
        new Error(
          `ttscgraph: process exited (${status})${stderrSuffix(child)}`,
        ),
      );
    });
    return child;
  }

  private consume(child: NativeChild, chunk: string): void {
    if (this.child !== child) return;
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      if (newline === -1) {
        if (
          start < chunk.length &&
          !this.appendResponseChunk(child, chunk.slice(start))
        ) {
          return;
        }
        return;
      }
      if (!this.appendResponseChunk(child, chunk.slice(start, newline))) return;
      const line = child.stdoutChunks.join("").trim();
      child.stdoutChunks.length = 0;
      child.stdoutBytes = 0;
      start = newline + 1;
      if (line === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        this.failChild(
          child,
          new Error(
            `ttscgraph: invalid NDJSON response: ${asError(error).message}`,
          ),
        );
        return;
      }
      let response: ITtscGraphSnapshot;
      try {
        response = parseTtscGraphSnapshot(value);
      } catch (error) {
        this.failChild(child, asError(error));
        return;
      }
      const pending = this.pending.get(response.id);
      if (pending === undefined || pending.child !== child) {
        this.failChild(
          child,
          new Error(`ttscgraph: unexpected response id ${String(response.id)}`),
        );
        return;
      }
      this.settlePending(response.id, pending, response);
    }
  }

  private appendResponseChunk(child: NativeChild, chunk: string): boolean {
    child.stdoutBytes += Buffer.byteLength(chunk, "utf8");
    if (child.stdoutBytes > this.maxResponseBytes) {
      this.failChild(
        child,
        new Error(
          `ttscgraph: response exceeded the ${String(this.maxResponseBytes)} byte frame limit`,
        ),
      );
      return false;
    }
    child.stdoutChunks.push(chunk);
    return true;
  }

  private failChild(
    child: NativeChild,
    error: Error,
  ): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.childHasSnapshot = false;
    this.failPending(error, child);
    this.retire(child);
  }

  private retire(child: NativeChild): void {
    const termination = this.terminate(child);
    void termination
      .then(() => {
        this.ownedChildren.delete(child);
      })
      .catch(() => undefined);
  }

  private terminate(child: NativeChild): Promise<void> {
    if (child.termination === undefined) {
      child.termination = ownedProcess.terminate(
        child.process,
        child.exit,
        "ttscgraph",
        { cooperativeStdin: true },
      );
      // A protocol failure retires the child before a caller necessarily asks
      // to close the client. Keep the rejection observed here while preserving
      // the original promise for close() to report.
      void child.termination.catch(() => undefined);
    }
    return child.termination;
  }

  private failPending(error: Error, child?: NativeChild): void {
    for (const [id, pending] of this.pending) {
      if (child === undefined || pending.child === child) {
        this.settlePending(id, pending, error);
      }
    }
  }

  private settlePending(
    id: number,
    pending: Pending,
    result: ITtscGraphSnapshot | Error,
  ): void {
    /* c8 ignore next -- callers retrieved this entry or are iterating it. */
    if (this.pending.get(id) !== pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.abort !== undefined) {
      pending.signal.removeEventListener("abort", pending.abort);
    }
    if (result instanceof Error) pending.reject(result);
    else pending.resolve(result);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("ttscgraph: session is closed");
  }

  private enqueue<T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: Error) => void;
    let started = false;
    let settled = false;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = (value) => {
        /* c8 ignore next -- cancelled queued tasks never call this resolver. */
        if (settled) return;
        settled = true;
        resolve(value);
      };
      rejectResult = (error) => {
        /* c8 ignore next -- cancelled queued tasks never call this rejecter. */
        if (settled) return;
        settled = true;
        reject(error);
      };
    });
    const cancelQueued = (): void => {
      if (!started) rejectResult(cancelledError(signal));
    };
    if (signal?.aborted) {
      rejectResult(cancelledError(signal));
      return result;
    }
    signal?.addEventListener("abort", cancelQueued, { once: true });
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        started = true;
        signal?.removeEventListener("abort", cancelQueued);
        if (settled) return;
        try {
          resolveResult(await task());
        } catch (error) {
          rejectResult(asError(error));
        }
      });
    return result;
  }
}

export namespace TtscGraphClient {
  export interface IOptions {
    root: string;
    command: string;
    args?: readonly string[];
    windowsVerbatimArguments?: boolean;
    windowsDoubleEscapeArguments?: boolean;
    /** Maximum time for one native snapshot response. */
    requestTimeoutMs?: number;
    /** Maximum bytes retained before one NDJSON response delimiter. */
    maxResponseBytes?: number;
    /** Provider contract gate run before a generation becomes current. */
    validate?: (snapshot: IBulkGraphSession.ISnapshot) => void;
  }

  export interface IRefreshOptions {
    /** Cancel this refresh and retire the native child generation it owns. */
    signal?: AbortSignal;
  }
}

function cancelledError(signal?: AbortSignal, child?: NativeChild): Error {
  const error = new Error(
    `ttscgraph: snapshot request cancelled${abortDetail(signal)}${
      child === undefined ? "" : stderrSuffix(child)
    }`,
  );
  error.name = "AbortError";
  return error;
}

function abortDetail(signal?: AbortSignal): string {
  const reason = signal?.reason;
  if (reason === undefined) return "";
  try {
    return `: ${reason instanceof Error ? reason.message : String(reason)}`;
  } catch {
    return "";
  }
}

function stderrSuffix(child: NativeChild): string {
  const stderr = child.stderr.trim();
  return stderr === "" ? "" : `: ${stderr}`;
}

function asError(error: unknown): Error {
  /* c8 ignore next */
  return error instanceof Error ? error : new Error(String(error));
}

function assertCapabilitiesMatch(
  envelope: readonly string[],
  dump: readonly string[],
): void {
  const compare = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  const left = JSON.stringify([...envelope].sort(compare));
  const right = JSON.stringify([...dump].sort(compare));
  if (left !== right) {
    throw new Error(
      "ttscgraph: response capabilities disagree with the snapshot provenance",
    );
  }
}
