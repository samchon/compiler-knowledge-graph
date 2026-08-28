import { TestValidator } from "@nestia/e2e";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { cppGraphHeapTrace } from "../../../../packages/graph/src/provider/cpp/cppGraphHeapTrace";
import { GraphPaths } from "../internal/GraphPaths";

/**
 * The C/C++ consumer states its own size, and only when asked.
 *
 * Three CI hosts died on this route before any stage reported what it held,
 * and every answer since has come from making one state its own figure rather
 * than inferring it from the stage after it. That instrument is only worth
 * having if it stays off by default, never carries payload, and cannot take a
 * refresh down with it when the sink it writes to fails.
 */
export const test_cpp_heap_trace_is_opt_in_and_payload_free = async () => {
  TestValidator.equals(
    "the heap trace is absent unless it is asked for",
    [
      cppGraphHeapTrace({}),
      cppGraphHeapTrace({ SAMCHON_GRAPH_CPP_HEAP_TRACE: "0" }),
      cppGraphHeapTrace({ SAMCHON_GRAPH_CPP_HEAP_TRACE: "true" }),
      cppGraphHeapTrace({ SAMCHON_GRAPH_CPP_HEAP_TRACE: "" }),
    ],
    [undefined, undefined, undefined, undefined],
  );

  const lines: string[] = [];
  const trace = cppGraphHeapTrace(
    { SAMCHON_GRAPH_CPP_HEAP_TRACE: "1" },
    (line) => {
      lines.push(line);
    },
    () => ({
      rss: 3 * 1024 * 1024,
      heapTotal: 2 * 1024 * 1024,
      heapUsed: 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    }),
  )!;
  trace.stage("walking", 64, 900);
  trace.stage("paged", 242, 1_500);
  trace.stage("committed", 242, 90_250.7);
  TestValidator.equals(
    "each stage reports counts and megabytes, and nothing that names code",
    lines,
    [
      "@samchon/graph: cpp-heap stage=walking shards=64 elapsedMs=900 " +
        "heapUsedMiB=1 heapTotalMiB=2 rssMiB=3\n",
      "@samchon/graph: cpp-heap stage=paged shards=242 elapsedMs=1500 " +
        "heapUsedMiB=1 heapTotalMiB=2 rssMiB=3\n",
      "@samchon/graph: cpp-heap stage=committed shards=242 elapsedMs=90251 " +
        "heapUsedMiB=1 heapTotalMiB=2 rssMiB=3\n",
    ],
  );

  // A trace that cannot write is still a trace that must not end a refresh.
  // Asserting the call returns would pass on a version that swallowed the
  // failure and also on one that never reached the sink, so the sink counts.
  let refused = 0;
  const emitted = lines.length;
  const resilient = cppGraphHeapTrace(
    { SAMCHON_GRAPH_CPP_HEAP_TRACE: "1" },
    () => {
      refused += 1;
      throw new Error("synthetic heap sink failure");
    },
  )!;
  resilient.stage("paged", 1, 0);
  TestValidator.equals(
    "a failed heap sink is reached, contained, and emits nothing",
    [refused, lines.length - emitted],
    [1, 0],
  );

  // The writer this actually ships with. Everything above supplies its own
  // sink, which proves the message and proves nothing about how it leaves the
  // process -- and the two ways it can leave differ by whether stderr has a
  // file descriptor. This process has one, so this takes the `writeSync` arm
  // and its lines land in the run log beside every other diagnostic.
  const direct = cppGraphHeapTrace({ SAMCHON_GRAPH_CPP_HEAP_TRACE: "1" })!;
  TestValidator.equals(
    "the shipped writer is reachable and reports nothing back",
    direct.stage("committed", 0, 0),
    undefined,
  );

  // A redirected stderr has no descriptor, which is the other arm.
  const traceModule = pathToFileURL(
    path.join(
      GraphPaths.graphPackageRoot,
      "lib",
      "provider",
      "cpp",
      "cppGraphHeapTrace.js",
    ),
  ).href;
  const worker = new Worker(
    [
      "(async () => {",
      `  const { cppGraphHeapTrace } = await import(${JSON.stringify(traceModule)});`,
      "  const trace = cppGraphHeapTrace(",
      "    { SAMCHON_GRAPH_CPP_HEAP_TRACE: '1' },",
      "    undefined,",
      "    () => ({ rss: 7340032, heapTotal: 5242880, heapUsed: 4194304, external: 0, arrayBuffers: 0 }),",
      "  );",
      "  trace.stage('committed', 5, 12);",
      "})().catch((error) => { throw error; });",
    ].join("\n"),
    { eval: true, stderr: true },
  );
  worker.stderr.setEncoding("utf8");
  let workerStderr = "";
  worker.stderr.on("data", (chunk: string) => {
    workerStderr += chunk;
  });
  const exitPromise = new Promise<number>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", resolve);
  });
  const stderrEnd = new Promise<void>((resolve, reject) => {
    worker.stderr.once("error", reject);
    worker.stderr.once("end", resolve);
  });
  const [exit] = await Promise.all([exitPromise, stderrEnd]);
  TestValidator.equals(
    "a redirected Worker uses the stream writer when stderr has no fd",
    [exit, workerStderr],
    [
      0,
      "@samchon/graph: cpp-heap stage=committed shards=5 elapsedMs=12 " +
        "heapUsedMiB=4 heapTotalMiB=5 rssMiB=7\n",
    ],
  );
};
