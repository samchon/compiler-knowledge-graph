import { pathToFileURL } from "node:url";

import { GraphLanguage } from "../../typings";
import { LspClient } from "../../lsp/LspClient";
import { LspResponseError } from "../../lsp/LspResponseError";
import { GraphSnapshotProtocol } from "../GraphSnapshotProtocol";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { IRustGraphSnapshot } from "./IRustGraphSnapshot";
import { IRustGraphSnapshotParams } from "./IRustGraphSnapshotParams";
import { RustGraphCache } from "./RustGraphCache";
import { RustGraphSnapshotAdapter } from "./RustGraphSnapshotAdapter";

const GRAPH_METHOD = "samchon/graphSnapshot";
const SERVER_CANCELLED = -32802;
const CONTENT_MODIFIED = -32801;
const DEFAULT_READY_TIMEOUT_MS = 300_000;
const RETRY_DELAY_MS = 50;

/** Resident LSP client for the pinned HIR graphSnapshot producer. */
export class RustGraphClient implements IBulkGraphSession {
  public readonly kind = "bulk" as const;
  public readonly languages: readonly GraphLanguage[] = ["rust"];
  public readonly root: string;

  private readonly lsp: LspClient;
  private adapter: RustGraphSnapshotAdapter;
  private readonly cache: RustGraphCache.IProps;
  private readonly validate: (
    snapshot: IBulkGraphSession.ISnapshot,
  ) => void;
  private readonly initializationOptions: unknown;
  private readonly requestTimeoutMs: number | undefined;
  private readonly readyTimeoutMs: number;
  private readonly lifecycleAbort = new AbortController();
  private queue: Promise<void> = Promise.resolve();
  private initialized: Promise<void> | undefined;
  private checkpointPending = false;
  private version: number;
  private closed = false;
  private closing: Promise<void> | undefined;

  public constructor(options: RustGraphClient.IOptions) {
    this.root = options.root;
    this.validate = options.validate ?? (() => undefined);
    this.cache = {
      root: options.root,
      producerCommit: options.producerCommit,
      ...(options.cacheRoot === undefined
        ? {}
        : { cacheRoot: options.cacheRoot }),
    };
    let restored: RustGraphSnapshotAdapter | undefined;
    const cached = RustGraphCache.load(this.cache, (state) => {
      const candidate = new RustGraphSnapshotAdapter(
        options.root,
        options.producerCommit,
        state,
      );
      restored = candidate;
      return true;
    });
    if (cached === undefined || restored === undefined) {
      RustGraphCache.clear(this.cache);
      this.adapter = new RustGraphSnapshotAdapter(
        options.root,
        options.producerCommit,
      );
    } else {
      this.adapter = restored;
    }
    this.checkpointPending = this.adapter.persistedCheckpoint !== undefined;
    this.version = 0;
    this.initializationOptions = options.initializationOptions;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    /* c8 ignore start -- production native binaries need no arguments; the
     * protocol fixture itself is a JavaScript file and therefore needs one. */
    const args = options.args ?? [];
    /* c8 ignore stop */
    this.lsp = new LspClient(
      options.command,
      args,
      options.requestTimeoutMs,
      options.root,
      options.maxMessageBytes,
      options.windowsVerbatimArguments,
      undefined,
      serverRequest,
    );
  }

  public get generation(): number {
    return this.version;
  }

  public get current(): IBulkGraphSession.ISnapshot | undefined {
    return this.adapter.store.current;
  }

  public refresh(
    options: { signal?: AbortSignal } = {},
  ): Promise<IBulkGraphSession.IRefresh> {
    if (this.closed) {
      return Promise.reject(new Error("rust HIR graph: session is closed"));
    }
    return this.enqueue(async () => {
      const signal = combineSignals(options.signal, this.lifecycleAbort.signal);
      this.assertOpen();
      await this.initialize(signal);
      const raw = await this.requestSnapshot(signal);
      const prepared = this.adapter.prepare(raw);
      if (!prepared.changed) {
        return {
          changed: false,
          generation: this.version,
          mode: prepared.mode,
          snapshot: prepared.snapshot,
        };
      }
      new GraphSnapshotProtocol.Store(this.root).apply(prepared.state.frames, {
        signal,
        validate: this.validate,
      });
      const warnings: string[] = [];
      try {
        RustGraphCache.save(
          this.cache,
          prepared.sequence,
          prepared.generation,
          prepared.state,
        );
      } catch (error) {
        warnings.push(
          `rust HIR graph: the validated snapshot is resident but its restart checkpoint could not be persisted: ${asError(error).message}`,
        );
      }
      const snapshot = this.adapter.store.apply(prepared.frames, {
        signal,
        validate: this.validate,
        warnings,
      });
      prepared.commit(snapshot);
      this.version += 1;
      return {
        changed: true,
        generation: this.version,
        mode: prepared.mode,
        snapshot,
      };
    }, options.signal);
  }

  public close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.lifecycleAbort.abort(new Error("rust HIR graph: session is closed"));
    this.closing = this.lsp.close();
    return this.closing;
  }

  private initialize(signal: AbortSignal): Promise<void> {
    this.initialized ??= this.initializeOnce(this.lifecycleAbort.signal);
    return signal === this.lifecycleAbort.signal
      ? this.initialized
      : raceWithAbort(this.initialized, signal);
  }

  private async initializeOnce(signal: AbortSignal): Promise<void> {
    await this.lsp.request(
      "initialize",
      {
        processId: process.pid,
        rootUri: pathToFileURL(this.root).href,
        capabilities: { workspace: { configuration: true } },
        ...(this.initializationOptions === undefined
          ? {}
          : { initializationOptions: this.initializationOptions }),
        workspaceFolders: [
          {
            uri: pathToFileURL(this.root).href,
            name: "samchon-graph-rust",
          },
        ],
      },
      this.requestTimeoutMs,
      signal,
    );
    this.lsp.notify("initialized", {});
  }

  private async requestSnapshot(signal: AbortSignal): Promise<IRustGraphSnapshot> {
    const deadline = performance.now() + this.readyTimeoutMs;
    let checkpoint = this.checkpointPending
      ? this.adapter.persistedCheckpoint
      : undefined;
    this.checkpointPending = false;
    for (;;) {
      throwIfAborted(signal);
      const params: IRustGraphSnapshotParams = {
        ...(this.adapter.persistedCheckpoint?.generation === undefined
          ? {}
          : {
              knownGeneration:
                this.adapter.persistedCheckpoint.generation,
            }),
        ...(checkpoint === undefined ? {} : { checkpoint }),
      };
      try {
        return await this.lsp.request<IRustGraphSnapshot>(
          GRAPH_METHOD,
          params,
          this.requestTimeoutMs,
          signal,
        );
      } catch (error) {
        if (
          checkpoint !== undefined &&
          error instanceof LspResponseError &&
          error.code === SERVER_CANCELLED &&
          /checkpoint|persisted/iu.test(error.message)
        ) {
          this.adapter.discardPersistedSnapshot();
          RustGraphCache.clear(this.cache);
          checkpoint = undefined;
          continue;
        }
        if (
          !(error instanceof LspResponseError) ||
          (error.code !== SERVER_CANCELLED && error.code !== CONTENT_MODIFIED)
        ) {
          throw error;
        }
        if (performance.now() >= deadline) {
          throw new Error(
            `rust HIR graph: producer did not become ready within ${String(this.readyTimeoutMs)} ms: ${error.message}`,
          );
        }
        await delay(RETRY_DELAY_MS, signal);
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("rust HIR graph: session is closed");
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
        settled = true;
        resolve(value);
      };
      rejectResult = (error) => {
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

export namespace RustGraphClient {
  export interface IOptions {
    root: string;
    command: string;
    args?: readonly string[];
    producerCommit: string;
    initializationOptions?: unknown;
    requestTimeoutMs?: number;
    readyTimeoutMs?: number;
    maxMessageBytes?: number;
    windowsVerbatimArguments?: boolean;
    cacheRoot?: string;
    validate?: (snapshot: IBulkGraphSession.ISnapshot) => void;
  }
}

function serverRequest(method: string, params: unknown): unknown {
  if (method !== "workspace/configuration") return null;
  const items = (params as { items?: unknown })?.items;
  return Array.isArray(items) ? items.map(() => null) : [];
}

function delay(milliseconds: number, signal: AbortSignal): Promise<undefined> {
  /* c8 ignore start -- requestSnapshot checks this signal immediately before
   * entering backoff; this closes only the intervening abort race. */
  if (signal.aborted) return Promise.reject(cancelledError(signal));
  /* c8 ignore stop */
  return new Promise<undefined>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(undefined);
    }, milliseconds);
    timer.unref?.();
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(cancelledError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function combineSignals(
  caller: AbortSignal | undefined,
  lifecycle: AbortSignal,
): AbortSignal {
  return caller === undefined ? lifecycle : AbortSignal.any([caller, lifecycle]);
}

function raceWithAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  /* c8 ignore start -- enqueue rejects pre-aborted callers before a task can
   * reach this initialization boundary. */
  if (signal.aborted) return Promise.reject(cancelledError(signal));
  /* c8 ignore stop */
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      reject(cancelledError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    void task
      .then((value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      })
      .catch((error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  /* c8 ignore start -- queue cancellation and the LSP request fence exercise
   * deterministic aborts; this is the instruction-boundary race guard. */
  if (signal.aborted) throw cancelledError(signal);
  /* c8 ignore stop */
}

function cancelledError(signal?: AbortSignal): Error {
  /* c8 ignore start -- standards-compliant AbortSignal.abort() always
   * supplies a reason; optionality protects foreign signal shims. */
  const reason = signal?.reason === undefined ? "" : `: ${String(signal.reason)}`;
  /* c8 ignore stop */
  const error = new Error(
    `rust HIR graph: snapshot request cancelled${reason}`,
  );
  error.name = "AbortError";
  return error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
