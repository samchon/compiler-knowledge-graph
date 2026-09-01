import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ISamchonRepositoryContextDump } from "../structures";
import { isSubPath } from "../utils/isSubPath";
import { spawnableCommand } from "../utils/spawnableCommand";
import { IRepositoryContextProvider } from "./IRepositoryContextProvider";
import { createRepositoryContextSession } from "./createRepositoryContextSession";
import { repositoryContextFacts } from "./repositoryContextFacts";
import { topologyPhaseTrace } from "./topologyPhaseTrace";
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
      external: !isSubPath(props.root, absolute),
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
  for (const directory of workspaceDiscoveryDirectories(
    props.root,
    packages.map((entry) => path.resolve(entry.path)),
  )) {
    sources.push(repositoryContextSource(props.root, directory));
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
    const declared = declaredRoot(packageRoot, rootName);
    if (declared === undefined) continue;
    const coordinate = repositoryContextFile(root, declared.absolute);
    const generated = declared.generated;
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
      external: !isSubPath(root, declared.absolute),
      root: repositoryContextFile(root, declared.absolute),
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
    const absoluteTarget = path.resolve(packageRoot, target);
    const file = repositoryContextFile(root, absoluteTarget);
    files.add(file);
    nodes.push({
      id,
      authority: "declared",
      kind: "entrypoint",
      name,
      ecosystem: ECOSYSTEM,
      coordinate,
      configuration: "default",
      external: !isSubPath(root, absoluteTarget),
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    malformedManifest(file, String(error));
  }
  if (!isRecord(parsed)) malformedManifest(file, "root must be an object");
  for (const field of ["name", "main", "module", "types", "typings"] as const) {
    if (parsed[field] !== undefined && typeof parsed[field] !== "string") {
      malformedManifest(file, `${field} must be a string`);
    }
  }
  if (
    parsed.files !== undefined &&
    (!Array.isArray(parsed.files) ||
      parsed.files.some((entry) => typeof entry !== "string"))
  ) {
    malformedManifest(file, "files must be a string array");
  }
  if (!optionalStringRecord(parsed.scripts)) {
    malformedManifest(file, "scripts must be a string record");
  }
  if (
    parsed.bin !== undefined &&
    typeof parsed.bin !== "string" &&
    !stringRecord(parsed.bin)
  ) {
    malformedManifest(file, "bin must be a string or string record");
  }
  if (!validExports(parsed.exports)) {
    malformedManifest(file, "exports must contain only string, null, array, or object targets");
  }
  return parsed as IPackageManifest;
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
  const started = performance.now();
  try {
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
    return parsePnpmPackages(result.stdout);
  } finally {
    topologyPhaseTrace(PROVIDER, "model-query", started);
  }
}

function detectPnpmVersion(root: string, env: NodeJS.ProcessEnv): string {
  const started = performance.now();
  try {
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
  } finally {
    topologyPhaseTrace(PROVIDER, "tool-startup", started);
  }
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
    !path.isAbsolute(value) &&
    path.win32.parse(value).root === "" &&
    !value.replaceAll("\\", "/").split("/").includes("..")
  );
}

function declaredRoot(
  packageRoot: string,
  value: string,
): { absolute: string; generated: boolean } | undefined {
  if (!isSimplePath(value)) return undefined;
  const absolute = path.resolve(packageRoot, value);
  const generated = isGeneratedRoot(value);
  const stat = fs.statSync(absolute, { throwIfNoEntry: false });
  if (stat?.isDirectory() === true || (stat === undefined && generated)) {
    return { absolute, generated };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function optionalStringRecord(value: unknown): boolean {
  return value === undefined || stringRecord(value);
}

function parsePnpmPackages(text: string): IPnpmPackage[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) malformedPnpmModel("root must be an array");
  for (const [index, entry] of parsed.entries()) {
    if (!isRecord(entry)) malformedPnpmModel(`[${index}] must be an object`);
    if (typeof entry.path !== "string" || entry.path.trim() === "") {
      malformedPnpmModel(`[${index}].path must be a nonempty string`);
    }
    for (const field of ["name", "version"] as const) {
      if (entry[field] !== undefined && typeof entry[field] !== "string") {
        malformedPnpmModel(`[${index}].${field} must be a string`);
      }
    }
    if (entry.private !== undefined && typeof entry.private !== "boolean") {
      malformedPnpmModel(`[${index}].private must be a boolean`);
    }
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ] as const) {
      const dependencies = entry[field];
      if (dependencies === undefined) continue;
      if (!isRecord(dependencies)) {
        malformedPnpmModel(`[${index}].${field} must be an object`);
      }
      for (const [name, dependency] of Object.entries(dependencies)) {
        if (
          !isRecord(dependency) ||
          (dependency.path !== undefined && typeof dependency.path !== "string")
        ) {
          malformedPnpmModel(
            `[${index}].${field}.${name} must be an object with an optional string path`,
          );
        }
      }
    }
  }
  return parsed as IPnpmPackage[];
}

function malformedPnpmModel(reason: string): never {
  throw new Error(`pnpm repository context returned a malformed package list: ${reason}`);
}

function validExports(value: unknown): boolean {
  if (value === undefined || value === null || typeof value === "string") {
    return true;
  }
  if (Array.isArray(value)) return value.every(validExports);
  return isRecord(value) && Object.values(value).every(validExports);
}

function malformedManifest(file: string, reason: string): never {
  throw new Error(`pnpm package manifest ${file} is malformed: ${reason}`);
}

function isGeneratedRoot(value: string): boolean {
  return /^(?:lib|dist|build|out)(?:\/|$)/.test(value.replaceAll("\\", "/"));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("pnpm repository context cancelled");
  }
}
