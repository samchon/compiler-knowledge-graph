import { TestValidator } from "@nestia/e2e";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { commitProjectInputGeneration } from "../../../../packages/graph/src/indexer/commitProjectInputGeneration";
import type { IIndexerResult } from "../../../../packages/graph/src/indexer/IIndexerResult";
import { movedConsumedSource } from "../../../../packages/graph/src/indexer/movedConsumedSource";
import { movedProviderSource } from "../../../../packages/graph/src/indexer/movedProviderSource";
import { projectInputGeneration } from "../../../../packages/graph/src/indexer/projectInputGeneration";
import { projectInputManifest } from "../../../../packages/graph/src/indexer/projectInputManifest";
import { providerBuildInputs } from "../../../../packages/graph/src/indexer/providerBuildInputs";
import { sameProjectInputManifest } from "../../../../packages/graph/src/indexer/sameProjectInputManifest";
import { dumpProvenanceOf } from "../../../../packages/graph/src/provider/dumpProvenanceOf";
import { GraphPaths } from "../internal/GraphPaths";
import { ProviderFixtures } from "../internal/ProviderFixtures";

export const test_project_input_generation_fences_every_owned_input =
  async () => {
    const root = GraphPaths.createTempDirectory("samchon-graph-input-commit-");
    const first = path.join(root, "first.ts");
    const second = path.join(root, "second.ts");
    const go = path.join(root, "main.go");
    const missing = path.join(root, "missing.generated");
    fs.writeFileSync(first, "export const first = 1;\n");
    fs.writeFileSync(second, "export const second = 2;\n");
    fs.writeFileSync(go, "package main\n");

    const external = GraphPaths.createTempDirectory(
      "samchon-graph-provider-source-helper-",
    );
    const externalFile = path.join(external, "shared.ts");
    const externalBody = Buffer.from("export const shared = 1;\n");
    fs.writeFileSync(externalFile, externalBody);
    const externalDigest = digest(externalBody);
    TestValidator.equals(
      "an absent provider manifest has no movement",
      movedProviderSource(undefined, new Map(), new Map()),
      undefined,
    );
    TestValidator.equals(
      "a bundled provider source needs no disk identity",
      movedProviderSource(
        new Map([
          [
            "bundled:///typescript/lib",
            { checkerDigest: externalDigest, diskDigest: "" },
          ],
        ]),
        new Map(),
        new Map(),
      ),
      undefined,
    );
    TestValidator.equals(
      "an unchanged external provider source remains bound",
      movedProviderSource(
        new Map([
          [
            externalFile,
            {
              checkerDigest: externalDigest,
              diskDigest: externalDigest,
            },
          ],
        ]),
        new Map(),
        new Map(),
      ),
      undefined,
    );
    TestValidator.predicate(
      "a relative provider source cannot escape the common identity contract",
      movedProviderSource(
        new Map([
          [
            "relative.ts",
            {
              checkerDigest: externalDigest,
              diskDigest: externalDigest,
            },
          ],
        ]),
        new Map(),
        new Map(),
      )?.includes("does not bind") === true,
    );
    // A tracked input the provider hashed the checker's text for and never
    // hashed on disk. It is the one shape a reader cannot act on at all: the
    // facts claim to describe that file, and nothing ties them to bytes the
    // reader can hash for itself. The refusal has to say which of the four
    // ways a source comes unbound this is, because each one is a defect in a
    // different place.
    TestValidator.predicate(
      "a tracked provider source without a disk digest is unbound",
      movedProviderSource(
        new Map([
          [
            externalFile,
            { checkerDigest: externalDigest, diskDigest: "" },
          ],
        ]),
        new Map([[externalFile, externalDigest]]),
        new Map([[externalFile, externalDigest]]),
      )?.includes("published no on-disk digest") === true,
    );
    TestValidator.predicate(
      "a missing external provider source cannot retain an old digest",
      movedProviderSource(
        new Map([
          [
            path.join(external, "missing.ts"),
            {
              checkerDigest: externalDigest,
              diskDigest: externalDigest,
            },
          ],
        ]),
        new Map(),
        new Map(),
      )?.includes("does not bind") === true,
    );

    const typescript = ProviderFixtures.provider({
      name: "typescript-owner",
      languages: ["typescript"],
      buildInputs: ["first.ts", "shared.generated"],
    });
    const goProvider = ProviderFixtures.provider({
      name: "go-owner",
      languages: ["go"],
      buildInputs: ["shared.generated", "go.generated"],
    });
    const unrelated = ProviderFixtures.provider({
      name: "unrelated",
      languages: ["rust"],
      buildInputs: ["rust.generated"],
    });
    const providers = [typescript, goProvider, unrelated];
    const dynamic = ProviderFixtures.provider({
      name: "dynamic-owner",
      languages: ["go"],
      buildInputs: (projectRoot) => [
        path.relative(projectRoot, path.join(root, "nested", "go.mod")),
      ],
    });

    TestValidator.equals(
      "only participating provider inputs are deduplicated and sorted",
      providerBuildInputs(["typescript", "go"], providers, root)
        .filter((input) =>
          ["first.ts", "go.generated", "shared.generated"].includes(input),
        ),
      ["first.ts", "go.generated", "shared.generated"],
    );
    TestValidator.equals(
      "a provider with no declared build inputs contributes none",
      providerBuildInputs(
        ["typescript"],
        [ProviderFixtures.provider({ name: "source-only" })],
        root,
      ),
      providerBuildInputs(["typescript"], [], root),
    );
    TestValidator.predicate(
      "dynamic build inputs receive the project root and join the common registry",
      providerBuildInputs(["go"], [dynamic], root).includes("nested/go.mod"),
    );

    const dartRoot = GraphPaths.createTempDirectory(
      "samchon-graph-dart-package-input-",
    );
    fs.writeFileSync(path.join(dartRoot, "pubspec.yaml"), "name: fixture\n");
    fs.writeFileSync(path.join(dartRoot, "main.dart"), "void main() {}\n");
    const packageConfig = path.join(
      dartRoot,
      ".dart_tool",
      "package_config.json",
    );
    TestValidator.predicate(
      "a missing generated Dart package config is already a build input",
      providerBuildInputs(["dart"], [], dartRoot).includes(
        ".dart_tool/package_config.json",
      ),
    );
    let dartAttempts = 0;
    const dartCommitted = await commitProjectInputGeneration(
      { cwd: dartRoot, languages: ["dart"] },
      [],
      () => {
        dartAttempts += 1;
        if (!fs.existsSync(packageConfig)) {
          fs.mkdirSync(path.dirname(packageConfig), { recursive: true });
          fs.writeFileSync(packageConfig, '{"configVersion":2}\n');
        }
        return resultOf(dartRoot);
      },
    );
    TestValidator.equals(
      "creating package_config.json during preparation retries the generation",
      [
        dartAttempts,
        dartCommitted.buildInputs?.includes(
          ".dart_tool/package_config.json",
        ),
        dartCommitted.inputManifest?.get(packageConfig) === "missing",
      ],
      [2, true, false],
    );

    const bomRoot = GraphPaths.createTempDirectory(
      "samchon-graph-bom-input-commit-",
    );
    const bomSource = path.join(bomRoot, "Program.cs");
    const bomBody = "internal static class Program {}\n";
    fs.writeFileSync(bomSource, `\uFEFF${bomBody}`);
    let bomAttempts = 0;
    await commitProjectInputGeneration(
      { cwd: bomRoot, languages: ["csharp"] },
      [],
      () => {
        bomAttempts += 1;
        return {
          ...resultOf(bomRoot),
          sources: new Map([[bomSource, bomBody]]),
        };
      },
    );
    TestValidator.equals(
      "the coordinator's leading-BOM transport transform commits once",
      bomAttempts,
      1,
    );

    const addedBomRoot = GraphPaths.createTempDirectory(
      "samchon-graph-added-bom-input-commit-",
    );
    const addedBomSource = path.join(addedBomRoot, "Program.cs");
    fs.writeFileSync(addedBomSource, bomBody);
    let addedBomAttempts = 0;
    await commitProjectInputGeneration(
      { cwd: addedBomRoot, languages: ["csharp"] },
      [],
      () => {
        addedBomAttempts += 1;
        if (addedBomAttempts === 1)
          fs.writeFileSync(addedBomSource, `\uFEFF${bomBody}`);
        return {
          ...resultOf(addedBomRoot),
          sources: new Map([[addedBomSource, bomBody]]),
        };
      },
    );
    TestValidator.equals(
      "a BOM added during consumption still moves the raw input generation",
      addedBomAttempts,
      2,
    );

    const manifest = projectInputManifest(
      root,
      { languages: ["typescript", "go"] },
      ["first.ts", "missing.generated"],
    );
    TestValidator.equals(
      "provider-owned source contents are coordinator-fenced too",
      manifest.get(second) !== undefined &&
        manifest.get(second) !== "missing",
      true,
    );
    TestValidator.predicate(
      "a declared input overrides source opacity and is hashed",
      manifest.get(first) !== undefined &&
        manifest.get(first) !== "provider-owned" &&
        manifest.get(first) !== "missing",
    );
    TestValidator.predicate(
      "ordinary source contents are hashed",
      manifest.get(go) !== undefined &&
        manifest.get(go) !== "provider-owned" &&
        manifest.get(go) !== "missing",
    );
    TestValidator.equals(
      "a missing declared input remains part of the manifest",
      manifest.get(missing),
      "missing",
    );
    const defaultManifest = projectInputManifest(
      root,
      { languages: ["typescript"] },
      [],
    );
    TestValidator.predicate(
      "the default manifest hashes selected source contents",
      defaultManifest.get(first) !== "provider-owned",
    );
    TestValidator.predicate(
      "equal manifests compare equal",
      sameProjectInputManifest(manifest, new Map(manifest)),
    );
    const changedManifest = new Map(manifest);
    changedManifest.set(second, "different");
    TestValidator.predicate(
      "different manifest values compare unequal",
      !sameProjectInputManifest(manifest, changedManifest),
    );
    TestValidator.predicate(
      "different manifest sizes compare unequal",
      !sameProjectInputManifest(manifest, new Map()),
    );

    const consumedSources = new Map([
      [first, fs.readFileSync(first, "utf8")],
      [go, fs.readFileSync(go, "utf8")],
    ]);
    const providerSources = new Map([
      [
        second,
        {
          checkerDigest: manifest.get(second)!,
          diskDigest: manifest.get(second)!,
        },
      ],
    ]);
    const providerSnapshot = ProviderFixtures.snapshot({
      root,
      provider: "typescript-owner",
      sources: providerSources,
    });
    const provenance = [dumpProvenanceOf(providerSnapshot)];
    const generation = projectInputGeneration({
      sourceFiles: [first, second, go],
      buildInputFiles: [missing],
      manifest,
      consumedSources,
      providerSources,
      provenance,
    });
    TestValidator.predicate(
      "one coordinator token names the complete input generation",
      /^[a-f0-9]{64}$/.test(generation),
    );
    TestValidator.equals(
      "collection and map insertion order cannot move the generation token",
      projectInputGeneration({
        sourceFiles: [go, second, first],
        buildInputFiles: [missing],
        manifest: new Map([...manifest].reverse()),
        consumedSources: new Map([...consumedSources].reverse()),
        providerSources: new Map([...providerSources].reverse()),
        provenance: [...provenance].reverse(),
      }),
      generation,
    );
    TestValidator.notEquals(
      "a provider checker generation is part of the coordinator token",
      projectInputGeneration({
        sourceFiles: [first, second, go],
        buildInputFiles: [missing],
        manifest,
        consumedSources,
        providerSources: new Map([
          [
            second,
            {
              checkerDigest: "a".repeat(64),
              diskDigest: manifest.get(second)!,
            },
          ],
        ]),
        provenance,
      }),
      generation,
    );
    TestValidator.notEquals(
      "a provider build universe is part of the coordinator token",
      projectInputGeneration({
        sourceFiles: [first, second, go],
        buildInputFiles: [missing],
        manifest,
        consumedSources,
        providerSources,
        provenance: [
          {
            ...provenance[0]!,
            universe: "b".repeat(64),
          },
        ],
      }),
      generation,
    );
    TestValidator.notEquals(
      "generic bytes are bound independently of their file name",
      projectInputGeneration({
        sourceFiles: [first, second, go],
        buildInputFiles: [missing],
        manifest,
        consumedSources: new Map([
          [first, `${consumedSources.get(first)!}// different\n`],
          [go, consumedSources.get(go)!],
        ]),
        providerSources,
        provenance,
      }),
      generation,
    );
    TestValidator.notEquals(
      "source-set and build-input roles are not collapsed into one path list",
      projectInputGeneration({
        sourceFiles: [first, second, go, missing],
        buildInputFiles: [],
        manifest,
        consumedSources,
        providerSources,
        provenance,
      }),
      generation,
    );
    TestValidator.notEquals(
      "length-prefixed fields cannot absorb an adjacent path",
      projectInputGeneration({
        sourceFiles: ["a", "bc"],
        buildInputFiles: [],
        manifest: new Map(),
      }),
      projectInputGeneration({
        sourceFiles: ["ab", "c"],
        buildInputFiles: [],
        manifest: new Map(),
      }),
    );

    const consumed = fs.readFileSync(first, "utf8");
    TestValidator.equals(
      "an unchanged consumed source does not move",
      movedConsumedSource(new Map([[first, consumed]])),
      undefined,
    );
    fs.writeFileSync(first, `${consumed}// moved\n`);
    TestValidator.equals(
      "the first changed consumed source is named",
      movedConsumedSource(new Map([[first, consumed]]))?.file,
      first,
    );
    fs.writeFileSync(first, consumed);
    TestValidator.equals(
      "consumed bytes must also match the coordinator's final manifest",
      movedConsumedSource(
        new Map([[first, consumed]]),
        new Map([[first, digest(Buffer.from(`${consumed}// other\n`))]]),
      )?.file,
      first,
    );
    const removed = path.join(root, "removed.ts");
    TestValidator.equals(
      "a consumed source removed before the final fence is named",
      movedConsumedSource(new Map([[removed, "export const gone = true;\n"]]))
        ?.file,
      removed,
    );
    assertMovementSaysHowTheTextsDiffer(root);

    const committed = await commitProjectInputGeneration(
      { cwd: root, languages: ["typescript", "go"] },
      providers,
      () => ({
        ...resultOf(root),
        sources: new Map([
          [first, consumed],
          [second, fs.readFileSync(second, "utf8")],
          [go, fs.readFileSync(go, "utf8")],
        ]),
      }),
    );
    TestValidator.equals(
      "the coordinator no longer excludes provider-owned languages",
      committed.inputManifestLanguages,
      [],
    );
    TestValidator.equals(
      "a stable generation retains the selected providers' build inputs",
      committed.buildInputs,
      providerBuildInputs(["typescript", "go"], providers, root),
    );
    TestValidator.predicate(
      "a stable build publishes its complete coordinator generation token",
      committed.inputGeneration !== undefined &&
        /^[a-f0-9]{64}$/.test(committed.inputGeneration),
    );
    const repeated = await commitProjectInputGeneration(
      { cwd: root, languages: ["typescript", "go"] },
      providers,
      () => ({
        ...resultOf(root),
        sources: new Map([
          [first, consumed],
          [second, fs.readFileSync(second, "utf8")],
          [go, fs.readFileSync(go, "utf8")],
        ]),
      }),
    );
    TestValidator.equals(
      "an unchanged project reproduces the same generation token",
      repeated.inputGeneration,
      committed.inputGeneration,
    );
    let claimsSourceAsBuildInput = false;
    let identityAttempts = 0;
    const movingIdentity = ProviderFixtures.provider({
      name: "moving-input-identity",
      languages: ["typescript"],
      buildInputs: () => (claimsSourceAsBuildInput ? ["first.ts"] : []),
    });
    await commitProjectInputGeneration(
      { cwd: root, languages: ["typescript"] },
      [movingIdentity],
      () => {
        identityAttempts += 1;
        claimsSourceAsBuildInput = true;
        return {
          ...resultOf(root),
          sources: new Map([[first, fs.readFileSync(first, "utf8")]]),
        };
      },
    );
    TestValidator.equals(
      "a build-input role change retries even when its file was already a source",
      identityAttempts,
      2,
    );

    const cleanupRoot = GraphPaths.createTempDirectory(
      "samchon-graph-input-cleanup-",
    );
    const cleanupFile = path.join(cleanupRoot, "index.ts");
    fs.writeFileSync(cleanupFile, "export const value = 1;\n");
    const closeError = new Error("candidate close failed");
    let cleanupFailure: unknown;
    try {
      await commitProjectInputGeneration(
        { cwd: cleanupRoot, languages: ["typescript"] },
        [],
        () => {
          fs.writeFileSync(cleanupFile, "export const value = 2;\n");
          return resultOf(cleanupRoot);
        },
        async () => [closeError],
      );
    } catch (error) {
      cleanupFailure = error;
    }
    TestValidator.predicate(
      "a stale candidate's cleanup failure is retained",
      cleanupFailure instanceof AggregateError &&
        cleanupFailure.errors[0] === closeError,
    );

    const invalidAfterRoot = GraphPaths.createTempDirectory(
      "samchon-graph-input-invalid-after-",
    );
    fs.writeFileSync(
      path.join(invalidAfterRoot, "index.ts"),
      "export const value = 1;\n",
    );
    let invalidAfterBuild = false;
    let invalidAfterDiscards = 0;
    let invalidAfterFailure: unknown;
    try {
      await commitProjectInputGeneration(
        { cwd: invalidAfterRoot, languages: ["typescript"] },
        [
          ProviderFixtures.provider({
            buildInputs: () =>
              invalidAfterBuild ? ["../escaped.generated"] : [],
          }),
        ],
        () => {
          invalidAfterBuild = true;
          return resultOf(invalidAfterRoot);
        },
        async () => {
          invalidAfterDiscards += 1;
          return [];
        },
      );
    } catch (error) {
      invalidAfterFailure = error;
    }
    TestValidator.predicate(
      "post-build validation failure retires the unpublished candidate",
      invalidAfterDiscards === 1 &&
        invalidAfterFailure instanceof Error &&
        invalidAfterFailure.message.includes(
          "build input must be project-relative",
        ),
    );
    let nonErrorAfterBuild = false;
    let nonErrorDiscards = 0;
    let nonErrorFailure: unknown;
    try {
      await commitProjectInputGeneration(
        { cwd: invalidAfterRoot, languages: ["typescript"] },
        [
          ProviderFixtures.provider({
            buildInputs: () => {
              if (nonErrorAfterBuild) throw "non-error validation failure";
              return [];
            },
          }),
        ],
        () => {
          nonErrorAfterBuild = true;
          return resultOf(invalidAfterRoot);
        },
        async () => {
          nonErrorDiscards += 1;
          return [];
        },
      );
    } catch (error) {
      nonErrorFailure = error;
    }
    TestValidator.predicate(
      "non-Error validation failures still retire the unpublished candidate",
      nonErrorDiscards === 1 &&
        nonErrorFailure === "non-error validation failure",
    );

    const restlessRoot = GraphPaths.createTempDirectory(
      "samchon-graph-input-restless-",
    );
    const restlessFile = path.join(restlessRoot, "index.ts");
    fs.writeFileSync(restlessFile, "export const value = 0;\n");
    let attempts = 0;
    let exhaustion: unknown;
    try {
      await commitProjectInputGeneration(
        { cwd: restlessRoot, languages: ["typescript"] },
        [],
        () => {
          attempts += 1;
          fs.writeFileSync(
            restlessFile,
            `export const value = ${String(attempts)};\n`,
          );
          return resultOf(restlessRoot);
        },
      );
    } catch (error) {
      exhaustion = error;
    }
    TestValidator.predicate(
      "a project that moves through all bounded attempts publishes nothing",
      attempts === 3 &&
        exhaustion instanceof Error &&
        exhaustion.message.includes("all 3 bounded attempts"),
    );

    const unboundRoot = GraphPaths.createTempDirectory(
      "samchon-graph-provider-digest-",
    );
    const unboundFile = path.join(unboundRoot, "index.ts");
    fs.writeFileSync(unboundFile, "export const value = 1;\n");
    let unboundAttempts = 0;
    let unboundFailure: unknown;
    try {
      await commitProjectInputGeneration(
        { cwd: unboundRoot, languages: ["typescript"] },
        [],
        () => {
          unboundAttempts += 1;
          return {
            ...resultOf(unboundRoot),
            providerSourceDigests: new Map([
              [
                unboundFile,
                {
                  checkerDigest: "a".repeat(64),
                  diskDigest: "b".repeat(64),
                },
              ],
            ]),
          };
        },
      );
    } catch (error) {
      unboundFailure = error;
    }
    TestValidator.predicate(
      "a provider digest outside the coordinator generation never publishes",
      unboundAttempts === 3 &&
        unboundFailure instanceof Error &&
        unboundFailure.message.includes("does not bind the provider snapshot"),
    );

    const siblingRoot = GraphPaths.createTempDirectory(
      "samchon-graph-provider-sibling-",
    );
    const siblingFile = path.join(siblingRoot, "shared.ts");
    fs.writeFileSync(siblingFile, "export const shared = 0;\n");
    let siblingAttempts = 0;
    let siblingFailure: unknown;
    try {
      await commitProjectInputGeneration(
        { cwd: unboundRoot, languages: ["typescript"] },
        [],
        () => {
          const consumed = fs.readFileSync(siblingFile);
          siblingAttempts += 1;
          fs.writeFileSync(
            siblingFile,
            `export const shared = ${String(siblingAttempts)};\n`,
          );
          return {
            ...resultOf(unboundRoot),
            providerSourceDigests: new Map([
              [
                siblingFile,
                {
                  checkerDigest: digest(consumed),
                  diskDigest: digest(consumed),
                },
              ],
            ]),
          };
        },
      );
    } catch (error) {
      siblingFailure = error;
    }
    TestValidator.predicate(
      "an external sibling that moves after provider consumption never publishes",
      siblingAttempts === 3 &&
        siblingFailure instanceof Error &&
        siblingFailure.message.includes("does not bind the provider snapshot"),
    );
  };

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function resultOf(root: string): IIndexerResult {
  return {
    dump: {
      project: root,
      languages: ["typescript"],
      indexer: "static",
      nodes: [],
      edges: [],
    },
    warnings: [],
  };
}

/**
 * A movement says which kind of difference it found.
 *
 * The guard used to report only that a file had moved, and a C# corpus lane
 * failed it three bounded attempts running, twice over, with no way to tell a
 * real edit from text the producer had normalized. The coordinator's own BOM
 * transform is accepted above; every other mismatch remains diagnostic.
 */
function assertMovementSaysHowTheTextsDiffer(root: string): void {
  const file = path.join(root, "moved-detail.ts");
  const body = "export const value = 1;\r\nexport const other = 2;\r\n";

  fs.writeFileSync(file, `\uFEFF${body.replace(/\r\n/g, "\n")}`);
  TestValidator.equals(
    "the coordinator's stripped leading byte order mark is equivalent",
    movedConsumedSource(
      new Map([[file, body.replace(/\r\n/g, "\n")]]),
    ),
    undefined,
  );

  fs.writeFileSync(file, `\uFEFF${body.replace(/\r\n/g, "\n")}extra\n`);
  TestValidator.predicate(
    "a byte order mark plus a real edit says both",
    movedConsumedSource(
      new Map([[file, body.replace(/\r\n/g, "\n")]]),
    )?.detail.includes("differs further from offset") === true,
  );

  fs.writeFileSync(file, body);
  TestValidator.predicate(
    "line endings alone are named as the only difference",
    movedConsumedSource(
      new Map([[file, body.replace(/\r\n/g, "\n")]]),
    )?.detail.includes("only by line endings") === true,
  );

  fs.writeFileSync(file, "export const value = 9;\n");
  TestValidator.predicate(
    "an ordinary edit reports lengths and the first differing offset",
    movedConsumedSource(
      new Map([[file, "export const value = 1;\n"]]),
    )?.detail.includes("first difference at offset 21") === true,
  );

  TestValidator.predicate(
    "an unreadable source says it could not be read back",
    movedConsumedSource(
      new Map([[path.join(root, "absent.ts"), "gone\n"]]),
    )?.detail.includes("could not be read back") === true,
  );

  fs.writeFileSync(file, "export const value = 1;\n");
  TestValidator.predicate(
    "a digest mismatch on identical text says so",
    movedConsumedSource(
      new Map([[file, "export const value = 1;\n"]]),
      new Map([[file, digest(Buffer.from("something else"))]]),
    )?.detail.includes("manifest digest") === true,
  );
}
