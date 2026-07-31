import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ISamchonRepositoryContextDump } from "../structures";
import { spawnableCommand } from "../utils/spawnableCommand";
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

const PROVIDER = "pnpm-workspace";
const ECOSYSTEM = "pnpm";
const TARGET = "workspace";

interface IPnpmPackage {
  name?: string;
  version?: string;
  path: string;
  private?: boolean;
  dependencies?: Record<string, IPnpmDependency>;
  devDependencies?: Record<string, IPnpmDependency>;
  optionalDependencies?: Record<string, IPnpmDependency>;
}

interface IPnpmDependency {
  path?: string;
}

interface IPackageManifest {
  name?: string;
  files?: string[];
  scripts?: Record<string, string>;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
}

export const pnpmRepositoryContextProvider: IRepositoryContextProvider & {
  collect: typeof collectPnpmRepositoryContext;
} = {
  name: PROVIDER,
  ecosystem: ECOSYSTEM,
  authority: "tool-resolved",
  families: [
    "contains",
    "depends-on",
    "source-of",
    "entrypoint-of",
    "joins-file",
  ],
  buildInputs: [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "pnpm-workspace.yml",
  ],
  detect: (root) =>
    fs.existsSync(path.join(root, "pnpm-workspace.yaml")) ||
    fs.existsSync(path.join(root, "pnpm-workspace.yml")),
  open: (props) =>
    createRepositoryContextSession(
      pnpmRepositoryContextProvider,
      props,
      collectPnpmRepositoryContext,
    ),
  collect: collectPnpmRepositoryContext,
};

function collectPnpmRepositoryContext(
  props: IRepositoryContextProvider.IOpenProps & { signal?: AbortSignal },
  execute: typeof executePnpm = executePnpm,
): IRepositoryContextProvider.ICollection {
  throwIfAborted(props.signal);
  const packages = execute(props.root, props.env);
  throwIfAborted(props.signal);
  const byPath = new Map(
    packages.map((entry) => [path.resolve(entry.path), entry]),
  );
  const workspace = repositoryContextId(
    ECOSYSTEM,
    "workspace",
    repositoryContextFile(props.root, props.root),
  );
  const nodes: ISamchonRepositoryContextDump.INode[] = [
    {
      id: workspace,
      authority: "tool-resolved",
      kind: "workspace",
      name: path.basename(props.root),
      ecosystem: ECOSYSTEM,
      coordinate: ".",
      configuration: "default",
      external: false,
      evidence: workspaceEvidence(props.root),
    },
  ];
  const edges: ISamchonRepositoryContextDump.IEdge[] = [];
  const sources: ISamchonRepositoryContextDump.ISource[] = [
    ...workspaceInputs(props.root).map((file) =>
      repositoryContextSource(props.root, file),
    ),
  ];
  const files = new Set<string>();

  const packageIds = new Map<string, string>();
  for (const entry of packages.sort((left, right) =>
    compareRepositoryText(left.path, right.path),
  )) {
    const absolute = path.resolve(entry.path);
    const coordinate = repositoryContextFile(props.root, absolute);
    const manifestFile = path.join(absolute, "package.json");
    const manifest = readManifest(manifestFile);
    const packageId = repositoryContextId(
      ECOSYSTEM,
      "package",
      manifest.name ?? entry.name ?? coordinate,
    );
    packageIds.set(absolute, packageId);
    sources.push(repositoryContextSource(props.root, manifestFile));
    nodes.push({
      id: packageId,
      authority:
        manifest.name === undefined ? "tool-resolved" : "declared",
      kind: "package",
      name: manifest.name ?? entry.name ?? path.basename(absolute),
      ecosystem: ECOSYSTEM,
      coordinate,
      configuration: "default",
      external: false,
      evidence: repositoryContextEvidence(props.root, manifestFile),
    });
    edges.push({
      authority: "tool-resolved",
      kind: "contains",
      from: workspace,
      to: packageId,
    });
    appendManifestFacts(
      props.root,
      absolute,
      packageId,
      manifest,
      nodes,
      edges,
      files,
    );
  }
  for (const parent of new Set(
    packages
      .map((entry) => path.resolve(entry.path))
      .filter((directory) => directory !== path.resolve(props.root))
      .map((directory) => path.dirname(directory)),
  )) {
    sources.push(repositoryContextSource(props.root, parent));
  }

  for (const entry of packages) {
    const from = packageIds.get(path.resolve(entry.path))!;
    for (const dependency of dependencyRows(entry)) {
      if (dependency.path === undefined) continue;
      const target = packageIds.get(path.resolve(dependency.path));
      if (target !== undefined) {
        edges.push({
          authority: "tool-resolved",
          kind: "depends-on",
          from,
          to: target,
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
      ["contains", "depends-on", "entrypoint-of", "joins-file"],
      ["source-of"],
    ),
    files: [...files].sort(compareRepositoryText),
    sources: uniqueRepositorySources(sources),
  };
  return {
    producerSchemaVersion: 1,
    tool: "pnpm",
    toolVersion: detectPnpmVersion(props.root, props.env),
    capabilities: [
      "workspace-members",
      "resolved-local-dependencies",
      "declared-entrypoints",
      "declared-publication-roots",
    ],
    universe: `${ECOSYSTEM}:${shard.sources
      .map((source) => `${source.file}:${source.digest}`)
      .join("|")}`,
    target: TARGET,
    shards: [shard],
    warnings: [
      "pnpm source-of coverage is partial: only package-manifest publication roots are declared facts.",
    ],
  };
}

function appendManifestFacts(
  root: string,
  packageRoot: string,
  packageId: string,
  manifest: IPackageManifest,
  nodes: ISamchonRepositoryContextDump.INode[],
  edges: ISamchonRepositoryContextDump.IEdge[],
  files: Set<string>,
): void {
  const evidence = repositoryContextEvidence(
    root,
    path.join(packageRoot, "package.json"),
  );
  for (const rootName of manifest.files ?? []) {
    if (!isSimplePath(rootName)) continue;
    const coordinate = `${repositoryContextFile(root, packageRoot)}/${rootName}`;
    const generated = isGeneratedRoot(rootName);
    const id = repositoryContextId(
      ECOSYSTEM,
      generated ? "generated-root" : "source-root",
      coordinate,
    );
    nodes.push({
      id,
      authority: "declared",
      kind: generated ? "generated-root" : "source-root",
      name: rootName,
      ecosystem: ECOSYSTEM,
      coordinate,
      configuration: "default",
      external: false,
      root: repositoryContextFile(root, path.resolve(packageRoot, rootName)),
      evidence,
    });
    edges.push(
      { authority: "declared", kind: "contains", from: packageId, to: id },
      { authority: "declared", kind: "source-of", from: id, to: packageId },
    );
  }
  for (const [name, target] of entrypoints(manifest)) {
    const coordinate = `${repositoryContextFile(root, packageRoot)}:${name}`;
    const id = repositoryContextId(
      ECOSYSTEM,
      "entrypoint",
      coordinate,
    );
    const file = repositoryContextFile(root, path.resolve(packageRoot, target));
    files.add(file);
    nodes.push({
      id,
      authority: "declared",
      kind: "entrypoint",
      name,
      ecosystem: ECOSYSTEM,
      coordinate,
      configuration: "default",
      external: false,
      file,
      evidence,
    });
    edges.push(
      { authority: "declared", kind: "contains", from: packageId, to: id },
      {
        authority: "declared",
        kind: "entrypoint-of",
        from: id,
        to: packageId,
      },
      { authority: "declared", kind: "joins-file", from: id, to: file },
    );
  }
  for (const name of Object.keys(manifest.scripts ?? {}).sort(
    compareRepositoryText,
  )) {
    const coordinate = `${repositoryContextFile(root, packageRoot)}:${name}`;
    const id = repositoryContextId(ECOSYSTEM, "task", coordinate);
    nodes.push({
      id,
      authority: "declared",
      kind: "task",
      name,
      ecosystem: ECOSYSTEM,
      coordinate,
      configuration: "default",
      external: false,
      evidence,
    });
    edges.push({
      authority: "declared",
      kind: "contains",
      from: packageId,
      to: id,
    });
  }
}

function entrypoints(manifest: IPackageManifest): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const [name, value] of [
    ["main", manifest.main],
    ["module", manifest.module],
    ["types", manifest.types ?? manifest.typings],
  ] as const) {
    if (typeof value === "string") rows.push([name, value]);
  }
  if (typeof manifest.bin === "string") rows.push(["bin", manifest.bin]);
  else {
    for (const [name, value] of Object.entries(manifest.bin ?? {})) {
      rows.push([`bin:${name}`, value]);
    }
  }
  collectExports(manifest.exports, "exports", rows);
  return [...new Map(rows.map(([name, value]) => [`${name}\0${value}`, [name, value] as [string, string]])).values()].sort(
    ([left], [right]) => compareRepositoryText(left, right),
  );
}

function collectExports(
  value: unknown,
  name: string,
  rows: Array<[string, string]>,
): void {
  if (typeof value === "string") {
    rows.push([name, value]);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value).sort(([left], [right]) =>
      compareRepositoryText(left, right),
    )) {
      collectExports(child, `${name}:${key}`, rows);
    }
  }
}

function dependencyRows(entry: IPnpmPackage): IPnpmDependency[] {
  return Object.values({
    ...(entry.dependencies ?? {}),
    ...(entry.devDependencies ?? {}),
    ...(entry.optionalDependencies ?? {}),
  });
}

function readManifest(file: string): IPackageManifest {
  return JSON.parse(fs.readFileSync(file, "utf8")) as IPackageManifest;
}

function workspaceInputs(root: string): string[] {
  return [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-workspace.yml",
    "pnpm-lock.yaml",
  ].filter((file) => fs.existsSync(path.join(root, file)));
}

function workspaceEvidence(
  root: string,
): ISamchonRepositoryContextDump.IEvidence {
  const file = workspaceInputs(root).find((entry) =>
    entry.startsWith("pnpm-workspace."),
  );
  return repositoryContextEvidence(root, path.join(root, file ?? "package.json"));
}

function executePnpm(
  root: string,
  env: NodeJS.ProcessEnv,
): IPnpmPackage[] {
  /* c8 ignore next -- each coverage host has exactly one native shim suffix. */
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const invocation = spawnableCommand(
    command,
    ["list", "-r", "--json", "--depth", "0"],
    env,
  );
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
      `pnpm repository context failed: ${failure.trim()}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as IPnpmPackage[];
  if (!Array.isArray(parsed) || parsed.some((entry) => !entry.path)) {
    throw new Error("pnpm repository context returned a malformed package list");
  }
  return parsed;
}

function detectPnpmVersion(root: string, env: NodeJS.ProcessEnv): string {
  /* c8 ignore next -- each coverage host has exactly one native shim suffix. */
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const invocation = spawnableCommand(command, ["--version"], env);
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

function isSimplePath(value: string): boolean {
  return (
    value.trim() !== "" &&
    !value.includes("*") &&
    !value.startsWith("!") &&
    !path.isAbsolute(value)
  );
}

function isGeneratedRoot(value: string): boolean {
  return /^(?:lib|dist|build|out)(?:\/|$)/.test(value.replaceAll("\\", "/"));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("pnpm repository context cancelled");
  }
}
