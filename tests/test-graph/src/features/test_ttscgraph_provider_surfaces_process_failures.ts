import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import path from "node:path";

// `TtscGraphClient` is internal to the package, so it is reached by path rather
// than through the public barrel.
import { TtscGraphClient } from "../../../../packages/graph/src/provider/ttscgraph/TtscGraphClient";
import { GraphPaths } from "../internal/GraphPaths";

/**
 * A resident strict session must always tell the truth about its child process:
 * a process that cannot start or crashes is surfaced as an error, while one
 * that refuses graceful shutdown is force-retired through the exact owned
 * handle. None becomes a silent empty graph or a leaked child.
 */
export const test_ttscgraph_provider_surfaces_process_failures = async () => {
  const root = GraphPaths.createTempDirectory("samchon-graph-ttscgraph-fail-");

  TestValidator.equals(
    "silent native exits distinguish signals, codes, and a still-running child",
    [
      TtscGraphClient.exitSuffix({
        signalCode: "SIGKILL",
        exitCode: null,
      }),
      TtscGraphClient.exitSuffix({ signalCode: null, exitCode: 7 }),
      TtscGraphClient.exitSuffix({ signalCode: null, exitCode: null }),
    ],
    [" (killed by SIGKILL)", " (child exited 7)", ""],
  );

  // A command that cannot be spawned rejects the refresh instead of hanging or
  // returning an empty snapshot, and publishes no generation.
  const unspawnable = new TtscGraphClient({
    root,
    command: path.join(root, "no-such-ttscgraph-binary"),
  });
  await rejects(
    unspawnable.refresh(),
    "an unspawnable command surfaces an error",
  );
  TestValidator.predicate(
    "an unspawnable command publishes no snapshot",
    unspawnable.current === undefined && unspawnable.generation === 0,
  );
  await unspawnable.close();

  // A process that writes diagnostics and then exits mid-request surfaces those
  // diagnostics verbatim, and a later refresh keeps reporting the dead process.
  const dying = new TtscGraphClient({
    root,
    command: process.execPath,
    args: [GraphPaths.fakeTtscGraphServer, "--stderr-exit"],
  });
  // No sleep before refreshing, deliberately. This used to wait 200 ms so the
  // child was already gone and its stderr already drained — which meant the
  // race was stepped around rather than closed. The client now waits for the
  // streams to finish before it reports, so the diagnostics arrive whether or
  // not the caller happened to pause first.
  let crash: unknown;
  try {
    await dying.refresh();
  } catch (error) {
    crash = error;
  }
  TestValidator.predicate(
    "a crashed serve process surfaces its stderr diagnostics",
    crash instanceof Error && crash.message.includes("ttscgraph diagnostic: fatal"),
  );
  TestValidator.predicate(
    "a crash leaves no snapshot and no generation",
    dying.current === undefined && dying.generation === 0,
  );
  await rejects(
    dying.refresh(),
    "a refresh after the process exited reports it is gone",
  );
  // The child already exited, so close resolves immediately without touching it.
  await dying.close();

  // A process that exits without diagnostics still rejects, and a later refresh
  // reports the process is gone without inventing an empty snapshot.
  const silent = new TtscGraphClient({
    root,
    command: process.execPath,
    args: [GraphPaths.fakeTtscGraphServer, "--exit-silently"],
  });
  // A child that says nothing still says how it left, and that is the whole
  // diagnosis available for one. The flagship benchmark lane came back with
  // `write EPIPE` and nothing else and fell to the static reader; an exit code
  // separates a program that chose to stop from one the kernel killed, which a
  // broken pipe alone never distinguishes.
  let quiet: unknown;
  try {
    await silent.refresh();
  } catch (error) {
    quiet = error;
  }
  TestValidator.predicate(
    "a silently exiting process rejects the refresh",
    quiet instanceof Error,
  );
  TestValidator.predicate(
    "and how it left is named even when it said nothing",
    quiet instanceof Error &&
      /exited \(1\)|child exited 1|killed by/.test(quiet.message),
  );
  await rejects(
    silent.refresh(),
    "a refresh after a silent exit reports the process is not running",
  );
  await silent.close();

  // A closed session refuses further refreshes, and close is idempotent.
  const closed = new TtscGraphClient({
    root,
    command: process.execPath,
    args: [GraphPaths.fakeTtscGraphServer],
  });
  const firstClose = closed.close();
  const secondClose = closed.close();
  TestValidator.equals(
    "close is idempotent and returns the same in-flight promise",
    firstClose === secondClose,
    true,
  );
  await firstClose;
  await rejects(
    closed.refresh(),
    "a refresh after close reports the session is closed",
  );

  // Windows named pipes retain the inherited read handle until process exit,
  // so they surface this condition through the already-covered exit listener.
  // Keep this platform-specific transport probe after the independent closed
  // session assertions so a pipe failure cannot hide their coverage.
  /* c8 ignore next */
  if (process.platform !== "win32") await assertClosedRequestPipe(root);

  // Closing before the first request must not spawn a process merely to stop it.
  const marker = path.join(root, "stubborn-closed.txt");
  const stubborn = new TtscGraphClient({
    root,
    command: process.execPath,
    args: [
      GraphPaths.fakeTtscGraphServer,
      "--ignore-stdin",
      `--marker=${marker}`,
    ],
  });
  await stubborn.close();
  TestValidator.equals(
    "pre-start close creates no owned process",
    fs.existsSync(marker),
    false,
  );
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await delay(10);
  }
}

async function assertClosedRequestPipe(root: string): Promise<void> {
  // A producer can remain alive after closing the request side of its pipe.
  // The next refresh must reject the write failure and retire that generation
  // instead of waiting for the snapshot timeout.
  const stdinClosed = path.join(root, "stdin-closed.txt");
  const client = new TtscGraphClient({
    root,
    command: process.execPath,
    args: [
      GraphPaths.fakeTtscGraphServer,
      "--close-stdin-after-first",
      `--stdin-closed-marker=${stdinClosed}`,
    ],
    requestTimeoutMs: 5_000,
  });
  try {
    await client.refresh();
    await waitForFile(stdinClosed);
    const writeFailure = await rejectionOf(client.refresh());
    TestValidator.predicate(
      "a closed native request pipe rejects before the snapshot timeout",
      (writeFailure.message.includes("could not request snapshot") ||
        writeFailure.message.includes("stdin failed")) &&
        !writeFailure.message.includes("timed out"),
    );
  } finally {
    await client.close();
  }
}

async function rejectionOf(task: Promise<unknown>): Promise<Error> {
  try {
    await task;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected promise to reject");
}

async function rejects(task: Promise<unknown>, label: string): Promise<void> {
  let error: unknown;
  try {
    await task;
  } catch (caught) {
    error = caught;
  }
  TestValidator.predicate(label, error instanceof Error);
}
