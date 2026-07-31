import { TestValidator } from "@nestia/e2e";
import { buildGraphDump } from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";

import { resolveTtscGraphCommand } from "../../../../packages/graph/src/provider/ttscgraph/resolveTtscGraphCommand";
import { GraphPaths } from "../internal/GraphPaths";

/**
 * A published producer that predates native shard negotiation cannot satisfy
 * the strict incremental route merely because its complete dump is valid.
 *
 * 1. Resolve the workspace's independently published `ttscgraph` binary.
 * 2. Ask the normal language route to index a strict TypeScript project.
 * 3. Require an explicit provider refusal and an honest fallback result.
 */
export const test_ttscgraph_published_legacy_dump_falls_back_honestly =
  async () => {
    const resolved = resolveTtscGraphCommand(GraphPaths.graphPackageRoot);
    TestValidator.predicate(
      "the workspace resolves its published ttscgraph binary",
      resolved !== undefined && resolved.args.length === 0,
    );
    const root = GraphPaths.createTempDirectory("samchon-graph-schema3-real-");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true },
        include: ["src/**/*.ts"],
      }),
    );
    fs.writeFileSync(
      path.join(root, "src", "model.ts"),
      'export type Status = "ready" | "done";\n',
    );

    const previous = process.env.TTSC_GRAPH_BINARY;
    process.env.TTSC_GRAPH_BINARY = resolved!.command;
    try {
      const dump = await buildGraphDump({
        cwd: root,
        mode: "lsp",
        languages: ["typescript"],
      });
      TestValidator.predicate(
        "the published legacy full-dump producer falls back instead of " +
          "masquerading as a shard producer",
        dump.warnings?.some(
          (warning) =>
            warning.includes("provider failed") &&
            warning.includes("legacy full dump"),
        ) === true &&
          (dump.provenance ?? []).every(
            (row) => row.provider !== "ttscgraph",
          ),
      );
      TestValidator.predicate(
        "the compatibility fallback still indexes the project source",
        dump.nodes.some((node) => node.file === "src/model.ts"),
      );
    } finally {
      if (previous === undefined) delete process.env.TTSC_GRAPH_BINARY;
      else process.env.TTSC_GRAPH_BINARY = previous;
    }
  };
