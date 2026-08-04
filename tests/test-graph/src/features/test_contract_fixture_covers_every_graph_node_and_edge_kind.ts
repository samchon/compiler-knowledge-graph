import { TestValidator } from "@nestia/e2e";
import { GRAPH_EDGE_KINDS, SamchonGraphMemory } from "@samchon/graph";

import { GraphFixtures } from "../internal/GraphFixtures";

/**
 * The contract fixture is the shared corpus every operation test reasons from,
 * so a kind it happens not to contain is a kind nothing tests — silently, and
 * more so after each new family is added. This is the completeness gate for
 * that.
 *
 * The two halves are not equally strong, which is worth knowing before relying
 * on either. The edge half is anchored: it compares the fixture against the
 * package's own exported `GRAPH_EDGE_KINDS`, so a new family reaches it by
 * existing. The node half compares against a list this suite maintains by
 * hand, so a new node kind reaches it only when someone adds it there too.
 */
export const test_contract_fixture_covers_every_graph_node_and_edge_kind = () => {
  const { dump } = GraphFixtures.createContractFixture();
  const graph = SamchonGraphMemory.from(dump);

  TestValidator.equals(
    "all graph node kinds are represented",
    [...new Set(graph.nodes.map((node) => node.kind))].sort(),
    [...GraphFixtures.GRAPH_NODE_KINDS].sort(),
  );
  TestValidator.equals(
    "the protocol coverage order contains the exact public edge-kind union",
    GRAPH_EDGE_KINDS,
    GraphFixtures.GRAPH_EDGE_KINDS,
  );
  // Every edge kind an index can store is in the fixture. `dispatches` is the
  // one it cannot: a forward walk synthesizes it when a call lands on a
  // declaration with no body, so it lives in a traversal and never in a graph.
  TestValidator.equals(
    "all stored graph edge kinds are represented",
    [...new Set(graph.edges.map((edge) => edge.kind))].sort(),
    GraphFixtures.GRAPH_EDGE_KINDS.filter(
      (kind) => !GraphFixtures.GRAPH_TRAVERSAL_EDGE_KINDS.includes(kind),
    ).sort(),
  );
  TestValidator.equals(
    "a traversal-only edge kind is never stored",
    graph.edges
      .filter((edge) =>
        GraphFixtures.GRAPH_TRAVERSAL_EDGE_KINDS.includes(edge.kind),
      )
      .map((edge) => edge.kind),
    [],
  );
};
