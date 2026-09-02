import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";
import { waitForProcessId } from "../internal/waitForProcessId";

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
    fs.writeFileSync(file, "424242");

    TestValidator.equals(
      "an incomplete or unsafe pid is never published to cleanup",
      await waiting,
      424242,
    );
  };

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
