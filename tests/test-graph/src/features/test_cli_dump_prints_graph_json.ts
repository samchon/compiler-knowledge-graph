import { TestValidator } from "@nestia/e2e";
import { execFileSync, spawnSync } from "node:child_process";

import { GraphFixtures } from "../internal/GraphFixtures";
import { GraphPaths } from "../internal/GraphPaths";

export const test_cli_dump_prints_graph_json = () => {
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

  assertTheDumpSaysWhatProducedIt(root);
};

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
  const ran = spawnSync(
    process.execPath,
    [GraphPaths.graphBin, "dump", "--mode", "lsp", "--cwd", root],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const summary = (ran.stderr ?? "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("@samchon/graph: "));
  TestValidator.predicate(
    "the dump names the indexer that answered",
    summary.some((line) => line.includes("indexer=")),
  );
  TestValidator.predicate(
    "and reports the reasons nothing better served",
    summary.length > 1,
  );
}
