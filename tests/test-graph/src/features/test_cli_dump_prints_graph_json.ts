import { TestValidator } from "@nestia/e2e";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { ISamchonGraphDump } from "@samchon/graph";
import { routeSummary } from "../../../../packages/graph/src/routeSummary";
import { GraphFixtures } from "../internal/GraphFixtures";
import { GraphPaths } from "../internal/GraphPaths";
import { waitForProcessId } from "../internal/waitForProcessId";

export const test_cli_dump_prints_graph_json = async () => {
  const root = GraphFixtures.createOrderFixture();
  const output = execFileSync(process.execPath, [
    GraphPaths.graphBin,
    "dump",
    "--mode",
    "static",
    "--cwd",
    root,
  ], { encoding: "utf8" });
  const dump = JSON.parse(output);
  TestValidator.equals("CLI dump indexer", dump.indexer, "static");
  TestValidator.predicate("CLI dump has nodes", dump.nodes.length > 0);
  assertStructuredRouteProvenance(dump);

  assertTheDumpSaysWhatProducedIt(root);
  assertPrefixedWarningsRemainSingle();
  await assertTimedOutDumpRetiresItsLanguageServer();
};

function assertStructuredRouteProvenance(dump: Record<string, unknown>): void {
  const digest = "a".repeat(64);
  const enriched = {
    ...dump,
    provenance: [
      {
        provider: "fixture-provider",
        languages: ["typescript"],
        authority: "compiler",
        facts: ["calls"],
        capabilities: ["fixture"],
        producer: {
          tool: "fixture-compiler",
          version: "1.2.3",
          compiler: "TypeScript 6",
          schemaVersion: 2,
          protocolVersion: 1,
        },
        universe: digest,
        manifest: digest,
        content: digest,
      },
    ],
  } as unknown as ISamchonGraphDump;
  const route = JSON.parse(routeSummary(enriched));
  TestValidator.equals(
    "the route record keeps compact serving provenance",
    route.provenance,
    [
      {
        provider: "fixture-provider",
        languages: ["typescript"],
        authority: "compiler",
        producer: {
          tool: "fixture-compiler",
          version: "1.2.3",
          schemaVersion: 2,
          protocolVersion: 1,
        },
      },
    ],
  );
  enriched.provenance![0]!.producer.version = "x".repeat(17_000);
  TestValidator.equals(
    "an oversized route record drops unbounded evidence explicitly",
    JSON.parse(routeSummary(enriched)),
    {
      schemaVersion: 1,
      indexer: dump.indexer,
      provenance: [],
      truncated: true,
    },
  );
}

/**
 * A dump says which path produced it, and why the better ones did not.
 *
 * The payload reaches hundreds of megabytes and callers pipe it to /dev/null,
 * so this rides on stderr where it costs nothing. Without it a benchmark lane
 * spent an hour timing out unable to report whether its strict producer had
 * served, been declined, or never been installed — and a corpus that came back
 * from the best-effort syntax reader in under three seconds read as the
 * compiler-owned provider being fast.
 *
 * `--mode lsp` with no language server installed shows both halves: the summary
 * names the lane that answered, and the reasons nothing better did follow it.
 */
function assertTheDumpSaysWhatProducedIt(root: string): void {
  // A server that is not there. The lsp lane cannot start it, falls through,
  // and records why — which is the pair this asserts: the summary naming the
  // lane that answered, and the reasons nothing better did.
  //
  // `--server` and not `--max-files`: the CLI takes `--cwd`, `--graph-file`,
  // `--language`, `--lsp-concurrency`, `--lsp-ready-quiet-ms`, `--mode`,
  // `--server` and `--server-arg`, and an option it does not know is rejected
  // before the dump runs at all.
  const ran = spawnSync(
    process.execPath,
    [
      GraphPaths.graphBin,
      "dump",
      "--mode",
      "lsp",
      "--cwd",
      root,
      "--server",
      path.join(root, "no-such-language-server"),
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const summary = (ran.stderr ?? "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("@samchon/graph: "));
  TestValidator.predicate(
    "the dump names the indexer that answered",
    summary.some((line) => line.includes("indexer=")),
  );
  const routeLine = summary.find((line) =>
    line.startsWith("@samchon/graph: route="),
  );
  const route = JSON.parse(
    routeLine?.slice("@samchon/graph: route=".length) ?? "null",
  ) as {
    schemaVersion?: number;
    indexer?: string;
    provenance?: unknown[];
  } | null;
  TestValidator.equals(
    "the discarded payload keeps a bounded machine-readable route record",
    [
      route?.schemaVersion,
      route?.indexer,
      route?.provenance?.length,
      (routeLine?.length ?? Number.POSITIVE_INFINITY) < 17_000,
    ],
    [1, "static", 0, true],
  );
  TestValidator.predicate(
    "and reports the reasons nothing better served",
    summary.length > 1,
  );
  // Announced before the build, because everything else here is written after
  // it. Two benchmark lanes spent an hour each and were killed, and their logs
  // were empty — the run that most needs to say what it was doing is the one
  // that never reaches the end.
  TestValidator.predicate(
    "and says what it is about to run before it runs it",
    summary.some((line) => line.includes("indexing with")),
  );
}

/** A warning already scoped to this package is not scoped a second time. */
function assertPrefixedWarningsRemainSingle(): void {
  const root = GraphPaths.createTempDirectory("samchon-graph-cli-partial-");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "Service.cs"),
    [
      "namespace Demo;",
      "partial class Service {}",
      "partial class Service {}",
      "partial class Service {}",
      "",
    ].join("\n"),
  );
  const ran = spawnSync(
    process.execPath,
    [
      GraphPaths.graphBin,
      "dump",
      "--mode",
      "lsp",
      "--language",
      "csharp",
      "--cwd",
      root,
      "--server",
      path.join(root, "no-such-language-server"),
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const warning =
    "@samchon/graph: generic semantic declaration has 3 locations";
  const lines = (ran.stderr ?? "").split(/\r?\n/);
  TestValidator.equals(
    "a package-scoped warning is written with one prefix",
    lines.filter((line) => line.startsWith(warning)).length,
    1,
  );
  TestValidator.equals(
    "a package-scoped warning is never double-prefixed",
    lines.some(
      (line) =>
        line.startsWith(`@samchon/graph: ${warning}`),
    ),
    false,
  );
}

/**
 * The benchmark's outer timeout terminates the dump process, not the language
 * server it spawned. The CLI must turn that signal into its normal abort path
 * before it exits or the orphaned server consumes the host during the next
 * supposedly quiet cell.
 */
async function assertTimedOutDumpRetiresItsLanguageServer(): Promise<void> {
  /* c8 ignore start -- POSIX delivers SIGTERM to a Node handler. Windows
   * TerminateProcess is not catchable; its nested Job Object owns this tree. */
  if (process.platform === "win32") return;
  const root = GraphFixtures.createLspFixture();
  const pidFile = path.join(root, "language-server.pid");
  const sigtermFile = path.join(root, "language-server.sigterm");
  const child = spawn(
    process.execPath,
    [
      GraphPaths.graphBin,
      "dump",
      "--mode",
      "lsp",
      "--language",
      "typescript",
      "--cwd",
      root,
      "--server",
      process.execPath,
      "--server-arg",
      GraphPaths.fakeLspServer,
      "--server-arg",
      "--hang-method=initialize",
      "--server-arg",
      "--ignore-termination",
    ],
    {
      env: {
        ...process.env,
        SAMCHON_GRAPH_FAKE_LSP_PID_FILE: pidFile,
        SAMCHON_GRAPH_FAKE_LSP_SIGTERM_FILE: sigtermFile,
        SAMCHON_GRAPH_LSP_REQUEST_TRACE: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  let stderr = "";
  let serverPid: number | undefined;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    serverPid = await waitForProcessId(pidFile);
    child.kill("SIGTERM");
    const code = await waitForExit(child, 5_000);
    TestValidator.equals(
      "a terminated dump settles through its abort boundary",
      code,
      1,
    );
    TestValidator.predicate(
      "the dump reports its aborted build",
      stderr.includes("aborted"),
    );
    const cutoffAt = stderr.indexOf(
      "@samchon/graph: lsp-request phase=cutoff",
    );
    TestValidator.predicate(
      "the dump records its request cutoff before abort cleanup",
      cutoffAt >= 0 && cutoffAt < stderr.indexOf("aborted"),
    );
    TestValidator.equals(
      "the dump asks the owned language server to terminate",
      fs.existsSync(sigtermFile),
      true,
    );
    TestValidator.equals(
      "the dump leaves no language server behind the next benchmark cell",
      isProcessAlive(serverPid),
      false,
    );
  } finally {
    if (isProcessAlive(child.pid!)) child.kill("SIGKILL");
    if (serverPid !== undefined && isProcessAlive(serverPid)) {
      process.kill(serverPid, "SIGKILL");
    }
  }
  /* c8 ignore stop */
}

function waitForExit(
  child: import("node:child_process").ChildProcess,
  timeoutMs: number,
): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for the dump process to exit"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
