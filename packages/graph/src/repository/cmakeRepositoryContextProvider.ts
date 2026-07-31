import fs from "node:fs";
import path from "node:path";

import { ISamchonRepositoryContextDump } from "../structures";
import { IRepositoryContextProvider } from "./IRepositoryContextProvider";
import { createRepositoryContextSession } from "./createRepositoryContextSession";
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

const PROVIDER = "cmake-file-api";
const ECOSYSTEM = "cmake";

interface ICmakeIndex {
  cmake?: { version?: { string?: string } };
  reply?: Record<string, { jsonFile?: string }>;
  objects?: Array<{ kind?: string; jsonFile?: string }>;
}

interface ICmakeCodemodel {
  configurations: ICmakeConfiguration[];
  paths: { source: string; build: string };
}

interface ICmakeFiles {
  paths: { source: string; build: string };
  inputs: Array<{ path: string }>;
}

interface ICmakeConfiguration {
  name: string;
  projects: Array<{
    name: string;
    directoryIndexes: number[];
    targetIndexes: number[];
  }>;
  directories: Array<{
    source: string;
    build: string;
    projectIndex?: number;
    targetIndexes: number[];
  }>;
  targets: Array<{
    name: string;
    id: string;
    directoryIndex: number;
    projectIndex: number;
    jsonFile: string;
  }>;
}

interface ICmakeTarget {
  name: string;
  id: string;
  type: string;
  paths: { source: string; build: string };
  sources?: Array<{ path: string; isGenerated?: boolean }>;
  dependencies?: Array<{ id: string }>;
  artifacts?: Array<{ path: string }>;
}

export const cmakeRepositoryContextProvider: IRepositoryContextProvider & {
  collect: typeof collectCmakeRepositoryContext;
} = {
  name: PROVIDER,
  ecosystem: ECOSYSTEM,
  authority: "tool-resolved",
  families: [
    "contains",
    "depends-on",
    "source-of",
    "produces",
    "entrypoint-of",
    "joins-file",
  ],
  buildInputs: [
    "CMakeLists.txt",
    "CMakePresets.json",
    "CMakeUserPresets.json",
  ],
  detect: (root) => fs.existsSync(path.join(root, "CMakeLists.txt")),
  open: (props) =>
    createRepositoryContextSession(
      cmakeRepositoryContextProvider,
      props,
      collectCmakeRepositoryContext,
    ),
  collect: collectCmakeRepositoryContext,
};

function collectCmakeRepositoryContext(
  props: IRepositoryContextProvider.IOpenProps & { signal?: AbortSignal },
): IRepositoryContextProvider.ICollection {
  throwIfAborted(props.signal);
  const reply = locateReply(props.root, props.env);
  if (reply === undefined) {
    throw new Error(
      "CMake File API reply is unavailable. Configure the project with codemodel-v2 and cmakeFiles-v1 queries first; repository-context indexing will not write a query or run configuration implicitly.",
    );
  }
  const indexFile = latestIndex(reply);
  const index = readJson<ICmakeIndex>(indexFile);
  const codemodelRef = objectReference(index, "codemodel", "codemodel-v2");
  const cmakeFilesRef = objectReference(
    index,
    "cmakeFiles",
    "cmakeFiles-v1",
  );
  if (codemodelRef === undefined || cmakeFilesRef === undefined) {
    throw new Error(
      "CMake File API index must contain codemodel-v2 and cmakeFiles-v1 replies",
    );
  }
  const codemodelFile = path.join(reply, codemodelRef);
  const codemodel = readJson<ICmakeCodemodel>(codemodelFile);
  const cmakeFilesFile = path.join(reply, cmakeFilesRef);
  const cmakeFiles = readJson<ICmakeFiles>(cmakeFilesFile);
  const modelInputs = [
    repositoryContextSource(props.root, cmakeFilesFile),
    ...cmakeFiles.inputs.map((input) =>
      repositoryContextSource(
        props.root,
        path.resolve(cmakeFiles.paths.source, input.path),
      ),
    ),
  ];
  const configurations = selectConfigurations(
    codemodel.configurations,
    props.env.SAMCHON_GRAPH_CMAKE_CONFIGURATION,
  );
  const shards = configurations.map((configuration) =>
    cmakeConfigurationShard(
      props.root,
      reply,
      indexFile,
      codemodelFile,
      codemodel,
      configuration,
      modelInputs,
    ),
  );
  throwIfAborted(props.signal);
  const sources = uniqueRepositorySources(
    shards.flatMap((shard) => shard.sources),
  );
  return {
    producerSchemaVersion: 1,
    tool: "CMake File API",
    toolVersion: index.cmake?.version?.string ?? "",
    capabilities: [
      "codemodel-v2",
      "cmakeFiles-v1",
      "projects",
      "targets",
      "target-dependencies",
      "sources",
      "artifacts",
    ],
    universe: `${ECOSYSTEM}:${sources
      .map((source) => `${source.file}:${source.digest}`)
      .join("|")}`,
    /* c8 ignore next -- selectConfigurations rejects an empty shard set. */
    target: shards[0]?.target ?? "default",
    shards,
    warnings: [
      "CMake context uses an existing File API reply and does not configure or mutate the project.",
    ],
  };
}

function objectReference(
  index: ICmakeIndex,
  kind: string,
  replyPrefix: string,
): string | undefined {
  return (
    index.objects?.find((entry) => entry.kind === kind)?.jsonFile ??
    Object.entries(index.reply ?? {}).find(([key]) =>
      key.startsWith(replyPrefix),
    )?.[1].jsonFile
  );
}

function cmakeConfigurationShard(
  root: string,
  reply: string,
  indexFile: string,
  codemodelFile: string,
  codemodel: ICmakeCodemodel,
  configuration: ICmakeConfiguration,
  modelInputs: readonly ISamchonRepositoryContextDump.ISource[],
) {
  const target = configuration.name || "default";
  const workspaceId = repositoryContextId(
    ECOSYSTEM,
    "workspace",
    repositoryContextFile(root, codemodel.paths.source),
    target,
  );
  const evidenceFile = path.join(codemodel.paths.source, "CMakeLists.txt");
  const evidence = repositoryContextEvidence(root, evidenceFile);
  const nodes: ISamchonRepositoryContextDump.INode[] = [
    {
      id: workspaceId,
      kind: "workspace",
      name: path.basename(codemodel.paths.source),
      ecosystem: ECOSYSTEM,
      coordinate: repositoryContextFile(root, codemodel.paths.source),
      configuration: target,
      external: false,
      evidence,
    },
  ];
  const edges: ISamchonRepositoryContextDump.IEdge[] = [];
  const files = new Set<string>();
  const sources = [
    repositoryContextSource(root, indexFile),
    repositoryContextSource(root, codemodelFile),
    repositoryContextSource(root, evidenceFile),
    ...modelInputs,
    ...configuration.directories.map((directory) =>
      repositoryContextSource(
        root,
        path.join(codemodel.paths.source, directory.source, "CMakeLists.txt"),
      ),
    ),
  ];
  assertCmakeReplyFresh(indexFile, sources, root);
  const projectIds = new Map<number, string>();
  const targetIds = new Map<string, string>();

  configuration.projects.forEach((project, index) => {
    const projectId = repositoryContextId(
      ECOSYSTEM,
      "project",
      project.name,
      target,
    );
    projectIds.set(index, projectId);
    nodes.push({
      id: projectId,
      kind: "project",
      name: project.name,
      ecosystem: ECOSYSTEM,
      coordinate: project.name,
      configuration: target,
      external: false,
      evidence,
    });
    edges.push({ kind: "contains", from: workspaceId, to: projectId });
  });

  const details = new Map<string, ICmakeTarget>();
  for (const summary of configuration.targets) {
    const detailFile = path.join(reply, summary.jsonFile);
    const detail = readJson<ICmakeTarget>(detailFile);
    details.set(summary.id, detail);
    sources.push(repositoryContextSource(root, detailFile));
    const projectId = projectIds.get(summary.projectIndex)!;
    const targetId = repositoryContextId(
      ECOSYSTEM,
      "build-target",
      summary.id,
      target,
    );
    targetIds.set(summary.id, targetId);
    nodes.push({
      id: targetId,
      kind: "build-target",
      name: summary.name,
      ecosystem: ECOSYSTEM,
      coordinate: summary.id,
      configuration: target,
      external: false,
      evidence,
    });
    edges.push({ kind: "contains", from: projectId, to: targetId });
    appendCmakeSources(
      root,
      target,
      projectId,
      targetId,
      detail,
      nodes,
      edges,
      files,
    );
    if (detail.type === "EXECUTABLE") {
      const entrypointId = repositoryContextId(
        ECOSYSTEM,
        "entrypoint",
        summary.id,
        target,
      );
      nodes.push({
        id: entrypointId,
        kind: "entrypoint",
        name: detail.name,
        ecosystem: ECOSYSTEM,
        coordinate: summary.id,
        configuration: target,
        external: false,
        evidence,
      });
      edges.push(
        { kind: "contains", from: targetId, to: entrypointId },
        { kind: "entrypoint-of", from: entrypointId, to: targetId },
      );
    }
    for (const artifact of detail.artifacts ?? []) {
      const artifactPath = path.resolve(detail.paths.build, artifact.path);
      const coordinate = repositoryContextFile(
        root,
        path.dirname(artifactPath),
      );
      const generatedId = repositoryContextId(
        ECOSYSTEM,
        "generated-root",
        `${summary.id}:${coordinate}`,
        target,
      );
      nodes.push({
        id: generatedId,
        kind: "generated-root",
        name: path.basename(path.dirname(artifactPath)),
        ecosystem: ECOSYSTEM,
        coordinate,
        configuration: target,
        external: !isInside(root, artifactPath),
        evidence,
      });
      edges.push(
        { kind: "contains", from: targetId, to: generatedId },
        { kind: "produces", from: targetId, to: generatedId },
      );
    }
  }
  for (const [id, detail] of details) {
    const from = targetIds.get(id)!;
    for (const dependency of detail.dependencies ?? []) {
      const to = targetIds.get(dependency.id);
      if (to !== undefined) edges.push({ kind: "depends-on", from, to });
    }
  }
  return {
    key: `${PROVIDER}:${target}`,
    target,
    nodes: dedupeNodes(nodes),
    edges: dedupeEdges(edges),
    coverage: repositoryContextCoverage(
      PROVIDER,
      ECOSYSTEM,
      target,
      [
        "contains",
        "depends-on",
        "source-of",
        "produces",
        "entrypoint-of",
        "joins-file",
      ],
    ),
    files: [...files].sort(compareRepositoryText),
    sources: uniqueRepositorySources(sources),
  };
}

function appendCmakeSources(
  root: string,
  configuration: string,
  projectId: string,
  targetId: string,
  detail: ICmakeTarget,
  nodes: ISamchonRepositoryContextDump.INode[],
  edges: ISamchonRepositoryContextDump.IEdge[],
  files: Set<string>,
): void {
  const roots = new Map<
    string,
    { generated: boolean; files: string[] }
  >();
  for (const source of detail.sources ?? []) {
    // Codemodel-v2 makes a source path relative only when it lies inside the
    // top-level source tree; generated files outside that tree are absolute.
    const absolute = path.resolve(detail.paths.source, source.path);
    const directory = path.dirname(absolute);
    const row = roots.get(directory) ?? {
      generated: source.isGenerated === true,
      files: [],
    };
    row.generated ||= source.isGenerated === true;
    row.files.push(absolute);
    roots.set(directory, row);
  }
  for (const [directory, row] of [...roots].sort(([left], [right]) =>
    compareRepositoryText(left, right),
  )) {
    const coordinate = `${detail.id}:${repositoryContextFile(root, directory)}`;
    const sourceId = repositoryContextId(
      ECOSYSTEM,
      row.generated ? "generated-root" : "source-root",
      coordinate,
      configuration,
    );
    nodes.push({
      id: sourceId,
      kind: row.generated ? "generated-root" : "source-root",
      name: path.basename(directory),
      ecosystem: ECOSYSTEM,
      coordinate,
      configuration,
      external: !isInside(root, directory),
      evidence: repositoryContextEvidence(
        root,
        path.join(detail.paths.source, "CMakeLists.txt"),
      ),
    });
    edges.push(
      { kind: "contains", from: targetId, to: sourceId },
      { kind: "source-of", from: sourceId, to: projectId },
    );
    for (const file of row.files) {
      const joined = repositoryContextFile(root, file);
      files.add(joined);
      edges.push({ kind: "joins-file", from: sourceId, to: joined });
    }
  }
}

function assertCmakeReplyFresh(
  indexFile: string,
  sources: readonly ISamchonRepositoryContextDump.ISource[],
  root: string,
): void {
  const replyTime = fs.statSync(indexFile).mtimeMs;
  for (const source of sources) {
    if (!source.file.endsWith("CMakeLists.txt")) continue;
    const file = path.resolve(root, source.file);
    if (fs.existsSync(file) && fs.statSync(file).mtimeMs > replyTime) {
      throw new Error(
        `CMake File API reply predates ${source.file}; reconfigure the project before repository-context indexing.`,
      );
    }
  }
}

function selectConfigurations(
  configurations: readonly ICmakeConfiguration[],
  requested: string | undefined,
): readonly ICmakeConfiguration[] {
  if (configurations.length === 0) {
    throw new Error("CMake File API codemodel has no configuration");
  }
  if (configurations.length <= 1) return configurations;
  if (requested !== undefined) {
    const selected = configurations.find(
      (configuration) => configuration.name === requested,
    );
    if (selected !== undefined) return [selected];
  }
  throw new Error(
    "CMake File API returned multiple configurations; select one with SAMCHON_GRAPH_CMAKE_CONFIGURATION before joining it to one repository-context generation.",
  );
}

function locateReply(
  root: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const candidates = [
    env.SAMCHON_GRAPH_CMAKE_REPLY,
    path.join(root, ".cmake", "api", "v1", "reply"),
    path.join(root, "build", ".cmake", "api", "v1", "reply"),
    path.join(root, "cmake-build-debug", ".cmake", "api", "v1", "reply"),
    path.join(root, "cmake-build-release", ".cmake", "api", "v1", "reply"),
  ].filter((value): value is string => value !== undefined);
  return candidates.map((value) => path.resolve(value)).find((value) =>
    fs.existsSync(value),
  );
}

function latestIndex(reply: string): string {
  const files = fs
    .readdirSync(reply)
    .filter((file) => /^index-.*\.json$/.test(file))
    .sort(compareRepositoryText);
  const latest = files.at(-1);
  if (latest === undefined) {
    throw new Error("CMake File API reply directory has no index");
  }
  return path.join(reply, latest);
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function dedupeNodes(
  input: readonly ISamchonRepositoryContextDump.INode[],
): ISamchonRepositoryContextDump.INode[] {
  const rows = new Map<string, ISamchonRepositoryContextDump.INode>();
  for (const node of input) rows.set(node.id, node);
  return [...rows.values()].sort((left, right) =>
    compareRepositoryText(left.id, right.id),
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

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("CMake repository context cancelled");
  }
}
