"use strict";

const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

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
  return manifestSelection(manifest).fixtures;
}

/**
 * Keep only agent measurements made for the exact current manifest prompt.
 *
 * The fixture can stay pinned while the question changes. Repository and
 * prompt family are checked too so a valid hash from one manifest entry cannot
 * be attached to another chart identity.
 */
function selectCurrentAgentCells(cells, manifest) {
  const { prompts } = manifestSelection(manifest);
  if (!Array.isArray(cells)) return [];
  return cells.filter((cell) => {
    const selected = prompts.get(cell?.promptId);
    return (
      selected !== undefined &&
      cell.repo === selected.repo &&
      cell.promptFamily === selected.family &&
      cell.fixtureBranch === selected.fixtureCommit &&
      cell.questionSha256 === selected.questionSha256
    );
  });
}

function manifestSelection(manifest) {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.prompts) ||
    manifest.prompts.length === 0
  ) {
    throw new TypeError(
      "benchmark question manifest must use schemaVersion 1 and contain prompts",
    );
  }
  const fixtures = Object.create(null);
  const prompts = new Map();
  const promptFamilies = new Set();
  for (const [index, prompt] of manifest.prompts.entries()) {
    const label = `benchmark question manifest.prompts[${String(index)}]`;
    if (
      typeof prompt?.id !== "string" ||
      prompt.id.trim() === "" ||
      typeof prompt?.repo !== "string" ||
      prompt.repo.trim() === "" ||
      typeof prompt.family !== "string" ||
      prompt.family.trim() === "" ||
      typeof prompt.fixtureCommit !== "string" ||
      !COMMIT.test(prompt.fixtureCommit) ||
      typeof prompt.questionSha256 !== "string" ||
      !SHA256.test(prompt.questionSha256)
    ) {
      throw new TypeError(
        `${label} must name an id, repository, family, full fixture commit, and question SHA-256`,
      );
    }
    const prior = fixtures[prompt.repo];
    if (prior !== undefined && prior !== prompt.fixtureCommit) {
      throw new TypeError(
        `${label} contradicts the earlier ${prompt.repo} fixture revision`,
      );
    }
    fixtures[prompt.repo] = prompt.fixtureCommit;
    if (prompts.has(prompt.id)) {
      throw new TypeError(`${label} duplicates prompt id ${prompt.id}`);
    }
    const promptFamily = JSON.stringify([prompt.repo, prompt.family]);
    if (promptFamilies.has(promptFamily)) {
      throw new TypeError(
        `${label} duplicates repository/family ${prompt.repo}/${prompt.family}`,
      );
    }
    promptFamilies.add(promptFamily);
    prompts.set(prompt.id, {
      repo: prompt.repo,
      family: prompt.family,
      fixtureCommit: prompt.fixtureCommit,
      questionSha256: prompt.questionSha256,
    });
  }
  return { fixtures, prompts };
}

module.exports = {
  fixtureRevisionsFromManifest,
  selectCurrentAgentCells,
  selectCurrentIndex,
};
