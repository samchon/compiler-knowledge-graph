import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

import { compareOrdinal as compareText } from "@samchon/graph-sitter";

import { LspClient } from "../../lsp/LspClient";
import { LspResponseError } from "../../lsp/LspResponseError";
import { GraphLanguage } from "../../typings";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { CppGraphSnapshotAdapter } from "./CppGraphSnapshotAdapter";
import { ICppGraphSnapshot } from "./ICppGraphSnapshot";

const GRAPH_METHOD = "samchon/graphSnapshot";
const SERVER_CANCELLED = -32802;
const CONTENT_MODIFIED = -32801;
const DEFAULT_READY_TIMEOUT_MS = 300_000;
const RETRY_DELAY_MS = 50;
const MAX_RETRY_DELAY_MS = 5_000;
const PAGE_SHARDS = 32;

/** Resident LSP client for the pinned clangd graph-snapshot producer. */
export class CppGraphClient implements IBulkGraphSession {
  public readonly kind = "bulk" as const;
  public readonly languages: readonly GraphLanguage[];
  public readonly root: string;

  private readonly lsp: LspClient;
  private readonly adapter: CppGraphSnapshotAdapter;
  private readonly validate: (
    snapshot: IBulkGraphSession.ISnapshot,
  ) => void;
  private readonly initializationOptions: unknown;
  private readonly requestTimeoutMs: number | undefined;
  private readonly readyTimeoutMs: number;
  private readonly lifecycleAbort = new AbortController();
  private queue: Promise<void> = Promise.resolve();
  private initialized: Promise<void> | undefined;
  private watchedInputs = new Map<string, string | null>();
  private version = 0;
  private closed = false;
  private closing: Promise<void> | undefined;

  public constructor(options: CppGraphClient.IOptions) {
    this.root = options.root;
    this.languages = [...options.languages];
    this.adapter = new CppGraphSnapshotAdapter(
      options.root,
      options.producerCommit,
      options.languages,
    );
    this.validate = options.validate ?? (() => undefined);
    this.initializationOptions = options.initializationOptions;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.lsp = new LspClient(
      options.command,
      options.args ?? [],
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
      return Promise.reject(new Error("C/C++ clang graph: session is closed"));
    }
    return this.enqueue(async () => {
      const signal = combineSignals(options.signal, this.lifecycleAbort.signal);
      await this.initialize(signal);
      this.notifyInputChanges();
      const raw = await this.requestSnapshot(signal);
      const result = this.adapter.apply(raw, this.validate);
      this.commitSnapshotInputs(result.snapshot);
      if (!result.changed) {
        return {
          changed: false,
          generation: this.version,
          mode: result.mode,
          snapshot: result.snapshot,
        };
      }
      this.version += 1;
      return {
        changed: true,
        generation: this.version,
        mode: result.mode,
        snapshot: result.snapshot,
      };
    }, options.signal);
  }

  public close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.lifecycleAbort.abort(new Error("C/C++ clang graph: session is closed"));
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
            name: "samchon-graph-cpp",
          },
        ],
      },
      this.requestTimeoutMs,
      signal,
    );
    this.lsp.notify("initialized", {});
    const inputs = inputDigests(this.root);
    const changes = [...inputs]
      .filter(([, digest]) => digest !== null)
      .map(([file]) => ({ uri: pathToFileURL(file).href, type: 1 }));
    if (changes.length !== 0) {
      this.lsp.notify("workspace/didChangeWatchedFiles", { changes });
    }
    this.watchedInputs = inputs;
  }

  private notifyInputChanges(): void {
    const current = inputDigests(this.root, this.current);
    const files = new Set([...this.watchedInputs.keys(), ...current.keys()]);
    const changes: Array<{ uri: string; type: 1 | 2 | 3 }> = [];
    for (const file of [...files].sort(compareText)) {
      const before = this.watchedInputs.get(file);
      const after = current.get(file);
      if (before === after) continue;
      const type = before === undefined || before === null ? 1 : after === null || after === undefined ? 3 : 2;
      changes.push({ uri: pathToFileURL(file).href, type });
    }
    if (changes.length !== 0) {
      this.lsp.notify("workspace/didChangeWatchedFiles", { changes });
    }
    this.watchedInputs = current;
  }

  private commitSnapshotInputs(snapshot: IBulkGraphSession.ISnapshot): void {
    const committed = inputDigests(this.root, snapshot);
    for (const [file, source] of snapshot.sources) {
      if (!path.isAbsolute(file)) continue;
      committed.set(
        file,
        source.diskDigest === "" ? null : source.diskDigest,
      );
    }
    this.watchedInputs = committed;
  }

  private async requestSnapshot(
    signal: AbortSignal,
  ): Promise<ICppGraphSnapshot> {
    const deadline = performance.now() + this.readyTimeoutMs;
    let backoff = RETRY_DELAY_MS;
    for (;;) {
      throwIfAborted(signal);
      try {
        return await this.requestSnapshotPages(signal);
      } catch (error) {
        if (
          !(error instanceof LspResponseError) ||
          (error.code !== SERVER_CANCELLED && error.code !== CONTENT_MODIFIED)
        ) {
          throw error;
        }
        if (error.code === CONTENT_MODIFIED) this.notifyInputChanges();
        if (performance.now() >= deadline) {
          throw new Error(
            `C/C++ clang graph: producer did not become ready within ${String(this.readyTimeoutMs)} ms: ${error.message}`,
          );
        }
        await delay(backoff, signal);
        // Backing off, because polling a producer that is busy becoming ready
        // costs the producer more than it costs this loop. "Not ready" here
        // means clangd is indexing the whole compilation database, and every
        // retry asks that same busy process to assemble a paged snapshot
        // again. At a flat 50 ms this issued roughly 5,400 requests over four
        // and a half minutes and took the CI runner down with it, four times,
        // always within seconds of the same offset — which is what a fixed
        // interval looks like when the thing being polled is the thing under
        // load. A short first wait keeps a producer that is ready-in-a-moment
        // fast; the cap keeps a long index cheap.
        backoff = Math.min(backoff * 2, MAX_RETRY_DELAY_MS);
      }
    }
  }

  private async requestSnapshotPages(
    signal: AbortSignal,
  ): Promise<ICppGraphSnapshot> {
    const knownGeneration = this.adapter.generation;
    let cursor: string | undefined;
    let expectedOffset = 0;
    let expectedTotal: number | undefined;
    let combined: ICppGraphSnapshot | undefined;
    const cursors = new Set<string>();
    for (;;) {
      const value = await this.lsp.request<unknown>(
        GRAPH_METHOD,
        {
          ...(knownGeneration === undefined ? {} : { knownGeneration }),
          ...(cursor === undefined ? {} : { cursor }),
          maxShards: PAGE_SHARDS,
        },
        this.requestTimeoutMs,
        signal,
      );
      assertSnapshotPage(value, expectedOffset, expectedTotal);
      const page = value;
      expectedTotal ??= page.page.total;
      if (combined === undefined) {
        combined = structuredClone(page);
      } else {
        assertSameGeneration(combined, page);
        if (page.manifest.length !== 0 || page.deletes.length !== 0) {
          throw new Error(
            "C/C++ clang graph: continuation repeated generation metadata",
          );
        }
        combined.upserts.push(...structuredClone(page.upserts));
        combined.phases.validationMillis += page.phases.validationMillis;
        combined.phases.semanticMillis += page.phases.semanticMillis;
        combined.phases.shardMillis += page.phases.shardMillis;
        combined.phases.encodeMillis += page.phases.encodeMillis;
        combined.phases.totalMillis += page.phases.totalMillis;
      }
      expectedOffset += page.page.count;
      if (page.page.nextCursor === null) {
        if (expectedOffset !== expectedTotal) {
          throw new Error("C/C++ clang graph: paged generation ended early");
        }
        combined.page = {
          offset: 0,
          count: combined.upserts.length,
          total: combined.upserts.length,
          nextCursor: null,
        };
        return combined;
      }
      if (
        expectedOffset >= expectedTotal ||
        cursors.has(page.page.nextCursor)
      ) {
        throw new Error("C/C++ clang graph: invalid continuation cursor");
      }
      cursors.add(page.page.nextCursor);
      cursor = page.page.nextCursor;
    }
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

export namespace CppGraphClient {
  export interface IOptions {
    root: string;
    languages: readonly GraphLanguage[];
    command: string;
    args?: readonly string[];
    producerCommit: string;
    initializationOptions?: unknown;
    requestTimeoutMs?: number;
    readyTimeoutMs?: number;
    maxMessageBytes?: number;
    windowsVerbatimArguments?: boolean;
    validate?: (snapshot: IBulkGraphSession.ISnapshot) => void;
  }
}

interface ICompileCommand {
  directory?: unknown;
  file?: unknown;
}

function compilationDatabaseFiles(root: string): string[] {
  for (const candidate of [
    path.join(root, "compile_commands.json"),
    path.join(root, "build", "compile_commands.json"),
  ]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as unknown;
      if (!Array.isArray(parsed)) continue;
      const files = new Set<string>();
      for (const row of parsed as ICompileCommand[]) {
        if (typeof row.file !== "string" || row.file === "") continue;
        const directory =
          typeof row.directory === "string" && row.directory !== ""
            ? row.directory
            : path.dirname(candidate);
        files.add(
          path.resolve(
            path.isAbsolute(row.file) ? root : directory,
            row.file,
          ),
        );
      }
      return [...files].sort(compareText);
    } catch {
      continue;
    }
  }
  return [];
}

function inputDigests(
  root: string,
  snapshot?: IBulkGraphSession.ISnapshot,
): Map<string, string | null> {
  const files = new Set<string>([
    path.join(root, ".clangd"),
    path.join(root, "compile_flags.txt"),
    path.join(root, "compile_commands.json"),
    path.join(root, "build", "compile_commands.json"),
    ...compilationDatabaseFiles(root),
  ]);
  for (const file of snapshot?.sources.keys() ?? []) {
    if (path.isAbsolute(file)) files.add(file);
  }
  return new Map(
    [...files]
      .sort(compareText)
      .map((file) => [file, fileDigest(file)] as const),
  );
}

function fileDigest(file: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function serverRequest(method: string, params: unknown): unknown {
  if (method !== "workspace/configuration") return null;
  const items = (params as { items?: unknown })?.items;
  return Array.isArray(items) ? items.map(() => null) : [];
}

function delay(milliseconds: number, signal: AbortSignal): Promise<undefined> {
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
  if (signal.aborted) return Promise.reject(cancelledError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(cancelledError(signal));
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
  if (signal.aborted) throw cancelledError(signal);
}

function cancelledError(signal?: AbortSignal): Error {
  const reason = signal?.reason === undefined ? "" : `: ${String(signal.reason)}`;
  const error = new Error(`C/C++ clang graph: snapshot request cancelled${reason}`);
  error.name = "AbortError";
  return error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function assertSnapshotPage(
  value: unknown,
  expectedOffset: number,
  expectedTotal: number | undefined,
): asserts value is ICppGraphSnapshot {
  if (
    value === null ||
    typeof value !== "object" ||
    !Array.isArray((value as ICppGraphSnapshot).upserts) ||
    !Array.isArray((value as ICppGraphSnapshot).deletes) ||
    !Array.isArray((value as ICppGraphSnapshot).manifest)
  ) {
    throw new Error("C/C++ clang graph: malformed paged generation");
  }
  const snapshot = value as ICppGraphSnapshot;
  const page = snapshot.page;
  if (
    page === null ||
    typeof page !== "object" ||
    !Number.isSafeInteger(page.offset) ||
    !Number.isSafeInteger(page.count) ||
    !Number.isSafeInteger(page.total) ||
    page.offset !== expectedOffset ||
    page.count !== snapshot.upserts.length ||
    page.count < 0 ||
    page.total < page.offset + page.count ||
    (expectedTotal !== undefined && page.total !== expectedTotal) ||
    (page.nextCursor !== null &&
      (typeof page.nextCursor !== "string" || page.nextCursor === "")) ||
    snapshot.phases === null ||
    typeof snapshot.phases !== "object"
  ) {
    throw new Error("C/C++ clang graph: malformed snapshot page envelope");
  }
  for (const value of [
    snapshot.phases.validationMillis,
    snapshot.phases.semanticMillis,
    snapshot.phases.shardMillis,
    snapshot.phases.encodeMillis,
    snapshot.phases.totalMillis,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("C/C++ clang graph: malformed page telemetry");
    }
  }
  if (typeof snapshot.phases.cacheHit !== "boolean") {
    throw new Error("C/C++ clang graph: malformed page cache state");
  }
}

function assertSameGeneration(
  first: ICppGraphSnapshot,
  next: ICppGraphSnapshot,
): void {
  if (
    first.protocolVersion !== next.protocolVersion ||
    first.schemaVersion !== next.schemaVersion ||
    first.sequence !== next.sequence ||
    first.generation !== next.generation ||
    first.baseGeneration !== next.baseGeneration ||
    first.phases.cacheHit !== next.phases.cacheHit ||
    JSON.stringify(first.producer) !== JSON.stringify(next.producer) ||
    JSON.stringify(first.universe) !== JSON.stringify(next.universe)
  ) {
    throw new Error("C/C++ clang graph: continuation crossed generations");
  }
}
