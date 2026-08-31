import { TestValidator } from "@nestia/e2e";
import { buildGraphDump } from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";

import { resolveTtscGraphCommand } from "../../../../packages/graph/src/provider/ttscgraph/resolveTtscGraphCommand";
import { GraphPaths } from "../internal/GraphPaths";

/**
 * The strict TypeScript route is only a claim until the release a project can
 * actually install answers it. Every other `ttscgraph` case in this suite talks
 * to the fake producer, so a protocol drift between this client and the shipped
 * binary — a renamed envelope field, a schema bump, a capability that stopped
 * being emitted — would pass all of them and fail every real project.
 *
 * 1. Resolve the workspace's independently published `ttscgraph` binary.
 * 2. Ask the normal language route to index a strict TypeScript project.
 * 3. Require compiler-owned provenance, not a fallback that happens to index.
 */
export const test_ttscgraph_published_release_serves_compiler_owned_shards =
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
    fs.writeFileSync(
      path.join(root, "src", "index.ts"),
      'import { Status } from "./model";\n\nexport const ready = (): Status => "ready";\n',
    );

    const previous = process.env.TTSC_GRAPH_BINARY;
    process.env.TTSC_GRAPH_BINARY = resolved!.command;
    try {
      const dump = await buildGraphDump({
        cwd: root,
        mode: "lsp",
        languages: ["typescript"],
      });
      // Provenance, not node counts: the honest fallback also indexes this
      // project, so only the provider name distinguishes a compiler-owned
      // generation from a navigation one.
      const provenance = (dump.provenance ?? []).find(
        (row) => row.provider === "ttscgraph",
      );
      TestValidator.predicate(
        "the published release publishes a compiler-owned ttscgraph generation",
        provenance !== undefined && provenance.authority === "compiler",
      );
      TestValidator.predicate(
        "no route reported the published release as a failed provider",
        (dump.warnings ?? []).every(
          (warning) => !warning.includes("ttscgraph compiler provider failed"),
        ),
      );
      // A generation the compiler owns has to carry what only the compiler
      // knows. `Status` resolves across files, which the syntax fallback
      // cannot prove, so an edge into it is the fact that separates them.
      TestValidator.predicate(
        "the generation carries cross-file compiler-resolved facts",
        dump.nodes.some((node) => node.file === "src/model.ts") &&
          dump.edges.some(
            (edge) =>
              edge.kind === "type_ref" &&
              edge.from.startsWith("src/index.ts#") &&
              edge.to.startsWith("src/model.ts#"),
          ),
      );
    } finally {
      if (previous === undefined) delete process.env.TTSC_GRAPH_BINARY;
      else process.env.TTSC_GRAPH_BINARY = previous;
    }
  };
