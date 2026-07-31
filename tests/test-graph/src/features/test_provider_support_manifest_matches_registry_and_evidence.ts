import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { GraphPaths } from "../internal/GraphPaths";

export const test_provider_support_manifest_matches_registry_and_evidence =
  () => {
    const root = GraphPaths.createTempDirectory(
      "samchon-graph-provider-support-",
    );
    const canonical = path.join(
      GraphPaths.repositoryRoot,
      "docs",
      "provider-support.json",
    );
    try {
      TestValidator.equals(
        "the canonical support manifest matches registry, experiments and benchmark evidence",
        validate(canonical, root),
        { status: 0, stderr: "" },
      );

      const parsed = JSON.parse(fs.readFileSync(canonical, "utf8")) as {
        providers: Array<
          Record<string, unknown> & {
            commands?: unknown;
            installSources?: unknown;
            platforms?: unknown;
            projectCommandSources?: unknown;
          }
        >;
      };
      const missing = structuredClone(parsed);
      missing.providers.shift();
      const missingFile = path.join(root, "missing-provider.json");
      fs.writeFileSync(missingFile, JSON.stringify(missing));
      TestValidator.predicate(
        "an undocumented registered provider fails closed",
        validate(missingFile, root).stderr.includes(
          "undocumented registered provider ttscgraph",
        ),
      );

      const absent = structuredClone(parsed);
      absent.providers.push({
        ...absent.providers[0],
        provider: "absent-provider",
        languages: ["absent-language"],
      });
      const absentFile = path.join(root, "absent-provider.json");
      fs.writeFileSync(absentFile, JSON.stringify(absent));
      TestValidator.predicate(
        "a documented absent provider fails closed",
        validate(absentFile, root).stderr.includes(
          "documented absent provider absent-provider",
        ),
      );

      const misspelledPlatform = structuredClone(parsed);
      misspelledPlatform.providers[0]!.platforms = ["linxu"];
      const misspelledPlatformFile = path.join(
        root,
        "misspelled-platform.json",
      );
      fs.writeFileSync(
        misspelledPlatformFile,
        JSON.stringify(misspelledPlatform),
      );
      TestValidator.predicate(
        "an unknown platform fails closed",
        validate(misspelledPlatformFile, root).stderr.includes(
          "ttscgraph names unknown platform linxu",
        ),
      );

      const duplicatePlatform = structuredClone(parsed);
      duplicatePlatform.providers[0]!.platforms = ["linux", "linux"];
      const duplicatePlatformFile = path.join(
        root,
        "duplicate-platform.json",
      );
      fs.writeFileSync(
        duplicatePlatformFile,
        JSON.stringify(duplicatePlatform),
      );
      TestValidator.predicate(
        "a duplicate platform fails closed",
        validate(duplicatePlatformFile, root).stderr.includes(
          "ttscgraph platform rows must be unique",
        ),
      );

      const duplicateCommand = structuredClone(parsed);
      duplicateCommand.providers[0]!.commands = ["ttscgraph", "ttscgraph"];
      const duplicateCommandFile = path.join(root, "duplicate-command.json");
      fs.writeFileSync(
        duplicateCommandFile,
        JSON.stringify(duplicateCommand),
      );
      TestValidator.predicate(
        "a duplicate fixed command fails closed",
        validate(duplicateCommandFile, root).stderr.includes(
          "ttscgraph command rows must be unique",
        ),
      );

      const incompleteProjectCommands = structuredClone(parsed);
      const clang = incompleteProjectCommands.providers.find(
        (provider) => provider.provider === "scip-clang",
      );
      if (clang === undefined)
        throw new Error("the canonical manifest must contain scip-clang");
      clang.projectCommandSources = ["compile_commands.json"];
      const incompleteProjectCommandsFile = path.join(
        root,
        "incomplete-project-command-sources.json",
      );
      fs.writeFileSync(
        incompleteProjectCommandsFile,
        JSON.stringify(incompleteProjectCommands),
      );
      TestValidator.predicate(
        "an omitted project-owned command source fails closed",
        validate(incompleteProjectCommandsFile, root).stderr.includes(
          "scip-clang project command sources differ from its resolver descriptor",
        ),
      );

      const missingInstallSource = structuredClone(parsed);
      missingInstallSource.providers[0]!.installSources = [];
      const missingInstallSourceFile = path.join(
        root,
        "missing-install-source.json",
      );
      fs.writeFileSync(
        missingInstallSourceFile,
        JSON.stringify(missingInstallSource),
      );
      TestValidator.predicate(
        "a missing install source fails closed",
        validate(missingInstallSourceFile, root).stderr.includes(
          "ttscgraph must name install sources",
        ),
      );

      const duplicateInstallLabel = structuredClone(parsed);
      duplicateInstallLabel.providers[0]!.installSources = [
        { label: "same", url: "https://example.com/one" },
        { label: "same", url: "https://example.com/two" },
      ];
      const duplicateInstallLabelFile = path.join(
        root,
        "duplicate-install-label.json",
      );
      fs.writeFileSync(
        duplicateInstallLabelFile,
        JSON.stringify(duplicateInstallLabel),
      );
      TestValidator.predicate(
        "a duplicate install-source label fails closed",
        validate(duplicateInstallLabelFile, root).stderr.includes(
          "ttscgraph install-source label rows must be unique",
        ),
      );

      const duplicateInstallUrl = structuredClone(parsed);
      duplicateInstallUrl.providers[0]!.installSources = [
        { label: "one", url: "https://example.com/same" },
        { label: "two", url: "https://example.com/same" },
      ];
      const duplicateInstallUrlFile = path.join(
        root,
        "duplicate-install-url.json",
      );
      fs.writeFileSync(
        duplicateInstallUrlFile,
        JSON.stringify(duplicateInstallUrl),
      );
      TestValidator.predicate(
        "a duplicate install-source URL fails closed",
        validate(duplicateInstallUrlFile, root).stderr.includes(
          "ttscgraph install-source URL rows must be unique",
        ),
      );

      const unsafeInstallSource = structuredClone(parsed);
      unsafeInstallSource.providers[0]!.installSources = [
        { label: "unsafe source", url: "http://example.com/package" },
      ];
      const unsafeInstallSourceFile = path.join(
        root,
        "unsafe-install-source.json",
      );
      fs.writeFileSync(
        unsafeInstallSourceFile,
        JSON.stringify(unsafeInstallSource),
      );
      TestValidator.predicate(
        "a non-HTTPS install source fails closed",
        validate(unsafeInstallSourceFile, root).stderr.includes(
          "ttscgraph install source unsafe source must be an HTTPS URL",
        ),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

function validate(
  manifest: string,
  coverageRoot: string,
): {
  status: number | null;
  stderr: string;
} {
  const script = path.join(
    GraphPaths.graphPackageRoot,
    "build",
    "provider-support.mjs",
  );
  const result = spawnSync(
    process.execPath,
    [script, "--validate-only", `--manifest=${manifest}`],
    {
      cwd: GraphPaths.repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_V8_COVERAGE: path.join(coverageRoot, "child-coverage"),
      },
      windowsHide: true,
    },
  );
  return {
    status: result.status,
    stderr: result.stderr,
  };
}
