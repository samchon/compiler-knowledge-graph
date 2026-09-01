import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLANG_PRODUCER_CACHE_INPUTS,
  CLANG_PRODUCER_COMMIT,
  CLANG_PRODUCER_REPOSITORY,
  assertClangProducerAdapterPin,
  clangProducerProvisionDecision,
} from "../../experiment/src/clang-producer.mjs";
import { findExperiment } from "../../experiment/src/catalog.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

/**
 * The expensive native producer has one source owner and one build owner.
 *
 * This is structural on purpose: running LLVM to test workflow scheduling
 * would take hours and still could not force both cache-hit and cold-miss
 * branches deterministically. The assertions bind the executable recipe to
 * the exact `hashFiles` inputs and the producer job to every consumer.
 */
export function assertClangProducerCacheOwnership() {
  assert.equal(assertClangProducerAdapterPin(), CLANG_PRODUCER_COMMIT);
  assert.throws(
    () =>
      assertClangProducerAdapterPin(
        'export const CPP_CLANG_PRODUCER_COMMIT = "0000000000000000000000000000000000000000";',
      ),
    /adapter pins 0000000000000000000000000000000000000000/,
    "a divergent adapter pin must refuse the producer generation",
  );
  for (const language of ["c", "cpp"]) {
    const experiment = findExperiment(language);
    assert.equal(experiment.producerRepository, CLANG_PRODUCER_REPOSITORY);
    assert.equal(experiment.producerCommit, CLANG_PRODUCER_COMMIT);
  }

  assert.equal(
    clangProducerProvisionDecision({ installed: true, allowBuild: false }),
    "reuse",
    "a verified exact cache hit must not build",
  );
  assert.equal(
    clangProducerProvisionDecision({ installed: false, allowBuild: true }),
    "build",
    "the dedicated owner must build a cold key",
  );
  assert.throws(
    () =>
      clangProducerProvisionDecision({ installed: false, allowBuild: false }),
    /only the workflow producer job may build/,
    "a consumer must refuse a cold or invalid cache",
  );

  const baseline = cacheDigest();
  assert.equal(
    cacheDigest(
      new Map([
        [
          "tests/experiment/src/catalog.mjs",
          Buffer.from("an unrelated language catalog edit"),
        ],
        [
          "tests/experiment/src/setup-language.mjs",
          Buffer.from("an unrelated installer edit"),
        ],
      ]),
    ),
    baseline,
    "unrelated catalog and installer edits must leave the Clang key unchanged",
  );
  for (const input of CLANG_PRODUCER_CACHE_INPUTS) {
    assert.notEqual(
      cacheDigest(new Map([[input, Buffer.from(`changed ${input}`)]])),
      baseline,
      `${input} must invalidate the Clang producer cache`,
    );
  }

  const setup = read("tests/experiment/src/setup-language.mjs");
  assert.match(setup, /installClangGraphProducer\(\{/);
  assert.doesNotMatch(
    setup,
    /samchon-clangd-source|LLVM_ENABLE_PROJECTS|--target[\s\S]*"clangd"/,
    "the generic installer must not retain a second native producer recipe",
  );

  for (const workflowName of ["experiment.yml", "index-time.yml"]) {
    assertWorkflowOwnsOneBuild(workflowName);
  }
}

function assertWorkflowOwnsOneBuild(workflowName) {
  const workflow = read(`.github/workflows/${workflowName}`);
  const owner = workflow.indexOf("\n  clang_producer:");
  const consumerName =
    workflowName === "experiment.yml" ? "experiment" : "measure";
  const consumer = workflow.indexOf(`\n  ${consumerName}:`, owner);
  assert.ok(
    owner >= 0 && consumer > owner,
    `${workflowName} has no producer predecessor`,
  );

  const ownerBlock = workflow.slice(owner, consumer);
  const consumerBlock = workflow.slice(consumer);
  assert.equal(
    occurrences(workflow, "run: node tests/experiment/src/clang-producer.mjs"),
    1,
    `${workflowName} must have exactly one executable build owner`,
  );
  assert.match(
    ownerBlock,
    /Restore the pinned Clang producer[\s\S]*Provision the pinned Clang producer[\s\S]*Save the pinned Clang producer[\s\S]*Upload the verified Clang producer/,
  );
  assert.match(
    consumerBlock,
    /needs: \[latest_update, clang_producer\]/,
    `${workflowName} consumers must wait for the producer owner`,
  );
  assert.equal(
    occurrences(workflow, "Save the pinned Clang producer"),
    1,
    `${workflowName} must save only in the predecessor job`,
  );
  assert.match(
    ownerBlock,
    /Save the pinned Clang producer[\s\S]*continue-on-error: true/,
    `${workflowName} cache saving must not block the guaranteed artifact handoff`,
  );
  assert.match(
    ownerBlock,
    /SAMCHON_GRAPH_CLANG_PRODUCER_ALLOW_BUILD: \$\{\{ steps\.clang_producer\.outputs\.cache-hit != 'true' && '1' \|\| '0' \}\}/,
    `${workflowName} must refuse an invalid immutable exact hit`,
  );
  assert.match(
    consumerBlock,
    /Download the verified Clang producer[\s\S]*uses: actions\/download-artifact@v8[\s\S]*name: pinned-clang-producer[\s\S]*path: tests\/experiment\/\.work\/tools/,
    `${workflowName} consumers must receive the verified same-run artifact`,
  );
  assert.match(
    consumerBlock,
    /SAMCHON_GRAPH_CLANG_PRODUCER_ALLOW_BUILD: "0"/,
    `${workflowName} consumers must be unable to rebuild`,
  );

  const expectedInputs = [...CLANG_PRODUCER_CACHE_INPUTS].sort();
  const hashCalls = [...workflow.matchAll(/hashFiles\(([^)]*)\)/gu)];
  assert.equal(hashCalls.length, 1, `${workflowName} must have one cache owner`);
  for (const call of hashCalls) {
    const actual = [...call[1].matchAll(/'([^']+)'/gu)]
      .map((match) => match[1])
      .sort();
    assert.deepEqual(
      actual,
      expectedInputs,
      `${workflowName} uses a broad or incomplete Clang key`,
    );
  }
}

function cacheDigest(overrides = new Map()) {
  const hash = crypto.createHash("sha256");
  for (const relative of CLANG_PRODUCER_CACHE_INPUTS) {
    hash.update(relative);
    hash.update("\0");
    hash.update(
      overrides.get(relative) ?? fs.readFileSync(path.join(repoRoot, relative)),
    );
    hash.update("\0");
  }
  return hash.digest("hex");
}

function read(relative) {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

function occurrences(text, fragment) {
  return text.split(fragment).length - 1;
}
