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
            installSources?: unknown;
            platforms?: unknown;
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
