import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import path from "node:path";

import { TtscGraphClient } from "../../../../packages/graph/src/provider/ttscgraph/TtscGraphClient";
import { GraphPaths } from "../internal/GraphPaths";

/**
 * The native shard lane is a separately versioned atomic transaction, so a
 * bad shard digest, manifest or base must never become common graph state.
 *
 * 1. Request independently corrupted initial transactions through the real client.
 * 2. Commit one good generation, then corrupt its incremental successor.
 * 3. Require no initial publication and exact prior-object retention respectively.
 */
export const test_ttscgraph_native_shard_transactions_fail_atomically =
  async () => {
    const initialFailures: Record<string, string> = {
      "--native-invalid-digest": "native shard",
      "--native-invalid-manifest": "manifest does not cover",
      "--native-invalid-base": "initial native transaction",
      "--native-invalid-protocol": "native snapshot protocol v2",
      "--native-invalid-schema": "unsupported dump schema",
      "--native-invalid-sequence-zero": "native sequence must be",
      "--native-invalid-sequence-fraction": "native sequence must be",
      "--native-invalid-generation-format":
        "native transaction generation must be",
      "--native-invalid-generation": "native generation",
      "--native-invalid-initial-sequence": "initial native transaction",
      "--native-invalid-base-sequence-only":
        "native base coordinates are incomplete",
      "--native-invalid-base-generation-only":
        "native base coordinates are incomplete",
      "--native-invalid-base-sequence-type":
        "native baseSequence must be",
      "--native-invalid-key-empty": "native shard key is invalid",
      "--native-invalid-key-nul": "native shard key is invalid",
      "--native-invalid-reserved-coverage":
        "uses reserved normalized namespace",
      "--native-invalid-reserved-coverage-alternate":
        "uses reserved normalized namespace",
      "--native-invalid-two-input-kinds": "owns two input kinds",
      "--native-invalid-duplicate-source": "has two shards",
      "--native-invalid-duplicate-config": "has two shards",
      "--native-invalid-config-facts": "config shard",
      "--native-invalid-nonsource-edges": "non-source shard",
      "--native-invalid-source-external-node": "misowns node",
      "--native-invalid-source-foreign-node": "misowns node",
      "--native-invalid-external-local-node": "misowns node",
      "--native-invalid-duplicate-node": "has two owners",
      "--native-invalid-local-duplicate-node": "has two owners",
      "--native-invalid-source-diagnostic": "misowns diagnostic",
      "--native-invalid-config-diagnostic": "misowns diagnostic",
      "--native-invalid-metadata-diagnostic": "misowns diagnostic",
      "--native-invalid-edge-owner": "misowns edge",
      "--native-invalid-config-coverage": "do not cover the universe",
      "--native-invalid-config-digest": "config shard disagrees",
      "--native-invalid-manifest-sort": "not strictly key-sorted",
      "--native-invalid-manifest-entry": "manifest disagrees",
      "--native-invalid-manifest-digest-format":
        "native manifest digest must be",
      "--native-invalid-snapshot-string": "native snapshot must be an object",
      "--native-invalid-snapshot-null": "native snapshot must be an object",
      "--native-invalid-producer-array": "native producer must be an object",
      "--native-invalid-capabilities-array":
        "native capabilities must be an array",
      "--native-invalid-project-string": "native project must be a string",
      "--native-invalid-nodes-array": "nodes must be an array",
      "--native-invalid-node-boolean": "external must be boolean",
    };
    for (const [mode, expected] of Object.entries(initialFailures)) {
      const client = create(fixture(), mode);
      try {
        const error = await rejectionOf(client.refresh());
        TestValidator.predicate(
          `${mode} rejects before initial publication: ${errorText(error)}`,
          error instanceof Error &&
            error.message.includes(expected) &&
            client.current === undefined &&
            client.generation === 0,
        );
      } finally {
        await client.close();
      }
    }

    const incrementalFailures: Record<string, string> = {
      "--native-invalid-digest-third": "native shard",
      "--native-invalid-base-third": "stale base",
      "--native-invalid-project-third": "project coordinates",
      "--native-invalid-tsconfig-third": "project coordinates",
      "--native-invalid-delete-unknown-third": "deletes unknown shard",
      "--native-invalid-delete-duplicate-third": "touches shard",
      "--native-invalid-upsert-duplicate-third": "touches shard",
      "--native-invalid-retained-edge-target-third":
        "native edge target is absent",
    };
    for (const [mode, expected] of Object.entries(incrementalFailures)) {
      const client = create(fixture(), mode);
      try {
        const initial = await client.refresh();
        const unchanged = await client.refresh();
        TestValidator.predicate(
          `${mode} reuses the good base before its corrupt delta`,
          unchanged.snapshot === initial.snapshot && !unchanged.changed,
        );
        const error = await rejectionOf(client.refresh());
        TestValidator.predicate(
          `${mode} retains the exact committed snapshot and generation: ${errorText(error)}`,
          error instanceof Error &&
            error.message.includes(expected) &&
            client.current === initial.snapshot &&
            client.generation === 1,
        );
      } finally {
        await client.close();
      }
    }
  };

function create(root: string, mode: string): TtscGraphClient {
  return new TtscGraphClient({
    root,
    command: process.execPath,
    args: [GraphPaths.fakeTtscGraphServer, mode],
  });
}

function fixture(): string {
  const root = GraphPaths.createTempDirectory("samchon-graph-native-shards-");
  fs.mkdirSync(path.join(root, "src", "core"), { recursive: true });
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};\n");
  fs.writeFileSync(
    path.join(root, "src", "core", "order.ts"),
    "export function first() {}\n",
  );
  fs.writeFileSync(path.join(root, "src", "empty.ts"), "export {};\n");
  return root;
}

async function rejectionOf(task: Promise<unknown>): Promise<unknown> {
  try {
    await task;
    return undefined;
  } catch (error) {
    return error;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
