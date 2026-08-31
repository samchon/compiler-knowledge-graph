import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";

/**
 * Core workflow actions stay on their maintained runtime generations.
 *
 * GitHub had begun forcing the former Node 20 actions onto Node 24, annotating
 * every test and experiment job. The release lane matters beyond the warning:
 * download-artifact v8 also makes an artifact digest mismatch fail closed, so
 * the exact tarballs verified before publication retain an enforced hand-off.
 *
 * Every workflow in the directory, not a list of three. The list was the three
 * that existed when this was written, and `index-time.yml` was then added on
 * `download-artifact@v7` without failing anything — a policy that only covers
 * the files it was born with is not a policy. Enumerating the directory means a
 * new workflow is held to it by existing, and the maintained majors are named
 * once instead of being counted per file.
 *
 * Reconciled with upstream by hand, and only by hand: the deterministic suite
 * may not reach the network, so nothing here can ask GitHub what the current
 * major is. The check that runs is workflow-against-map, which makes this map
 * an oracle only as good as the last time someone read the releases. Every
 * entry was checked when `cache` was added — and `cache` is why the caveat is
 * written down, because it was first added two majors behind from memory and
 * nothing caught it: an action absent from this map is an action nobody
 * watches.
 */
const MAINTAINED: Record<string, number> = {
  cache: 6,
  checkout: 7,
  "setup-go": 7,
  "setup-node": 7,
  "upload-artifact": 7,
  "download-artifact": 8,
};

/**
 * Nothing in the product suite reads a workflow, so what CI claims about
 * itself is unchecked here by default, and each way that goes wrong stays
 * green until the day it matters: a retired action major, a release lane that
 * publishes before it audits, a producer pin that drifts, a hang boundary
 * moved off the matrix job onto GitHub's six-hour default.
 *
 * This reads the workflow and release-script sources directly and holds them
 * to {@link MAINTAINED} and to the ordering and scoping each lane depends on.
 */
export const test_workflows_use_current_core_action_runtimes = () => {
  const directory = path.join(GraphPaths.repositoryRoot, ".github", "workflows");
  const files = fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();
  TestValidator.predicate(
    "the workflow directory is being read at all",
    files.length >= 4,
  );
  const stale: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(directory, file), "utf8");
    // Sub-actions count as their parent. `actions/cache/restore` ships from
    // the `actions/cache` repository and carries its major, so a pattern that
    // stopped at the first path segment would have watched `actions/cache@v6`
    // and silently ignored `actions/cache/restore@v6` — which is the form the
    // experiment workflow actually uses, and would have made this map's entry
    // for it dead on arrival.
    for (const match of text.matchAll(
      /uses:\s+actions\/([\w-]+)(?:\/[\w-]+)*@v(\d+)/g,
    )) {
      const maintained = MAINTAINED[match[1]!];
      if (maintained !== undefined && Number(match[2]) !== maintained)
        stale.push(`${file}: ${match[1]}@v${match[2]} (maintained: v${String(maintained)})`);
    }
  }
  TestValidator.equals(
    "every core action use names the maintained major",
    stale,
    [],
  );

  const release = fs.readFileSync(path.join(directory, "release.yml"), "utf8");
  TestValidator.equals(
    "release verification uploads both inspected tarballs together",
    occurrences(release, "name: tarballs"),
    3,
  );
  TestValidator.equals(
    "release verification selects only packed tarballs",
    occurrences(release, "path: .release/*.tgz"),
    1,
  );
  TestValidator.equals(
    "both publishers download the verified tarball artifact",
    occurrences(release, "uses: actions/download-artifact@v8"),
    2,
  );
  TestValidator.predicate(
    "exact local tarballs execute before their artifact can be uploaded",
    release.indexOf("node build/release-smoke.mjs") <
      release.indexOf("uses: actions/upload-artifact@v7"),
  );
  TestValidator.predicate(
    "a production advisory fails before either publication job",
    release.indexOf("pnpm audit --prod") <
      release.indexOf("publish-graph-sitter:"),
  );
  TestValidator.predicate(
    "the packaged Go source fallback uses a pinned workflow-local SCIP producer",
    release.includes(
      "go install github.com/scip-code/scip-go/cmd/scip-go@v0.2.7",
    ) &&
      release.includes("RELEASE_SCIP_GO:"),
  );
  const releaseJob = release.slice(release.indexOf("\n  release:"));
  TestValidator.predicate(
    "the release job installs its locked changelog tool before executing it",
    releaseJob.indexOf("pnpm install --frozen-lockfile") !== -1 &&
      releaseJob.indexOf("pnpm install --frozen-lockfile") <
        releaseJob.indexOf("pnpm exec changelogithub"),
  );

  for (const workflow of ["experiment.yml", "index-time.yml"]) {
    const text = fs.readFileSync(path.join(directory, workflow), "utf8");
    for (const input of [
      "config/**",
      "package.json",
      "packages/graph/**",
      "packages/graph-sitter/**",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "sidecars/**",
      "tests/experiment/**",
    ]) {
      TestValidator.predicate(
        `${workflow} triggers and classifies the runtime build input ${input}`,
        text.includes(`- "${input}"`) &&
          text.includes(`--include=${input}`),
      );
    }
  }
  const experiment = fs.readFileSync(
    path.join(directory, "experiment.yml"),
    "utf8",
  );
  // One boundary declaration for the whole matrix, and the exception set
  // written into it rather than left to a reader.
  //
  // This originally refused any per-language exception, and the reason it gave
  // was a cause: the lane that wanted more than ninety minutes wanted it
  // because its provider had been serialized, so raising the budget preserved
  // that cause instead of bounding it. The serialization was real and was
  // removed, and ninety still does not fit — the same build completed in 56
  // minutes on one runner and 107 on another in one workflow, with setup and a
  // real-corpus lifecycle run around it. C and C++ build a compiler from
  // source and the other fourteen rows install a released producer, so the
  // difference is a property of those two rows and not a defect inside them.
  //
  // Asserted as the exact expression. That is the same shape of assertion as
  // the single number it replaces, not a tighter one — what changed is the
  // policy, not the grip. The grip is what matters here: the ninety-minute
  // bound still governs every other row, and a third language cannot reach the
  // wider one, nor a fourth number appear, without editing this line and
  // answering for it.
  //
  // Scoped to the matrix job, not to the file. Counting `timeout-minutes:`
  // lines across the whole workflow passes just as well when the only one has
  // been moved up into the classification job — leaving all sixteen real-tool
  // lanes on GitHub's six-hour default, which is the unbounded state this
  // assertion exists to prevent.
  const experimentJob = experiment.slice(experiment.indexOf("\n  experiment:"));
  const experimentTimeouts = experimentJob
    .split("\n")
    .filter((line) => line.trim().startsWith("timeout-minutes:"))
    .map((line) => line.trim());
  TestValidator.equals(
    "one bound governs the matrix and only the compiler-building rows widen it",
    experimentTimeouts,
    [
      "timeout-minutes: ${{ (matrix.language == 'c' || matrix.language == 'cpp') && 150 || 90 }}",
    ],
  );
  // The wider bound is only defensible while an ordinary push does not reach
  // it, and that depends entirely on the restore below. Pinned per step rather
  // than as loose substrings over the job: four independent `includes` calls
  // are satisfied by four unrelated steps, which would let the key, the path
  // and the condition drift apart while the assertion stayed green.
  //
  // The key is pinned by its exact file list because that list is the whole
  // claim. `catalog.mjs` is where the commit is actually read from, so leaving
  // it out would bind the cache to the producer only by convention; the key
  // would then survive a bump, the restored binary would fail its version
  // check, the build would run in full, and — having hit an exact key — never
  // re-save. Permanent silent full-cost rebuilding, with the widened bound as
  // the normal path.
  const steps = experimentSteps(experimentJob);
  const restore = steps.find((step) =>
    step.body.includes("uses: actions/cache/restore@v6"),
  );
  const save = steps.find((step) =>
    step.body.includes("uses: actions/cache/save@v6"),
  );
  TestValidator.equals(
    "the producer is restored and saved around the build, on the same key",
    [
      restore?.body.includes("id: clang_producer"),
      restore?.body.includes("path: tests/experiment/.work/tools"),
      restore?.body.includes(
        "key: clang-producer-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('packages/graph/src/provider/cpp/CPP_CLANG_PRODUCER_COMMIT.ts', 'tests/experiment/src/catalog.mjs', 'tests/experiment/src/setup-language.mjs') }}",
      ),
      save?.body.includes("path: tests/experiment/.work/tools"),
      save?.body.includes(
        "key: ${{ steps.clang_producer.outputs.cache-primary-key }}",
      ),
      save?.body.includes("steps.clang_producer.outputs.cache-hit != 'true'"),
      [restore, save].every((step) =>
        step?.body.includes("(matrix.language == 'c' || matrix.language == 'cpp')"),
      ),
      // Order is the whole safety argument. Saving before the build writes an
      // empty tree under the exact primary key, which then restores as a hit
      // forever, fails `setup`'s version check, rebuilds, and never re-saves —
      // the same terminal state as saving under a key the restore cannot hit.
      // Saving after the corpus run instead loses a correct build to an
      // unrelated assertion.
      //
      // Relative, not absolute. The argument is about what comes before what,
      // so pinning positions would make an unrelated step inserted anywhere
      // above fail an assertion that has nothing to say about it.
      isStrictlyOrdered(
        [restore, "Install language server", save, "Run LSP experiment"].map(
          (entry) =>
            typeof entry === "string"
              ? steps.findIndex((step) => step.name === entry)
              : (entry?.index ?? -1),
        ),
      ),
    ],
    [true, true, true, true, true, true, true, true],
  );
  TestValidator.predicate(
    "the Rust experiment launches the exact binary provisioned by setup",
    experimentJob.includes(
      "SAMCHON_GRAPH_RUST_ANALYZER_HIR: ${{ github.workspace }}/tests/experiment/.work/tools/bin/samchon-rust-analyzer",
    ),
  );
  const indexTime = fs.readFileSync(
    path.join(directory, "index-time.yml"),
    "utf8",
  );
  // Every workflow that classifies its own synchronize boundary owes this.
  // Skipping is honest only when the head being skipped for already has
  // evidence: a relevant push followed, while it is still running, by an
  // irrelevant one publishes a green check on the second head having executed
  // nothing, and a reader merges on that green while the run that covered the
  // change is still open or already red. The experiment lane classified without
  // carrying forward and produced exactly that: a success on a head where the
  // matrix was skipped.
  //
  // Scoped to the classifying job, not to the file. The token and the read
  // permission belong to the step that queries the previous run; move either
  // one to a different job and the classifier throws, the outer catch turns
  // that into a warning, and it fails open to running the whole matrix on
  // every push — the failure nobody watches, because it is only ever reached
  // on the pushes that were supposed to be skipped.
  for (const [name, source] of [
    ["experiment.yml", experiment],
    ["index-time.yml", indexTime],
  ] as const) {
    const classify = classifyingJob(source, name);
    TestValidator.predicate(
      `a skipped ${name} update still requires its predecessor's verdict`,
      classify.includes(`--carry-forward-workflow=${name}`) &&
        classify.includes("GITHUB_TOKEN: ${{ github.token }}") &&
        classify.includes("actions: read"),
    );
  }

  const releasePack = fs.readFileSync(
    path.join(GraphPaths.repositoryRoot, "build", "release-pack.mjs"),
    "utf8",
  );
  const releasePublish = fs.readFileSync(
    path.join(GraphPaths.repositoryRoot, "build", "release-publish.mjs"),
    "utf8",
  );
  const releaseSmoke = fs.readFileSync(
    path.join(GraphPaths.repositoryRoot, "build", "release-smoke.mjs"),
    "utf8",
  );
  TestValidator.predicate(
    "archive inspection never passes an absolute drive path to tar",
    [releasePack, releasePublish].every(
      (script) =>
        script.includes("path.basename(tarball)") &&
        script.includes("cwd: path.dirname(tarball)"),
    ),
  );
  for (const surface of [
    "MCP handshake",
    "packaged viewer",
    "packaged Go source fallback",
    "graph-sitter tarballs",
  ]) {
    TestValidator.predicate(
      `the exact-artifact smoke proves ${surface}`,
      releaseSmoke.includes(surface),
    );
  }
};

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Whether every position was found and each one follows the last. */
function isStrictlyOrdered(positions: readonly number[]): boolean {
  return positions.every(
    (position, index) =>
      position >= 0 && (index === 0 || position > positions[index - 1]!),
  );
}

/**
 * The matrix job's steps, in order, with their comments removed.
 *
 * Two properties this file needs and cannot get from a substring search over
 * the whole job. Order, because the cache save has to happen after the step
 * that builds and before the step that can fail for unrelated reasons, and a
 * job-wide `indexOf` cannot tell those apart from a save at the top. And
 * comment removal, because this workflow explains itself at length: every
 * string these assertions look for also appears in prose a few lines above the
 * step that implements it, so an `includes` over raw text is satisfied by the
 * explanation of a step that was deleted.
 */
function experimentSteps(
  job: string,
): { name: string; body: string; index: number }[] {
  return job
    .split(/\n      - name: /u)
    .slice(1)
    .map((chunk, index) => {
      const body = chunk
        .split("\n")
        .filter((line) => !/^\s*#/u.test(line))
        .join("\n");
      return {
        name: body.split("\n", 1)[0]!.trim(),
        body,
        index,
      };
    });
}

/**
 * The `latest_update` job alone, so an assertion about it cannot be satisfied
 * by the same text sitting in a different job.
 *
 * Bounded at the next top-level job key rather than at a named one, because the
 * job that follows it differs between these two workflows and naming it would
 * make the helper wrong for one of them the moment either is renamed.
 *
 * Both line endings, and not as a courtesy. A Windows checkout hands these
 * files back with CRLF while the repository stores LF, so a literal newline
 * match here would pass on the runner and fail on the author's machine — a
 * scoping helper that silently stops scoping on one of the two platforms it is
 * read on.
 */
function classifyingJob(source: string, workflow: string): string {
  const start = /\r?\n {2}latest_update:\r?\n/.exec(source);
  if (start === null) {
    throw new Error(
      `@samchon/graph-test: ${workflow} has no latest_update job to scope to`,
    );
  }
  const rest = source.slice(start.index + start[0].indexOf("l"));
  const next = /\r?\n {2}[a-z_]+:\r?\n/.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}
