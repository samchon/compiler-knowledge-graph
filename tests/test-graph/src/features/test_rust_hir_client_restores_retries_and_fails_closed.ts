import { TestValidator } from "@nestia/e2e";
import {
  RUST_GRAPH_PRODUCER_COMMIT,
  RustGraphClient,
  buildLspGraph,
  rustGraphProvider,
} from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths.js";

export const test_rust_hir_client_restores_retries_and_fails_closed = async () => {
  const root = GraphPaths.createTempDirectory("samchon-graph-rust-client-");
  const cacheRoot = GraphPaths.createTempDirectory("samchon-graph-rust-checkpoints-");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/lib.rs"), "pub fn answer() -> u8 { 42 }\n");

  await assertResidentLifecycle(root, cacheRoot);
  await assertCheckpointRejectionRecovers(root, cacheRoot);
  await assertRetryBoundaries(root);
  await assertCancellationBoundaries(root);
  await assertPersistenceAndValidationBoundaries(root);
  await assertClientOptionBoundaries(root);
  await assertPublicCommitFence(root);
  await assertPinnedResolution(root);
};

async function assertResidentLifecycle(root: string, cacheRoot: string): Promise<void> {
  const marker = path.join(root, "basic-closed.txt");
  const requestLog = path.join(root, "basic-requests.ndjson");
  let validations = 0;
  const client = rustClient(root, cacheRoot, [
    `--marker=${marker}`,
    `--request-log=${requestLog}`,
  ], () => {
    validations += 1;
  });
  const initial = await client.refresh();
  const unchanged = await client.refresh();
  TestValidator.equals(
    "the resident Rust client publishes and reuses one validated generation",
    [
      initial.changed,
      initial.mode,
      initial.generation,
      unchanged.changed,
      unchanged.mode,
      unchanged.snapshot === initial.snapshot,
      client.current === initial.snapshot,
      client.generation,
      initial.snapshot.nodes.map((node) => [node.name, node.language]),
      initial.snapshot.sources.has(path.join(root, "src/lib.rs")),
      initial.snapshot.provenance.provider,
      validations,
    ],
    [
      true,
      "initial",
      1,
      false,
      "unchanged",
      true,
      true,
      1,
      [
        ["dependency", "rust"],
        ["answer", "rust"],
      ],
      true,
      "samchon-rust-analyzer-hir",
      2,
    ],
  );
  await Promise.all([client.close(), client.close()]);
  TestValidator.equals("the Rust LSP process closes through its handshake", fs.readFileSync(marker, "utf8"), "closed");
  await rejected("a closed Rust session refuses refresh", client.refresh(), "session is closed");

  let restoredValidations = 0;
  const restoredLog = path.join(root, "restored-requests.ndjson");
  const restored = rustClient(root, cacheRoot, [`--request-log=${restoredLog}`], () => {
    restoredValidations += 1;
  });
  TestValidator.predicate(
    "a persisted checkpoint stays unpublished before the restarted producer validates it",
    restored.current === undefined && restored.generation === 0 && restoredValidations === 0,
  );
  const reuse = await restored.refresh();
  const params = readRequests(restoredLog)[0]!;
  TestValidator.equals(
    "a restart sends both the exact known generation and its producer checkpoint",
    [
      reuse.changed,
      reuse.mode,
      reuse.generation,
      params.knownGeneration,
      params.checkpoint?.generation,
    ],
    [true, "initial", 1, params.checkpoint?.generation, params.checkpoint?.generation],
  );
  await restored.close();
}

async function assertCheckpointRejectionRecovers(
  root: string,
  cacheRoot: string,
): Promise<void> {
  const requestLog = path.join(root, "rejected-checkpoint-requests.ndjson");
  const client = rustClient(root, cacheRoot, [
    "--reject-checkpoint",
    `--request-log=${requestLog}`,
  ]);
  const refreshed = await client.refresh();
  const requests = readRequests(requestLog);
  TestValidator.equals(
    "a producer-rejected persisted checkpoint is discarded and rebuilt once",
    [
      refreshed.changed,
      refreshed.mode,
      requests.length,
      requests[0]?.checkpoint !== undefined,
      requests[1]?.checkpoint,
      requests[1]?.knownGeneration,
    ],
    [true, "initial", 2, true, undefined, undefined],
  );
  await client.close();
}

async function assertRetryBoundaries(root: string): Promise<void> {
  const retrying = rustClient(root, isolatedCache(), ["--retry=1", "--content-modified=1"], undefined, {
    readyTimeoutMs: 1_000,
  });
  TestValidator.equals(
    "ServerCancelled and ContentModified are retried until the producer is ready",
    (await retrying.refresh()).changed,
    true,
  );
  await retrying.close();

  const exhausted = rustClient(root, isolatedCache(), ["--retry=100"], undefined, {
    readyTimeoutMs: 1,
  });
  await rejected(
    "the Rust readiness retry loop has a hard deadline",
    exhausted.refresh(),
    "did not become ready",
  );
  await exhausted.close();

  const internal = rustClient(root, isolatedCache(), ["--internal-error"]);
  await rejected(
    "an unrelated producer error is not disguised as readiness",
    internal.refresh(),
    "fixture internal failure",
  );
  await internal.close();

  const malformed = rustClient(root, isolatedCache(), ["--malformed"]);
  await rejected(
    "a malformed producer identity fails before publication",
    malformed.refresh(),
    "identity/commit mismatch",
  );
  TestValidator.equals("a rejected producer response leaves no resident graph", malformed.current, undefined);
  await malformed.close();
}

async function assertCancellationBoundaries(root: string): Promise<void> {
  const preAborted = rustClient(root, isolatedCache(), []);
  const preAbort = new AbortController();
  preAbort.abort("pre-aborted fixture cancellation");
  await rejected(
    "a pre-aborted Rust request never enters its session queue",
    preAborted.refresh({ signal: preAbort.signal }),
    "cancelled",
  );
  await preAborted.close();

  const initializeMarker = path.join(root, "initialize-abort-started.txt");
  const initializing = rustClient(root, isolatedCache(), [
    "--initialize-delay=100",
    `--initialize-marker=${initializeMarker}`,
  ]);
  const initializeAbort = new AbortController();
  const cancelledInitialization = initializing.refresh({
    signal: initializeAbort.signal,
  });
  await waitFor(() => fs.existsSync(initializeMarker));
  initializeAbort.abort("initialize fixture cancellation");
  await rejected(
    "caller cancellation leaves the shared Rust initialization usable",
    cancelledInitialization,
    "cancelled",
  );
  TestValidator.equals(
    "a later refresh reuses and completes the initialization instead of inheriting its caller's cancellation",
    (await initializing.refresh()).changed,
    true,
  );
  await initializing.close();

  const failedInitialization = rustClient(root, isolatedCache(), [
    "--initialize-error",
  ]);
  await rejected(
    "a producer initialization error crosses the caller-cancellation fence intact",
    failedInitialization.refresh({ signal: new AbortController().signal }),
    "fixture initialize failure",
  );
  await rejected(
    "a failed producer initialization remains a fatal session result",
    failedInitialization.refresh(),
    "fixture initialize failure",
  );
  await failedInitialization.close();

  const retryLog = path.join(root, "retry-abort-requests.ndjson");
  const retrySent = path.join(root, "retry-abort-sent.txt");
  const retryDelay = rustClient(root, isolatedCache(), [
    "--retry=100",
    `--request-log=${retryLog}`,
    `--retry-sent-marker=${retrySent}`,
  ]);
  const retryAbort = new AbortController();
  const retryRefresh = retryDelay.refresh({ signal: retryAbort.signal });
  await waitFor(() => fs.existsSync(retrySent));
  await new Promise((resolve) => setTimeout(resolve, 10));
  retryAbort.abort("retry-delay fixture cancellation");
  await rejected(
    "Rust readiness backoff remains cancellable",
    retryRefresh,
    "cancelled",
  );
  await retryDelay.close();

  const activeLog = path.join(root, "active-abort-requests.ndjson");
  const active = rustClient(root, isolatedCache(), ["--hang", `--request-log=${activeLog}`]);
  const activeAbort = new AbortController();
  const activeRefresh = active.refresh({ signal: activeAbort.signal });
  await waitFor(() => fs.existsSync(activeLog));
  activeAbort.abort("active fixture cancellation");
  await rejected("an active Rust request observes caller cancellation", activeRefresh, "aborted");
  await active.close();

  const requestLog = path.join(root, "queued-abort-requests.ndjson");
  const queued = rustClient(root, isolatedCache(), ["--hang", `--request-log=${requestLog}`]);
  const first = queued.refresh();
  await waitFor(() => fs.existsSync(requestLog));
  const queuedAbort = new AbortController();
  const second = queued.refresh({ signal: queuedAbort.signal });
  queuedAbort.abort("queued fixture cancellation");
  await rejected("a queued Rust request cancels without entering the producer", second, "cancelled");
  const firstRejected = rejected(
    "closing the Rust session cancels its active request",
    first,
    "aborted",
  );
  await queued.close();
  await firstRejected;
  TestValidator.equals("the cancelled queued request never reached the producer", readRequests(requestLog).length, 1);
}

async function assertPersistenceAndValidationBoundaries(root: string): Promise<void> {
  const cacheFile = path.join(isolatedCache(), "not-a-directory");
  fs.writeFileSync(cacheFile, "file");
  const nonPersistent = rustClient(root, cacheFile, []);
  const published = await nonPersistent.refresh();
  TestValidator.predicate(
    "checkpoint persistence failure is disclosed without discarding the validated resident graph",
    published.snapshot.warnings.some((warning) => warning.includes("could not be persisted")),
  );
  await nonPersistent.close();

  const refused = rustClient(root, isolatedCache(), [], () => {
    throw new Error("fixture consumer contract rejection");
  });
  await rejected(
    "the consumer contract runs before cache persistence and publication",
    refused.refresh(),
    "fixture consumer contract rejection",
  );
  TestValidator.equals("consumer rejection is atomic", refused.current, undefined);
  await refused.close();

  const refusedString = rustClient(root, isolatedCache(), [], () => {
    throw "fixture consumer string rejection";
  });
  await rejected(
    "a non-Error consumer rejection is normalized at the session boundary",
    refusedString.refresh(),
    "fixture consumer string rejection",
  );
  await refusedString.close();
}

async function assertClientOptionBoundaries(root: string): Promise<void> {
  const options = new RustGraphClient({
    root,
    cacheRoot: isolatedCache(),
    command: process.execPath,
    args: [
      GraphPaths.fakeRustGraphServer,
      `--commit=${RUST_GRAPH_PRODUCER_COMMIT}`,
      "--configuration-without-items",
      "--expect-initialization-options",
    ],
    producerCommit: RUST_GRAPH_PRODUCER_COMMIT,
    initializationOptions: { fixture: true },
  });
  TestValidator.equals(
    "the Rust client forwards initialization options and answers configuration requests without items",
    (await options.refresh()).changed,
    true,
  );
  await options.close();

  const closing = rustClient(root, isolatedCache(), []);
  const racedRefresh = closing.refresh();
  const racedRejection = rejected(
    "closing before a queued Rust refresh starts fails at the session fence",
    racedRefresh,
    "session is closed",
  );
  await closing.close();
  await racedRejection;
}

async function assertPublicCommitFence(root: string): Promise<void> {
  const cacheRoot = isolatedCache();
  const priorCacheRoot = process.env.SAMCHON_GRAPH_CACHE_DIR;
  process.env.SAMCHON_GRAPH_CACHE_DIR = cacheRoot;
  try {
    const result = await buildLspGraph(
      { cwd: root, languages: ["rust"] },
      {
        providers: [
          {
            ...rustGraphProvider,
            resolve: () => ({
              command: process.execPath,
              args: [
                GraphPaths.fakeRustGraphServer,
                `--commit=${RUST_GRAPH_PRODUCER_COMMIT}`,
              ],
            }),
          },
        ],
      },
    );
    TestValidator.equals(
      "a disk-bound Rust HIR generation crosses the public commit fence",
      [
        result.dump.provenance?.map((row) => row.provider),
        result.dump.nodes.some((node) => node.name === "answer"),
        result.dump.warnings.some((warning) =>
          warning.includes("does not bind the provider snapshot"),
        ),
      ],
      [["samchon-rust-analyzer-hir"], true, false],
    );
  } finally {
    if (priorCacheRoot === undefined) delete process.env.SAMCHON_GRAPH_CACHE_DIR;
    else process.env.SAMCHON_GRAPH_CACHE_DIR = priorCacheRoot;
  }
}

async function assertPinnedResolution(root: string): Promise<void> {
  const pinned = nodeShim(root, "pinned-rust-analyzer", RUST_GRAPH_PRODUCER_COMMIT);
  const wrong = nodeShim(root, "wrong-rust-analyzer", "0000000000000000000000000000000000000000");
  const failing = nodeShim(root, "failing-rust-analyzer", RUST_GRAPH_PRODUCER_COMMIT, [
    "--fail-version",
  ]);
  const override = "SAMCHON_GRAPH_RUST_ANALYZER_HIR";
  const resolved = rustGraphProvider.resolve(root, { ...process.env, [override]: pinned });
  const rejected = rustGraphProvider.resolve(root, { ...process.env, [override]: wrong });
  const failed = rustGraphProvider.resolve(root, { ...process.env, [override]: failing });
  TestValidator.equals(
    "the HIR provider resolves only the exact disclosed producer commit",
    [
      resolved !== undefined,
      rejected,
      failed,
      rustGraphProvider.configuration?.(root, { [override]: pinned }),
    ],
    [
      true,
      undefined,
      undefined,
      [
        `producer-commit=${RUST_GRAPH_PRODUCER_COMMIT}`,
        `${override}=${pinned}`,
      ],
    ],
  );
  TestValidator.equals(
    "an absent Rust producer override remains explicit in build configuration",
    rustGraphProvider.configuration?.(root, {}),
    [
      `producer-commit=${RUST_GRAPH_PRODUCER_COMMIT}`,
      `${override}=unconfigured`,
    ],
  );
  TestValidator.predicate(
    "whole-program Rust generations explicitly refuse bounded or caller-owned LSP modes",
    rustGraphProvider.refuse({ maxFiles: 1 })?.includes("maxFiles") === true &&
      rustGraphProvider.refuse({ server: "rust-analyzer" })?.includes("server") === true &&
      rustGraphProvider.refuse({ lspReferenceLimit: 1 })?.includes("lspReferenceLimit") === true &&
      rustGraphProvider.refuse({}) === undefined,
  );
  const priorCacheRoot = process.env.SAMCHON_GRAPH_CACHE_DIR;
  process.env.SAMCHON_GRAPH_CACHE_DIR = isolatedCache();
  try {
    const session = rustGraphProvider.open({
      root,
      command: resolved!,
      languages: ["rust"],
      options: {},
    });
    try {
      const snapshot = await session.refresh();
      TestValidator.equals(
        "the registered Rust provider opens the pinned producer under its declared contract",
        [snapshot.changed, snapshot.snapshot.provenance.authority],
        [true, "analyzer"],
      );
    } finally {
      await session.close();
    }
  } finally {
    if (priorCacheRoot === undefined) delete process.env.SAMCHON_GRAPH_CACHE_DIR;
    else process.env.SAMCHON_GRAPH_CACHE_DIR = priorCacheRoot;
  }
}

function rustClient(
  root: string,
  cacheRoot: string,
  args: readonly string[],
  validate?: ConstructorParameters<typeof RustGraphClient>[0]["validate"],
  timeouts: { requestTimeoutMs?: number; readyTimeoutMs?: number } = {},
): RustGraphClient {
  return new RustGraphClient({
    root,
    cacheRoot,
    command: process.execPath,
    args: [
      GraphPaths.fakeRustGraphServer,
      `--commit=${RUST_GRAPH_PRODUCER_COMMIT}`,
      ...args,
    ],
    producerCommit: RUST_GRAPH_PRODUCER_COMMIT,
    validate,
    ...timeouts,
  });
}

function isolatedCache(): string {
  return GraphPaths.createTempDirectory("samchon-graph-rust-isolated-cache-");
}

function readRequests(file: string): Array<{
  knownGeneration?: string;
  checkpoint?: { generation?: string };
}> {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

function nodeShim(
  root: string,
  name: string,
  commit: string,
  args: readonly string[] = [],
): string {
  const directory = path.join(root, "shims");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, process.platform === "win32" ? `${name}.cmd` : name);
  const invocation = [
    `"${process.execPath}"`,
    `"${GraphPaths.fakeRustGraphServer}"`,
    `--commit=${commit}`,
    ...args,
  ].join(" ");
  fs.writeFileSync(
    file,
    process.platform === "win32"
      ? `@echo off\r\n${invocation} %*\r\n`
      : `#!/bin/sh\nexec ${invocation} "$@"\n`,
  );
  if (process.platform !== "win32") fs.chmodSync(file, 0o755);
  return file;
}

async function rejected(label: string, promise: Promise<unknown>, message: string): Promise<void> {
  let error: Error | undefined;
  try {
    await promise;
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }
  TestValidator.predicate(label, error !== undefined && error.message.includes(message));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fixture condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
