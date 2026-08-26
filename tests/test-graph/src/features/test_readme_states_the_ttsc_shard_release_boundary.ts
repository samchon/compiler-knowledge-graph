import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";

/**
 * The strict TypeScript route is a published-release boundary, not a promise:
 * `ttsc@0.24.0` is the first release whose `ttscgraph serve` answers protocol
 * v1, and 0.23.0 answers a legacy complete dump the route refuses. Installation
 * prose that names no floor sends a reader to whichever release they already
 * have and leaves the honest fallback looking like a broken strict provider.
 *
 * 1. Read both source and packaged README projections.
 * 2. Require the exact release floor, the refused legacy release, and the
 *    producer link.
 * 3. Retain the independently pinned Go corroboration command.
 */
export const test_readme_states_the_ttsc_shard_release_boundary = () => {
  const floor = "Install `ttsc@>=0.24.0` in the indexed project.";
  const legacy =
    "0.23.0 and earlier answer a legacy complete dump and are declined";
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
      `${label} states the published ttsc release floor`,
      text.includes(floor),
    );
    TestValidator.predicate(
      `${label} states which published releases are declined`,
      text.includes(legacy),
    );
    TestValidator.predicate(
      `${label} links the native shard producer`,
      text.includes(producer),
    );
    TestValidator.predicate(
      `${label} pins the Go navigation producer used by the bundled provider`,
      text.includes(goInstall),
    );
  }
};
