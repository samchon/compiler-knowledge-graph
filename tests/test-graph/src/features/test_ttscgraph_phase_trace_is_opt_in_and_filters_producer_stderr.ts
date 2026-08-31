import { TestValidator } from "@nestia/e2e";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { ttscGraphPhaseTrace } from "../../../../packages/graph/src/provider/ttscgraph/ttscGraphPhaseTrace";
import { GraphPaths } from "../internal/GraphPaths";

/**
 * Phase evidence is a benchmark diagnostic, not a second transport surface.
 *
 * 1. Construct the trace with disabled and enabled isolated environments.
 * 2. Emit a consumer phase and fragmented producer stderr containing noise.
 * 3. Require stable timings while rejecting arbitrary diagnostics and paths.
 */
export const test_ttscgraph_phase_trace_is_opt_in_and_filters_producer_stderr =
  async () => {
    TestValidator.equals(
      "the phase trace is disabled by default",
      ttscGraphPhaseTrace({}, () => undefined),
      undefined,
    );
    const lines: string[] = [];
    const trace = ttscGraphPhaseTrace(
      { SAMCHON_GRAPH_TTSC_PHASE_TRACE: "1" },
      (line) => lines.push(line),
    )!;
    trace.event({
      request: 7,
      mode: "incremental",
      phase: "native-normalize",
      durationMs: 12.3456,
    });
    let buffered = trace.forwardProducer(
      "",
      "private diagnostic C:\\project\\secret.ts\n" +
        "@samchon/graph: ttscgraph-phase C:\\project\\spoof.ts\n" +
        "@samchon/graph: ttscgraph-",
    );
    buffered = trace.forwardProducer(
      buffered,
      "phase owner=producer request=7 mode=incremental phase=shard-export durationMs=8.250\n",
    );
    TestValidator.equals(
      "a complete producer line leaves no buffer",
      buffered,
      "",
    );
    TestValidator.equals(
      "only payload-free phase rows reach the trace",
      lines,
      [
        "@samchon/graph: ttscgraph-phase owner=consumer request=7 " +
          "mode=incremental phase=native-normalize durationMs=12.346\n",
        "@samchon/graph: ttscgraph-phase owner=producer request=7 " +
          "mode=incremental phase=shard-export durationMs=8.250\n",
      ],
    );
    TestValidator.equals(
      "a carriage-return producer line is normalized before filtering",
      trace.forwardProducer(
        "",
        "@samchon/graph: ttscgraph-phase owner=producer request=8 " +
          "mode=unchanged phase=producer-total durationMs=1.000\r\n",
      ),
      "",
    );
    TestValidator.equals(
      "an unterminated producer diagnostic is bounded",
      trace.forwardProducer("", "x".repeat(5_000)).length,
      4_096,
    );
    // The sink counts, so this states something. Asserting `true` after a call
    // that would have thrown does prove the call returned — but only to a
    // reader who works out that the throw would have propagated, and it goes
    // on passing if the sink stops being reached at all, which is the one way
    // the property could be lost without anything else changing.
    let refused = 0;
    const emitted = lines.length;
    const resilient = ttscGraphPhaseTrace(
      { SAMCHON_GRAPH_TTSC_PHASE_TRACE: "1" },
      () => {
        refused += 1;
        throw new Error("synthetic trace sink failure");
      },
    )!;
    resilient.event({
      request: 9,
      mode: "error",
      phase: "mcp-ready",
      durationMs: 1,
    });
    TestValidator.equals(
      "a failed trace sink is reached, contained, and emits nothing",
      [refused, lines.length - emitted],
      [1, 0],
    );

    const root = GraphPaths.createTempDirectory("samchon-graph-phase-trace-");
    fs.mkdirSync(path.join(root, "src", "core"), { recursive: true });
    fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
    fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};\n");
    fs.writeFileSync(
      path.join(root, "src", "core", "order.ts"),
      "export function first() {}\n",
    );
    fs.writeFileSync(path.join(root, "src", "empty.ts"), "export {};\n");
    const clientModule = pathToFileURL(
      path.join(
        GraphPaths.graphPackageRoot,
        "lib",
        "provider",
        "ttscgraph",
        "TtscGraphClient.js",
      ),
    ).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          `const { TtscGraphClient } = await import(${JSON.stringify(clientModule)});`,
          "const client = new TtscGraphClient({",
          `  root: ${JSON.stringify(root)},`,
          "  command: process.execPath,",
          `  args: [${JSON.stringify(GraphPaths.fakeTtscGraphServer)}, "--phase-trace"],`,
          "});",
          "try { await client.refresh(); } finally { await client.close(); }",
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          SAMCHON_GRAPH_TTSC_PHASE_TRACE: "1",
        },
        windowsHide: true,
      },
    );
    TestValidator.predicate(
      "the client forwards only exact producer rows beside its consumer phases",
      child.status === 0 &&
        child.signal === null &&
        child.stderr.includes("owner=producer request=1 mode=initial") &&
        child.stderr.includes(
          "owner=consumer request=1 mode=initial phase=mcp-ready",
        ) &&
        !child.stderr.includes("spoof.ts"),
    );

    const traceModule = pathToFileURL(
      path.join(
        GraphPaths.graphPackageRoot,
        "lib",
        "provider",
        "ttscgraph",
        "ttscGraphPhaseTrace.js",
      ),
    ).href;
    const worker = new Worker(
      [
        "(async () => {",
        `  const { ttscGraphPhaseTrace } = await import(${JSON.stringify(traceModule)});`,
        "  const trace = ttscGraphPhaseTrace({ SAMCHON_GRAPH_TTSC_PHASE_TRACE: '1' });",
        "  trace.event({ request: 11, mode: 'unchanged', phase: 'mcp-ready', durationMs: 2 });",
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
        "@samchon/graph: ttscgraph-phase owner=consumer request=11 " +
          "mode=unchanged phase=mcp-ready durationMs=2.000\n",
      ],
    );
  };
