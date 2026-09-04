import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ISamchonRepositoryContextDump } from "../structures";
import { isSubPath } from "../utils/isSubPath";
import { IRepositoryContextProvider } from "./IRepositoryContextProvider";
import { createRepositoryContextSession } from "./createRepositoryContextSession";
import { parseGradleRepositoryContextModel } from "./parseGradleRepositoryContextModel";
import { repositoryContextFacts } from "./repositoryContextFacts";

const {
  compareRepositoryText,
  repositoryContextCoverage,
  repositoryContextEvidence,
  repositoryContextFile,
  repositoryContextId,
  repositoryContextSource,
  uniqueRepositorySources,
} = repositoryContextFacts;

const PROVIDER = "gradle-tooling-api";
const ECOSYSTEM = "gradle";
const TARGET = "workspace";

export const gradleRepositoryContextProvider: IRepositoryContextProvider & {
  collect: typeof collectGradleRepositoryContext;
} = {
  name: PROVIDER,
  ecosystem: ECOSYSTEM,
  authority: "tool-resolved",
  families: [
    "contains",
    "depends-on",
    "source-of",
    "test-of",
    "joins-file",
  ],
  buildInputs: [
    "settings.gradle",
    "settings.gradle.kts",
    "build.gradle",
    "build.gradle.kts",
    "gradle.properties",
    "gradle/libs.versions.toml",
    "gradle/wrapper/gradle-wrapper.properties",
  ],
  detect: (root) =>
    ["settings.gradle", "settings.gradle.kts"].some((file) =>
      fs.existsSync(path.join(root, file)),
    ),
  open: (props) =>
    createRepositoryContextSession(
      gradleRepositoryContextProvider,
      props,
      collectGradleRepositoryContext,
    ),
  collect: collectGradleRepositoryContext,
};

function collectGradleRepositoryContext(
  props: IRepositoryContextProvider.IOpenProps & { signal?: AbortSignal },
  execute: typeof executeGradleModel = executeGradleModel,
): IRepositoryContextProvider.ICollection {
  throwIfAborted(props.signal);
  if (props.env.SAMCHON_GRAPH_ALLOW_GRADLE_MODEL !== "1") {
    throw new Error(
      "Gradle repository context is disabled until SAMCHON_GRAPH_ALLOW_GRADLE_MODEL=1 acknowledges that the Tooling API evaluates project build configuration; no task is run.",
    );
  }
  const model = execute(props.root, props.env);
  throwIfAborted(props.signal);
  const workspaceId = repositoryContextId(ECOSYSTEM, "workspace", ".");
  const settings = firstExisting(props.root, [
    "settings.gradle",
    "settings.gradle.kts",
  ]);
  const nodes: ISamchonRepositoryContextDump.INode[] = [
    {
      id: workspaceId,
      authority: "tool-resolved",
      kind: "workspace",
      name: path.basename(props.root),
      ecosystem: ECOSYSTEM,
      coordinate: ".",
      configuration: "default",
      external: false,
      evidence: repositoryContextEvidence(props.root, settings),
    },
  ];
  const edges: ISamchonRepositoryContextDump.IEdge[] = [];
  const files = new Set<string>();
  const sources = gradleInputs(props.root).map((file) =>
    repositoryContextSource(props.root, file),
  );
  const projectIds = new Map<string, string>();
  const names = new Map<string, string[]>();

  for (const module of [...model.modules].sort((left, right) =>
    compareRepositoryText(left.path, right.path),
  )) {
    const projectId = repositoryContextId(
      ECOSYSTEM,
      "project",
      module.path,
    );
    const buildTargetId = repositoryContextId(
      ECOSYSTEM,
      "build-target",
      module.path,
    );
    projectIds.set(module.path, projectId);
    names.set(module.name, [...(names.get(module.name) ?? []), projectId]);
    const buildFile = firstExisting(module.directory, [
      "build.gradle",
      "build.gradle.kts",
    ]);
    sources.push(repositoryContextSource(props.root, buildFile));
    const evidence = repositoryContextEvidence(props.root, buildFile);
    nodes.push(
      {
        id: projectId,
        authority: "tool-resolved",
        kind: "project",
        name: module.name,
        ecosystem: ECOSYSTEM,
        coordinate: module.path,
        configuration: "default",
        external: false,
        evidence,
      },
      {
        id: buildTargetId,
        authority: "tool-resolved",
        kind: "build-target",
        name: module.path,
        ecosystem: ECOSYSTEM,
        coordinate: module.path,
        configuration: "default",
        external: false,
        evidence,
      },
    );
    edges.push(
      {
        authority: "tool-resolved",
        kind: "contains",
        from: workspaceId,
        to: projectId,
      },
      {
        authority: "tool-resolved",
        kind: "contains",
        from: projectId,
        to: buildTargetId,
      },
    );
    for (const source of module.sources) {
      const coordinate = `${module.path}:${repositoryContextFile(
        props.root,
        source.directory,
      )}`;
      const sourceId = repositoryContextId(
        ECOSYSTEM,
        source.generated ? "generated-root" : "source-root",
        coordinate,
      );
      nodes.push({
        id: sourceId,
        authority: "tool-resolved",
        kind: source.generated ? "generated-root" : "source-root",
        name: path.basename(source.directory),
        ecosystem: ECOSYSTEM,
        coordinate,
        configuration: source.kind,
        external: !isSubPath(props.root, source.directory),
        root: repositoryContextFile(props.root, source.directory),
        evidence,
      });
      edges.push(
        {
          authority: "tool-resolved",
          kind: "contains",
          from: buildTargetId,
          to: sourceId,
        },
        {
          authority: "tool-resolved",
          kind: "source-of",
          from: sourceId,
          to: projectId,
        },
      );
      if (source.kind.startsWith("test")) {
        edges.push({
          authority: "tool-resolved",
          kind: "test-of",
          from: sourceId,
          to: projectId,
        });
      }
    }
    for (const task of module.tasks) {
      const taskId = repositoryContextId(
        ECOSYSTEM,
        "task",
        task.path,
      );
      nodes.push({
        id: taskId,
        authority: "tool-resolved",
        kind: "task",
        name: task.name,
        ecosystem: ECOSYSTEM,
        coordinate: task.path,
        configuration: "default",
        external: false,
        evidence,
      });
      edges.push({
        authority: "tool-resolved",
        kind: "contains",
        from: projectId,
        to: taskId,
      });
    }
  }

  let unresolvedDependencies = 0;
  for (const module of model.modules) {
    const from = projectIds.get(module.path)!;
    for (const dependency of module.dependencies) {
      const candidates = names.get(dependency) ?? [];
      const to =
        projectIds.get(dependency) ??
        (candidates.length === 1 ? candidates[0] : undefined);
      if (to !== undefined) {
        edges.push({
          authority: "tool-resolved",
          kind: "depends-on",
          from,
          to,
        });
      }
      else unresolvedDependencies += 1;
    }
  }
  const shard = {
    key: `${PROVIDER}:workspace`,
    target: TARGET,
    nodes: nodes.sort((left, right) =>
      compareRepositoryText(left.id, right.id),
    ),
    edges: dedupeEdges(edges),
    coverage: repositoryContextCoverage(
      PROVIDER,
      ECOSYSTEM,
      TARGET,
      [
        "contains",
        ...(unresolvedDependencies === 0 ? ["depends-on" as const] : []),
        "source-of",
        "test-of",
        "joins-file",
      ],
      unresolvedDependencies === 0 ? [] : ["depends-on"],
    ),
    files: [...files].sort(compareRepositoryText),
    sources: uniqueRepositorySources(sources),
  };
  return {
    producerSchemaVersion: 1,
    tool: "Gradle Tooling API",
    toolVersion: model.version,
    capabilities: [
      "projects",
      "project-dependencies",
      "source-directories",
      "tasks",
      "daemon-reuse",
    ],
    universe: `${ECOSYSTEM}:${shard.sources
      .map((source) => `${source.file}:${source.digest}`)
      .join("|")}`,
    target: TARGET,
    shards: [shard],
    warnings: [
      "Gradle Tooling API model evaluation was explicitly enabled; no build task was invoked.",
      ...(unresolvedDependencies === 0
        ? []
        : [
            `${unresolvedDependencies} Gradle project dependencies had ambiguous or absent Tooling API module identities.`,
          ]),
    ],
  };
}

function executeGradleModel(
  root: string,
  env: NodeJS.ProcessEnv,
): parseGradleRepositoryContextModel.IModel {
  const classpath = gradleToolingClasspath(env);
  if (classpath === undefined) {
    throw new Error(
      "Gradle Tooling API classpath is unavailable; set SAMCHON_GRAPH_GRADLE_TOOLING_CLASSPATH or GRADLE_HOME without downloading or mutating the project.",
    );
  }
  /* c8 ignore next 4 -- a coverage host exercises exactly one native Java
   * executable suffix; JAVA_HOME and PATH selection are both tested. */
  const java =
    env.JAVA_HOME !== undefined
      ? path.join(env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
      : "java";
  const source = path.resolve(
    __dirname,
    "..",
    "..",
    "sidecars",
    "gradle",
    "RepositoryContext.java",
  );
  const result = spawnSync(
    java,
    ["--class-path", classpath, source, path.resolve(root)],
    {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    /* c8 ignore start -- direct-spawn error details differ by operating
     * system; explicit classpath, GRADLE_HOME and failure paths are tested. */
    const failure =
      result.stderr || result.error?.message || "unknown error";
    /* c8 ignore stop */
    throw new Error(
      `Gradle Tooling API model failed: ${failure.trim()}`,
    );
  }
  /* c8 ignore start -- a successful external JVM boundary needs an installed
   * Tooling API; its complete output parser is tested independently. */
  return parseGradleRepositoryContextModel(result.stdout);
}
/* c8 ignore stop */

function gradleToolingClasspath(
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (env.SAMCHON_GRAPH_GRADLE_TOOLING_CLASSPATH?.trim()) {
    return env.SAMCHON_GRAPH_GRADLE_TOOLING_CLASSPATH;
  }
  if (!env.GRADLE_HOME?.trim()) return undefined;
  return [
    path.join(env.GRADLE_HOME, "lib", "*"),
    path.join(env.GRADLE_HOME, "lib", "plugins", "*"),
  ].join(path.delimiter);
}

function gradleInputs(root: string): string[] {
  return [
    "settings.gradle",
    "settings.gradle.kts",
    "build.gradle",
    "build.gradle.kts",
    "gradle.properties",
    "gradle/libs.versions.toml",
    "gradle/wrapper/gradle-wrapper.properties",
  ]
    .map((file) => path.join(root, file))
    .filter((file) => fs.existsSync(file));
}

function firstExisting(root: string, candidates: readonly string[]): string {
  return (
    candidates
      .map((file) => path.join(root, file))
      .find((file) => fs.existsSync(file)) ?? path.join(root, candidates[0]!)
  );
}

function dedupeEdges(
  input: readonly ISamchonRepositoryContextDump.IEdge[],
): ISamchonRepositoryContextDump.IEdge[] {
  const rows = new Map<string, ISamchonRepositoryContextDump.IEdge>();
  for (const edge of input) {
    rows.set(`${edge.kind}\0${edge.from}\0${edge.to}`, edge);
  }
  return [...rows.values()].sort(
    (left, right) =>
      compareRepositoryText(left.kind, right.kind) ||
      compareRepositoryText(left.from, right.from) ||
      compareRepositoryText(left.to, right.to),
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Gradle repository context cancelled");
  }
}
