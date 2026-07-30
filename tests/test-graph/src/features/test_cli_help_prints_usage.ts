import { TestValidator } from "@nestia/e2e";
import { spawnSync } from "node:child_process";

import { GraphPaths } from "../internal/GraphPaths";

export const test_cli_help_prints_usage = () => {
  const result = spawnSync(process.execPath, [GraphPaths.graphBin, "--help"], {
    encoding: "utf8",
  });

  TestValidator.equals("CLI help exit code", result.status, 0);
  TestValidator.predicate(
    "CLI help prints usage",
    result.stdout.includes("Usage:") && result.stdout.includes("samchon-graph dump"),
  );
  TestValidator.predicate(
    "CLI help names the strict-provider comparison switch",
    result.stdout.includes("--no-strict"),
  );
  TestValidator.equals("CLI help has no stderr", result.stderr, "");
};
