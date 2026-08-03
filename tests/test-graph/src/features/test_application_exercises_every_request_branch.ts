import { TestValidator } from "@nestia/e2e";

import { ContractGraph } from "../internal/ContractGraph";
import { GraphFixtures } from "../internal/GraphFixtures";

/**
 * Every request member is driven through the real application and its result
 * discriminator is compared, in order, against the advertised request list.
 * The property that buys is narrow but not otherwise held anywhere: no arm may
 * answer as another arm. Each one selects its own result union member, and a
 * mis-wired `switch` that returned an overview for a trace would satisfy the
 * type checker, every per-operation suite that only calls its own request, and
 * the coverage gate that only asks whether the line ran.
 *
 * This is not the guard against an unexercised arm. Both the driven list here
 * and {@link GraphFixtures.GRAPH_REQUEST_TYPES} are hand-maintained, so a new
 * union member reaches neither by itself; the 100 percent branch-coverage gate
 * is what refuses an arm nothing runs.
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
