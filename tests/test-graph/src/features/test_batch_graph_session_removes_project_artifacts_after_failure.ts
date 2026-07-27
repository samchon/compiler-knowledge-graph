import fs from "node:fs";
import path from "node:path";

import { TestValidator } from "@nestia/e2e";

import { BatchGraphSession } from "../../../../packages/graph/src/provider/BatchGraphSession";
import { GraphPaths } from "../internal/GraphPaths";

/**
 * A producer with a fixed output path does not earn permission to mutate the
 * project merely because it failed after writing.
 *
 * `scip-php` writes `index.scip` in its working directory and has no output
 * option. BatchGraphSession therefore has to take that artifact on both the
 * success and failure paths, including when the checkout and OS temporary
 * directory live on different volumes.
 */
export const test_batch_graph_session_removes_project_artifacts_after_failure =
  async (): Promise<void> => {
    const root = GraphPaths.createTempDirectory("graph-failed-artifact-");
    const produced = path.join(root, "fixed-index.json");
    let loaded = false;
    const session = new BatchGraphSession({
      root,
      languages: ["php"],
      provider: "failed-artifact-fixture",
      command: {
        command: process.execPath,
        args: [
          "-e",
          [
            "require('node:fs').writeFileSync(",
            "  'fixed-index.json',",
            "  JSON.stringify({ incomplete: true }),",
            ");",
            "process.exit(23);",
          ].join(""),
        ],
      },
      artifactName: "index.json",
      indexArgs: () => [],
      artifactFrom: () => produced,
      inputs: () => [],
      load: () => {
        loaded = true;
        throw new Error("a failed producer artifact must never be loaded");
      },
    });
    let message = "";
    try {
      await session.refresh();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      await session.close();
    }

    TestValidator.predicate(
      "the original producer failure remains visible",
      message.includes("exited with code 23"),
    );
    TestValidator.equals(
      "a failed producer artifact is not loaded",
      loaded,
      false,
    );
    TestValidator.equals(
      "a failed producer leaves no artifact in the project",
      fs.existsSync(produced),
      false,
    );
  };
