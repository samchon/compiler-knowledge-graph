"use strict";

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Keep only index-time evidence measured against the selected fixture revision.
 *
 * A fixture binding in the index document and the revision on the individual
 * cell are independent evidence. Both must name the currently selected commit:
 * accepting either one alone can relabel an old duration after the corpus
 * advances. Scale belongs to the same measured checkout and follows that gate.
 */
function selectCurrentIndex(index, selectedFixtures) {
  const source =
    typeof index === "object" && index !== null && !Array.isArray(index)
      ? index
      : {};
  const selected =
    typeof selectedFixtures === "object" &&
    selectedFixtures !== null &&
    !Array.isArray(selectedFixtures)
      ? selectedFixtures
      : {};
  const bound = new Set();
  if (
    source.schemaVersion === 2 &&
    typeof source.fixtures === "object" &&
    source.fixtures !== null &&
    !Array.isArray(source.fixtures)
  ) {
    for (const [project, commit] of Object.entries(selected)) {
      if (source.fixtures[project] === commit) bound.add(project);
    }
  }

  const candidates = Array.isArray(source.cells) ? source.cells : [];
  const cells = candidates.filter(
    (cell) =>
      typeof cell === "object" &&
      cell !== null &&
      bound.has(cell.project) &&
      cell.fixtureCommit === selected[cell.project],
  );
  const scale =
    typeof source.scale === "object" &&
    source.scale !== null &&
    !Array.isArray(source.scale)
      ? Object.fromEntries(
          Object.entries(source.scale).filter(([project]) =>
            bound.has(project),
          ),
        )
      : {};
  const fixtures = Object.fromEntries(
    [...bound].map((project) => [project, selected[project]]),
  );

  return {
    index: {
      ...source,
      schemaVersion: 2,
      fixtures,
      scale,
      cells,
    },
    staleCellCount: candidates.length - cells.length,
  };
}

/**
 * Derive the renderer's current fixture registry from the question manifest.
 *
 * Each project has multiple prompts, so repeated entries must agree. The
 * manifest generator's corpus regression proves completeness and exact
 * agreement with corpus.mjs; this boundary refuses contradictory input too.
 */
function fixtureRevisionsFromManifest(manifest) {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !Array.isArray(manifest.prompts)
  ) {
    throw new TypeError("benchmark question manifest must contain prompts");
  }
  const fixtures = {};
  for (const [index, prompt] of manifest.prompts.entries()) {
    const label = `benchmark question manifest.prompts[${String(index)}]`;
    if (
      typeof prompt?.repo !== "string" ||
      prompt.repo.trim() === "" ||
      typeof prompt.fixtureCommit !== "string" ||
      !COMMIT.test(prompt.fixtureCommit)
    ) {
      throw new TypeError(
        `${label} must name a repository and full lowercase fixture commit`,
      );
    }
    const prior = fixtures[prompt.repo];
    if (prior !== undefined && prior !== prompt.fixtureCommit) {
      throw new TypeError(
        `${label} contradicts the earlier ${prompt.repo} fixture revision`,
      );
    }
    fixtures[prompt.repo] = prompt.fixtureCommit;
  }
  return fixtures;
}

module.exports = { fixtureRevisionsFromManifest, selectCurrentIndex };
