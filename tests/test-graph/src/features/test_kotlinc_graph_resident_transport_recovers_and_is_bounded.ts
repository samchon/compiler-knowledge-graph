import { TestValidator } from "@nestia/e2e";
import { KotlinGraphProducerClient } from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";

/** One failed resident request retires only its owned producer generation. */
export const test_kotlinc_graph_resident_transport_recovers_and_is_bounded =
  async (): Promise<void> => {
    const root = GraphPaths.createTempDirectory(
      "samchon-graph-kotlinc-resident-",
    );

    for (const value of [0, -1, 1.5, Number.NaN, 2_147_483_648]) {
      TestValidator.error(`unsafe timeout ${String(value)} is refused`, () =>
        create(root, [], { requestTimeoutMs: value }),
      );
    }
    for (const value of [0, -1, 1.5, Number.NaN]) {
      TestValidator.error(
        `unsafe response bound ${String(value)} is refused`,
        () => create(root, [], { maxResponseBytes: value }),
      );
    }

    const reuseLog = path.join(root, "reuse.log");
    const reused = create(root, [
      `--fake-server-log=${reuseLog}`,
      "--fake-server-blank-prefix",
      "--fake-server-split-response",
    ]);
    try {
      const liveController = new AbortController();
      await reused.produce(
        path.join(root, "reuse-one.json"),
        liveController.signal,
      );
      await reused.produce(path.join(root, "reuse-two.json"), undefined);
      const processIds = lines(reuseLog);
      TestValidator.predicate(
        "successful requests reuse one resident producer",
        processIds.length === 2 && processIds[0] === processIds[1],
      );
    } finally {
      await reused.close();
    }

    const errorMarker = path.join(root, "error-once.marker");
    const errorLog = path.join(root, "error.log");
    const recoverable = create(root, [
      `--fake-server-error-once=${errorMarker}`,
      `--fake-server-log=${errorLog}`,
      "--fake-server-stderr",
    ]);
    try {
      const failure = await rejectionOf(
        recoverable.produce(path.join(root, "error.json"), undefined),
      );
      TestValidator.predicate(
        "a producer-declared failure reaches the caller",
        failure.message.includes("deliberate resident failure") &&
          failure.message.includes("resident fixture stderr"),
      );
      await recoverable.produce(
        path.join(root, "error-recovered.json"),
        undefined,
      );
      const processIds = lines(errorLog);
      TestValidator.predicate(
        "a normal error does not discard a healthy resident producer",
        processIds.length === 2 && processIds[0] === processIds[1],
      );
    } finally {
      await recoverable.close();
    }

    await assertRestart(root, "crash", "server-crash-once", "exited");
    await assertRestart(
      root,
      "malformed",
      "server-malformed-once",
      "invalid Kotlin graph server response",
    );
    for (const [name, flag, message] of [
      ["string", "server-string-once", "must be an object"],
      ["null", "server-null-once", "must be an object"],
      ["array", "server-non-object-once", "must be an object"],
      ["identity", "server-bad-identity-once", "invalid Kotlin graph response identity"],
      ["protocol", "server-bad-protocol-once", "invalid Kotlin graph response identity"],
      ["result", "server-bad-result-once", "invalid Kotlin graph response result"],
      ["error-type", "server-non-string-error-once", "invalid Kotlin graph response result"],
      ["error-empty", "server-empty-error-once", "invalid Kotlin graph response result"],
      ["response-id", "server-unexpected-id-once", "unexpected Kotlin graph response id"],
    ] as const) {
      await assertRestart(root, name, flag, message);
    }
    await assertRestart(
      root,
      "oversized",
      "server-oversized-once",
      "byte limit",
      { maxResponseBytes: 128 },
    );
    await assertRestart(
      root,
      "timeout",
      "server-stall-once",
      "timed out after 5000 ms",
      { requestTimeoutMs: 5_000 },
    );

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const preflightClient = create(root, []);
    try {
      const failure = await rejectionOf(
        preflightClient.produce(
          path.join(root, "preflight-aborted.json"),
          alreadyAborted.signal,
        ),
      );
      TestValidator.predicate(
        "an already-cancelled request starts no producer",
        failure.name === "AbortError" && failure.message.includes("aborted"),
      );
    } finally {
      await preflightClient.close();
    }

    let abortReads = 0;
    const racingSignal = {
      get aborted() {
        abortReads += 1;
        return abortReads > 1;
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;
    const racingClient = create(root, []);
    try {
      const failure = await rejectionOf(
        racingClient.produce(
          path.join(root, "racing-abort.json"),
          racingSignal,
        ),
      );
      TestValidator.predicate(
        "cancellation between preflight and listener registration wins the race",
        failure.name === "AbortError" && abortReads === 2,
      );
    } finally {
      await racingClient.close();
    }

    const missingClient = new KotlinGraphProducerClient({
      root,
      provider: "kotlinc-graph",
      command: {
        command: path.join(root, "missing-kotlin-graph-server"),
        args: [],
      },
      requestTimeoutMs: 5_000,
    });
    try {
      const failure = await rejectionOf(
        missingClient.produce(path.join(root, "missing.json"), undefined),
      );
      TestValidator.predicate(
        "a launcher that cannot spawn fails its owned request",
        (failure.message.includes("Kotlin graph server failed") ||
          failure.message.includes("process launch failed")) &&
          failure.message.includes("missing-kotlin-graph-server"),
      );
    } finally {
      await missingClient.close();
    }

    const closedInputClient = create(
      root,
      ["--fake-server-close-stdin"],
      { requestTimeoutMs: 5_000 },
    );
    try {
      const failure = await rejectionOf(
        closedInputClient.produce("x".repeat(8 * 1024 * 1024), undefined),
      );
      TestValidator.predicate(
        "a producer that closes its input pipe remains deadline-bounded",
        failure.message.includes("stdin failed") ||
          failure.message.includes("timed out after 5000 ms"),
      );
    } finally {
      await closedInputClient.close();
    }

    const abortMarker = path.join(root, "abort.marker");
    const abortLog = path.join(root, "abort.log");
    const abortedClient = create(root, [
      `--fake-server-stall-once=${abortMarker}`,
      `--fake-server-log=${abortLog}`,
    ]);
    try {
      const controller = new AbortController();
      const aborted = abortedClient.produce(
        path.join(root, "aborted.json"),
        controller.signal,
      );
      await waitForLines(abortLog, 1);
      controller.abort();
      const failure = await rejectionOf(aborted);
      TestValidator.predicate(
        "cancellation rejects and retires its exact producer",
        failure.name === "AbortError" && failure.message.includes("aborted"),
      );
      await abortedClient.produce(
        path.join(root, "abort-recovered.json"),
        undefined,
      );
      const processIds = lines(abortLog);
      TestValidator.predicate(
        "the request after cancellation starts a fresh producer",
        processIds.length === 2 && processIds[0] !== processIds[1],
      );
    } finally {
      await abortedClient.close();
    }

    const closeLog = path.join(root, "close.log");
    const closingClient = create(root, [
      "--fake-server-stall",
      `--fake-server-log=${closeLog}`,
    ]);
    const pending = closingClient.produce(
      path.join(root, "closing.json"),
      undefined,
    );
    await waitForLines(closeLog, 1);
    const firstClose = closingClient.close();
    const secondClose = closingClient.close();
    TestValidator.equals(
      "close is idempotent while termination is in flight",
      firstClose,
      secondClose,
    );
    const closeFailure = await rejectionOf(pending);
    await firstClose;
    TestValidator.predicate(
      "close rejects an active request without waiting for its deadline",
      closeFailure.message.includes("session is closed"),
    );
    const afterClose = await rejectionOf(
      closingClient.produce(path.join(root, "after-close.json"), undefined),
    );
    TestValidator.predicate(
      "a closed client cannot spawn another producer",
      afterClose.message.includes("session is closed") &&
        lines(closeLog).length === 1,
    );
  };

async function assertRestart(
  root: string,
  name: string,
  flag: string,
  message: string,
  options: Partial<KotlinGraphProducerClient.IOptions> = {},
): Promise<void> {
  const marker = path.join(root, `${name}.marker`);
  const log = path.join(root, `${name}.log`);
  const client = create(
    root,
    [`--fake-${flag}=${marker}`, `--fake-server-log=${log}`],
    options,
  );
  try {
    const failure = await rejectionOf(
      client.produce(path.join(root, `${name}-failed.json`), undefined),
    );
    TestValidator.predicate(
      `${name} fails its owned request precisely`,
      failure.message.includes(message),
    );
    await client.produce(path.join(root, `${name}-recovered.json`), undefined);
    const processIds = lines(log);
    TestValidator.predicate(
      `${name} recovers on a fresh resident producer`,
      processIds.length === 2 && processIds[0] !== processIds[1],
    );
  } finally {
    await client.close();
  }
}

function create(
  root: string,
  flags: readonly string[],
  options: Partial<KotlinGraphProducerClient.IOptions> = {},
): KotlinGraphProducerClient {
  return new KotlinGraphProducerClient({
    root,
    provider: "kotlinc-graph",
    command: {
      command: process.execPath,
      args: [GraphPaths.fakeKotlinGraph, ...flags],
    },
    ...options,
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected resident request to reject");
}

function lines(file: string): string[] {
  return fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").trim().split(/\r?\n/u).filter(Boolean)
    : [];
}

async function waitForLines(file: string, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (lines(file).length >= count) return;
    await new Promise<undefined>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`resident fixture did not write ${file}`);
}
