import { TestValidator } from "@nestia/e2e";

import { ContractGraph } from "../internal/ContractGraph";
import { GraphFixtures } from "../internal/GraphFixtures";

export const test_application_exercises_every_request_branch = async () => {
  const app = ContractGraph.createApplication();
  const requests = [
    { type: "entrypoints", query: "Root.Service.run helper" },
    { type: "lookup", query: "Root.Service.run" },
    { type: "trace", from: "Root.Service.run", direction: "forward", focus: "execution" },
    { type: "details", handles: ["Root.Service.run"], neighbors: true },
    { type: "overview", aspect: "all" },
    { type: "tour", reinterpretations: ["Root.Service.run"] },
    { type: "topology" },
    { type: "escape", reason: "outside graph", nextStep: "answer without graph" },
  ] as const;

  const results = [];
  for (const request of requests) {
    const output = await ContractGraph.call(app, request);
    results.push(output.result.type);
  }
  TestValidator.equals("all request branches return matching result types", results, GraphFixtures.GRAPH_REQUEST_TYPES);
};
