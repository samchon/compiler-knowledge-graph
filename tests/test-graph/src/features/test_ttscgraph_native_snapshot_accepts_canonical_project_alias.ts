import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import path from "node:path";

import { TtscGraphClient } from "../../../../packages/graph/src/provider/ttscgraph/TtscGraphClient";
import { GraphPaths } from "../internal/GraphPaths";

/**
 * The producer publishes its canonical physical project base while callers may
 * select the same checkout through a symlink or Windows junction.
 *
 * 1. Create one physical project and address it through a filesystem alias.
 * 2. Make the fake producer publish the physical base in its native transaction.
 * 3. Require acceptance while preserving caller-root source identities.
 */
export const test_ttscgraph_native_snapshot_accepts_canonical_project_alias =
  async () => {
    const parent = GraphPaths.createTempDirectory(
      "samchon-graph-native-project-alias-",
    );
    const physical = path.join(parent, "physical");
    const alias = path.join(parent, "alias");
    fs.mkdirSync(path.join(physical, "src", "core"), { recursive: true });
    fs.writeFileSync(path.join(physical, "tsconfig.json"), "{}\n");
    fs.writeFileSync(path.join(physical, "src", "index.ts"), "export {};\n");
    fs.writeFileSync(
      path.join(physical, "src", "core", "order.ts"),
      "export function first() {}\n",
    );
    fs.writeFileSync(path.join(physical, "src", "empty.ts"), "export {};\n");
    fs.symlinkSync(
      physical,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );

    const client = new TtscGraphClient({
      root: alias,
      command: process.execPath,
      args: [GraphPaths.fakeTtscGraphServer, "--canonical-project"],
    });
    try {
      const snapshot = (await client.refresh()).snapshot;
      TestValidator.predicate(
        "the physical producer base and caller alias identify one project",
        snapshot.nodes.some((node) => node.name === "first") &&
          snapshot.sources.has(path.join(alias, "src", "core", "order.ts")),
      );
    } finally {
      await client.close();
    }
  };
