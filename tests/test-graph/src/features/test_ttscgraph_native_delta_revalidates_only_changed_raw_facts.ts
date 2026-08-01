import { TestValidator } from "@nestia/e2e";
import { createHash } from "node:crypto";

import { IBulkGraphSession } from "../../../../packages/graph/src/provider/IBulkGraphSession";
import { TtscGraphSnapshotStore } from "../../../../packages/graph/src/provider/ttscgraph/TtscGraphSnapshotStore";
import { GraphPaths } from "../internal/GraphPaths";

/**
 * A compact atomic manifest is generation-wide, but semantic fact parsing is
 * not: one source replacement must never touch retained raw node arrays.
 */
export const test_ttscgraph_native_delta_revalidates_only_changed_raw_facts =
  () => {
    const root = GraphPaths.createTempDirectory(
      "samchon-graph-native-delta-cost-",
    );
    const fixture = initialTransaction(root, 32);
    const store = new TtscGraphSnapshotStore(root);
    const initial = store.prepare(fixture.transaction, { sequence: 1 });
    initial.commit();
    for (const counter of fixture.counters) counter.reads = 0;

    const changedCounter = { reads: 0 };
    const changedShard = sourceShard(
      fixture.files[0]!,
      "1:source:replacement",
      digest("replacement checker text"),
      changedCounter,
    );
    const changedDigest = digestJson(changedShard);
    const manifest = [
      ...fixture.transaction.manifest.filter(
        (entry) => entry.key !== fixture.sourceKeys[0],
      ),
      { key: changedShard.key, digest: changedDigest },
    ].sort((left, right) => compareUtf8(left.key, right.key));
    const transaction = {
      ...fixture.transaction,
      sequence: 2,
      baseSequence: 1,
      baseGeneration: fixture.transaction.generation,
      generation: digestJson({
        tsconfig: fixture.transaction.tsconfig,
        producer: fixture.transaction.producer,
        capabilities: fixture.transaction.capabilities,
        universe: fixture.transaction.universe,
        manifest,
      }),
      upserts: [{ digest: changedDigest, shard: changedShard }],
      deletes: [fixture.sourceKeys[0]],
      manifest,
    };
    // Signing the changed shard exercises its getter before the measured
    // prepare. Only accesses caused by delta validation count below.
    changedCounter.reads = 0;
    store.prepare(transaction, {
      sequence: 2,
      previous: {
        protocol: {
          sequence: 1,
          generation: fixture.transaction.generation,
        },
      } as unknown as IBulkGraphSession.ISnapshot,
    });

    TestValidator.equals(
      "a one-source delta never reparses retained raw facts",
      fixture.counters.slice(1).reduce((sum, row) => sum + row.reads, 0),
      0,
    );
    TestValidator.predicate(
      "the replacement source is still parsed and validated",
      changedCounter.reads > 0,
    );
  };

function initialTransaction(root: string, size: number): {
  transaction: ReturnType<typeof transactionOf>;
  counters: { reads: number }[];
  files: string[];
  sourceKeys: string[];
} {
  const producer = {
    tool: "ttscgraph",
    version: "test",
    typescript: "5.9.0",
  };
  const capabilities = [
    "universe",
    "sourceDigests",
    "diskDigests",
    "diagnostics",
  ];
  const files = Array.from(
    { length: size },
    (_, index) => `src/f${String(index).padStart(3, "0")}.ts`,
  );
  const config = { file: "tsconfig.json", digest: digest("configuration") };
  const universe = {
    configs: [config],
    roots: files.map((file) => ({ config: config.file, file })),
  };
  const counters = files.map(() => ({ reads: 0 }));
  const sourceKeys = files.map(
    (_, index) => `1:source:${String(index).padStart(3, "0")}`,
  );
  const shards = files.map((file, index) =>
    sourceShard(
      file,
      sourceKeys[index]!,
      digest(`checker:${file}`),
      counters[index]!,
    ),
  );
  shards.push({
    key: "3:config",
    config,
    nodes: [],
    edges: [],
    diagnostics: [],
  } as ReturnType<typeof sourceShard>);
  const upserts = shards.map((shard) => ({
    digest: digestJson(shard),
    shard,
  }));
  const manifest = upserts
    .map((entry) => ({ key: entry.shard.key, digest: entry.digest }))
    .sort((left, right) => compareUtf8(left.key, right.key));
  const transaction = transactionOf({
    root,
    producer,
    capabilities,
    universe,
    upserts,
    manifest,
  });
  return { transaction, counters, files, sourceKeys };
}

function transactionOf(input: {
  root: string;
  producer: Record<string, string>;
  capabilities: string[];
  universe: Record<string, unknown>;
  upserts: { digest: string; shard: ReturnType<typeof sourceShard> }[];
  manifest: { key: string; digest: string }[];
}) {
  const transaction = {
    protocolVersion: 1,
    schemaVersion: 6,
    project: input.root,
    tsconfig: "tsconfig.json",
    producer: input.producer,
    capabilities: input.capabilities,
    universe: input.universe,
    sequence: 1,
    generation: "",
    upserts: input.upserts,
    deletes: [] as string[],
    manifest: input.manifest,
  };
  transaction.generation = digestJson({
    tsconfig: transaction.tsconfig,
    producer: transaction.producer,
    capabilities: transaction.capabilities,
    universe: transaction.universe,
    manifest: transaction.manifest,
  });
  return transaction;
}

function sourceShard(
  file: string,
  key: string,
  checkerDigest: string,
  counter: { reads: number },
) {
  const id = `${file}#${file}:module`;
  const node = {
    get id(): string {
      counter.reads += 1;
      return id;
    },
    kind: "module",
    name: file,
    file,
    external: false,
  };
  return {
    key,
    source: {
      file,
      checkerDigest,
      diskDigest: digest(`disk:${file}`),
    },
    nodes: [node],
    edges: [],
    diagnostics: [],
  };
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function digestJson(value: unknown): string {
  return digest(
    JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => {
      if (character === "<") return "\\u003c";
      if (character === ">") return "\\u003e";
      if (character === "&") return "\\u0026";
      return character === "\u2028" ? "\\u2028" : "\\u2029";
    }),
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
