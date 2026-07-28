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
 */
const MAINTAINED: Record<string, number> = {
  checkout: 7,
  "setup-go": 7,
  "setup-node": 7,
  "upload-artifact": 7,
  "download-artifact": 8,
};

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
    for (const match of text.matchAll(
      /uses:\s+actions\/([\w-]+)@v(\d+)/g,
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
  const indexTime = fs.readFileSync(
    path.join(directory, "index-time.yml"),
    "utf8",
  );
  TestValidator.predicate(
    "a result-only index update runs when its predecessor has no verdict",
    indexTime.includes("--carry-forward-workflow=index-time.yml") &&
      indexTime.includes("GITHUB_TOKEN: ${{ github.token }}"),
  );

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
