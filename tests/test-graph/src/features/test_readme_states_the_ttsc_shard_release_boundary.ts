import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";

/**
 * The published ttsc release predates native shard negotiation, so installation
 * prose must not advertise that binary as satisfying the strict route.
 *
 * 1. Read both source and packaged README projections.
 * 2. Require the legacy fallback boundary and pending producer link.
 * 3. Retain the independently pinned Go corroboration command.
 */
export const test_readme_states_the_ttsc_shard_release_boundary = () => {
  const fallback =
    "`ttsc@0.23.0` provides the ordinary `ttscserver` fallback but predates this strict protocol";
  const producer = "native shard producer PR";
  const goInstall =
    "go install github.com/scip-code/scip-go/cmd/scip-go@v0.2.7";
  for (const readme of [
    path.join(GraphPaths.repositoryRoot, "README.md"),
    path.join(GraphPaths.graphPackageRoot, "README.md"),
  ]) {
    const text = fs.readFileSync(readme, "utf8");
    const label = path.relative(GraphPaths.repositoryRoot, readme);
    TestValidator.predicate(
      `${label} states the published ttsc fallback boundary`,
      text.includes(fallback),
    );
    TestValidator.predicate(
      `${label} links the pending native producer`,
      text.includes(producer),
    );
    TestValidator.predicate(
      `${label} pins the Go navigation producer used by the bundled provider`,
      text.includes(goInstall),
    );
  }
};
