import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";

/** Real-language experiments always check out one reviewable corpus revision. */
export const test_experiment_corpora_are_commit_pinned = () => {
  const catalog = experimentSource("catalog.mjs");
  const helpers = experimentSource("process.mjs");
  const lifecycle = experimentSource("strict-lifecycle.mjs");
  const runner = experimentSource("run-language.mjs");
  const setup = experimentSource("setup-language.mjs");

  const repositories = [...catalog.matchAll(/repository:\s*"[^"]+"/g)];
  const commits = [...catalog.matchAll(/commit:\s*"([0-9a-f]{40})"/g)];
  TestValidator.equals(
    "every real-language corpus has one exact Git commit",
    commits.length,
    repositories.length,
  );
  TestValidator.equals(
    "every strict corpus declares an isolated lifecycle fixture",
    [...catalog.matchAll(/strictProvider:\s*"[^"]+"/g)].length,
    [...catalog.matchAll(/lifecycle:\s*\{/g)].length,
  );
  const python = region(catalog, 'language: "python"', 'language: "ruby"');
  TestValidator.predicate(
    "the dynamic SCIP smoke proves a versioned Python lifecycle, not an edge count",
    python.includes('strictProvider: "scip-python"') &&
      python.includes('strictAuthority: "semantic-index"') &&
      python.includes('semanticEdges: ["references"]') &&
      !python.includes("minEdges"),
  );
  // A family the producer cannot emit at all is different from one this corpus
  // happens not to contain, and only the first is a limitation worth publishing.
  // `contains` is the first for scip-python, so the row has to say so.
  TestValidator.predicate(
    "a family the pinned producer cannot emit is published as a limitation",
    /semanticLimitation:\s*"?[^",]/.test(python) &&
      python.includes("enclosing_symbol") &&
      runner.includes("semanticLimitation: experiment.semanticLimitation"),
  );
  // scip-python 0.6.6 recovers from a malformed `pyproject.toml` and emits no
  // SCIP diagnostics, so a row claiming either boundary would assert behaviour
  // the pinned producer does not have. A tolerated row earns its place only by
  // proving the exact upstream claim instead — the producer ignored the input,
  // so the build universe moved and the published facts did not — and by saying
  // what it gave up rather than leaving a reader to infer it from a green lane.
  TestValidator.predicate(
    "a failure boundary the producer does not have is published as a limitation",
    python.includes('failurePolicy: "tolerated"') &&
      /failureLimitation:\s*"?[^",]/.test(python) &&
      lifecycle.includes('fixture.failurePolicy === "tolerated"') &&
      lifecycle.includes('fixture.failureLimitation === ""') &&
      lifecycle.includes("provenance.universe === prior.universe") &&
      lifecycle.includes("provenance.content !== prior.content") &&
      lifecycle.includes("diagnosticCount !== previousDiagnostics"),
  );

  TestValidator.predicate(
    "the clone helper fetches and detaches the pinned revision",
    helpers.includes('["fetch", "--depth=1", "origin", experiment.commit]') &&
      helpers.includes('["checkout", "--detach", experiment.commit]'),
  );
  TestValidator.predicate(
    "strict edits happen only in a copied external workspace",
    lifecycle.includes('isolateCorpus(experiment, pinnedRoot, "lifecycle")') &&
      lifecycle.includes("path.join(lifecycleRoot, fixture.sourceFile)"),
  );

  // A package manager run inside the clone writes locks, caches, and build
  // state, and the result still reports the pristine commit it no longer has.
  // Both lanes therefore prepare a copy, and the clone is re-proved afterwards.
  TestValidator.predicate(
    "every lane prepares a copy and re-proves the pinned clone afterwards",
    runner.includes('isolateCorpus(experiment, pinned, "prepared")') &&
      runner.includes("assertPinnedCorpus(experiment, pinned)") &&
      !runner.includes("shell(experiment.prepare, { cwd: pinned })") &&
      helpers.includes('["status", "--porcelain", "--ignored"]'),
  );
  // A default would let a row inherit a claim it never made, which is how a row
  // came to require a cross-file `calls` edge from a provider registered to
  // prove none.
  TestValidator.predicate(
    "a strict row states its own authority, tool, capabilities, and families",
    [
      "strictAuthority",
      "strictTool",
      "requiredCapabilities",
      "semanticEdges",
      "crossFileEdge",
    ].every((field) => runner.includes(`"${field}",`)) &&
      runner.includes("a strict row must state its expected") &&
      !runner.includes('experiment.strictAuthority ?? "compiler"') &&
      !runner.includes("experiment.strictTool ?? experiment.strictProvider"),
  );
  TestValidator.predicate(
    "the runner proves declared families are present and undeclared ones absent",
    runner.includes("provenance.facts.includes(kind)") &&
      runner.includes("provenance.facts.includes(crossFileEdge)") &&
      runner.includes("tools: toolManifest(experiment.language)"),
  );

  // A digest over the root archive proves nothing while installation still
  // resolves that archive's dependency ranges against whatever the registry
  // serves that hour. Extracting the verified bytes is what makes the toolchain
  // the same one the next run gets, and running it once is what proves the
  // extraction was enough.
  const installPython = region(
    setup,
    "const installScipPython",
    "const findFile",
  );
  TestValidator.predicate(
    "the Python indexer and decoder are exact campaign-owned tools",
    installPython.includes("scip-python-0.6.6.tgz") &&
      installPython.includes(
        "qoKL1Rggg0o5newAFbCFAKlS0AjWxG5MA+mC28BtgxOv0DhO4zdL8u7151FxEppDpXMVvm7+yXSjXotoVH9cMQ==",
      ) &&
      installPython.includes('run("tar"') &&
      installPython.includes('run(link, ["--version"])') &&
      !installPython.includes('run("npm"') &&
      setup.includes("await installScipPython();") &&
      setup.includes("await installScip();") &&
      !setup.includes("npm install -g pyright"),
  );
};

function experimentSource(file: string): string {
  return fs.readFileSync(
    path.join(GraphPaths.repositoryRoot, "tests", "experiment", "src", file),
    "utf8",
  );
}

/**
 * A slice that fails loudly instead of silently widening.
 *
 * `String.slice` treats a missing marker's `-1` as an offset from the end, so a
 * renamed function would leave every assertion below reading the whole file and
 * still passing — the scoping the caller asked for, gone with no failure.
 */
function region(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `@samchon/graph-test: the experiment region between ${from} and ${to} moved`,
    );
  }
  return source.slice(start, end);
}
