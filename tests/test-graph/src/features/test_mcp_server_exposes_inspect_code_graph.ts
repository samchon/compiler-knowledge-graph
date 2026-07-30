import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TestValidator } from "@nestia/e2e";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { GraphFixtures } from "../internal/GraphFixtures";
import { GraphPaths } from "../internal/GraphPaths";

const overview = async (args: string[]) => {
  const client = new Client({ name: "samchon-graph-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [GraphPaths.graphBin, ...args],
    stderr: "pipe",
  });
  await client.connect(transport);
  try {
    TestValidator.equals(
      "the handshake names the exact graph package release",
      client.getServerVersion(),
      { name: "samchon-graph", version: "0.2.0" },
    );
    // Coverage instrumentation adds real overhead to every spawned child
    // process; the SDK's 60s default has been observed to trip under a
    // fully-instrumented suite run even though the call itself is fast.
    const tools = await client.listTools(undefined, { timeout: 120_000 });
    TestValidator.equals(
      "MCP exposes one graph tool",
      tools.tools.map((tool) => tool.name),
      ["inspect_code_graph"],
    );
    const result = await client.callTool(
      {
        name: "inspect_code_graph",
        arguments: {
          question: "Show project overview",
          draft: { reason: "Overview is the smallest project map.", type: "overview" },
          review: "Overview is appropriate.",
          request: { type: "overview" },
        },
      },
      undefined,
      { timeout: 120_000 },
    );
    // The result crosses the wire once (§4j). A tool that declares an output
    // schema must answer with `structuredContent`, and serializing the same JSON
    // into a text block as well doubled a 30 KB tour into 60 KB — enough to blow
    // a client's tool-result cap and spill the answer to a file the model then
    // shelled out to read back.
    TestValidator.equals(
      "the payload does not cross a second time as text",
      result.content,
      [],
    );
    const payload = result.structuredContent as Record<string, unknown>;
    TestValidator.predicate(
      "the result arrives as structured content",
      payload !== undefined,
    );
    // `audit` serializes first, then the structured completeness evidence,
    // before `next` says where the result leaves the question.
    TestValidator.equals(
      "audit leads, then where it leaves the question, then the facts",
      Object.keys(payload),
      ["audit", "coverage", "unresolved", "next", "result"],
    );
    return payload;
  } finally {
    await client.close();
  }
};

export const test_mcp_server_exposes_inspect_code_graph = async () => {
  const root = GraphFixtures.createOrderFixture();
  const parsed = await overview(["--mode", "static", "--cwd", root]);
  TestValidator.equals("MCP call result type", parsed.result.type, "overview");
  TestValidator.predicate("MCP overview has nodes", parsed.result.counts.nodes > 0);

  // A pre-built dump serves without re-indexing: the server answers from the
  // graph file the way the benchmark pre-warms it.
  const dump = execFileSync(
    process.execPath,
    [GraphPaths.graphBin, "dump", "--mode", "static", "--cwd", root],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const graphFile = path.join(GraphPaths.createTempDirectory("samchon-graph-dump-"), "graph.json");
  fs.writeFileSync(graphFile, dump);
  const served = await overview(["--graph-file", graphFile]);
  TestValidator.equals("graph-file server result type", served.result.type, "overview");
  TestValidator.equals(
    "graph-file server answers from the same graph",
    served.result.counts.nodes,
    parsed.result.counts.nodes,
  );
};
