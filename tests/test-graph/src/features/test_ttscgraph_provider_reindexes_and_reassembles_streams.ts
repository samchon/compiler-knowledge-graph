import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import path from "node:path";

// `TtscGraphClient` is internal to the package, so it is reached by path rather
// than through the public barrel.
import { TtscGraphClient } from "../../../../packages/graph/src/provider/ttscgraph/TtscGraphClient";
import { GraphPaths } from "../internal/GraphPaths";

/**
 * The serve stream is NDJSON, and the client owns the framing. A frame the OS
 * hands over in two chunks, or one preceded by a blank line, must reassemble
 * into exactly the same snapshot as a frame delivered whole — the transport
 * must never leak into the facts.
 *
 * The confirmation round-trip this file once also covered is gone: the client
 * no longer re-reads disk or issues a second poll to confirm a dump still holds
 * (the producer's manifest answers that in the same envelope), so there is no
 * "concurrent edit during confirmation" path left to drive. What survives #70's
 * rewrite is the framing invariant, and that is what this test now states.
 */
export const test_ttscgraph_provider_reindexes_and_reassembles_streams =
  async () => {
    const root = GraphPaths.createTempDirectory("samchon-graph-ttscgraph-stream-");
    fs.mkdirSync(path.join(root, "src", "core"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "index.ts"), "export * from './core/order';\n");
    fs.writeFileSync(path.join(root, "src", "core", "order.ts"), "export async function first() {}\n");
    fs.writeFileSync(path.join(root, "src", "empty.ts"), "export {};\n");

    // A blank NDJSON line before a valid frame is ignored, not treated as a
    // response.
    const blank = await refreshOnce(root, "--blank-line");
    TestValidator.predicate(
      "a blank NDJSON line is ignored and the real frame still applies",
      blank.changed &&
        blank.generation === 1 &&
        blank.snapshot.nodes.some((node) => node.name === "first"),
    );

    // A frame split across two stream chunks is reassembled before parsing.
    const split = await refreshOnce(root, "--split-frame");
    TestValidator.predicate(
      "a frame split across stream chunks is reassembled",
      split.changed &&
        split.generation === 1 &&
        split.snapshot.nodes.some((node) => node.name === "first"),
    );
  };

async function refreshOnce(
  root: string,
  serveFlag: string,
): Promise<{
  changed: boolean;
  generation: number;
  snapshot: { nodes: { name: string }[] };
}> {
  const client = new TtscGraphClient({
    root,
    command: process.execPath,
    args: [GraphPaths.fakeTtscGraphServer, serveFlag],
  });
  try {
    return await client.refresh();
  } finally {
    await client.close();
  }
}
