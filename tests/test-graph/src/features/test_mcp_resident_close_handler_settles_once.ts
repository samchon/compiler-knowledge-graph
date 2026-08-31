import { TestValidator } from "@nestia/e2e";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { GraphPaths } from "../internal/GraphPaths";
import { createCompositeResidentClose } from "../../../../packages/graph/src/mcp/createCompositeResidentClose";

/**
 * Shutdown arrives twice — the transport closing and stdin ending are separate
 * events — and both reach the same handler. Closing twice would either kill a
 * resident mid-teardown or double-report the same failure, and neither shows up
 * in a single-path test. This pins one shared shutdown promise, one close, one
 * contained report, and the composite that now fronts several resident planes
 * closing each of them in order while retaining the first failure.
 */
export const test_mcp_resident_close_handler_settles_once = async () => {
  const module = (await import(
    pathToFileURL(
      path.join(
        GraphPaths.graphPackageRoot,
        "lib",
        "mcp",
        "createResidentCloseHandler.js",
      ),
    ).href
  )) as {
    createResidentCloseHandler(
      resident: { close(): Promise<void> },
      report: (error: unknown) => void,
    ): () => Promise<void>;
  };
  const failure = new Error("resident close failed");
  const reports: unknown[] = [];
  let closes = 0;
  const close = module.createResidentCloseHandler(
    {
      close(): Promise<void> {
        closes += 1;
        return Promise.reject(failure);
      },
    },
    (error) => reports.push(error),
  );

  const fromTransport = close();
  const fromStdin = close();
  TestValidator.predicate(
    "transport close and stdin end share one shutdown promise",
    fromTransport === fromStdin,
  );
  await fromTransport;
  await fromStdin;
  TestValidator.equals("the resident closes once", closes, 1);
  TestValidator.equals(
    "the contained close failure is reported once",
    reports,
    [failure],
  );

  const calls: string[] = [];
  await createCompositeResidentClose([
    undefined,
    { close: async () => void calls.push("code") },
    { close: async () => void calls.push("topology") },
  ]).close();
  TestValidator.equals(
    "the composite closes every opened resident plane in order",
    calls,
    ["code", "topology"],
  );

  const firstFailure = new Error("code close failed");
  let topologyClosed = false;
  await TestValidator.error(
    "the composite retains the first failure while closing later planes",
    () =>
      createCompositeResidentClose([
        { close: async () => Promise.reject(firstFailure) },
        {
          close: async () => {
            topologyClosed = true;
            throw "topology close failed";
          },
        },
      ]).close(),
  );
  TestValidator.equals(
    "a first close failure does not skip the topology plane",
    topologyClosed,
    true,
  );
  await TestValidator.error(
    "a non-Error close failure is normalized",
    () =>
      createCompositeResidentClose([
        { close: async () => Promise.reject("string close failure") },
      ]).close(),
  );
};
