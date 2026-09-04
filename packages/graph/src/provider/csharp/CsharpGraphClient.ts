import { pathToFileURL } from "node:url";

import { LspClient } from "../../lsp/LspClient";
import { LspResponseError } from "../../lsp/LspResponseError";
import { GraphLanguage } from "../../typings";
import { GraphSnapshotProtocol } from "../GraphSnapshotProtocol";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { ICsharpGraphSnapshot } from "./ICsharpGraphSnapshot";

const COMMAND = "csharp.graph.snapshot";
const CONTENT_MODIFIED = -32801;
const RETRY_DELAY_MS = 50;

/** Resident client for one immutable Roslyn Solution generation. */
export class CsharpGraphClient implements IBulkGraphSession {
  public readonly kind = "bulk" as const;
  public readonly languages: readonly GraphLanguage[] = ["csharp"];
  public readonly root: string;

  private readonly lsp: LspClient;
  private readonly store: GraphSnapshotProtocol.Store;
  private readonly validate: (snapshot: IBulkGraphSession.ISnapshot) => void;
  private readonly initializationOptions: unknown;
  private readonly requestTimeoutMs: number | undefined;
  private readonly readyTimeoutMs: number | undefined;
  private readonly lifecycleAbort = new AbortController();
  private initialized: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private version = 0;
  private closed = false;
  private closing: Promise<void> | undefined;

  public constructor(options: CsharpGraphClient.IOptions) {
    this.root = options.root;
    this.store = new GraphSnapshotProtocol.Store(options.root);
    this.validate = options.validate;
    this.initializationOptions = options.initializationOptions;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.readyTimeoutMs = options.readyTimeoutMs;
    this.lsp = new LspClient(
      options.command,
      options.args,
      options.requestTimeoutMs,
      options.root,
      options.maxMessageBytes,
      options.windowsVerbatimArguments,
    );
  }

  public get generation(): number {
    return this.version;
  }

  public get current(): IBulkGraphSession.ISnapshot | undefined {
    return this.store.current;
  }

  public refresh(
    options: { signal?: AbortSignal } = {},
  ): Promise<IBulkGraphSession.IRefresh> {
    if (this.closed) {
      return Promise.reject(new Error("Roslyn workspace graph: session is closed"));
    }
    return this.enqueue(async () => {
      const signal = combineSignals(options.signal, this.lifecycleAbort.signal);
      await this.initialize(signal);
      const requestStarted = performance.now();
      const raw = await this.requestSnapshot(signal);
      trace("request", performance.now() - requestStarted);
      const prior = this.store.current;
      assertEnvelope(raw);
      if (raw.mode === "unchanged") {
        if (
          prior === undefined ||
          raw.frames.length !== 0 ||
          raw.sequence !== prior.protocol?.sequence ||
          raw.generation !== prior.protocol.generation ||
          raw.universe !== prior.provenance.universe
        ) {
          throw new Error(
            "Roslyn workspace graph: unchanged envelope does not match the committed generation",
          );
        }
        return {
          changed: false,
          generation: this.version,
          mode: "unchanged",
          snapshot: prior,
        };
      }
      assertTransactionEnvelope(raw, prior);
      const applyStarted = performance.now();
      const snapshot = this.store.apply(raw.frames, {
        signal,
        validate: this.validate,
        reuseValidatedFacts: true,
      });
      trace("store", performance.now() - applyStarted);
      /* c8 ignore start -- the store validates these same frame coordinates
       * before committing; this guards against a future store regression. */
      if (
        raw.sequence !== snapshot.protocol?.sequence ||
        raw.generation !== snapshot.protocol.generation ||
        raw.universe !== snapshot.provenance.universe
      ) {
        throw new Error(
          "Roslyn workspace graph: response mode disagrees with its validated transaction",
        );
      }
      /* c8 ignore stop */
      this.version += 1;
      return {
        changed: true,
        generation: this.version,
        mode: raw.mode,
        snapshot,
      };
    }, options.signal);
  }

  public close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.lifecycleAbort.abort(
      new Error("Roslyn workspace graph: session is closed"),
    );
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
            name: "samchon-graph-csharp",
          },
        ],
      },
      this.requestTimeoutMs,
      signal,
    );
    this.lsp.notify("initialized", {});
  }

  private async requestSnapshot(signal: AbortSignal): Promise<ICsharpGraphSnapshot> {
    const deadline =
      this.readyTimeoutMs === undefined
        ? undefined
        : performance.now() + this.readyTimeoutMs;
    for (;;) {
      try {
        return await this.lsp.request<ICsharpGraphSnapshot>(
          "workspace/executeCommand",
          {
            command: COMMAND,
            arguments: [
              {
                knownGeneration:
                  this.store.current?.protocol?.generation ?? null,
              },
            ],
          },
          this.requestTimeoutMs,
          signal,
        );
      } catch (error) {
        if (!(error instanceof LspResponseError) || error.code !== CONTENT_MODIFIED) {
          throw error;
        }
        const remaining =
          deadline === undefined ? undefined : deadline - performance.now();
        if (remaining !== undefined && remaining <= 0) {
          throw new Error(
            `Roslyn workspace graph: producer inputs did not settle within ${String(this.readyTimeoutMs)} ms: ${error.message}`,
          );
        }
        await delay(
          remaining === undefined
            ? RETRY_DELAY_MS
            : Math.min(RETRY_DELAY_MS, remaining),
          signal,
        );
      }
    }
  }

  private enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
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
      if (!started) rejectResult(abortError(signal!));
    };
    if (signal?.aborted) {
      rejectResult(abortError(signal));
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

export namespace CsharpGraphClient {
  export interface IOptions {
    root: string;
    command: string;
    args: readonly string[];
    initializationOptions?: unknown;
    requestTimeoutMs?: number;
    readyTimeoutMs?: number;
    maxMessageBytes?: number;
    windowsVerbatimArguments?: boolean;
    validate: (snapshot: IBulkGraphSession.ISnapshot) => void;
  }
}

function assertTransactionEnvelope(
  raw: ICsharpGraphSnapshot,
  prior: IBulkGraphSession.ISnapshot | undefined,
): void {
  const begins = raw.frames.filter(
    (frame): frame is GraphSnapshotProtocol.IBegin => frame.type === "begin",
  );
  const commits = raw.frames.filter(
    (frame): frame is GraphSnapshotProtocol.ICommit => frame.type === "commit",
  );
  if (
    begins.length !== 1 ||
    commits.length !== 1 ||
    begins[0]!.sequence !== raw.sequence ||
    begins[0]!.generation !== raw.generation ||
    begins[0]!.universe !== raw.universe ||
    commits[0]!.sequence !== raw.sequence ||
    commits[0]!.generation !== raw.generation
  ) {
    throw new Error(
      "Roslyn workspace graph: envelope disagrees with its frame transaction",
    );
  }
  const begin = begins[0]!;
  const full =
    begin.baseSequence === undefined && begin.baseGeneration === undefined;
  const exactBase =
    prior?.protocol !== undefined &&
    begin.baseSequence === prior.protocol.sequence &&
    begin.baseGeneration === prior.protocol.generation;
  const expected =
    prior === undefined
      ? full
        ? "initial"
        : undefined
      : prior.provenance.universe !== raw.universe
        ? full
          ? "reload"
          : undefined
        : exactBase
          ? "incremental"
          : full
            ? "rebuild"
            : undefined;
  if (raw.mode !== expected) {
    throw new Error(
      "Roslyn workspace graph: response mode disagrees with its frame transaction",
    );
  }
}

function assertEnvelope(value: unknown): asserts value is ICsharpGraphSnapshot {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as ICsharpGraphSnapshot).protocolVersion !== 1 ||
    !["initial", "incremental", "rebuild", "reload", "unchanged"].includes(
      (value as ICsharpGraphSnapshot).mode,
    ) ||
    !Number.isSafeInteger((value as ICsharpGraphSnapshot).sequence) ||
    (value as ICsharpGraphSnapshot).sequence < 1 ||
    !/^[a-f0-9]{64}$/u.test((value as ICsharpGraphSnapshot).generation) ||
    !/^[a-f0-9]{64}$/u.test((value as ICsharpGraphSnapshot).universe) ||
    !Array.isArray((value as ICsharpGraphSnapshot).frames)
  ) {
    throw new Error("Roslyn workspace graph: malformed producer envelope");
  }
}

function combineSignals(
  request: AbortSignal | undefined,
  lifecycle: AbortSignal,
): AbortSignal {
  return request === undefined
    ? lifecycle
    : AbortSignal.any([request, lifecycle]);
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  /* c8 ignore start -- enqueue rejects an already-aborted caller before this
   * helper can receive it; this remains a defensive standalone invariant. */
  if (signal.aborted) return Promise.reject(abortError(signal));
  /* c8 ignore stop */
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => reject(abortError(signal));
    signal.addEventListener("abort", cancel, { once: true });
    void promise
      .then((value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      })
      .catch((error: unknown) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      });
  });
}

function delay(milliseconds: number, signal: AbortSignal): Promise<undefined> {
  /* c8 ignore start -- request() owns cancellation until its rejection and
   * there is no asynchronous gap before this retry delay installs its owner. */
  if (signal.aborted) return Promise.reject(abortError(signal));
  /* c8 ignore stop */
  return new Promise<undefined>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve(undefined);
    }, milliseconds);
    timer.unref?.();
    const cancel = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  const error = asError(signal.reason);
  error.name = "AbortError";
  return error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function trace(phase: string, elapsedMs: number): void {
  if (process.env["SAMCHON_GRAPH_ROSLYN_TRACE"] !== "1") return;
  process.stderr.write(
    `${JSON.stringify({ phase: `roslyn-client-${phase}`, elapsedMs: Math.round(elapsedMs) })}\n`,
  );
}
