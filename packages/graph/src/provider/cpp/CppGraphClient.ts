import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

import { compareOrdinal as compareText } from "@samchon/graph-sitter";

import { LspClient } from "../../lsp/LspClient";
import { LspResponseError } from "../../lsp/LspResponseError";
import { GraphLanguage } from "../../typings";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { CppGraphReloadRequired } from "./CppGraphReloadRequired";
import { CppGraphSnapshotAdapter } from "./CppGraphSnapshotAdapter";
import { ICppGraphSnapshot } from "./ICppGraphSnapshot";

const GRAPH_METHOD = "samchon/graphSnapshot";
const SERVER_CANCELLED = -32802;
const CONTENT_MODIFIED = -32801;
const DEFAULT_READY_TIMEOUT_MS = 300_000;
const RETRY_DELAY_MS = 50;
const MAX_RETRY_DELAY_MS = 5_000;
// A page is one shard, because a shard is the only unit whose size the
// producer can state. The producer answers a page by holding every body it
// carries, the whole page as a `llvm::json::Value` tree, and the serialized
// text, all at once, so a page bounded by shard *count* is an unbounded
// promise in bytes. Measured on the experiment corpora: one `fmt` translation
// unit is 169,505 occurrences, 40,366 symbols and 173,255 relations, and a
// 32-shard page took a 16 GiB host from 11.5 GiB free to dead in 76 seconds.
// Asking for more than one is a bet that N of those fit, and nothing in this
// protocol tells a client what N is safe for a repository it has not read.
//
// It is not free. The producer reads one main file's shard once per page and
// serves every configuration of that file from it, so a file built under
// several configurations is now read once per configuration instead of once.
// Both pinned corpora build each file one way, so today that costs nothing;
// a project with many configurations per file pays it. Reading a shard again
// is a cost that scales with the work; holding thirty-two of them expanded
// into a JSON tree is a cost that ends the process.
const PAGE_SHARDS = 1;

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
      const result = await this.applySnapshot(signal);
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
    let waiting: string | undefined;
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
        // Say what is being waited on, once per distinct answer.
        //
        // The producer refuses until every translation unit the compilation
        // database registers has been indexed, and its refusal names how many
        // are left. That number is the only thing that distinguishes a wait
        // from a hang, and three separate CI hosts have now died during one of
        // these waits with nothing in the log but a memory sample every ten
        // seconds — so a reader cannot tell whether the collapse happened
        // while units were still counting down or after the last one landed
        // and the snapshot began to assemble. Those are different defects in
        // different places. One line per change is enough to tell them apart,
        // and it follows the same convention as the selection lines above it.
        if (error.message !== waiting) {
          waiting = error.message;
          process.stderr.write(
            `@samchon/graph: c, cpp: waiting for the clang graph producer: ${waiting}\n`,
          );
        }
        if (performance.now() >= deadline) {
          throw new Error(
            `C/C++ clang graph: producer did not become ready within ${String(this.readyTimeoutMs)} ms: ${error.message}`,
          );
        }
        // Clamped to what is left, so the wait cannot outlive the bound the
        // error message quotes. Sleeping a flat cap from just before the
        // deadline would overshoot it by up to that cap, which is a stated
        // bound quietly widened — the thing this provider keeps having to
        // correct elsewhere.
        await delay(
          Math.min(backoff, Math.max(0, deadline - performance.now())),
          signal,
        );
        // Backing off, because polling twenty times a second for a condition
        // that takes minutes is wrong on its own terms. Each retry is one
        // round trip and one refusal — the producer rejects before assembling
        // anything — but at a flat 50 ms that is still about 5,400 of them
        // over four and a half minutes, aimed at a process that is indexing
        // the whole compilation database.
        //
        // Four CI runs died there, the host reporting a shutdown 4m23s to
        // 4m47s after indexing began, every one of them past the 180-second
        // timeout that used to end the wait first. That the polling caused it
        // is not established — this is a correlation and nothing here has
        // measured the host — but it is the only thing this repository does at
        // that cadence, and the change is cheap enough not to need the proof.
        //
        // Reset for content movement, which is a different condition: the
        // inputs changed rather than the producer being busy, `notifyInputChanges`
        // has already told it so, and an edit should not wait out a backoff
        // that a previous slow index inflated.
        backoff =
          error.code === CONTENT_MODIFIED
            ? RETRY_DELAY_MS
            : Math.min(backoff * 2, MAX_RETRY_DELAY_MS);
      }
    }
  }

  /**
   * Adapt one generation, asking for a whole one if a delta cannot serve.
   *
   * The adapter remembers a published shard by seven strings and not by its
   * body, so a reload -- the served languages or the compilation universe
   * moving -- has nothing to re-adapt from. The producer still holds every
   * shard, so the answer is to forget the generation and ask again. It refuses
   * before it has assigned anything, and the second request cannot ask for the
   * same thing twice: with no known generation the producer sends a whole
   * generation, which is the case a reload is already prepared for.
   */
  private async applySnapshot(
    signal: AbortSignal,
  ): Promise<ReturnType<CppGraphSnapshotAdapter["apply"]>> {
    const raw = await this.requestSnapshot(signal);
    try {
      return this.adapter.apply(raw, this.validate);
    } catch (error) {
      if (!(error instanceof CppGraphReloadRequired)) throw error;
      this.adapter.forget();
      return this.adapter.apply(await this.requestSnapshot(signal), this.validate);
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
        // Not cloned. `LspClient` parses each response body and resolves the
        // result without keeping a reference, so this page is already a private
        // object graph -- and it is the largest one this process holds. Copying
        // it doubled the peak and walked every occurrence a second time, to
        // defend against an alias that does not exist. Accumulating the parsed
        // shards directly also lets each page's envelope and manifest be
        // collected while the upserts that matter stay reachable.
        combined = page;
      } else {
        assertSameGeneration(combined, page);
        if (page.manifest.length !== 0 || page.deletes.length !== 0) {
          throw new Error(
            "C/C++ clang graph: continuation repeated generation metadata",
          );
        }
        combined.upserts.push(...page.upserts);
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
