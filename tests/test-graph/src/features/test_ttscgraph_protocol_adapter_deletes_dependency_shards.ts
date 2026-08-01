import { TestValidator } from "@nestia/e2e";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { GraphSnapshotProtocol } from "../../../../packages/graph/src/provider/GraphSnapshotProtocol";
import { adaptTtscGraphDump } from "../../../../packages/graph/src/provider/ttscgraph/adaptTtscGraphDump";
import { createTtscGraphProtocolTransaction } from "../../../../packages/graph/src/provider/ttscgraph/createTtscGraphProtocolTransaction";
import { TtscGraphClient } from "../../../../packages/graph/src/provider/ttscgraph/TtscGraphClient";
import { GraphPaths } from "../internal/GraphPaths";

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const compareUtf8 = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

/**
 * The TypeScript reference adapter keeps dependency churn inside the protocol:
 * a dependency that leaves the compiler manifest becomes an explicit shard
 * deletion, while a global compiler finding belongs to the target metadata
 * shard rather than to an arbitrary source.
 */
export const test_ttscgraph_protocol_adapter_deletes_dependency_shards =
  async () => {
    await assertNativeProducerDeltas();
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

async function assertNativeProducerDeltas(): Promise<void> {
  const root = GraphPaths.createTempDirectory(
    "samchon-graph-ttscgraph-native-delta-",
  );
  fs.mkdirSync(path.join(root, "src", "core"), { recursive: true });
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};\n");
  fs.writeFileSync(
    path.join(root, "src", "core", "order.ts"),
    "export function first() {}\n",
  );
  fs.writeFileSync(path.join(root, "src", "empty.ts"), "export {};\n");

  const bodyLog = path.join(root, "body-native.ndjson");
  const body = new TtscGraphClient({
    root,
    command: process.execPath,
    args: [
      GraphPaths.fakeTtscGraphServer,
      `--native-log=${bodyLog}`,
    ],
  });
  try {
    const initial = await body.refresh();
    await body.refresh();
    const changed = await body.refresh();
    const [coldTransaction, bodyTransaction] = nativeTransactions(bodyLog);
    const coldSource = coldTransaction!.upserts.find((entry) =>
      entry.shard.source?.file === "src/core/order.ts",
    )!;
    const coldCoordinates = JSON.parse(
      coldSource.shard.key.slice("1:source:".length),
    ) as unknown[];
    const normalizedUniverse = normalizeProducerUniverse(
      coldTransaction!.universe,
    );
    TestValidator.equals(
      "the fake producer publishes ttsc's normalized universe order",
      coldTransaction!.universe,
      normalizedUniverse,
    );
    TestValidator.equals(
      "the fake producer uses ttsc's exact native shard identity coordinates",
      coldCoordinates.slice(0, 6),
      [
        1,
        coldTransaction!.producer.tool,
        coldTransaction!.producer.version,
        coldTransaction!.producer.typescript,
        coldTransaction!.tsconfig,
        sha256(goJson(normalizedUniverse)),
      ],
    );
    const oldSourceKey = coldTransaction!.manifest.find((entry) =>
      entry.key.includes('"src/core/order.ts"'),
    )!.key;
    const newSource = bodyTransaction!.upserts.find((entry) =>
      entry.shard.source?.file === "src/core/order.ts",
    );
    TestValidator.predicate(
      "a real-client body delta deletes the old content-addressed source key",
      bodyTransaction!.deletes.includes(oldSourceKey) &&
        newSource !== undefined &&
        newSource.shard.key !== oldSourceKey &&
        newSource.shard.key.startsWith("1:source:"),
    );
    TestValidator.predicate(
      "the committed client generation contains only the replacement fact",
      initial.snapshot.nodes.some((node) => node.name === "first") &&
        changed.snapshot.nodes.some((node) => node.name === "second") &&
        !changed.snapshot.nodes.some((node) => node.name === "first"),
    );
  } finally {
    await body.close();
  }

  const reloadLog = path.join(root, "reload-native.ndjson");
  const reload = new TtscGraphClient({
    root,
    command: process.execPath,
    args: [
      GraphPaths.fakeTtscGraphServer,
      "--universe-reload",
      `--native-log=${reloadLog}`,
    ],
  });
  try {
    await reload.refresh();
    await reload.refresh();
    await reload.refresh();
    const [coldTransaction, reloadTransaction] =
      nativeTransactions(reloadLog);
    const oldKeys = new Set(
      coldTransaction!.manifest.map((entry) => entry.key),
    );
    const newKeys = new Set(
      reloadTransaction!.manifest.map((entry) => entry.key),
    );
    TestValidator.predicate(
      "a universe reload replaces every producer identity and leaves no stale key",
      reloadTransaction!.deletes.length === oldKeys.size &&
        reloadTransaction!.upserts.length === newKeys.size &&
        [...oldKeys].every(
          (key) =>
            reloadTransaction!.deletes.includes(key) && !newKeys.has(key),
        ),
    );
  } finally {
    await reload.close();
  }
}

interface INativeLogTransaction {
  tsconfig: string;
  producer: { tool: string; version: string; typescript: string };
  universe: Record<string, unknown>;
  manifest: { key: string; digest: string }[];
  upserts: {
    digest: string;
    shard: {
      key: string;
      source?: { file: string };
    };
  }[];
  deletes: string[];
}

function goJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => {
    if (character === "<") return "\\u003c";
    if (character === ">") return "\\u003e";
    if (character === "&") return "\\u0026";
    return character === "\u2028" ? "\\u2028" : "\\u2029";
  });
}

function normalizeProducerUniverse(
  universe: Record<string, unknown>,
): Record<string, unknown> {
  const configs = universe.configs as { file: string; digest: string }[];
  const roots = universe.roots as { config: string; file: string }[];
  return {
    configs: [...configs].sort((left, right) =>
      compareUtf8(left.file, right.file),
    ),
    roots: [...roots].sort(
      (left, right) =>
        compareUtf8(left.config, right.config) ||
        compareUtf8(left.file, right.file),
    ),
  };
}

function nativeTransactions(file: string): INativeLogTransaction[] {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as INativeLogTransaction);
}

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
