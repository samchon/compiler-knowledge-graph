import { TestValidator } from "@nestia/e2e";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { TtscGraphClient } from "../../../../packages/graph/src/provider/ttscgraph/TtscGraphClient";
import { GraphPaths } from "../internal/GraphPaths";

/** A stalled request owns one child generation, never the resident queue. */
export const test_ttscgraph_native_requests_recover_from_stalls = async () => {
  const root = fixture();
  const marker = path.join(root, "first-child.txt");
  // The Windows Job Object supervisor must initialize before the native
  // server can read its first request. Keep the deliberate stall comfortably
  // beyond cold PowerShell startup so this proves the request deadline rather
  // than timing the host's process-launch load.
  const stallTimeoutMs = 5_000;
  const client = create(root, marker, stallTimeoutMs);
  try {
    const first = client.refresh();
    const queued = client.refresh();
    const error = await rejectionOf(first);
    TestValidator.predicate(
      "a silent native request times out precisely",
      error.message.includes(`timed out after ${String(stallTimeoutMs)} ms`),
    );
    const recovered = await queued;
    TestValidator.equals(
      "a queued refresh restarts on a fresh child",
      recovered.generation,
      1,
    );
    TestValidator.predicate(
      "the timed-out snapshot is not retained",
      recovered.snapshot.nodes.some((node) => node.name === "first"),
    );
  } finally {
    await client.close();
  }

  const closeRoot = fixture();
  const closeRequestLog = path.join(closeRoot, "close-request.txt");
  const closeClient = create(
    closeRoot,
    path.join(closeRoot, "first-child.txt"),
    5_000,
    closeRequestLog,
  );
  const stalled = closeClient.refresh();
  const queuedBehindStall = closeClient.refresh();
  await waitForFile(closeRequestLog);
  const closed = await Promise.race([
    Promise.allSettled([
      stalled,
      queuedBehindStall,
      closeClient.close(),
    ]),
    delay(1_000).then(() => "timeout" as const),
  ]);
  TestValidator.predicate(
    "close rejects active and queued refreshes without waiting for the stall",
    closed !== "timeout" &&
      closed[0]?.status === "rejected" &&
      closed[1]?.status === "rejected" &&
      closed[2]?.status === "fulfilled",
  );

  /* c8 ignore next -- Windows terminates child processes unconditionally. */
  if (process.platform !== "win32") {
    await assertRetiredChildIsClosed();
  }

  const abortRoot = fixture();
  const abortRequestLog = path.join(abortRoot, "abort-request.txt");
  const abortClient = create(
    abortRoot,
    path.join(abortRoot, "first-child.txt"),
    5_000,
    abortRequestLog,
  );
  try {
    const controller = new AbortController();
    const aborted = abortClient.refresh({ signal: controller.signal });
    await waitForFile(abortRequestLog);
    controller.abort("test cancellation");
    const error = await rejectionOf(aborted);
    TestValidator.predicate(
      "abort retires its exact child generation",
      error.name === "AbortError" && error.message.includes("test cancellation"),
    );
    TestValidator.equals(
      "the next refresh recovers after abort",
      (await abortClient.refresh()).generation,
      1,
    );
  } finally {
    await abortClient.close();
  }

  const queuedAbortRoot = fixture();
  const queuedAbortLog = path.join(queuedAbortRoot, "queued-abort-request.txt");
  const queuedAbortClient = create(
    queuedAbortRoot,
    path.join(queuedAbortRoot, "first-child.txt"),
    15_000,
    queuedAbortLog,
  );
  const active = queuedAbortClient.refresh();
  try {
    await waitForFile(queuedAbortLog);
    const controller = new AbortController();
    const queued = queuedAbortClient.refresh({ signal: controller.signal });
    controller.abort(new Error("queued cancellation"));
    const error = await rejectionOf(queued);
    TestValidator.predicate(
      "an aborted queued refresh settles before it owns a child",
      error.name === "AbortError" && error.message.includes("queued cancellation"),
    );
    TestValidator.equals(
      "queued cancellation writes no native request",
      fs.readFileSync(queuedAbortLog, "utf8"),
      "1\n",
    );
  } finally {
    const closing = queuedAbortClient.close();
    await rejectionOf(active);
    await closing;
  }

  const immediateRoot = fixture();
  const immediateMarker = path.join(immediateRoot, "pre-aborted-child.txt");
  const immediate = create(immediateRoot, immediateMarker, 5_000);
  const immediateController = new AbortController();
  immediateController.abort({
    toString: () => {
      throw new Error("reason cannot be rendered");
    },
  });
  const immediateError = await rejectionOf(
    immediate.refresh({ signal: immediateController.signal }),
  );
  TestValidator.predicate(
    "an already-aborted refresh fails without rendering a hostile reason",
    immediateError.name === "AbortError" &&
      immediateError.message === "ttscgraph: snapshot request cancelled",
  );
  await immediate.close();
  TestValidator.equals(
    "an already-aborted refresh spawns no child",
    fs.existsSync(immediateMarker),
    false,
  );

  const handoffRoot = fixture();
  const handoffClient = new TtscGraphClient({
    root: handoffRoot,
    command: process.execPath,
    args: [GraphPaths.fakeTtscGraphServer],
  });
  try {
    const controller = new AbortController();
    const error = await rejectionOf(
      handoffClient.refresh({ signal: abortAtQueueHandoff(controller) }),
    );
    TestValidator.predicate(
      "an abort at the queue-to-request handoff is observed before spawn",
      error.name === "AbortError" && error.message.includes("handoff cancellation"),
    );
  } finally {
    await handoffClient.close();
  }

  const registrationRoot = fixture();
  const registrationClient = new TtscGraphClient({
    root: registrationRoot,
    command: process.execPath,
    args: [GraphPaths.fakeTtscGraphServer],
    requestTimeoutMs: 5_000,
  });
  try {
    const controller = new AbortController();
    const signal = abortDuringRequestRegistration(controller);
    const error = await Promise.race([
      rejectionOf(registrationClient.refresh({ signal })),
      delay(1_000).then(() => {
        throw new Error("post-registration abort left the refresh pending");
      }),
    ]);
    TestValidator.predicate(
      "an abort dispatched during request registration settles its owned request",
      error.name === "AbortError" &&
        error.message === "ttscgraph: snapshot request cancelled",
    );
  } finally {
    await registrationClient.close();
  }

  const reorderedCapabilities = new TtscGraphClient({
    root: fixture(),
    command: process.execPath,
    args: [
      GraphPaths.fakeTtscGraphServer,
      "--reverse-capabilities",
      "--duplicate-capability",
    ],
  });
  try {
    TestValidator.equals(
      "capability identity tolerates reordered repeated claims on both sides",
      (await reorderedCapabilities.refresh()).generation,
      1,
    );
  } finally {
    await reorderedCapabilities.close();
  }

  for (const value of [0, -1, 1.5, Number.NaN, 2_147_483_648]) {
    let error: unknown;
    try {
      new TtscGraphClient({
        root,
        command: process.execPath,
        args: [GraphPaths.fakeTtscGraphServer],
        requestTimeoutMs: value,
      });
    } catch (caught) {
      error = caught;
    }
    TestValidator.predicate(
      `unsafe timeout ${String(value)} is rejected before spawn`,
      error instanceof TypeError,
    );
  }
};

const abortAtQueueHandoff = (controller: AbortController): AbortSignal =>
  new Proxy(controller.signal, {
    get(target, property) {
      if (property === "removeEventListener") {
        return (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: boolean | EventListenerOptions,
        ): void => {
          target.removeEventListener(type, listener, options);
          controller.abort("handoff cancellation");
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

const abortDuringRequestRegistration = (
  controller: AbortController,
): AbortSignal => {
  let registrations = 0;
  return new Proxy(controller.signal, {
    get(target, property) {
      if (property === "reason") return undefined;
      if (property === "addEventListener") {
        return (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: boolean | AddEventListenerOptions,
        ): void => {
          target.addEventListener(type, listener, options);
          registrations += 1;
          if (registrations === 2) {
            controller.abort("registration cancellation");
          }
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

const create = (
  root: string,
  marker: string,
  requestTimeoutMs: number,
  requestLog?: string,
): TtscGraphClient =>
  new TtscGraphClient({
    root,
    command: process.execPath,
    args: [
      GraphPaths.fakeTtscGraphServer,
      `--ignore-first-process=${marker}`,
      ...(requestLog === undefined ? [] : [`--request-log=${requestLog}`]),
    ],
    requestTimeoutMs,
  });

/** A detached generation remains owned until its SIGKILL fallback exits. */
const assertRetiredChildIsClosed = async (): Promise<void> => {
  const root = fixture();
  const started = path.join(root, "retired-child.txt");
  const requested = path.join(root, "retired-request.txt");
  const terminated = path.join(root, "retired-sigterm.txt");
  const unrelatedStarted = path.join(root, "unrelated-child.txt");
  const childSource = [
    'const fs = require("node:fs");',
    'const readline = require("node:readline");',
    `fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));`,
    "readline.createInterface({ input: process.stdin }).once(\"line\", () =>",
    `  fs.writeFileSync(${JSON.stringify(requested)}, "request\\n"));`,
    "process.on(\"SIGTERM\", () =>",
    `  fs.writeFileSync(${JSON.stringify(terminated)}, "sigterm\\n"));`,
    "setInterval(() => undefined, 1_000);",
  ].join("\n");
  const client = new TtscGraphClient({
    root,
    command: process.execPath,
    args: ["-e", childSource],
    requestTimeoutMs: 5_000,
  });
  const unrelated = spawn(
    process.execPath,
    [
      "-e",
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(unrelatedStarted)}, String(process.pid));`,
        "setInterval(() => undefined, 1_000);",
      ].join("\n"),
    ],
    { stdio: "ignore", windowsHide: true },
  );
  try {
    await waitForFile(unrelatedStarted);
    const controller = new AbortController();
    const stalled = client.refresh({ signal: controller.signal });
    await waitForFile(requested);
    const pid = Number(fs.readFileSync(started, "utf8"));
    controller.abort("retire stubborn generation");
    await rejectionOf(stalled);
    await waitForFile(terminated);

    const firstClose = client.close();
    const secondClose = client.close();
    TestValidator.equals(
      "retired-generation close remains idempotent",
      firstClose === secondClose,
      true,
    );
    const closed = await Promise.race([
      firstClose.then(() => "closed" as const),
      delay(3_000).then(() => "timeout" as const),
    ]);
    TestValidator.equals(
      "close awaits the retired child's SIGKILL fallback",
      closed,
      "closed",
    );
    TestValidator.equals(
      "close returns only after the retired child exits",
      isProcessAlive(pid),
      false,
    );
    TestValidator.equals(
      "close does not terminate an unrelated Node process",
      isProcessAlive(unrelated.pid!),
      true,
    );
  } finally {
    await Promise.allSettled([client.close(), stop(unrelated)]);
  }
};

const fixture = (): string => {
  const root = GraphPaths.createTempDirectory(
    "samchon-graph-ttscgraph-timeout-",
  );
  fs.mkdirSync(path.join(root, "src", "core"), { recursive: true });
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export * from './core/order';\n");
  fs.writeFileSync(path.join(root, "src", "core", "order.ts"), "export function first() {}\n");
  fs.writeFileSync(path.join(root, "src", "empty.ts"), "export {};\n");
  return root;
};

const rejectionOf = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected promise to reject");
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForFile = async (file: string): Promise<void> => {
  // c8 instruments the whole package before this Windows Job child starts.
  // This is fixture-readiness time, not the native request deadline asserted
  // above, so keep enough headroom for an instrumented cold process launch.
  const deadline = Date.now() + 15_000;
  while (!hasContents(file)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${file}`);
    }
    await delay(10);
  }
};

function hasContents(file: string): boolean {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const stop = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGKILL");
  await exited;
};
