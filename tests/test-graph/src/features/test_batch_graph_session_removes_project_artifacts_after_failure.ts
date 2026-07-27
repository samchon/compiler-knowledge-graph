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

    const existing = JSON.stringify({ owner: "user" });
    const marker = path.join(root, "producer-ran");
    fs.writeFileSync(produced, existing);
    const guarded = new BatchGraphSession({
      root,
      languages: ["php"],
      provider: "existing-artifact-fixture",
      command: {
        command: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeFileSync('producer-ran', 'yes')",
        ],
      },
      artifactName: "index.json",
      indexArgs: () => [],
      artifactFrom: () => produced,
      inputs: () => [],
      load: () => {
        throw new Error("a producer with a colliding artifact must not run");
      },
    });
    message = "";
    try {
      await guarded.refresh();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      await guarded.close();
    }
    TestValidator.predicate(
      "a pre-existing fixed artifact is refused explicitly",
      message.includes("refusing to overwrite"),
    );
    TestValidator.equals(
      "the pre-existing artifact keeps its bytes",
      fs.readFileSync(produced, "utf8"),
      existing,
    );
    TestValidator.equals(
      "the producer is not launched against a colliding artifact",
      fs.existsSync(marker),
      false,
    );
    fs.rmSync(produced);

    const linkedTarget = path.join(root, "outside-user-index");
    const linkedMarker = path.join(root, "linked-producer-ran");
    fs.symlinkSync(
      linkedTarget,
      produced,
      process.platform === "win32" ? "junction" : "file",
    );
    const linked = new BatchGraphSession({
      root,
      languages: ["php"],
      provider: "linked-artifact-fixture",
      command: {
        command: process.execPath,
        args: [
          "-e",
          [
            "require('node:fs').writeFileSync(",
            "  'linked-producer-ran',",
            "  'yes',",
            ");",
          ].join(""),
        ],
      },
      artifactName: "index.json",
      indexArgs: () => [],
      artifactFrom: () => produced,
      inputs: () => [],
      load: () => {
        throw new Error("a producer with a dangling artifact link must not run");
      },
    });
    message = "";
    try {
      await linked.refresh();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      await linked.close();
    }
    TestValidator.predicate(
      "a dangling fixed-artifact symlink is an existing project entry",
      message.includes("refusing to overwrite") &&
        fs.lstatSync(produced).isSymbolicLink(),
    );
    TestValidator.equals(
      "the producer cannot write through the dangling artifact link",
      [fs.existsSync(linkedTarget), fs.existsSync(linkedMarker)],
      [false, false],
    );
    fs.rmSync(produced, { force: true });

    const blocked = path.join(root, "unremovable-artifact");
    const cleanupFailure = new BatchGraphSession({
      root,
      languages: ["php"],
      provider: "failed-cleanup-fixture",
      command: {
        command: process.execPath,
        args: [
          "-e",
          [
            "require('node:fs').mkdirSync(",
            "  'unremovable-artifact',",
            ");",
            "process.exit(29);",
          ].join(""),
        ],
      },
      artifactName: "index.json",
      indexArgs: () => [],
      artifactFrom: () => blocked,
      inputs: () => [],
      load: () => {
        throw new Error("an unremovable failed artifact must never be loaded");
      },
    });
    message = "";
    try {
      await cleanupFailure.refresh();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      await cleanupFailure.close();
    }
    TestValidator.predicate(
      "producer and cleanup failures are both reported",
      message.includes(
        "the producer failed and its project artifact could not be removed",
      ),
    );
    TestValidator.equals(
      "a failed cleanup does not disguise the remaining artifact",
      fs.statSync(blocked).isDirectory(),
      true,
    );
    fs.rmSync(blocked, { recursive: true, force: true });
  };
