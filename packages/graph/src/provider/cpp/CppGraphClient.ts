import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

import { compareOrdinal as compareText } from "@samchon/graph-sitter";

import { appendAll } from "../../indexer/appendAll";
import { LspClient } from "../../lsp/LspClient";
import { LspResponseError } from "../../lsp/LspResponseError";
import { GraphLanguage } from "../../typings";
import { isSubPath } from "../../utils/isSubPath";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { cppGraphHeapTrace } from "./cppGraphHeapTrace";
import { CppGraphReloadRequired } from "./CppGraphReloadRequired";
import { CppGraphSnapshotAdapter } from "./CppGraphSnapshotAdapter";
import { ICppGraphSnapshot } from "./ICppGraphSnapshot";

const GRAPH_METHOD = "samchon/graphSnapshot";
const SERVER_CANCELLED = -32802;
const CONTENT_MODIFIED = -32801;
/**
 * How much published-body text this consumer keeps parsed at once.
 *
 * A piece is kept only to save reading it again, and a walk names the same
 * headers over and over -- which is the whole reason bodies are split by
 * file. But one C++ unit's facts run to hundreds of megabytes, and keeping
 * every piece a project ever published is a second copy of the project
 * standing beside the graph being built from it.
 */
const PIECE_BUDGET_BYTES = 256 * 1024 * 1024;
const RETRY_DELAY_MS = 50;
const MAX_RETRY_DELAY_MS = 5_000;
// A page size balances two costs that pull against each other, and the first
// choice here only measured one of them.
//
// Upward: the producer answers a page by holding every body it carries, the
// whole page as a `llvm::json::Value` tree, and the serialized text at once.
// One `fmt` translation unit is 169,505 occurrences, 40,366 symbols and
// 173,255 relations -- some 590 MiB once expanded -- so a page bounded by
// shard *count* is an unbounded promise in bytes, and thirty-two of them took
// a 16 GiB host from 11.5 GiB free to dead in seventy-six seconds.
//
// Downward: every page costs the producer a copy of its whole snapshot cache,
// shard metadata and per-shard source lists included, before it reads the one
// shard the page is for. That is O(shards) paid O(shards) times. On libuv --
// 242 translation units, each carrying its headers -- one shard to a page made
// the memory fit and the wall clock quadratic: nine lifecycle refreshes spent
// over eighty minutes without finishing, against a job that is killed at 150.
//
// Four is where those meet. It keeps a page within one order of magnitude of a
// single shard, which is the only size this protocol lets a client reason
// about, and it divides the producer's per-page fixed cost by four. It is not
// derived from a rule; it is a reading of two measured curves, and it moves
// again only against another reading.
//
// This is affordable now for a reason that did not hold before: the client
// adapts each page as it arrives instead of accumulating the generation, so
// what a page costs *this* process no longer scales with how many shards it
// carries. Only the producer's side of the trade is left.
const PAGE_SHARDS = 4;
// How often a walk in progress reports itself. Sixty-four shards is a hundred
// and twenty lines over a 469-shard generation -- enough to see the shape of
// the curve and where it bends, and few enough that the trace is not the thing
// filling the log.
const WALK_STRIDE = 64;

/** Resident LSP client for the pinned clangd graph-snapshot producer. */
export class CppGraphClient implements IBulkGraphSession {
  public readonly kind = "bulk" as const;
  public readonly languages: readonly GraphLanguage[];
  public readonly root: string;

  private readonly lsp: LspClient;
  private readonly adapter: CppGraphSnapshotAdapter;
  private readonly heapTrace: cppGraphHeapTrace.ITrace | undefined =
    cppGraphHeapTrace();
  private readonly validate: (
    snapshot: IBulkGraphSession.ISnapshot,
  ) => void;
  private readonly initializationOptions: unknown;
  private readonly requestTimeoutMs: number | undefined;
  private readonly readyTimeoutMs: number | undefined;
  private readonly pieceBudgetBytes: number;
  private readonly lifecycleAbort = new AbortController();
  private queue: Promise<void> = Promise.resolve();
  private initialized: Promise<void> | undefined;
  private watchedInputs = new Map<string, IInputDigest>();
  private readonly dirtyInputs = new Set<string>();
  private readonly inputWatches = new Map<string, IInputWatch>();
  private polledInputs = new Set<string>();
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
    this.readyTimeoutMs = options.readyTimeoutMs;
    this.pieceBudgetBytes = options.pieceBudgetBytes ?? PIECE_BUDGET_BYTES;
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
      const moved = await this.notifyInputChanges();
      const result = await this.applySnapshot(signal, moved);
      if (result.changed) this.commitSnapshotInputs(result.snapshot);
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
    this.closeInputWatches();
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
    const files = inputFiles(this.root);
    this.syncInputWatches(files);
    const inputs = inputDigests(files);
    const changes = [...inputs]
      .filter(([, input]) => input.digest !== null)
      .map(([file]) => ({ uri: pathToFileURL(file).href, type: 1 }));
    if (changes.length !== 0) {
      this.lsp.notify("workspace/didChangeWatchedFiles", { changes });
    }
    this.watchedInputs = inputs;
  }

  /**
   * Tell the producer which watched inputs moved, and say whether any did.
   *
   * The answer decides whether this client will accept being told nothing
   * changed. A compilation database rewritten to the same commands leaves the
   * producer's generation identical and it says so -- truthfully, about its
   * own facts. But the file a project is built from is an input, and a
   * consumer that watched it move and then published the previous generation
   * unchanged would be reporting on a checkout it no longer describes.
   */
  private async notifyInputChanges(): Promise<boolean> {
    // Let native filesystem notifications queued by the write that prompted
    // this load reach their directory watchers before deciding it is a no-op.
    // Project-owned inputs are also polled: direct writes followed immediately
    // by load must not depend on an OS event's delivery latency. External SDK
    // and dependency trees stay bound by their directory events without
    // turning every no-op into a stat walk over tens of thousands of headers.
    await inputEventTurn();
    const required = inputFiles(this.root);
    this.addInputWatches(required);
    const files = new Set(this.dirtyInputs);
    this.dirtyInputs.clear();
    for (const file of this.polledInputs) files.add(file);
    for (const watch of this.inputWatches.values()) {
      if (watch.watcher === undefined) {
        for (const file of watch.files) files.add(file);
      }
    }
    for (const file of required) {
      if (!this.watchedInputs.has(file)) files.add(file);
    }
    const current = new Map(this.watchedInputs);
    const changes: Array<{ uri: string; type: 1 | 2 | 3 }> = [];
    for (const file of [...files].sort(compareText)) {
      const before = this.watchedInputs.get(file)?.digest;
      const input = fileDigest(file, this.watchedInputs.get(file));
      const after = input.digest;
      current.set(file, input);
      if (before === after) continue;
      const type = before === undefined || before === null ? 1 : after === null || after === undefined ? 3 : 2;
      changes.push({ uri: pathToFileURL(file).href, type });
    }
    if (changes.length !== 0) {
      this.lsp.notify("workspace/didChangeWatchedFiles", { changes });
    }
    this.watchedInputs = current;
    return changes.length !== 0;
  }

  private commitSnapshotInputs(snapshot: IBulkGraphSession.ISnapshot): void {
    const files = inputFiles(this.root, snapshot);
    // Attach watchers before reading the post-snapshot baseline. A file that
    // moves during the read is either rejected by fileDigest's stable-read
    // fence or arrives as a dirty event checked by the next resident load.
    this.syncInputWatches(files);
    const committed = inputDigests(files, this.watchedInputs);
    for (const [file, source] of snapshot.sources) {
      if (!path.isAbsolute(file)) continue;
      const digest = source.diskDigest === "" ? null : source.diskDigest;
      const scanned = committed.get(file);
      committed.set(file, {
        digest,
        // A producer digest is a baseline for the next refresh only. Reuse the
        // scan fingerprint when it proves those are the bytes on disk now; if
        // the file moved after the frozen snapshot, force the next refresh to
        // read it and compare against the producer's older identity.
        fingerprint:
          scanned?.digest === digest ? scanned.fingerprint : null,
      });
    }
    this.watchedInputs = committed;
  }

  private addInputWatches(files: Iterable<string>): void {
    for (const file of files) {
      if (isSubPath(this.root, file)) this.polledInputs.add(file);
      const directory = path.dirname(file);
      const current = this.inputWatches.get(directory);
      if (current !== undefined) {
        current.files.add(file);
        continue;
      }
      const watch: IInputWatch = { files: new Set([file]) };
      this.inputWatches.set(directory, watch);
      this.openInputWatch(directory, watch);
    }
  }

  private syncInputWatches(files: Iterable<string>): void {
    const wanted = new Map<string, Set<string>>();
    const polled = new Set<string>();
    for (const file of files) {
      if (isSubPath(this.root, file)) polled.add(file);
      const directory = path.dirname(file);
      let entries = wanted.get(directory);
      if (entries === undefined) {
        entries = new Set();
        wanted.set(directory, entries);
      }
      entries.add(file);
    }
    for (const [directory, watch] of this.inputWatches) {
      const entries = wanted.get(directory);
      if (entries === undefined) {
        watch.watcher?.close();
        this.inputWatches.delete(directory);
        for (const file of watch.files) this.dirtyInputs.delete(file);
        continue;
      }
      for (const file of watch.files) {
        if (!entries.has(file)) this.dirtyInputs.delete(file);
      }
      watch.files = entries;
      wanted.delete(directory);
      if (watch.watcher === undefined) this.openInputWatch(directory, watch);
    }
    for (const [directory, entries] of wanted) {
      const watch: IInputWatch = { files: entries };
      this.inputWatches.set(directory, watch);
      this.openInputWatch(directory, watch);
    }
    this.polledInputs = polled;
  }

  private openInputWatch(directory: string, watch: IInputWatch): void {
    try {
      const watcher = fs.watch(directory, { persistent: false }, () => {
        for (const file of watch.files) this.dirtyInputs.add(file);
      });
      watcher.on("error", () => {
        for (const file of watch.files) this.dirtyInputs.add(file);
        watcher.close();
        watch.watcher = undefined;
      });
      watch.watcher = watcher;
    } catch {
      // A missing build directory and filesystems without watch support stay
      // correct by polling the files assigned to this directory on each load.
      watch.watcher = undefined;
    }
  }

  private closeInputWatches(): void {
    for (const watch of this.inputWatches.values()) watch.watcher?.close();
    this.inputWatches.clear();
    this.dirtyInputs.clear();
    this.polledInputs.clear();
  }

  private async requestSnapshot(
    signal: AbortSignal,
    moved: boolean,
  ): Promise<CppGraphSnapshotAdapter.IResult> {
    const deadline =
      this.readyTimeoutMs === undefined
        ? undefined
        : performance.now() + this.readyTimeoutMs;
    let backoff = RETRY_DELAY_MS;
    let waiting: string | undefined;
    for (;;) {
      throwIfAborted(signal);
      try {
        const result = await this.requestSnapshotPages(signal, false);
        // A producer that says nothing changed is answering about its own
        // facts, and it is right: a compilation database rewritten to the
        // same commands leaves every fact where it was. But the file a
        // project is built from is an input this client watches, and
        // republishing the previous generation unchanged would describe a
        // checkout that has moved. Asked again without a generation to
        // build on, the producer sends the whole thing and this side
        // publishes it as the reload it is.
        if (!moved || result.mode !== "unchanged") return result;
        return await this.requestSnapshotPages(signal, true);
      } catch (error) {
        if (
          !(error instanceof LspResponseError) ||
          (error.code !== SERVER_CANCELLED && error.code !== CONTENT_MODIFIED)
        ) {
          throw error;
        }
        // Progress is not movement.
        //
        // The producer refuses with the same code whether its inputs moved
        // or it is simply still indexing, and this treated both as movement:
        // every refusal told the producer its inputs had changed and reset
        // the backoff. Indexing a compilation database takes minutes, so that
        // was eighteen notifications a second for the whole of it, and each
        // one starts a fresh discovery pass. The pass could never drain, and
        // a C run sat for twenty minutes being told that project changes were
        // still being discovered -- by itself.
        //
        // A refusal that says the snapshot is not ready is the producer
        // working. Anything else -- a stale cursor, a generation that moved
        // between pages -- is the inputs moving, and that is worth saying.
        const indexing = error.message.includes(
          "graph snapshot is not ready",
        );
        if (error.code === CONTENT_MODIFIED && !indexing)
          await this.notifyInputChanges();
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
        if (deadline !== undefined && performance.now() >= deadline) {
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
          deadline === undefined
            ? backoff
            : Math.min(backoff, Math.max(0, deadline - performance.now())),
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
          error.code === CONTENT_MODIFIED && !indexing
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
    moved: boolean,
  ): Promise<CppGraphSnapshotAdapter.IResult> {
    try {
      return await this.requestSnapshot(signal, moved);
    } catch (error) {
      if (!(error instanceof CppGraphReloadRequired)) throw error;
      this.adapter.forget();
      return await this.requestSnapshot(signal, false);
    }
  }

  /**
   * Report what this consumer holds at one boundary, when asked to.
   *
   * One call site for the optional trace rather than four: a diagnostic that
   * is off in every run but one should not put a branch on the path it
   * measures four times over.
   */
  private reportHeap(
    stage: "walking" | "paged" | "committed",
    shards: number,
    split: {
      startedAt: number;
      producerMs: number;
      producerFetchMs: number;
      producerEncodeMs: number;
      bodyMs: number;
      adaptMs: number;
      census: CppGraphSnapshotAdapter.ICensus;
    },
  ): void {
    this.heapTrace?.stage(stage, shards, {
      elapsedMs: performance.now() - split.startedAt,
      producerMs: split.producerMs,
      producerFetchMs: split.producerFetchMs,
      producerEncodeMs: split.producerEncodeMs,
      bodyMs: split.bodyMs,
      adaptMs: split.adaptMs,
      nodes: split.census.nodes,
      nodesOffMain: split.census.offMain,
      entities: split.census.entities,
      relationships: split.census.relationships,
    });
  }

  /**
   * Walk a paged generation into the adapter, one shard at a time.
   *
   * Nothing accumulates here. A whole-compilation-database producer answered a
   * 242 translation-unit project with 469 shards -- a file built under two
   * configurations publishes a view of each -- and holding them as parsed
   * JSON until the last one arrived is what exhausted this process: it died
   * inside `JSON.parse` with the generation still incomplete, having adapted
   * nothing. Each page is handed over and released, so what stays is the graph
   * rather than the graph and the producer's rendering of it.
   *
   * The first page is the envelope, with its own `page` replaced by the one the
   * assembled generation has: offset zero, every shard, no cursor. Its
   * `upserts` are handed over like any other page's rather than left on the
   * envelope, so a page's shards are reachable exactly as long as they are
   * being adapted.
   *
   * A partial walk costs nothing to abandon. `open` assigns no adapter state,
   * so a page that fails validation, a producer that moves underneath the
   * cursor, and a reload refused at `finish` all leave the adapter as it was.
   */
  private async requestSnapshotPages(
    signal: AbortSignal,
    whole: boolean,
  ): Promise<CppGraphSnapshotAdapter.IResult> {
    const knownGeneration = whole ? undefined : this.adapter.generation;
    let cursor: string | undefined;
    let expectedOffset = 0;
    let expectedTotal: number | undefined;
    const startedAt = performance.now();
    // The two halves of a walk, kept apart. A stride that costs thirteen
    // seconds a shard is one problem if the producer owns it and another if
    // this process does, and the wall clock alone cannot say which.
    // Pieces already parsed in this walk, by the path that named them. A
    // header's piece is named by every unit that includes it, and reading it
    // once is the whole reason bodies are split before they are published.
    const pieces = new Map<string, ICppGraphSnapshot.ITU>();
    const pieceBytes = new Map<string, number>();
    const pieceBudget = { held: 0, limit: this.pieceBudgetBytes };
    const split = {
      startedAt,
      producerMs: 0,
      producerFetchMs: 0,
      producerEncodeMs: 0,
      bodyMs: 0,
      adaptMs: 0,
      census: {
        nodes: 0,
        offMain: 0,
        entities: 0,
        relationships: 0,
      } as CppGraphSnapshotAdapter.ICensus,
    };
    let first: ICppGraphSnapshot | undefined;
    let settled: CppGraphSnapshotAdapter.IResult | undefined;
    let ingest: CppGraphSnapshotAdapter.IOpen | undefined;
    const cursors = new Set<string>();
    for (;;) {
      const askedAt = performance.now();
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
      split.producerMs += performance.now() - askedAt;
      assertSnapshotPage(value, expectedOffset, expectedTotal);
      const page = value;
      // The producer's own account of the time this client just spent waiting.
      // It measured both halves while building the page and says so in every
      // response; nothing else has to be asked.
      split.producerFetchMs +=
        page.phases.validationMillis +
        page.phases.semanticMillis +
        page.phases.shardMillis;
      split.producerEncodeMs += page.phases.encodeMillis;
      expectedTotal ??= page.page.total;
      if (first === undefined) {
        first = page;
        const opened = this.adapter.open(
          {
            ...page,
            upserts: [],
            page: {
              offset: 0,
              count: expectedTotal,
              total: expectedTotal,
              nextCursor: null,
            },
          },
          expectedTotal,
          this.validate,
        );
        if (opened.settled !== undefined) settled = opened.settled;
        else {
          ingest = opened;
          split.census = opened.census;
        }
      } else {
        assertSameGeneration(first!, page);
        if (page.manifest.length !== 0 || page.deletes.length !== 0) {
          throw new Error(
            "C/C++ clang graph: continuation repeated generation metadata",
          );
        }
      }
      // A page names its bodies rather than carrying them, so they are read
      // here, from the producer's own store, by the digest that named them.
      // What crosses the pipe is a path; what the producer skipped is building
      // a `json::Value` tree of the body, serializing it, and reading the body
      // off disk only to put the same bytes back through a socket.
      const readAt = performance.now();
      for (const shard of page.upserts)
        readGraphBody(shard, pieces, pieceBytes, pieceBudget);
      split.bodyMs += performance.now() - readAt;
      const adaptedAt = performance.now();
      for (const shard of page.upserts) ingest?.shard(shard);
      split.adaptMs += performance.now() - adaptedAt;
      const before = expectedOffset;
      expectedOffset += page.page.count;
      // Every stride of shards, so a walk that never finishes still says how
      // far it got and what it was holding when it stopped. Twice the reading
      // that was needed did not exist because the run died before the boundary
      // that would have reported it.
      if (
        ingest !== undefined &&
        Math.floor(before / WALK_STRIDE) !==
          Math.floor(expectedOffset / WALK_STRIDE)
      ) {
        this.reportHeap("walking", expectedOffset, split);
      }
      if (page.page.nextCursor === null) {
        if (expectedOffset !== expectedTotal) {
          throw new Error("C/C++ clang graph: paged generation ended early");
        }
        if (settled !== undefined) return settled;
        this.reportHeap("paged", expectedTotal, split);
        const finishedAt = performance.now();
        const result = ingest!.finish();
        split.adaptMs += performance.now() - finishedAt;
        this.reportHeap("committed", expectedTotal, split);
        return result;
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

    /**
     * How much published-body text to keep parsed at once.
     *
     * Only a walk over a real compilation database reaches the default, so a
     * fixture that has to prove what happens past it says so here.
     */
    pieceBudgetBytes?: number;
    maxMessageBytes?: number;
    windowsVerbatimArguments?: boolean;
    validate?: (snapshot: IBulkGraphSession.ISnapshot) => void;
  }
}

interface ICompileCommand {
  directory?: unknown;
  file?: unknown;
}

interface IInputDigest {
  digest: string | null;
  fingerprint: string | null;
}

interface IInputWatch {
  files: Set<string>;
  watcher?: fs.FSWatcher;
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

function inputFiles(
  root: string,
  snapshot?: IBulkGraphSession.ISnapshot,
): string[] {
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
  return [...files].sort(compareText);
}

function inputDigests(
  files: Iterable<string>,
  previous: ReadonlyMap<string, IInputDigest> = new Map(),
): Map<string, IInputDigest> {
  return new Map(
    [...files]
      .sort(compareText)
      .map((file) => [file, fileDigest(file, previous.get(file))] as const),
  );
}

function fileDigest(
  file: string,
  previous: IInputDigest | undefined,
): IInputDigest {
  // The no-op lifecycle is allowed to be a metadata walk, not a whole-corpus
  // byte walk. ctime joins mtime and size because callers can restore mtime;
  // inode and device keep a replacement from inheriting the old identity.
  // A regular writer cannot restore ctime, on either Unix or NTFS.
  for (let attempt = 0; attempt !== 3; ++attempt) {
    try {
      const before = fileFingerprint(file);
      if (before === null) return { digest: null, fingerprint: null };
      if (previous?.fingerprint === before) return previous;
      const digest = createHash("sha256")
        .update(fs.readFileSync(file))
        .digest("hex");
      const after = fileFingerprint(file);
      if (before === after) return { digest, fingerprint: after };
    } catch {
      return { digest: null, fingerprint: null };
    }
  }
  // A file that keeps moving cannot establish a reusable identity. Publishing
  // it as unknown makes an older producer baseline visibly move and ensures a
  // later settled refresh reads the bytes again.
  return { digest: null, fingerprint: null };
}

function fileFingerprint(file: string): string | null {
  const stat = fs.statSync(file, { bigint: true });
  if (!stat.isFile()) return null;
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}

function inputEventTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
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

/**
 * Fill in a shard's body from the file the producer published it to.
 *
 * The producer writes a completed body once, named by the body's own
 * content digest, and a page names it instead of carrying it. That takes
 * the largest object this route moves out of the request path entirely:
 * no `json::Value` tree on one side, no serialization between, and no
 * megabytes of JSON through a pipe that delivers it in sixty-four
 * kibibyte pieces.
 *
 * A shard that carries its body inline is left alone -- that is what a
 * project with nowhere to publish gets, and the body is the same either
 * way. A shard that has neither is a producer that broke its own
 * contract, and is refused rather than adapted into an empty graph.
 */
// The lists reassembly reads out of every piece.
const PIECE_LISTS = [
  "symbols",
  "occurrences",
  "relations",
  "macros",
  "includes",
  "missingIncludes",
  "modules",
  "diagnostics",
] as const;

function readGraphBody(
  shard: ICppGraphSnapshot.IShard,
  pieces: Map<string, ICppGraphSnapshot.ITU>,
  bytes: Map<string, number>,
  budget: { held: number; limit: number },
): void {
  // A page's shards arrive from `JSON.parse`, so `graph` is absent in fact
  // whenever the producer published paths instead -- the declared type is
  // what holds from here on, and holding it is this function's whole job.
  const carried = shard as { graph?: ICppGraphSnapshot.ITU };
  if (carried.graph !== undefined) return;
  if (!Array.isArray(shard.graphPaths) || shard.graphPaths.length === 0) {
    throw new Error(
      `C/C++ clang graph: shard carries neither a body nor a path: ${shard.key}`,
    );
  }
  const read = (file: string): ICppGraphSnapshot.ITU => {
    const known = pieces.get(file);
    if (known !== undefined) {
      // Moved to the end of the map, so what is dropped when the budget is
      // reached is what has gone longest without being named. A header the
      // whole project includes is named constantly and never leaves.
      pieces.delete(file);
      pieces.set(file, known);
      return known;
    }
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      throw new Error(
        `C/C++ clang graph: published body cannot be read: ${file}`,
      );
    }
    let piece: ICppGraphSnapshot.ITU;
    try {
      piece = JSON.parse(text) as ICppGraphSnapshot.ITU;
    } catch {
      throw new Error(
        `C/C++ clang graph: published body is not valid JSON: ${file}`,
      );
    }
    // A piece has to be a piece before it can be added to one. Reassembly
    // reads eight lists out of it, and a file that is valid JSON but not a
    // graph would otherwise fail somewhere inside that spread, as a type
    // error about a property rather than as what it is: a published body that
    // is not one.
    for (const key of PIECE_LISTS)
      if (!Array.isArray((piece as unknown as Record<string, unknown>)[key])) {
        throw new Error(
          `C/C++ clang graph: published body is not a graph: ${file}`,
        );
      }
    pieces.set(file, piece);
    // Bounded, because a piece is only kept to save reading it again.
    //
    // A walk names the same headers over and over, which is why keeping them
    // parsed is worth anything at all; but one C++ unit's facts run to
    // hundreds of megabytes, and keeping every piece a whole project ever
    // published is a second copy of the project in memory beside the graph
    // being built from it. Past the budget the least recently named pieces
    // are dropped: reading one again costs a file read, and holding one that
    // nothing is naming costs the run.
    // Recorded before anything is dropped, so the two maps are never out of
    // step and a size is never missing for a piece that is present.
    bytes.set(file, text.length);
    budget.held += text.length;
    while (budget.held > budget.limit && pieces.size > 1) {
      const oldest = pieces.keys().next().value!;
      budget.held -= bytes.get(oldest)!;
      bytes.delete(oldest);
      pieces.delete(oldest);
    }
    return piece;
  };
  // The first piece is the main file's, which carries the unit's identity and
  // its whole source set; the rest add the facts found in the files it
  // included. Reassembled, they are the unit -- and `assertShard` checks that
  // by rebuilding the producer's digest chain over the result, so pieces that
  // do not belong together fail there rather than becoming a graph.
  const [first, ...rest] = shard.graphPaths;
  const main = read(first!);
  const body: ICppGraphSnapshot.ITU = {
    ...main,
    symbols: [...main.symbols],
    occurrences: [...main.occurrences],
    relations: [...main.relations],
    macros: [...main.macros],
    includes: [...main.includes],
    missingIncludes: [...main.missingIncludes],
    modules: [...main.modules],
    diagnostics: [...main.diagnostics],
  };
  for (const file of rest) {
    const piece = read(file);
    appendAll(body.symbols, piece.symbols);
    appendAll(body.occurrences, piece.occurrences);
    appendAll(body.relations, piece.relations);
    appendAll(body.macros, piece.macros);
    appendAll(body.includes, piece.includes);
    appendAll(body.missingIncludes, piece.missingIncludes);
    appendAll(body.modules, piece.modules);
    appendAll(body.diagnostics, piece.diagnostics);
  }
  carried.graph = body;
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
  // Each page's own arithmetic, which the assembled envelope used to carry
  // for all of them. Summing first and checking once let two pages cancel:
  // a total overstated on one and understated on another added up right.
  if (
    snapshot.phases.totalMillis !==
    snapshot.phases.validationMillis +
      snapshot.phases.semanticMillis +
      snapshot.phases.shardMillis +
      snapshot.phases.encodeMillis
  ) {
    throw new Error("C/C++ clang graph: page telemetry does not add up");
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
