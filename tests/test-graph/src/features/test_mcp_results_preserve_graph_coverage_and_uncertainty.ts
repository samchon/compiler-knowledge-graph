import { TestValidator } from "@nestia/e2e";
import {
  GRAPH_EDGE_KINDS,
  ISamchonGraphDump,
  SamchonGraphApplication,
  SamchonGraphMemory,
} from "@samchon/graph";
import path from "node:path";

/** Provenance, completeness and uncertainty survive dump, memory and MCP. */
export const test_mcp_results_preserve_graph_coverage_and_uncertainty =
  async () => {
    const dump = fixture();
    const memory = SamchonGraphMemory.from(dump);
    TestValidator.equals(
      "memory retains the exact public trust planes",
      [
        memory.provenance[0]?.universe,
        memory.coverage.length,
        memory.unresolved[0]?.reason,
      ],
      ["a".repeat(64), GRAPH_EDGE_KINDS.length, "dynamic"],
    );

    const application = new SamchonGraphApplication(memory);
    const lookup = await application.inspect_code_graph({
      question: "where is run",
      draft: { reason: "named symbol", type: "lookup" },
      review: "lookup is exact",
      request: { type: "lookup", query: "run" },
    });
    TestValidator.equals(
      "lookup reports every family that can affect ranking",
      [
        lookup.provenance?.[0]?.provider,
        lookup.coverage?.schemaVersion,
        lookup.coverage?.families,
        lookup.coverage?.rows.length,
        lookup.unresolved,
      ],
      [
        "fixture-compiler",
        1,
        GRAPH_EDGE_KINDS.filter(
          (family) =>
            family === "exports" ||
            !["contains", "exports", "imports"].includes(family),
        ),
        GRAPH_EDGE_KINDS.length - 2,
        {
          count: 2,
          reasons: [
            { reason: "dynamic", count: 1 },
            { reason: "reflection", count: 1 },
          ],
          examples: dump.unresolved,
        },
      ],
    );

    const entrypoints = await application.inspect_code_graph({
      question: "where does run begin",
      draft: { reason: "first handles", type: "entrypoints" },
      review: "entrypoints is exact",
      request: { type: "entrypoints", query: "run" },
    });
    TestValidator.equals(
      "entrypoints includes the lookup and neighborhood trust families",
      [
        entrypoints.coverage?.families,
        entrypoints.unresolved?.count,
      ],
      [lookup.coverage?.families, 2],
    );

    const overview = await application.inspect_code_graph({
      question: "what are the architectural hotspots",
      draft: { reason: "dependency ranking", type: "overview" },
      review: "overview is exact",
      request: { type: "overview", aspect: "hotspots" },
    });
    TestValidator.equals(
      "overview reports every family counted or used for ranking",
      [
        overview.coverage?.families,
        overview.unresolved?.count,
      ],
      [GRAPH_EDGE_KINDS, 2],
    );

    const trace = await application.inspect_code_graph({
      question: "what does run call",
      draft: { reason: "dependency flow", type: "trace" },
      review: "trace is exact",
      request: { type: "trace", from: "run" },
    });
    TestValidator.equals(
      "trace carries all-family coverage and bounded structured uncertainty",
      [
        trace.coverage?.families.length,
        trace.unresolved?.count,
        trace.unresolved?.reasons,
        trace.unresolved?.examples[0]?.candidates,
        trace.unresolved?.examples[1]?.candidates,
      ],
      [
        GRAPH_EDGE_KINDS.length,
        2,
        [
          { reason: "dynamic", count: 1 },
          { reason: "reflection", count: 1 },
        ],
        ["src/main.ts#target:function"],
        undefined,
      ],
    );

    const escaped = await application.inspect_code_graph({
      question: "read a body",
      draft: { reason: "outside graph", type: "escape" },
      review: "escape",
      request: { type: "escape", reason: "body text" },
    });
    TestValidator.equals(
      "escape does not load or invent a graph trust envelope",
      [escaped.provenance, escaped.coverage, escaped.unresolved],
      [undefined, undefined, undefined],
    );
  };

function fixture(): ISamchonGraphDump {
  const universe = "a".repeat(64);
  return {
    project: path.resolve("fixture"),
    languages: ["typescript"],
    indexer: "lsp",
    provenance: [
      {
        provider: "fixture-compiler",
        languages: ["typescript"],
        authority: "compiler",
        facts: ["calls"],
        capabilities: ["universe"],
        producer: {
          tool: "fixture-exporter",
          version: "1.0.0",
          compiler: "fixture-1",
          schemaVersion: 7,
          protocolVersion: 1,
        },
        universe,
        manifest: "b".repeat(64),
        content: "c".repeat(64),
      },
    ],
    coverage: GRAPH_EDGE_KINDS.map((family) => ({
      provider: "fixture-compiler",
      language: "typescript",
      target: "app",
      family,
      state: family === "calls" ? "partial" : "unsupported",
    })),
    unresolved: [
      {
        provider: "fixture-compiler",
        language: "typescript",
        target: "app",
        universe,
        family: "calls",
        evidence: { file: "src/main.ts", startLine: 1, startCol: 1 },
        reason: "dynamic",
        candidates: ["src/main.ts#target:function"],
      },
      {
        provider: "fixture-compiler",
        language: "typescript",
        target: "app",
        universe,
        family: "calls",
        evidence: { file: "src/main.ts", startLine: 2, startCol: 1 },
        reason: "reflection",
      },
    ],
    nodes: [
      {
        id: "src/main.ts#run:function",
        kind: "function",
        language: "typescript",
        name: "run",
        file: "src/main.ts",
        external: false,
        evidence: { startLine: 1, startCol: 1 },
      },
    ],
    edges: [],
  };
}
