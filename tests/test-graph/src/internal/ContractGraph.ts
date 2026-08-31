import {
  SamchonGraphMemory,
  SamchonGraphApplication,
  SamchonRepositoryContextMemory,
} from "@samchon/graph";
import type { ISamchonGraphApplication } from "@samchon/graph";

import { GraphFixtures } from "./GraphFixtures";

const createApplication = (): SamchonGraphApplication => {
  const fixture = GraphFixtures.createContractFixture();
  return new SamchonGraphApplication(
    SamchonGraphMemory.from(fixture.dump),
    () =>
      new SamchonRepositoryContextMemory({
        project: fixture.root,
        schemaVersion: 1,
        inputGeneration: "a".repeat(64),
        generation: {
          sequence: 1,
          token: "b".repeat(64),
          shards: [],
          contentDigest: "c".repeat(64),
        },
        provenance: [],
        coverage: [],
        nodes: [],
        edges: [],
        files: [],
        sources: [],
        warnings: [],
      }),
  );
};

const call = (
  app: SamchonGraphApplication,
  request: ISamchonGraphApplication.IProps["request"],
  question?: string,
) =>
  app.inspect_code_graph({
    // The tour ranks against the question, in the user's own words; a caller
    // that means to steer one writes it here, not into the request.
    question: question ?? `contract ${request.type}`,
    draft: { reason: `${request.type} is under contract test.`, type: request.type },
    review: "Contract fixture intentionally exercises this request branch.",
    request,
  });

export const ContractGraph = {
  call,
  createApplication,
};
