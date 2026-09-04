import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";
import { waitForProcessId } from "../internal/waitForProcessId";

/**
 * PID fixtures expose a truncation window before their complete write lands.
 * Cleanup must accept only a newline-terminated positive integer and must stop
 * waiting at its deadline when no publication boundary ever arrives.
 */
export const test_process_id_fixture_waits_for_complete_publication =
  async () => {
    const root = GraphPaths.createTempDirectory("samchon-graph-pid-publication-");
    const file = path.join(root, "child.pid");
    fs.writeFileSync(file, "");

    const waiting = waitForProcessId(file);
    await delay(20);
    fs.writeFileSync(file, "0");
    await delay(20);
    fs.writeFileSync(file, "123x");
    await delay(20);
    fs.writeFileSync(file, "4");
    await delay(30);
    fs.writeFileSync(file, "424242");
    await delay(20);
    fs.writeFileSync(file, "424242\n");

    TestValidator.equals(
      "an incomplete or unsafe pid is never published to cleanup",
      await waiting,
      424242,
    );

    const incomplete = path.join(root, "incomplete.pid");
    fs.writeFileSync(incomplete, "7");
    let rejection: unknown;
    try {
      await waitForProcessId(incomplete, 20);
    } catch (error) {
      rejection = error;
    }
    TestValidator.predicate(
      "a pid without its publication boundary times out",
      rejection instanceof Error &&
        rejection.message.includes("timed out waiting for a complete process id"),
    );
  };

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
