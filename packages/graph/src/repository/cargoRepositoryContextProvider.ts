import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ISamchonRepositoryContextDump } from "../structures";
import { isSubPath } from "../utils/isSubPath";
import { IRepositoryContextProvider } from "./IRepositoryContextProvider";
import { createRepositoryContextSession } from "./createRepositoryContextSession";
import { repositoryContextFacts } from "./repositoryContextFacts";
import { resolveCargoCommand } from "./resolveCargoCommand";
import { workspaceDiscoveryDirectories } from "./workspaceDiscoveryDirectories";

const {
  compareRepositoryText,
  repositoryContextCoverage,
  repositoryContextEvidence,
  repositoryContextFile,
  repositoryContextId,
  repositoryContextSource,
  uniqueRepositorySources,
} = repositoryContextFacts;

const PROVIDER = "cargo-metadata";
const ECOSYSTEM = "cargo";
const TARGET = "workspace";

interface ICargoMetadata {
  packages: ICargoPackage[];
  workspace_members: string[];
  workspace_root: string;
  resolve: {
    nodes: Array<{ id: string; dependencies: string[]; features?: string[] }>;
  } | null;
}

interface ICargoPackage {
  id: string;
  name: string;
  version: string;
  manifest_path: string;
  targets: ICargoTarget[];
}

interface ICargoTarget {
  name: string;
  kind: string[];
  crate_types: string[];
  src_path: string;
}

export const cargoRepositoryContextProvider: IRepositoryContextProvider & {
  collect: typeof collectCargoRepositoryContext;
} = {
  name: PROVIDER,
  ecosystem: ECOSYSTEM,
  authority: "tool-resolved",
  families: [
    "contains",
    "depends-on",
    "source-of",
    "test-of",
    "entrypoint-of",
    "joins-file",
  ],
  buildInputs: [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain",
    "rust-toolchain.toml",
  ],
  detect: (root) => fs.existsSync(path.join(root, "Cargo.toml")),
  open: (props) =>
    createRepositoryContextSession(
      cargoRepositoryContextProvider,
      props,
      collectCargoRepositoryContext,
    ),
  collect: collectCargoRepositoryContext,
};

function collectCargoRepositoryContext(
  props: IRepositoryContextProvider.IOpenProps & { signal?: AbortSignal },
  execute: typeof executeCargoMetadata = executeCargoMetadata,
): IRepositoryContextProvider.ICollection {
  throwIfAborted(props.signal);
  const metadata = execute(props.root, props.env);
  throwIfAborted(props.signal);
  const members = new Set(metadata.workspace_members);
  const workspaceCoordinate = repositoryContextFile(
    props.root,
    metadata.workspace_root,
  );
  const workspaceId = repositoryContextId(
    ECOSYSTEM,
    "workspace",
    workspaceCoordinate,
  );
  const workspaceManifest = path.join(metadata.workspace_root, "Cargo.toml");
  const nodes: ISamchonRepositoryContextDump.INode[] = [
    {
      id: workspaceId,
      authority: "tool-resolved",
      kind: "workspace",
      name: path.basename(metadata.workspace_root),
      ecosystem: ECOSYSTEM,
      coordinate: workspaceCoordinate,
      configuration: "default",
      external: false,
      evidence: repositoryContextEvidence(props.root, workspaceManifest),
    },
  ];
  const edges: ISamchonRepositoryContextDump.IEdge[] = [];
  const sources: ISamchonRepositoryContextDump.ISource[] = [
    repositoryContextSource(props.root, workspaceManifest),
  ];
  const files = new Set<string>();
  const packageIds = new Map<string, string>();
  const configurations = new Map(
    (metadata.resolve?.nodes ?? []).map((node) => [
      node.id,
      cargoConfiguration(node.features),
    ]),
  );

  for (const pkg of [...metadata.packages].sort((left, right) =>
    compareRepositoryText(left.id, right.id),
  )) {
    const member = members.has(pkg.id);
    const coordinate = `${pkg.name}@${pkg.version}:${repositoryContextFile(
      props.root,
      path.dirname(pkg.manifest_path),
    )}`;
    const packageId = repositoryContextId(
      ECOSYSTEM,
      "package",
      coordinate,
      configurations.get(pkg.id) ?? "default",
    );
    packageIds.set(pkg.id, packageId);
    sources.push(repositoryContextSource(props.root, pkg.manifest_path));
    nodes.push({
      id: packageId,
      authority: "tool-resolved",
      kind: "package",
      name: pkg.name,
      ecosystem: ECOSYSTEM,
      coordinate,
      configuration: configurations.get(pkg.id) ?? "default",
      external: !member,
      evidence: repositoryContextEvidence(props.root, pkg.manifest_path),
    });
    if (member) {
      edges.push({
        authority: "tool-resolved",
        kind: "contains",
        from: workspaceId,
        to: packageId,
      });
    }
    appendCargoTargets(
      props.root,
      pkg,
      packageId,
      configurations.get(pkg.id) ?? "default",
      nodes,
      edges,
      files,
    );
  }

  for (const resolved of metadata.resolve?.nodes ?? []) {
    const from = packageIds.get(resolved.id);
    if (from === undefined) continue;
    for (const dependency of [...resolved.dependencies].sort(
      compareRepositoryText,
    )) {
      const to = packageIds.get(dependency);
      if (to !== undefined) {
        edges.push({
          authority: "tool-resolved",
          kind: "depends-on",
          from,
          to,
        });
      }
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
        "depends-on",
        "source-of",
        "test-of",
        "entrypoint-of",
        "joins-file",
      ],
    ),
    files: [...files].sort(compareRepositoryText),
    sources: uniqueRepositorySources([
      ...sources,
      ...workspaceDiscoveryDirectories(
        metadata.workspace_root,
        metadata.packages
          .filter((pkg) => members.has(pkg.id))
          .map((pkg) => path.dirname(pkg.manifest_path)),
      ).map((directory) => repositoryContextSource(props.root, directory)),
      ...["Cargo.lock", "rust-toolchain", "rust-toolchain.toml"]
        .map((file) => path.join(props.root, file))
        .filter((file) => fs.existsSync(file))
        .map((file) => repositoryContextSource(props.root, file)),
    ]),
  };
  return {
    producerSchemaVersion: 1,
    tool: "cargo metadata",
    toolVersion: cargoVersion(props.root, props.env),
    capabilities: [
      "workspace-members",
      "resolved-dependencies",
      "targets",
      "features",
      "source-files",
    ],
    universe: `${ECOSYSTEM}:${shard.sources
      .map((source) => `${source.file}:${source.digest}`)
      .join("|")}`,
    target: TARGET,
    shards: [shard],
    warnings: [],
  };
}

function appendCargoTargets(
  root: string,
  pkg: ICargoPackage,
  packageId: string,
  configuration: string,
  nodes: ISamchonRepositoryContextDump.INode[],
  edges: ISamchonRepositoryContextDump.IEdge[],
  files: Set<string>,
): void {
  for (const target of [...pkg.targets].sort((left, right) =>
    compareRepositoryText(
      `${left.name}:${left.kind.join(",")}`,
      `${right.name}:${right.kind.join(",")}`,
    ),
  )) {
    const targetCoordinate = `${pkg.id}#${target.name}:${target.kind.join("+")}`;
    const targetId = repositoryContextId(
      ECOSYSTEM,
      "build-target",
      targetCoordinate,
      configuration,
    );
    const sourceSetId = repositoryContextId(
      ECOSYSTEM,
      "source-set",
      targetCoordinate,
      configuration,
    );
    const evidence = repositoryContextEvidence(root, pkg.manifest_path);
    const file = repositoryContextFile(root, target.src_path);
    nodes.push(
      {
        id: targetId,
        authority: "tool-resolved",
        kind: "build-target",
        name: target.name,
        ecosystem: ECOSYSTEM,
        coordinate: targetCoordinate,
        configuration,
        external: !isSubPath(root, target.src_path),
        file,
        evidence,
      },
      {
        id: sourceSetId,
        authority: "tool-resolved",
        kind: "source-set",
        name: target.kind.join("+"),
        ecosystem: ECOSYSTEM,
        coordinate: targetCoordinate,
        configuration,
        external: !isSubPath(root, target.src_path),
        file,
        evidence,
      },
    );
    edges.push(
      {
        authority: "tool-resolved",
        kind: "contains",
        from: packageId,
        to: targetId,
      },
      {
        authority: "tool-resolved",
        kind: "contains",
        from: targetId,
        to: sourceSetId,
      },
      {
        authority: "tool-resolved",
        kind: "source-of",
        from: sourceSetId,
        to: packageId,
      },
      {
        authority: "tool-resolved",
        kind: "joins-file",
        from: sourceSetId,
        to: file,
      },
    );
    files.add(file);
    if (target.kind.includes("test") || target.kind.includes("bench")) {
      edges.push({
        authority: "tool-resolved",
        kind: "test-of",
        from: sourceSetId,
        to: packageId,
      });
    }
    if (
      target.kind.some((kind) =>
        ["bin", "example", "test", "bench"].includes(kind),
      )
    ) {
      const entrypointId = repositoryContextId(
        ECOSYSTEM,
        "entrypoint",
        targetCoordinate,
        configuration,
      );
      nodes.push({
        id: entrypointId,
        authority: "tool-resolved",
        kind: "entrypoint",
        name: target.name,
        ecosystem: ECOSYSTEM,
        coordinate: targetCoordinate,
        configuration,
        external: !isSubPath(root, target.src_path),
        file,
        evidence,
      });
      edges.push(
        {
          authority: "tool-resolved",
          kind: "contains",
          from: targetId,
          to: entrypointId,
        },
        {
          authority: "tool-resolved",
          kind: "entrypoint-of",
          from: entrypointId,
          to: targetId,
        },
        {
          authority: "tool-resolved",
          kind: "joins-file",
          from: entrypointId,
          to: file,
        },
      );
    }
  }
}

function cargoConfiguration(features: readonly string[] | undefined): string {
  if (features === undefined || features.length === 0) return "default";
  return `features=${[...features].sort(compareRepositoryText).join(",")}`;
}

function executeCargoMetadata(
  root: string,
  env: NodeJS.ProcessEnv,
): ICargoMetadata {
  const invocation = resolveCargoCommand(
    root,
    env,
    ["metadata", "--format-version", "1", "--locked", "--offline"],
  );
  if (invocation === undefined) {
    throw new Error(
      "cargo metadata failed without changing the project: cargo was not found",
    );
  }
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.status !== 0) {
    /* c8 ignore start -- direct-spawn errors and silent nonzero exits are
     * operating-system fallbacks; stderr failures are exercised here. */
    const failure =
      result.stderr || result.error?.message || "unknown error";
    /* c8 ignore stop */
    throw new Error(
      `cargo metadata failed without changing the project: ${failure.trim()}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as ICargoMetadata;
  if (
    !Array.isArray(parsed.packages) ||
    !Array.isArray(parsed.workspace_members) ||
    typeof parsed.workspace_root !== "string"
  ) {
    throw new Error("cargo metadata returned a malformed model");
  }
  return parsed;
}

function cargoVersion(root: string, env: NodeJS.ProcessEnv): string {
  const invocation = resolveCargoCommand(root, env, ["--version"]);
  if (invocation === undefined) return "";
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  return result.status === 0 ? result.stdout.trim() : "";
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
    throw new Error("cargo repository context cancelled");
  }
}
