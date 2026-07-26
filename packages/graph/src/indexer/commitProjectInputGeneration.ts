import path from "node:path";

import { IGraphProvider } from "../provider/IGraphProvider";
import { IBuildGraphOptions } from "./IBuildGraphOptions";
import { IIndexerResult } from "./IIndexerResult";
import { movedConsumedSource } from "./movedConsumedSource";
import { movedProviderSource } from "./movedProviderSource";
import { projectInputGeneration } from "./projectInputGeneration";
import { projectInputManifest } from "./projectInputManifest";
import { providerBuildInputs } from "./providerBuildInputs";
import { sameProjectInputManifest } from "./sameProjectInputManifest";
import { selectGraphSources } from "./selectGraphSources";

const INPUT_COMMIT_ATTEMPTS = 3;

/** Build one candidate and publish it only if its project generation holds. */
export async function commitProjectInputGeneration(
  options: IBuildGraphOptions,
  providers: readonly IGraphProvider[],
  build: () => Promise<IIndexerResult> | IIndexerResult,
  discard: (result: IIndexerResult) => Promise<Error[]> = async () => [],
): Promise<IIndexerResult> {
  const root = path.resolve(options.cwd ?? process.cwd());
  const discardResult = async (
    result: IIndexerResult,
    reason: string,
  ): Promise<void> => {
    const closeErrors = await discard(result);
    if (closeErrors.length > 0) {
      throw new AggregateError(
        closeErrors,
        `@samchon/graph: ${reason}, and the discarded candidate's sessions could not all close`,
      );
    }
  };
  let lastMovement = "";
  for (let attempt = 1; attempt <= INPUT_COMMIT_ATTEMPTS; attempt++) {
    const beforeSelection = selectGraphSources(root, options);
    const buildInputs = providerBuildInputs(
      beforeSelection.languages,
      providers,
      root,
    );
    const beforeBuildInputFiles = buildInputs.map((input) =>
      path.resolve(root, input),
    );
    const before = projectInputManifest(
      root,
      options,
      buildInputs,
      beforeSelection.files,
    );
    const result = await build();
    let candidate: {
      afterBuildInputs: string[];
      after: Map<string, string>;
      moved: movedConsumedSource.IMovement | undefined;
      providerMovement: string | undefined;
      beforeGeneration: string;
      afterGeneration: string;
    };
    try {
      const afterSelection = selectGraphSources(root, options);
      const afterBuildInputs = providerBuildInputs(
        afterSelection.languages,
        providers,
        root,
      );
      const after = projectInputManifest(
        root,
        options,
        afterBuildInputs,
        afterSelection.files,
      );
      const afterBuildInputFiles = afterBuildInputs.map((input) =>
        path.resolve(root, input),
      );
      const moved =
        result.sources === undefined
          ? undefined
          : movedConsumedSource(result.sources, after);
      const providerMovement = movedProviderSource(
        result.providerSourceDigests,
        before,
        after,
      );
      const generationInput = {
        consumedSources: result.sources,
        providerSources: result.providerSourceDigests,
        provenance: result.dump.provenance,
      };
      candidate = {
        afterBuildInputs,
        after,
        moved,
        providerMovement,
        beforeGeneration: projectInputGeneration({
          sourceFiles: beforeSelection.files,
          buildInputFiles: beforeBuildInputFiles,
          manifest: before,
          ...generationInput,
        }),
        afterGeneration: projectInputGeneration({
          sourceFiles: afterSelection.files,
          buildInputFiles: afterBuildInputFiles,
          manifest: after,
          ...generationInput,
        }),
      };
    } catch (error) {
      await discardResult(
        result,
        `candidate validation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
    if (
      candidate.moved === undefined &&
      candidate.providerMovement === undefined &&
      sameProjectInputManifest(before, candidate.after) &&
      candidate.beforeGeneration === candidate.afterGeneration
    ) {
      return {
        ...result,
        inputManifest: candidate.after,
        inputGeneration: candidate.afterGeneration,
        inputManifestLanguages: [],
        buildInputs: candidate.afterBuildInputs,
      };
    }

    lastMovement =
      candidate.moved !== undefined
        ? `${candidate.moved.file} changed after this build consumed it (${candidate.moved.detail})`
        : candidate.providerMovement !== undefined
          ? candidate.providerMovement
          : "the selected source/config/build input generation changed while the build was preparing";
    await discardResult(result, lastMovement);
  }
  throw new Error(
    `@samchon/graph: ${lastMovement} in all ${String(INPUT_COMMIT_ATTEMPTS)} bounded attempts, so no mixed-generation graph was published`,
  );
}
