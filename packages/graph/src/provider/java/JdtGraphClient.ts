import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { LspClient } from "../../lsp/LspClient";
import { GraphLanguage } from "../../typings";
import { providerInputFiles } from "../providerInputFiles";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { IJdtGraphSnapshot } from "./IJdtGraphSnapshot";
import { JdtGraphSnapshotAdapter } from "./JdtGraphSnapshotAdapter";

const COMMAND = "java.graph.snapshot";

/** Resident JDT client that receives one whole workspace snapshot per refresh. */
export class JdtGraphClient implements IBulkGraphSession {
  public readonly kind = "bulk" as const;
  public readonly languages: readonly GraphLanguage[] = ["java"];
  public readonly root: string;

  private readonly lsp: LspClient;
  private readonly adapter: JdtGraphSnapshotAdapter;
  private readonly validate: (snapshot: IBulkGraphSession.ISnapshot) => void;
  private readonly initializationOptions: unknown;
  private readonly requestTimeoutMs: number | undefined;
  private readonly lifecycleAbort = new AbortController();
  private initialized: Promise<void> | undefined;
  private watchedInputs = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private version = 0;
  private closed = false;
  private closing: Promise<void> | undefined;

  public constructor(options: JdtGraphClient.IOptions) {
    this.root = options.root;
    this.adapter = new JdtGraphSnapshotAdapter(options.root);
    this.validate = options.validate;
    this.initializationOptions = options.initializationOptions;
    this.requestTimeoutMs = options.requestTimeoutMs;
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
    return this.adapter.current;
  }

  public refresh(
    options: { signal?: AbortSignal } = {},
  ): Promise<IBulkGraphSession.IRefresh> {
    if (this.closed) {
      return Promise.reject(new Error("JDT workspace graph: session is closed"));
    }
    return this.enqueue(async () => {
      const signal = combineSignals(options.signal, this.lifecycleAbort.signal);
      await this.initialize(signal);
      const moved = this.notifyInputChanges();
      const raw = await this.lsp.request<IJdtGraphSnapshot>(
        "workspace/executeCommand",
        { command: COMMAND, arguments: [] },
        this.requestTimeoutMs,
        signal,
      );
      const result = this.adapter.apply(raw, {
        signal,
        validate: this.validate,
      });
      if (moved && !result.changed) {
        throw new Error(
          "JDT workspace graph: watched Java inputs moved but the producer reused its generation",
        );
      }
      if (result.changed) this.version += 1;
      return {
        changed: result.changed,
        generation: this.version,
        mode: result.mode,
        snapshot: result.snapshot,
      };
    }, options.signal);
  }

  public close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.lifecycleAbort.abort(
      new Error("JDT workspace graph: session is closed"),
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
        capabilities: {
          window: { workDoneProgress: true },
          workspace: { configuration: true },
        },
        ...(this.initializationOptions === undefined
          ? {}
          : { initializationOptions: this.initializationOptions }),
        workspaceFolders: [
          {
            uri: pathToFileURL(this.root).href,
            name: "samchon-graph-java",
          },
        ],
      },
      this.requestTimeoutMs,
      signal,
    );
    this.lsp.notify("initialized", {});
  }

  private notifyInputChanges(): boolean {
    const current = javaInputDigests(this.root);
    const files = new Set([...this.watchedInputs.keys(), ...current.keys()]);
    const changes: Array<{ uri: string; type: 1 | 2 | 3 }> = [];
    for (const file of [...files].sort(compareText)) {
      const before = this.watchedInputs.get(file);
      const after = current.get(file);
      if (before === after) continue;
      changes.push({
        uri: pathToFileURL(file).href,
        type: before === undefined ? 1 : after === undefined ? 3 : 2,
      });
    }
    if (changes.length !== 0) {
      this.lsp.notify("workspace/didChangeWatchedFiles", { changes });
    }
    this.watchedInputs = current;
    return changes.length !== 0;
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

export namespace JdtGraphClient {
  export interface IOptions {
    root: string;
    command: string;
    args: readonly string[];
    initializationOptions?: unknown;
    requestTimeoutMs?: number;
    maxMessageBytes?: number;
    windowsVerbatimArguments?: boolean;
    validate: (snapshot: IBulkGraphSession.ISnapshot) => void;
  }
}

function javaInputDigests(root: string): Map<string, string> {
  const answer = new Map<string, string>();
  for (const relative of providerInputFiles(root, ["java"], [])) {
    const file = path.resolve(root, relative);
    try {
      answer.set(
        file,
        createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      );
    /* c8 ignore start -- a source disappearing between the directory walk and
     * this read is a benign filesystem race; the next refresh reports it. */
    } catch {
      continue;
    }
    /* c8 ignore stop */
  }
  return answer;
}

function combineSignals(
  request: AbortSignal | undefined,
  lifecycle: AbortSignal,
): AbortSignal {
  return request === undefined
    ? lifecycle
    : AbortSignal.any([request, lifecycle]);
}

function raceWithAbort<T>(
  task: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  /* c8 ignore start -- enqueue rejects a pre-aborted caller before this
   * initialization boundary; this closes only the instruction-boundary race. */
  if (signal.aborted) return Promise.reject(abortError(signal));
  /* c8 ignore stop */
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      reject(abortError(signal));
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

function abortError(signal: AbortSignal): Error {
  return signal.reason as Error;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function compareText(left: string, right: string): number {
  // The set contains distinct paths, so equality is not a reachable arm.
  return left < right ? -1 : 1;
}
