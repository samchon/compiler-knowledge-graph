import { TestValidator } from "@nestia/e2e";
import {
  RepositoryContextProtocol,
  SamchonRepositoryContextMemory,
  cargoRepositoryContextProvider,
  cmakeRepositoryContextProvider,
  gradleRepositoryContextProvider,
  pnpmRepositoryContextProvider,
} from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";
import { parseGradleRepositoryContextModel } from "../../../../packages/graph/src/repository/parseGradleRepositoryContextModel";

/**
 * Each adapter reads a different owning tool, and the tempting failure is the
 * same in all four: when the model is missing, stale, or refuses to answer,
 * reconstruct the topology from directory layout and publish it as though the
 * tool had said it. This pins the opposite behaviour per ecosystem. Detection
 * is keyed to the owning manifest rather than to any repository that happens
 * to contain a folder; `declared` and `tool-resolved` authority stay distinct
 * per node and edge; an absent Tooling API classpath, a failed tool, malformed
 * JSON, a stale CMake reply and a missing File API query each make the adapter
 * throw rather than answer; and a Gradle module name that resolves ambiguously
 * degrades `depends-on` to partial coverage with a warning instead of emitting
 * the edge it cannot prove.
 */
export const test_repository_context_adapters_preserve_authoritative_models =
  async () => {
    const root = GraphPaths.createTempDirectory(
      "samchon-graph-repository-context-adapters-",
    );
    try {
      const pnpm = pnpmFixture(root);
      const cargo = cargoFixture(root);
      const gradle = gradleFixture(root);
      const cmake = cmakeFixture(root);

      TestValidator.equals(
        "repository-context adapters detect only their owning manifests",
        [
          pnpmRepositoryContextProvider.detect(root),
          cargoRepositoryContextProvider.detect(path.join(root, "cargo")),
          gradleRepositoryContextProvider.detect(root),
          cmakeRepositoryContextProvider.detect(path.join(root, "cmake")),
          pnpmRepositoryContextProvider.detect(path.join(root, "absent")),
          cargoRepositoryContextProvider.detect(path.join(root, "absent")),
          gradleRepositoryContextProvider.detect(path.join(root, "absent")),
          cmakeRepositoryContextProvider.detect(path.join(root, "absent")),
        ],
        [true, true, true, true, false, false, false, false],
      );
      for (const [provider, providerRoot] of [
        [pnpmRepositoryContextProvider, root],
        [cargoRepositoryContextProvider, path.join(root, "cargo")],
        [gradleRepositoryContextProvider, root],
        [cmakeRepositoryContextProvider, path.join(root, "cmake")],
      ] as const) {
        const session = provider.open({
          root: providerRoot,
          env: process.env,
        });
        TestValidator.equals(
          `${provider.name} opens at generation zero`,
          session.generation,
          0,
        );
        await session.close();
        await TestValidator.error(
          `${provider.name} refuses refresh after close`,
          () => session.refresh(),
        );
      }

      TestValidator.equals(
        "pnpm preserves members, local dependencies, roots, tasks and entrypoints",
        summarize(pnpm),
        {
          ecosystem: "pnpm",
          nodeKinds: [
            "entrypoint",
            "entrypoint",
            "generated-root",
            "package",
            "package",
            "source-root",
            "source-root",
            "task",
            "workspace",
          ],
          edgeKinds: [
            "contains",
            "contains",
            "contains",
            "contains",
            "contains",
            "contains",
            "contains",
            "contains",
            "depends-on",
            "entrypoint-of",
            "entrypoint-of",
            "joins-file",
            "joins-file",
            "source-of",
            "source-of",
            "source-of",
          ],
          files: ["apps/app/src/index.ts", "packages/lib/src/index.ts"],
          coverage: 8,
        },
      );
      TestValidator.equals(
        "pnpm distinguishes tool-resolved workspace facts from declared manifest facts",
        authoritySummary(pnpm),
        {
          nodes: { declared: 8, "tool-resolved": 1 },
          edges: { declared: 13, "tool-resolved": 3 },
        },
      );
      TestValidator.equals(
        "Cargo preserves packages, targets, dependencies, tests and source joins",
        summarize(cargo),
        {
          ecosystem: "cargo",
          nodeKinds: [
            "build-target",
            "build-target",
            "entrypoint",
            "entrypoint",
            "package",
            "package",
            "source-set",
            "source-set",
            "workspace",
          ],
          edgeKinds: [
            "contains",
            "contains",
            "contains",
            "contains",
            "contains",
            "contains",
            "contains",
            "contains",
            "depends-on",
            "entrypoint-of",
            "entrypoint-of",
            "joins-file",
            "joins-file",
            "joins-file",
            "joins-file",
            "source-of",
            "source-of",
            "test-of",
          ],
          files: ["cargo/app/src/main.rs", "cargo/lib/src/lib.rs"],
          coverage: 8,
        },
      );
      TestValidator.equals(
        "Gradle Tooling API preserves projects, project dependencies, tasks and roots",
        summarize(gradle),
        {
          ecosystem: "gradle",
          nodeKinds: [
            "build-target",
            "build-target",
            "project",
            "project",
            "source-root",
            "source-root",
            "task",
            "task",
            "workspace",
          ],
          edgeKinds: [
            "contains",
            "contains",
            "contains",
            "contains",
            "contains",
            "contains",
            "contains",
            "contains",
            "depends-on",
            "source-of",
            "source-of",
            "test-of",
          ],
          files: [],
          coverage: 8,
        },
      );
      TestValidator.equals(
        "Gradle source roots join against the current code generation without rescanning the Tooling API model",
        joinedFiles(gradle, [
          "gradle/app/src/main/App.java",
          "gradle/lib/src/test/LibTest.java",
        ]),
        [
          "gradle/app/src/main/App.java",
          "gradle/lib/src/test/LibTest.java",
        ],
      );
      TestValidator.equals(
        "code-file create, rename and delete recompute joins without changing the topology model",
        [
          joinedFiles(gradle, ["gradle/app/src/main/Created.java"]),
          joinedFiles(gradle, ["gradle/app/src/main/Renamed.java"]),
          joinedFiles(gradle, []),
        ],
        [
          ["gradle/app/src/main/Created.java"],
          ["gradle/app/src/main/Renamed.java"],
          [],
        ],
      );
      TestValidator.equals(
        "CMake File API preserves projects, targets, sources, artifacts and entrypoints",
        summarize(cmake),
        {
          ecosystem: "cmake",
          nodeKinds: [
            "build-target",
            "entrypoint",
            "generated-root",
            "generated-root",
            "project",
            "source-root",
            "workspace",
          ],
          edgeKinds: [
            "contains",
            "contains",
            "contains",
            "contains",
            "contains",
            "contains",
            "entrypoint-of",
            "joins-file",
            "joins-file",
            "produces",
            "source-of",
            "source-of",
          ],
          files: [
            "cmake/build/generated/gen.c",
            "cmake/src/main.c",
          ],
          coverage: 8,
        },
      );
      TestValidator.equals(
        "all first-slice adapters retain exhaustive topology coverage",
        [pnpm, cargo, gradle, cmake].map(
          (collection) => collection.shards[0]!.coverage.length,
        ),
        [8, 8, 8, 8],
      );
      TestValidator.predicate(
        "code contents are joins, not topology model inputs",
        ![...pnpm.shards[0]!.sources, ...cargo.shards[0]!.sources].some(
          (source) =>
            source.file.endsWith(".ts") || source.file.endsWith(".rs"),
        ),
      );
      TestValidator.equals(
        "Cargo feature selections participate in repository identity",
        cargo.shards[0]!.nodes
          .filter((node) => node.name === "app")
          .map((node) => node.configuration),
        ["features=cli", "features=cli", "features=cli"],
      );
      TestValidator.equals(
        "exact manifest files synthesize joins against the current code generation",
        joinedFiles(pnpm, [
          "apps/app/src/index.ts",
          "packages/lib/src/index.ts",
        ]),
        [
          "apps/app/src/index.ts",
          "apps/app/src/index.ts",
          "packages/lib/src/index.ts",
          "packages/lib/src/index.ts",
        ],
      );

      const rootJoin = structuredClone(gradle);
      rootJoin.shards[0]!.nodes[0]!.root = ".";
      TestValidator.equals(
        "a repository-root fact joins every current code file",
        joinedFiles(rootJoin, ["at-root.ts", "nested/file.ts"]),
        ["at-root.ts", "nested/file.ts"],
      );
      TestValidator.equals(
        "a query retains an inbound declared dependency edge",
        topologyMemory(pnpm)
          .inspect(
            {
              type: "topology",
              query: "@fixture/lib",
              relations: ["depends-on"],
            },
            {
              state: "unavailable",
              topologyInputGeneration: "input",
              codeInputGeneration: "code",
            },
          )
          .edges.map((edge) => edge.kind),
        ["depends-on"],
      );

      const ambiguousGradle = gradleAmbiguousDependencyFixture(root);
      TestValidator.equals(
        "an ambiguous Gradle module name degrades dependency coverage instead of inventing an edge",
        [
          ambiguousGradle.shards[0]!.edges.some(
            (edge) => edge.kind === "depends-on",
          ),
          ambiguousGradle.shards[0]!.coverage.find(
            (row) => row.family === "depends-on",
          )?.state,
          ambiguousGradle.warnings.some((warning) =>
            warning.includes("ambiguous"),
          ),
        ],
        [false, "partial", true],
      );
      TestValidator.predicate(
        "Gradle preserves generated roots and resolves one unambiguous module name",
        gradleEdgeFixture(root).shards[0]!.edges.some(
          (edge) => edge.kind === "depends-on",
        ),
      );
      TestValidator.predicate(
        "pnpm preserves fallback identities, nested exports and non-path dependency rows",
        pnpmEdgeFixture(root).shards[0]!.nodes.some(
          (node) => node.kind === "entrypoint" && node.name.startsWith("exports"),
        ),
      );
      TestValidator.equals(
        "pnpm falls back to package.json evidence when no workspace manifest is present",
        pnpmNoWorkspaceFixture(root).shards[0]!.nodes[0]!.evidence?.file,
        "package.json",
      );
      TestValidator.predicate(
        "Cargo distinguishes default configurations, external packages and unresolved metadata rows",
        cargoEdgeFixtures(root).every(
          (collection) => collection.shards[0]!.nodes.length > 1,
        ),
      );

      TestValidator.error(
        "Gradle Tooling API evaluation requires explicit opt-in",
        () =>
          gradleRepositoryContextProvider.collect(
            { root, env: process.env },
            () => ({ version: "", modules: [] }),
          ),
      );
      TestValidator.error(
        "Gradle reports a missing Tooling API classpath without downloading it",
        () =>
          gradleRepositoryContextProvider.collect({
            root,
            env: {
              ...process.env,
              GRADLE_HOME: undefined,
              SAMCHON_GRAPH_GRADLE_TOOLING_CLASSPATH: undefined,
              SAMCHON_GRAPH_ALLOW_GRADLE_MODEL: "1",
            },
          }),
      );
      for (const env of [
        {
          ...process.env,
          SAMCHON_GRAPH_ALLOW_GRADLE_MODEL: "1",
          SAMCHON_GRAPH_GRADLE_TOOLING_CLASSPATH: path.join(root, "missing.jar"),
          JAVA_HOME: path.join(root, "missing-java"),
        },
        {
          ...process.env,
          SAMCHON_GRAPH_ALLOW_GRADLE_MODEL: "1",
          SAMCHON_GRAPH_GRADLE_TOOLING_CLASSPATH: undefined,
          GRADLE_HOME: path.join(root, "missing-gradle"),
          JAVA_HOME: path.join(root, "missing-java"),
        },
        {
          ...process.env,
          SAMCHON_GRAPH_ALLOW_GRADLE_MODEL: "1",
          SAMCHON_GRAPH_GRADLE_TOOLING_CLASSPATH: path.join(root, "missing.jar"),
          JAVA_HOME: undefined,
        },
      ]) {
        TestValidator.error(
          "Gradle surfaces a Tooling API process failure without a fallback",
          () => gradleRepositoryContextProvider.collect({ root, env }),
        );
      }
      exerciseGradleModelParser(root);

      const toolDirectory = path.join(root, "tools");
      installFakeRepositoryTool(toolDirectory, "pnpm");
      installFakeRepositoryTool(toolDirectory, "cargo");
      const toolEnv = {
        ...process.env,
        PATH: `${toolDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      };
      TestValidator.predicate(
        "the pnpm process boundary accepts a valid resolved workspace model",
        pnpmRepositoryContextProvider.collect({
          root,
          env: {
            ...toolEnv,
            FIXTURE_TOOL_MODEL: JSON.stringify(pnpmModel(root)),
          },
        }).shards[0]!.nodes.length > 1,
      );
      TestValidator.predicate(
        "the Cargo process boundary accepts a valid offline metadata model",
        cargoRepositoryContextProvider.collect({
          root: path.join(root, "cargo"),
          env: {
            ...toolEnv,
            FIXTURE_TOOL_MODEL: JSON.stringify(cargoModel(root)),
          },
        }).shards[0]!.nodes.length > 1,
      );
      for (const provider of [
        pnpmRepositoryContextProvider,
        cargoRepositoryContextProvider,
      ] as const) {
        const providerRoot =
          provider === pnpmRepositoryContextProvider
            ? root
            : path.join(root, "cargo");
        TestValidator.error(`${provider.name} rejects a failed tool`, () =>
          provider.collect({
            root: providerRoot,
            env: {
              ...toolEnv,
              FIXTURE_TOOL_MODE: "failed",
            },
          }),
        );
        TestValidator.error(`${provider.name} rejects malformed tool JSON`, () =>
          provider.collect({
            root: providerRoot,
            env: {
              ...toolEnv,
              FIXTURE_TOOL_MODE: "malformed",
            },
          }),
        );
      }
      for (const [provider, invalidModels] of [
        [
          pnpmRepositoryContextProvider,
          [JSON.stringify([{ path: "" }])],
        ],
        [
          cargoRepositoryContextProvider,
          [
            JSON.stringify({
              packages: [],
              workspace_members: "invalid",
              workspace_root: "",
            }),
            JSON.stringify({
              packages: [],
              workspace_members: [],
              workspace_root: 1,
            }),
          ],
        ],
      ] as const) {
        const providerRoot =
          provider === pnpmRepositoryContextProvider
            ? root
            : path.join(root, "cargo");
        for (const model of invalidModels) {
          TestValidator.error(`${provider.name} validates every model field`, () =>
            provider.collect({
              root: providerRoot,
              env: {
                ...toolEnv,
                FIXTURE_TOOL_MODEL: model,
              },
            }),
          );
        }
      }
      for (const [provider, providerRoot, model] of [
        [pnpmRepositoryContextProvider, root, pnpmModel(root)],
        [
          cargoRepositoryContextProvider,
          path.join(root, "cargo"),
          cargoModel(root),
        ],
      ] as const) {
        TestValidator.equals(
          `${provider.name} reports an unavailable version probe honestly`,
          provider.collect({
            root: providerRoot,
            env: {
              ...toolEnv,
              FIXTURE_TOOL_MODE: "version-failed",
              FIXTURE_TOOL_MODEL: JSON.stringify(model),
            },
          }).toolVersion,
          "",
        );
      }

      exerciseCmakeRefusals(root);

      const aborted = new AbortController();
      aborted.abort();
      for (const operation of [
        () =>
          pnpmRepositoryContextProvider.collect(
            { root, env: process.env, signal: aborted.signal },
            () => [],
          ),
        () =>
          cargoRepositoryContextProvider.collect(
            { root, env: process.env, signal: aborted.signal },
            () => cargoModel(root),
          ),
        () =>
          gradleRepositoryContextProvider.collect(
            {
              root,
              env: {
                ...process.env,
                SAMCHON_GRAPH_ALLOW_GRADLE_MODEL: "1",
              },
              signal: aborted.signal,
            },
            () => ({ version: "1", modules: [] }),
          ),
        () =>
          cmakeRepositoryContextProvider.collect({
            root,
            env: process.env,
            signal: aborted.signal,
          }),
      ]) {
        TestValidator.error("an adapter refuses a cancelled collection", operation);
      }

      const cmakeList = path.join(root, "cmake", "CMakeLists.txt");
      const future = new Date(Date.now() + 2_000);
      fs.utimesSync(cmakeList, future, future);
      TestValidator.error(
        "a stale CMake File API model is refused rather than joined to changed configuration",
        () =>
          cmakeRepositoryContextProvider.collect({
            root,
            env: {
              ...process.env,
              SAMCHON_GRAPH_CMAKE_REPLY: path.join(
                root,
                "cmake",
                "build",
                ".cmake",
                "api",
                "v1",
                "reply",
              ),
            },
          }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

function pnpmFixture(root: string) {
  const app = path.join(root, "apps", "app");
  const library = path.join(root, "packages", "lib");
  write(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n");
  write(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeJson(path.join(root, "package.json"), {
    name: "workspace",
    private: true,
  });
  writeJson(path.join(app, "package.json"), {
    name: "@fixture/app",
    files: ["src", "dist"],
    main: "src/index.ts",
    scripts: { build: "fixture" },
  });
  write(path.join(app, "src", "index.ts"), "export const app = 1;\n");
  writeJson(path.join(library, "package.json"), {
    name: "@fixture/lib",
    files: ["src"],
    exports: "./src/index.ts",
  });
  write(path.join(library, "src", "index.ts"), "export const lib = 1;\n");
  return pnpmRepositoryContextProvider.collect(
    { root, env: process.env },
    () => pnpmModel(root),
  );
}

function pnpmModel(root: string) {
  return [
    {
      name: "@fixture/app",
      path: path.join(root, "apps", "app"),
      dependencies: {
        "@fixture/lib": { path: path.join(root, "packages", "lib") },
      },
    },
    { name: "@fixture/lib", path: path.join(root, "packages", "lib") },
  ];
}

function pnpmEdgeFixture(root: string) {
  const first = path.join(root, "edge", "first");
  const second = path.join(root, "edge", "second");
  writeJson(path.join(first, "package.json"), {
    files: ["", "*", "!private", path.resolve(first, "absolute"), "src"],
    typings: "types.d.ts",
    bin: "cli.js",
    exports: {
      ".": {
        import: "esm.js",
        ignored: null,
      },
      "./feature": "feature.js",
    },
  });
  writeJson(path.join(second, "package.json"), {
    bin: { second: "second.js" },
  });
  return pnpmRepositoryContextProvider.collect(
    { root, env: process.env },
    () => [
      {
        path: first,
        dependencies: { missingPath: {} },
        devDependencies: { absentWorkspace: { path: path.join(root, "absent") } },
      },
      { name: "fallback-name", path: second },
    ],
  );
}

function pnpmNoWorkspaceFixture(root: string) {
  const workspace = path.join(root, "pnpm-no-workspace");
  writeJson(path.join(workspace, "package.json"), {
    name: "no-workspace-manifest",
  });
  return pnpmRepositoryContextProvider.collect(
    { root: workspace, env: process.env },
    () => [{ name: "no-workspace-manifest", path: workspace }],
  );
}

function cargoFixture(root: string) {
  const workspace = path.join(root, "cargo");
  const app = path.join(workspace, "app");
  const library = path.join(workspace, "lib");
  write(path.join(workspace, "Cargo.toml"), "[workspace]\nmembers=[]\n");
  write(path.join(workspace, "Cargo.lock"), "");
  write(path.join(app, "Cargo.toml"), "[package]\nname='app'\nversion='1.0.0'\n");
  write(path.join(app, "src", "main.rs"), "fn main() {}\n");
  write(path.join(library, "Cargo.toml"), "[package]\nname='lib'\nversion='1.0.0'\n");
  write(path.join(library, "src", "lib.rs"), "#[test] fn works() {}\n");
  return cargoRepositoryContextProvider.collect(
    { root, env: process.env },
    () => cargoModel(root),
  );
}

function cargoModel(root: string) {
  const workspace = path.join(root, "cargo");
  const app = path.join(workspace, "app");
  const library = path.join(workspace, "lib");
  return {
    workspace_root: workspace,
    workspace_members: ["app 1", "lib 1"],
    packages: [
      {
        id: "app 1",
        name: "app",
        version: "1.0.0",
        manifest_path: path.join(app, "Cargo.toml"),
        targets: [
          {
            name: "app",
            kind: ["bin"],
            crate_types: ["bin"],
            src_path: path.join(app, "src", "main.rs"),
          },
        ],
      },
      {
        id: "lib 1",
        name: "lib",
        version: "1.0.0",
        manifest_path: path.join(library, "Cargo.toml"),
        targets: [
          {
            name: "lib-test",
            kind: ["test"],
            crate_types: ["bin"],
            src_path: path.join(library, "src", "lib.rs"),
          },
        ],
      },
    ],
    resolve: {
      nodes: [
        { id: "app 1", dependencies: ["lib 1"], features: ["cli"] },
        { id: "lib 1", dependencies: [] },
      ],
    },
  };
}

function cargoEdgeFixtures(root: string) {
  const workspace = path.join(root, "cargo");
  const external = path.join(root, "cargo-external");
  write(
    path.join(external, "Cargo.toml"),
    "[package]\nname='external'\nversion='1.0.0'\n",
  );
  write(path.join(external, "src", "lib.rs"), "pub fn library() {}\n");
  write(path.join(external, "examples", "demo.rs"), "fn main() {}\n");
  const model = cargoModel(root);
  const externalPackage = {
    id: "external 1",
    name: "external",
    version: "1.0.0",
    manifest_path: path.join(external, "Cargo.toml"),
    targets: [
      {
        name: "library",
        kind: ["lib"],
        crate_types: ["lib"],
        src_path: path.join(external, "src", "lib.rs"),
      },
      {
        name: "demo",
        kind: ["example"],
        crate_types: ["bin"],
        src_path: path.join(external, "examples", "demo.rs"),
      },
    ],
  };
  return [
    cargoRepositoryContextProvider.collect(
      { root: workspace, env: process.env },
      () => ({
        ...model,
        workspace_root: workspace,
        packages: [externalPackage],
        workspace_members: [],
        resolve: null,
      }),
    ),
    cargoRepositoryContextProvider.collect(
      { root: workspace, env: process.env },
      () => ({
        ...model,
        workspace_root: workspace,
        packages: [...model.packages, externalPackage],
        resolve: {
          nodes: [
            ...model.resolve.nodes,
            { id: "absent 1", dependencies: ["external 1"] },
          ],
        },
      }),
    ),
  ];
}

function gradleAmbiguousDependencyFixture(root: string) {
  const directory = path.join(root, "gradle");
  return gradleRepositoryContextProvider.collect(
    {
      root,
      env: {
        ...process.env,
        SAMCHON_GRAPH_ALLOW_GRADLE_MODEL: "1",
      },
    },
    () => ({
      version: "9.1",
      modules: [
        {
          path: ":app",
          name: "app",
          directory,
          dependencies: ["shared"],
          sources: [],
          tasks: [],
        },
        {
          path: ":left",
          name: "shared",
          directory,
          dependencies: [],
          sources: [],
          tasks: [],
        },
        {
          path: ":right",
          name: "shared",
          directory,
          dependencies: [],
          sources: [],
          tasks: [],
        },
      ],
    }),
  );
}

function gradleFixture(root: string) {
  const workspace = path.join(root, "gradle");
  const app = path.join(workspace, "app");
  const library = path.join(workspace, "lib");
  write(path.join(root, "settings.gradle.kts"), "rootProject.name = \"fixture\"\n");
  write(path.join(app, "build.gradle.kts"), "");
  write(path.join(library, "build.gradle.kts"), "");
  write(path.join(app, "src", "main", "App.java"), "class App {}\n");
  write(path.join(library, "src", "test", "LibTest.java"), "class LibTest {}\n");
  return gradleRepositoryContextProvider.collect(
    {
      root,
      env: {
        ...process.env,
        SAMCHON_GRAPH_ALLOW_GRADLE_MODEL: "1",
      },
    },
    () => ({
      version: "9.1",
      modules: [
        {
          path: ":app",
          name: "app",
          directory: app,
          dependencies: [":lib"],
          sources: [
            {
              kind: "source",
              directory: path.join(app, "src", "main"),
              generated: false,
            },
          ],
          tasks: [{ path: ":app:build", name: "build" }],
        },
        {
          path: ":lib",
          name: "lib",
          directory: library,
          dependencies: [],
          sources: [
            {
              kind: "test",
              directory: path.join(library, "src", "test"),
              generated: false,
            },
          ],
          tasks: [{ path: ":lib:test", name: "test" }],
        },
      ],
    }),
  );
}

function gradleEdgeFixture(root: string) {
  const workspace = path.join(root, "gradle-edge");
  const app = path.join(workspace, "app");
  const library = path.join(workspace, "library");
  write(path.join(workspace, "settings.gradle"), "rootProject.name='edge'\n");
  write(path.join(app, "build.gradle"), "");
  write(path.join(library, "build.gradle"), "");
  return gradleRepositoryContextProvider.collect(
    {
      root: workspace,
      env: {
        ...process.env,
        SAMCHON_GRAPH_ALLOW_GRADLE_MODEL: "1",
      },
    },
    () => ({
      version: "9.1",
      modules: [
        {
          path: ":app",
          name: "app",
          directory: app,
          dependencies: ["library"],
          sources: [
            {
              kind: "generated",
              directory: path.join(app, "build", "generated"),
              generated: true,
            },
          ],
          tasks: [],
        },
        {
          path: ":library",
          name: "library",
          directory: library,
          dependencies: [],
          sources: [],
          tasks: [],
        },
      ],
    }),
  );
}

function cmakeFixture(root: string) {
  const workspace = path.join(root, "cmake");
  const reply = path.join(workspace, "build", ".cmake", "api", "v1", "reply");
  write(path.join(workspace, "CMakeLists.txt"), "add_executable(app src/main.c)\n");
  write(path.join(workspace, "src", "main.c"), "int main(void) { return 0; }\n");
  writeJson(path.join(reply, "index-1.json"), {
    cmake: { version: { string: "4.0.0" } },
    reply: {
      "codemodel-v2": { jsonFile: "codemodel.json" },
      "cmakeFiles-v1": { jsonFile: "cmakeFiles.json" },
    },
  });
  writeJson(path.join(reply, "cmakeFiles.json"), {
    paths: { source: workspace, build: path.join(workspace, "build") },
    inputs: [{ path: "CMakeLists.txt" }],
  });
  writeJson(path.join(reply, "codemodel.json"), {
    paths: { source: workspace, build: path.join(workspace, "build") },
    configurations: [
      {
        name: "Debug",
        projects: [{ name: "fixture", directoryIndexes: [0], targetIndexes: [0] }],
        directories: [
          {
            source: ".",
            build: ".",
            projectIndex: 0,
            targetIndexes: [0],
          },
        ],
        targets: [
          {
            name: "app",
            id: "app::1",
            directoryIndex: 0,
            projectIndex: 0,
            jsonFile: "target-app.json",
          },
        ],
      },
    ],
  });
  writeJson(path.join(reply, "target-app.json"), {
    name: "app",
    id: "app::1",
    type: "EXECUTABLE",
    paths: { source: workspace, build: path.join(workspace, "build") },
    sources: [
      { path: "src/main.c" },
      {
        path: path.join(workspace, "build", "generated", "gen.c"),
        isGenerated: true,
      },
    ],
    dependencies: [],
    artifacts: [{ path: "bin/app" }],
  });
  return cmakeRepositoryContextProvider.collect({
    root,
    env: {
      ...process.env,
      SAMCHON_GRAPH_CMAKE_REPLY: reply,
    },
  });
}

function summarize(
  collection: ReturnType<typeof pnpmRepositoryContextProvider.collect>,
) {
  const shard = collection.shards[0]!;
  return {
    ecosystem: shard.nodes[0]!.ecosystem,
    nodeKinds: shard.nodes.map((node) => node.kind).sort(),
    edgeKinds: shard.edges.map((edge) => edge.kind).sort(),
    files: shard.files,
    coverage: shard.coverage.length,
  };
}

function joinedFiles(
  collection: ReturnType<typeof pnpmRepositoryContextProvider.collect>,
  codeFiles: readonly string[],
): string[] {
  return topologyMemory(collection)
    .inspect(
      { type: "topology", relations: ["joins-file"], limit: 500 },
      {
        state: "compatible",
        topologyInputGeneration: "input",
        codeInputGeneration: "code",
      },
      new Set(codeFiles),
    )
    .edges.map((edge) => edge.to)
    .sort();
}

function topologyMemory(
  collection: ReturnType<typeof pnpmRepositoryContextProvider.collect>,
): SamchonRepositoryContextMemory {
  const shard = collection.shards[0]!;
  const contentDigest = RepositoryContextProtocol.contentDigest(shard);
  return new SamchonRepositoryContextMemory({
    project: ".",
    schemaVersion: 1,
    inputGeneration: "input",
    generation: {
      sequence: 1,
      token: "topology",
      shards: [
        {
          key: shard.key,
          digest: RepositoryContextProtocol.shardDigest(shard),
        },
      ],
      contentDigest,
    },
    provenance: [],
    coverage: shard.coverage,
    nodes: shard.nodes,
    edges: shard.edges,
    files: shard.files,
    sources: shard.sources,
    warnings: [],
  });
}

function exerciseGradleModelParser(root: string): void {
  const encode = (value: string): string =>
    Buffer.from(value, "utf8").toString("base64url");
  const row = (kind: string, ...fields: string[]): string =>
    [kind, ...fields.map(encode)].join("\t");
  const output = [
    "",
    row("V", "9.1"),
    row("M", ":app", "app", root),
    row("D", ":app", ":lib"),
    row("S", ":app", "main", path.join(root, "src"), "true"),
    row("T", ":app", ":app:build", "build"),
  ].join("\r\n");
  TestValidator.equals(
    "the Gradle sidecar framing preserves every supported record",
    parseGradleRepositoryContextModel(output),
    {
      version: "9.1",
      modules: [
        {
          path: ":app",
          name: "app",
          directory: root,
          dependencies: [":lib"],
          sources: [
            {
              kind: "main",
              directory: path.join(root, "src"),
              generated: true,
            },
          ],
          tasks: [{ path: ":app:build", name: "build" }],
        },
      ],
    },
  );
  for (const malformed of [
    "",
    row("V", "9.1"),
    row("M", ":app", "app"),
    [row("V", "9.1"), row("D", ":absent", ":lib")].join("\n"),
    [row("V", "9.1"), row("S", ":absent", "main", root, "false")].join(
      "\n",
    ),
    [row("V", "9.1"), row("T", ":absent", ":task", "task")].join("\n"),
    [row("V", "9.1"), row("X", "unknown")].join("\n"),
  ]) {
    TestValidator.error("malformed Gradle sidecar framing is refused", () =>
      parseGradleRepositoryContextModel(malformed),
    );
  }
}

function exerciseCmakeRefusals(root: string): void {
  const absentRoot = path.join(root, "cmake-absent");
  write(path.join(absentRoot, "CMakeLists.txt"), "project(absent)\n");
  TestValidator.error("CMake never creates a missing File API query", () =>
    cmakeRepositoryContextProvider.collect({
      root: absentRoot,
      env: process.env,
    }),
  );

  const emptyReply = path.join(
    root,
    "cmake-empty",
    ".cmake",
    "api",
    "v1",
    "reply",
  );
  fs.mkdirSync(emptyReply, { recursive: true });
  TestValidator.error("CMake requires an existing File API index", () =>
    cmakeRepositoryContextProvider.collect({
      root,
      env: {
        ...process.env,
        SAMCHON_GRAPH_CMAKE_REPLY: emptyReply,
      },
    }),
  );

  const missingReferences = cmakeScenario(root, "missing-references", {
    index: {},
    configurations: [{ name: "", projects: [], directories: [], targets: [] }],
  });
  TestValidator.error(
    "CMake requires both codemodel-v2 and cmakeFiles-v1 replies",
    () =>
      cmakeRepositoryContextProvider.collect({
        root,
        env: {
          ...process.env,
          SAMCHON_GRAPH_CMAKE_REPLY: missingReferences,
        },
      }),
  );

  const wrongReplyVersions = cmakeScenario(root, "wrong-reply-versions", {
    index: {
      reply: {
        "codemodel-v20": { jsonFile: "codemodel.json" },
        "cmakeFiles-v10": { jsonFile: "cmakeFiles.json" },
      },
    },
    configurations: [{ name: "", projects: [], directories: [], targets: [] }],
  });
  TestValidator.error(
    "CMake stateless reply keys must match the requested major versions exactly",
    () =>
      cmakeRepositoryContextProvider.collect({
        root,
        env: {
          ...process.env,
          SAMCHON_GRAPH_CMAKE_REPLY: wrongReplyVersions,
        },
      }),
  );

  const failedReply = cmakeScenario(root, "failed-latest-reply", {
    configurations: [{ name: "", projects: [], directories: [], targets: [] }],
  });
  writeJson(path.join(failedReply, "error-1.json"), {
    error: "fixture same-generation failure",
  });
  writeJson(path.join(failedReply, "error-9999.json"), {
    error: "fixture configure failed",
  });
  TestValidator.error(
    "CMake refuses an error reply newer than the last successful index",
    () =>
      cmakeRepositoryContextProvider.collect({
        root,
        env: {
          ...process.env,
          SAMCHON_GRAPH_CMAKE_REPLY: failedReply,
        },
      }),
  );

  const emptyConfigurations = cmakeScenario(root, "empty-configurations", {
    configurations: [],
  });
  TestValidator.error("CMake refuses an empty codemodel", () =>
    cmakeRepositoryContextProvider.collect({
      root,
      env: {
        ...process.env,
        SAMCHON_GRAPH_CMAKE_REPLY: emptyConfigurations,
      },
    }),
  );

  const configurations = [
    { name: "Debug", projects: [], directories: [], targets: [] },
    { name: "Release", projects: [], directories: [], targets: [] },
  ];
  const multiple = cmakeScenario(root, "multiple-configurations", {
    configurations,
  });
  TestValidator.error(
    "CMake requires an explicit choice for multiple configurations",
    () =>
      cmakeRepositoryContextProvider.collect({
        root,
        env: {
          ...process.env,
          SAMCHON_GRAPH_CMAKE_REPLY: multiple,
        },
      }),
  );
  TestValidator.error("CMake refuses an absent requested configuration", () =>
    cmakeRepositoryContextProvider.collect({
      root,
      env: {
        ...process.env,
        SAMCHON_GRAPH_CMAKE_REPLY: multiple,
        SAMCHON_GRAPH_CMAKE_CONFIGURATION: "Absent",
      },
    }),
  );
  TestValidator.equals(
    "CMake publishes only the explicitly selected configuration",
    cmakeRepositoryContextProvider
      .collect({
        root,
        env: {
          ...process.env,
          SAMCHON_GRAPH_CMAKE_REPLY: multiple,
          SAMCHON_GRAPH_CMAKE_CONFIGURATION: "Release",
        },
      })
      .shards.map((shard) => shard.target),
    ["Release"],
  );

  const objectReply = cmakeScenario(root, "object-references", {
    index: {
      objects: [
        {
          kind: "codemodel",
          version: { major: 2, minor: 8 },
          jsonFile: "codemodel.json",
        },
        {
          kind: "cmakeFiles",
          version: { major: 1, minor: 1 },
          jsonFile: "cmakeFiles.json",
        },
      ],
    },
    configurations: [
      {
        name: "",
        projects: [{ name: "fixture", directoryIndexes: [], targetIndexes: [0, 1] }],
        directories: [],
        targets: [
          {
            name: "app",
            id: "app",
            directoryIndex: 0,
            projectIndex: 0,
            jsonFile: "app.json",
          },
          {
            name: "library",
            id: "library",
            directoryIndex: 0,
            projectIndex: 0,
            jsonFile: "library.json",
          },
        ],
      },
    ],
    targets: {
      "app.json": {
        name: "app",
        id: "app",
        type: "EXECUTABLE",
        dependencies: [{ id: "library" }],
      },
      "library.json": {
        name: "library",
        id: "library",
        type: "STATIC_LIBRARY",
      },
    },
  });
  const objectModel = cmakeRepositoryContextProvider.collect({
    root,
    env: {
      ...process.env,
      SAMCHON_GRAPH_CMAKE_REPLY: objectReply,
    },
  });
  TestValidator.equals(
    "CMake accepts the object index form, default configuration and target dependencies",
    [
      objectModel.toolVersion,
      objectModel.target,
      objectModel.shards[0]!.edges.some(
        (edge) => edge.kind === "depends-on",
      ),
    ],
    ["", "default", true],
  );

  const wrongObjectVersions = cmakeScenario(
    root,
    "wrong-object-versions",
    {
      index: {
        objects: [
          {
            kind: "codemodel",
            version: { major: 1, minor: 0 },
            jsonFile: "codemodel.json",
          },
          {
            kind: "cmakeFiles",
            jsonFile: "cmakeFiles.json",
          },
        ],
      },
      configurations: [
        { name: "", projects: [], directories: [], targets: [] },
      ],
    },
  );
  TestValidator.error(
    "CMake object references must declare the requested reply major versions",
    () =>
      cmakeRepositoryContextProvider.collect({
        root,
        env: {
          ...process.env,
          SAMCHON_GRAPH_CMAKE_REPLY: wrongObjectVersions,
        },
      }),
  );

  const includedInputReply = cmakeScenario(root, "included-input", {
    configurations: [
      { name: "", projects: [], directories: [], targets: [] },
    ],
    inputs: [
      { path: "CMakeLists.txt" },
      { path: "cmake/options.cmake" },
    ],
  });
  const includedInput = path.join(
    root,
    "cmake-included-input",
    "cmake",
    "options.cmake",
  );
  write(includedInput, "set(FIXTURE_OPTION ON)\n");
  const future = new Date(Date.now() + 2_000);
  fs.utimesSync(includedInput, future, future);
  TestValidator.error(
    "CMake refuses a File API model older than any owning cmakeFiles input",
    () =>
      cmakeRepositoryContextProvider.collect({
        root,
        env: {
          ...process.env,
          SAMCHON_GRAPH_CMAKE_REPLY: includedInputReply,
        },
      }),
  );

  const renamedInput = path.join(
    root,
    "cmake-renamed-input",
    "cmake",
    "options.cmake",
  );
  write(renamedInput, "set(FIXTURE_OPTION ON)\n");
  const renamedInputReply = cmakeScenario(root, "renamed-input", {
    configurations: [
      { name: "", projects: [], directories: [], targets: [] },
    ],
    inputs: [
      { path: "CMakeLists.txt" },
      { path: "cmake/options.cmake" },
    ],
  });
  fs.renameSync(
    renamedInput,
    path.join(path.dirname(renamedInput), "renamed-options.cmake"),
  );
  TestValidator.error(
    "CMake refuses a File API model whose owning input was renamed or deleted",
    () =>
      cmakeRepositoryContextProvider.collect({
        root,
        env: {
          ...process.env,
          SAMCHON_GRAPH_CMAKE_REPLY: renamedInputReply,
        },
      }),
  );
}

function cmakeScenario(
  root: string,
  name: string,
  options: {
    index?: Record<string, unknown>;
    configurations: Array<Record<string, unknown>>;
    targets?: Record<string, Record<string, unknown>>;
    inputs?: Array<{ path: string }>;
  },
): string {
  const source = path.join(root, `cmake-${name}`);
  const build = path.join(source, "build");
  const reply = path.join(build, ".cmake", "api", "v1", "reply");
  write(path.join(source, "CMakeLists.txt"), `project(${name})\n`);
  writeJson(path.join(reply, "cmakeFiles.json"), {
    paths: { source, build },
    inputs: options.inputs ?? [{ path: "CMakeLists.txt" }],
  });
  writeJson(path.join(reply, "codemodel.json"), {
    paths: { source, build },
    configurations: options.configurations,
  });
  for (const [file, target] of Object.entries(options.targets ?? {})) {
    writeJson(path.join(reply, file), {
      paths: { source, build },
      ...target,
    });
  }
  writeJson(path.join(reply, "index-1.json"), {
    ...(options.index ?? {
      reply: {
        "codemodel-v2": { jsonFile: "codemodel.json" },
        "cmakeFiles-v1": { jsonFile: "cmakeFiles.json" },
      },
    }),
  });
  return reply;
}

function installFakeRepositoryTool(directory: string, name: string): void {
  fs.mkdirSync(directory, { recursive: true });
  const source = [
    "#!/usr/bin/env node",
    'const mode = process.env.FIXTURE_TOOL_MODE ?? "valid";',
    'if (process.argv.includes("--version")) { if (mode === "version-failed") process.exit(2); console.log("fixture 1.0.0"); process.exit(0); }',
    'if (mode === "failed") { console.error("fixture tool failed"); process.exit(2); }',
    'if (mode === "malformed") { console.log("{}"); process.exit(0); }',
    'console.log(process.env.FIXTURE_TOOL_MODEL ?? "{}");',
  ].join("\n");
  if (process.platform === "win32") {
    const script = path.join(directory, `${name}.cjs`);
    write(script, source);
    write(
      path.join(directory, `${name}.cmd`),
      `@node "%~dp0\\${name}.cjs" %*\r\n`,
    );
  } else {
    const executable = path.join(directory, name);
    write(executable, source);
    fs.chmodSync(executable, 0o755);
  }
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeJson(file: string, value: unknown): void {
  write(file, JSON.stringify(value));
}

function authoritySummary(
  collection: ReturnType<typeof pnpmRepositoryContextProvider.collect>,
): {
  nodes: Record<string, number>;
  edges: Record<string, number>;
} {
  const count = (
    rows: readonly { authority: string }[],
  ): Record<string, number> =>
    Object.fromEntries(
      [...rows]
        .reduce((output, row) => {
          output.set(row.authority, (output.get(row.authority) ?? 0) + 1);
          return output;
        }, new Map<string, number>())
        .entries(),
    );
  return {
    nodes: count(collection.shards.flatMap((shard) => shard.nodes)),
    edges: count(collection.shards.flatMap((shard) => shard.edges)),
  };
}
