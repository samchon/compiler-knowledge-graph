import { TestValidator } from "@nestia/e2e";
import {
  ISamchonRepositoryContextDump,
  RepositoryContextProtocol,
  SamchonGraphApplication,
  SamchonGraphMemory,
  SamchonRepositoryContextMemory,
  repositoryContextFacts,
} from "@samchon/graph";
import fs from "node:fs";

import { GraphFixtures } from "../internal/GraphFixtures";

const { repositoryContextCoverage, repositoryContextId } =
  repositoryContextFacts;

export const test_mcp_topology_fences_file_joins_by_code_generation =
  async () => {
    const fixture = GraphFixtures.createContractFixture();
    try {
      const input = "a".repeat(64);
      const graph = SamchonGraphMemory.from({
        ...fixture.dump,
        generation: { input },
      });
      const topology = new SamchonRepositoryContextMemory(
        topologyDump(fixture.dump.project),
      );
      const application = new SamchonGraphApplication(graph, () => topology);
      const compatible = await application.inspect_code_graph({
        question: "show repository packages and their source files",
        draft: { reason: "repository orientation", type: "topology" },
        review: "topology is the typed repository plane",
        request: {
          type: "topology",
          query: "source",
          relations: ["joins-file"],
          limit: 10,
        },
      });
      TestValidator.equals(
        "a stable code generation admits only joins to indexed code files",
        [
          compatible.result.type,
          compatible.result.type === "topology"
            ? compatible.result.join.state
            : undefined,
          compatible.result.type === "topology"
            ? compatible.result.edges.map((edge) => edge.to)
            : [],
          compatible.result.type === "topology"
            ? compatible.result.coverage.map((row) => row.family)
            : [],
        ],
        [
          "topology",
          "compatible",
          ["src/contract.ts"],
          ["joins-file"],
        ],
      );

      const bounded = await application.inspect_code_graph({
        question: "show one repository file join",
        draft: { reason: "repository orientation", type: "topology" },
        review: "topology is the typed repository plane",
        request: {
          type: "topology",
          relations: ["joins-file"],
          joinLimit: 1,
        },
      });
      TestValidator.equals(
        "incompatible file identities are removed before the join bound is evaluated",
        [
          bounded.result.type === "topology"
            ? bounded.result.edges.filter(
                (edge) => edge.kind === "joins-file",
              ).length
            : -1,
          bounded.result.type === "topology"
            ? bounded.result.truncated
            : false,
        ],
        [1, false],
      );

      const endpointBounded = await application.inspect_code_graph({
        question: "show the source relation",
        draft: { reason: "repository orientation", type: "topology" },
        review: "topology is the typed repository plane",
        request: {
          type: "topology",
          query: "source",
          relations: ["contains"],
          limit: 1,
        },
      });
      TestValidator.equals(
        "dropping a relation endpoint at the node bound reports truncation",
        endpointBounded.result.type === "topology"
          ? [
              endpointBounded.result.nodes.length,
              endpointBounded.result.nodes[0]?.name,
              endpointBounded.result.edges.length,
              endpointBounded.result.truncated,
            ]
          : [],
        [1, "source", 0, true],
      );

      const legacy = SamchonGraphMemory.from({
        ...fixture.dump,
        generation: undefined,
      });
      const unavailable = await new SamchonGraphApplication(
        legacy,
        () => topology,
      ).inspect_code_graph({
        question: "show repository topology",
        draft: { reason: "repository orientation", type: "topology" },
        review: "topology is correct",
        request: { type: "topology", limit: 1 },
      });
      TestValidator.equals(
        "a legacy code dump cannot receive topology file joins",
        [
          unavailable.result.type === "topology"
            ? unavailable.result.join.state
            : undefined,
          unavailable.result.type === "topology"
            ? unavailable.result.edges.some(
                (edge) => edge.kind === "joins-file",
              )
            : true,
          unavailable.result.type === "topology"
            ? unavailable.result.truncated
            : false,
        ],
        ["unavailable", false, true],
      );

      let loads = 0;
      const moved = SamchonGraphMemory.from({
        ...fixture.dump,
        generation: { input: "moved".padEnd(64, "0") },
      });
      const stale = await new SamchonGraphApplication(
        () => (loads++ === 0 ? graph : moved),
        () => topology,
      ).inspect_code_graph({
        question: "show repository topology",
        draft: { reason: "repository orientation", type: "topology" },
        review: "topology is correct",
        request: { type: "topology" },
      });
      TestValidator.equals(
        "a code generation that moves across the topology load refuses stale file joins",
        [
          stale.result.type === "topology"
            ? stale.result.join.state
            : undefined,
          stale.result.type === "topology"
            ? stale.result.edges.some((edge) => edge.kind === "joins-file")
            : true,
        ],
        ["unavailable", false],
      );

      const emptyTopology = new SamchonRepositoryContextMemory({
        ...topology.dump,
        provenance: [],
        coverage: topology.dump.coverage.map((row) => ({
          ...row,
          target: "unavailable",
          state: "unsupported",
        })),
        nodes: [],
        edges: [],
        files: [],
      });
      const providerUnavailable = await new SamchonGraphApplication(
        graph,
        () => emptyTopology,
      ).inspect_code_graph({
        question: "show repository topology",
        draft: { reason: "repository orientation", type: "topology" },
        review: "topology is correct",
        request: { type: "topology" },
      });
      TestValidator.equals(
        "an unavailable provider generation cannot claim join compatibility",
        [
          providerUnavailable.result.type === "topology"
            ? providerUnavailable.result.join
            : undefined,
          providerUnavailable.next.reason,
        ],
        [
          {
            state: "unavailable",
            topologyInputGeneration: emptyTopology.dump.inputGeneration,
            codeInputGeneration: input,
            reason:
              "No repository-context provider produced a compatible current generation.",
          },
          "No repository topology node matched the requested query or available provider facts.",
        ],
      );

      await TestValidator.error(
        "the topology branch fails explicitly without a repository source",
        () =>
          new SamchonGraphApplication(graph).inspect_code_graph({
            question: "show repository topology",
            draft: { reason: "repository orientation", type: "topology" },
            review: "topology is correct",
            request: { type: "topology" },
          }),
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  };

function topologyDump(project: string): ISamchonRepositoryContextDump {
  const workspace = repositoryContextId("fixture", "workspace", ".");
  const sourceHelper = repositoryContextId(
    "fixture",
    "source-root",
    "source-helper",
  );
  const upperSource = repositoryContextId(
    "fixture",
    "source-root",
    "Source",
  );
  const source = repositoryContextId("fixture", "source-root", "src");
  const nodes: ISamchonRepositoryContextDump.INode[] = [
    {
      id: workspace,
      authority: "declared",
      kind: "workspace",
      name: "fixture",
      ecosystem: "fixture",
      coordinate: ".",
      configuration: "default",
      external: false,
    },
    {
      id: sourceHelper,
      authority: "declared",
      kind: "source-root",
      name: "source-helper",
      ecosystem: "fixture",
      coordinate: "source-helper",
      configuration: "default",
      external: false,
    },
    {
      id: upperSource,
      authority: "declared",
      kind: "source-root",
      name: "Source",
      ecosystem: "fixture",
      coordinate: "Source",
      configuration: "default",
      external: false,
    },
    {
      id: source,
      authority: "declared",
      kind: "source-root",
      name: "source",
      ecosystem: "fixture",
      coordinate: "src",
      configuration: "default",
      external: false,
    },
  ];
  const edges: ISamchonRepositoryContextDump.IEdge[] = [
    {
      authority: "declared",
      kind: "contains",
      from: workspace,
      to: source,
    },
    {
      authority: "declared",
      kind: "joins-file",
      from: source,
      to: "src/contract.ts",
    },
    {
      authority: "declared",
      kind: "joins-file",
      from: source,
      to: "src/not-indexed.ts",
    },
  ];
  const coverage = repositoryContextCoverage(
    "fixture-context",
    "fixture",
    "workspace",
    ["contains", "joins-file"],
  );
  const contentDigest = RepositoryContextProtocol.digest({
    nodes,
    edges,
    coverage,
  });
  return {
    project,
    schemaVersion: 1,
    inputGeneration: "b".repeat(64),
    generation: {
      sequence: 1,
      token: "c".repeat(64),
      shards: [{ key: "fixture", digest: "d".repeat(64) }],
      contentDigest,
    },
    provenance: [
      {
        provider: "fixture-context",
        ecosystem: "fixture",
        authority: "declared",
        tool: "fixture",
        toolVersion: "1",
        schemaVersion: 1,
        protocolVersion: 1,
        universe: "e".repeat(64),
        manifest: "f".repeat(64),
        content: contentDigest,
        capabilities: ["fixture"],
      },
    ],
    coverage,
    nodes,
    edges,
    files: ["src/contract.ts", "src/not-indexed.ts"],
    sources: [{ file: "fixture.json", digest: "a".repeat(64) }],
    warnings: [],
  };
}
