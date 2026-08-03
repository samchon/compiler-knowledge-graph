import { TestValidator } from "@nestia/e2e";

import { ContractGraph } from "../internal/ContractGraph";
import { GraphFixtures } from "../internal/GraphFixtures";

/**
 * The application's request switch is the one place where a new MCP member can
 * be added to the union, compile, and never run: the type checker is satisfied
 * by the union alone, and each arm's audit, trust envelope, and `next` decision
 * are chosen independently of the others. This walks every discriminator,
 * including the `topology` arm and the `escape` arm that must carry no trust
 * envelope, so an unexercised branch fails here rather than at a caller.
 */
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
