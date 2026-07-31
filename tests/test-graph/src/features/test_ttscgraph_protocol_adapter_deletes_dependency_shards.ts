import { TestValidator } from "@nestia/e2e";
import { createHash } from "node:crypto";
import path from "node:path";

import { GraphSnapshotProtocol } from "../../../../packages/graph/src/provider/GraphSnapshotProtocol";
import { adaptTtscGraphDump } from "../../../../packages/graph/src/provider/ttscgraph/adaptTtscGraphDump";
import { createTtscGraphProtocolTransaction } from "../../../../packages/graph/src/provider/ttscgraph/createTtscGraphProtocolTransaction";
import { GraphPaths } from "../internal/GraphPaths";

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/**
 * The TypeScript reference adapter keeps dependency churn inside the protocol:
 * a dependency that leaves the compiler manifest becomes an explicit shard
 * deletion, while a global compiler finding belongs to the target metadata
 * shard rather than to an arbitrary source.
 */
export const test_ttscgraph_protocol_adapter_deletes_dependency_shards =
  async () => {
    const root = GraphPaths.createTempDirectory(
      "samchon-graph-ttscgraph-protocol-",
    );
    const store = new GraphSnapshotProtocol.Store(root);
    const initialFrames = createTtscGraphProtocolTransaction(
      adaptTtscGraphDump(dump(root, true, false), root),
      { root, sequence: 1 },
    );
    const initial = store.apply(initialFrames);
    const changedFrames = createTtscGraphProtocolTransaction(
      adaptTtscGraphDump(dump(root, false, true), root),
      { root, sequence: 2, previous: initial },
    );
    TestValidator.equals(
      "a removed dependency is carried as one explicit shard deletion",
      changedFrames.filter((frame) => frame.type === "deleteShard").length,
      1,
    );

    const changed = store.apply(changedFrames);
    TestValidator.equals(
      "the delta removes the dependency and retains a global diagnostic",
      [
        changed.protocol?.baseSequence,
        changed.nodes.some((node) => node.name === "Dependency"),
        changed.sources.has(path.join(root, "vendor", "dependency.d.ts")),
        changed.diagnostics,
      ],
      [
        1,
        false,
        false,
        [
          {
            file: "",
            line: 0,
            column: 0,
            code: 9999,
            message: "synthetic global finding",
            severity: "warning",
          },
        ],
      ],
    );
  };

function dump(
  root: string,
  dependency: boolean,
  globalDiagnostic: boolean,
): unknown {
  const bundled = "bundled:///libs/lib.es2015.collection.d.ts";
  const files = [
    "src/main.ts",
    bundled,
    ...(dependency ? ["vendor/dependency.d.ts"] : []),
  ];
  return {
    project: root,
    tsconfig: "tsconfig.json",
    provenance: {
      schemaVersion: 6,
      capabilities: [
        "universe",
        "sourceDigests",
        "diskDigests",
        "diagnostics",
      ],
      producer: {
        tool: "ttscgraph",
        version: "0.20.1",
        typescript: "5.9.0",
      },
      universe: {
        configs: [
          { file: "tsconfig.json", digest: sha256("configuration") },
        ],
        roots: [{ config: "tsconfig.json", file: "src/main.ts" }],
      },
      sources: files.map((file) => ({
        file,
        checkerDigest: sha256(`${file}:checker`),
        diskDigest: sha256(`${file}:disk`),
      })),
    },
    diagnostics: [
      ...(dependency
        ? [
            {
              file: "src/main.ts",
              line: 1,
              column: 1,
              code: 2322,
              category: "error",
              message: "synthetic source finding",
            },
          ]
        : []),
      ...(globalDiagnostic
        ? [
          {
            file: "",
            line: 0,
            column: 0,
            code: 9999,
            category: "warning",
            message: "synthetic global finding",
          },
          ]
        : []),
    ],
    nodes: [
      {
        id: "src/main.ts#src/main.ts:module",
        kind: "module",
        name: "src/main.ts",
        file: "src/main.ts",
        external: false,
      },
      {
        id: "src/main.ts#run:function",
        kind: "function",
        name: "run",
        file: "src/main.ts",
        external: false,
      },
      {
        id: `${bundled}#Map:interface`,
        kind: "interface",
        name: "Map",
        file: bundled,
        external: true,
      },
      ...(dependency
        ? [
            {
              id: "vendor/dependency.d.ts#Dependency:interface",
              kind: "interface",
              name: "Dependency",
              file: "vendor/dependency.d.ts",
              external: true,
            },
          ]
        : []),
    ],
    edges: [
      {
        from: "src/main.ts#run:function",
        to: `${bundled}#Map:interface`,
        kind: "type_ref",
      },
      ...(dependency
        ? [
            {
              from: "src/main.ts#run:function",
              to: "vendor/dependency.d.ts#Dependency:interface",
              kind: "type_ref",
            },
          ]
        : []),
    ],
  };
}
