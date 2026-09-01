#!/usr/bin/env node
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  SamchonRepositoryContextMemory,
  createResidentRepositoryContextSource,
} from "@samchon/graph";

import { parseArgs, repositoryRoot } from "./process.mjs";

const QUESTION =
  "Explain the workspaces, applications and packages, their source/test/generated roots and entrypoints, and the project dependency flow relevant to @samchon/graph.";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.cwd ?? repositoryRoot);
const out =
  args.out === undefined ? undefined : path.resolve(process.cwd(), args.out);

const baseline = directOrientation(root);
const client = new Client({
  name: "samchon-graph-topology-orientation",
  version: "1.0.0",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    path.join(repositoryRoot, "packages", "graph", "lib", "bin.js"),
    "--mode",
    "static",
    "--cwd",
    root,
  ],
  stderr: "pipe",
});
const topologyResident = createResidentRepositoryContextSource(root);

try {
  const request = {
    question: QUESTION,
    draft: { reason: "repository orientation", type: "topology" },
    review: "compare the indexed topology with direct manifest orientation",
    request: {
      type: "topology",
      relations: [
        "contains",
        "depends-on",
        "source-of",
        "test-of",
        "produces",
        "invokes",
        "entrypoint-of",
        "joins-file",
      ],
      limit: 200,
      joinLimit: 64,
    },
  };
  const modelColdStarted = performance.now();
  const modelCold = await topologyResident.load();
  const topologyModelColdMs = Math.round(
    performance.now() - modelColdStarted,
  );
  const modelNoopStarted = performance.now();
  const modelNoop = await topologyResident.load();
  const topologyModelNoopMs = Math.round(
    performance.now() - modelNoopStarted,
  );
  const readyStarted = performance.now();
  await client.connect(transport);
  const mcpReadyMs = Math.round(performance.now() - readyStarted);
  const coldStarted = performance.now();
  const cold = await callTopology(client, request);
  const coldMs = Math.round(performance.now() - coldStarted);
  const noopStarted = performance.now();
  const noop = await callTopology(client, request);
  const noopMs = Math.round(performance.now() - noopStarted);
  if (cold.result.type !== "topology" || noop.result.type !== "topology") {
    throw new Error(
      "topology orientation experiment received a non-topology result",
    );
  }

  const projects = cold.result.nodes.filter((node) =>
    ["workspace", "project"].includes(node.kind),
  );
  const packages = cold.result.nodes.filter((node) => node.kind === "package");
  const roots = cold.result.nodes.filter((node) =>
    ["source-root", "generated-root"].includes(node.kind),
  );
  const entrypoints = cold.result.nodes.filter(
    (node) => node.kind === "entrypoint",
  );
  const dependencies = cold.result.edges.filter(
    (edge) => edge.kind === "depends-on",
  );
  const names = new Map(cold.result.nodes.map((node) => [node.id, node.name]));
  const dependencyFacts = dependencies.map((edge) => ({
    from: names.get(edge.from) ?? edge.from,
    to: names.get(edge.to) ?? edge.to,
    authority: edge.authority,
  }));
  const joins = cold.result.edges.filter((edge) => edge.kind === "joins-file");
  const joinedFiles = new Set(joins.map((edge) => edge.to));
  const normalizationJoinStarted = performance.now();
  const localProjection = new SamchonRepositoryContextMemory(modelCold).inspect(
    request.request,
    {
      state: "compatible",
      topologyInputGeneration: modelCold.inputGeneration,
      codeInputGeneration: "orientation-experiment",
    },
    joinedFiles,
  );
  const normalizationJoinMs = Math.round(
    performance.now() - normalizationJoinStarted,
  );
  const semanticFollowUpFiles = [
    "packages/graph/src/index.ts",
    "packages/graph/src/SamchonGraphApplication.ts",
  ].filter((file) => joinedFiles.has(file));
  const unsupported = cold.result.coverage
    .filter((row) => row.state === "unsupported")
    .map((row) => row.family)
    .sort(compareText);
  const result = {
    schemaVersion: 1,
    question: QUESTION,
    root,
    method: {
      agentCalls: 0,
      inputTokens: 0,
      paidAgent: false,
      note: "This deterministic zero-spend run compares two real stdio MCP topology calls with direct repository orientation; it is not an agent A/B benchmark.",
    },
    indexed: {
      topologyMcpCalls: 2,
      topologyModelLoads: 2,
      rgCalls: 0,
      directoryWalks: 0,
      rawManifestReads: 0,
      mcpReadyMs,
      coldTopologyMs: coldMs,
      warmTopologyMcpMs: noopMs,
      topologyModelColdMs,
      topologyModelNoopMs,
      normalizationJoinMs,
      phases: {
        toolStartupMs: baseline.toolStartupMs,
        modelQueryMs: baseline.modelQueryMs,
        normalizationJoinMs,
        mcpReadyMs,
      },
      provenance: cold.result.provenance,
      coverage: cold.result.coverage,
      join: cold.result.join,
      projects: projects.length,
      packages: packages.length,
      roots: roots.length,
      entrypoints: entrypoints.length,
      dependencies: dependencies.length,
      joins: joins.length,
      semanticFollowUpFiles,
      unsupported,
      inferredFacts: cold.result.nodes.filter(
        (node) => node.authority === "inferred",
      ).length,
      facts: {
        projects: projects.map(
          ({ kind, name, coordinate, authority, evidence }) =>
            ({ kind, name, coordinate, authority, evidence }),
        ),
        packages: packages.map(
          ({ name, coordinate, authority, evidence }) =>
            ({ name, coordinate, authority, evidence }),
        ),
        roots: roots.map(
          ({ kind, name, root, authority, evidence }) =>
            ({ kind, name, root, authority, evidence }),
        ),
        entrypoints: entrypoints.map(
          ({ name, file, external, authority, evidence }) =>
            ({ name, file, external, authority, evidence }),
        ),
        dependencies: dependencyFacts,
      },
    },
    direct: baseline,
    correctness: {
      packageCountMatches: packages.length === baseline.packages,
      projectSetMatches: sameStrings(
        projects.map((node) => node.coordinate),
        baseline.facts.projects,
      ),
      packageSetMatches: sameStrings(
        packages.map((node) => node.name),
        baseline.facts.packages,
      ),
      rootSetMatches: sameStrings(
        roots.map((node) => node.root),
        baseline.facts.roots,
      ),
      entrypointSetMatches: sameStrings(
        entrypoints.map((node) => node.file),
        baseline.facts.entrypoints,
      ),
      dependencySetMatches: sameStrings(
        dependencyFacts.map((edge) => `${edge.from} -> ${edge.to}`),
        baseline.facts.dependencies,
      ),
      everyPackageHasEvidence: packages.every(
        (node) => node.evidence !== undefined,
      ),
      noInferredClaims: cold.result.nodes.every(
        (node) => node.authority !== "inferred",
      ),
      hasWorkspaceProject: projects.some(
        (node) => node.kind === "workspace" && node.coordinate === ".",
      ),
      hasGraphSourceAndGeneratedRoots:
        roots.some((node) => node.root === "packages/graph/src") &&
        roots.some((node) => node.root === "packages/graph/lib"),
      hasGraphCliEntrypoint: entrypoints.some(
        (node) => node.file === "packages/graph/lib/bin.js",
      ),
      hasExperimentDependencyOnGraph: dependencyFacts.some(
        (edge) =>
          edge.from === "@samchon/graph-experiment" &&
          edge.to === "@samchon/graph",
      ),
      fileJoinsWereFenced: cold.result.join.state === "compatible",
      warmMcpMatchesCold:
        JSON.stringify(noop.result) === JSON.stringify(cold.result),
      topologyModelNoopReusedGeneration: modelCold === modelNoop,
      topologyModelNoopUnder250Ms: topologyModelNoopMs < 250,
      normalizationJoinProjectionIsCompatible:
        localProjection.join.state === "compatible" &&
        localProjection.edges.some((edge) => edge.kind === "joins-file"),
      semanticFollowUpReachedGraphApi: semanticFollowUpFiles.length === 2,
    },
    limitations: [
      "The direct comparison uses pnpm's resolved member list plus raw manifests; it does not claim shell or source reads are eliminated.",
      "The public MCP boundary exposes handshake, cold-call and warm-call latency; those calls include code-graph validation and wire costs, while the separate topology-model no-op is the issue's validated-input target.",
      "The cold MCP call intentionally keeps internal graph build, model query, normalization and join time aggregated because the public boundary does not expose those private phases.",
      "The phase probes separately execute the same pnpm startup/model commands and the public in-memory topology join; they describe each phase and are not claimed to sum to the independently measured cold MCP call.",
      ...unsupported.map((family) =>
        `The pnpm provider reports ${family} as unsupported for this generation.`,
      ),
    ],
  };
  if (!Object.values(result.correctness).every((value) => value === true)) {
    const latencies = {
      mcpReadyMs,
      coldMs,
      noopMs,
      topologyModelColdMs,
      topologyModelNoopMs,
      normalizationJoinMs,
    };
    throw new Error(
      `topology orientation correctness failed: ${JSON.stringify(result.correctness)}; ` +
        `latencies=${JSON.stringify(latencies)}`,
    );
  }
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (out === undefined) process.stdout.write(text);
  else {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text);
    process.stdout.write(`topology orientation report: ${out}\n`);
  }
} finally {
  await client.close().catch(() => undefined);
  await topologyResident.close();
}

async function callTopology(client, request) {
  const response = await client.callTool(
    { name: "inspect_code_graph", arguments: request },
    undefined,
    { timeout: 120_000 },
  );
  const payload = response.structuredContent;
  if (payload === undefined || payload === null || typeof payload !== "object") {
    throw new Error(
      "topology orientation MCP call returned no structured content",
    );
  }
  return payload;
}

function directOrientation(root) {
  const started = performance.now();
  const startupStarted = performance.now();
  const versioned = runPnpm(root, ["--version"]);
  const toolStartupMs = Math.round(performance.now() - startupStarted);
  if (versioned.status !== 0) {
    throw new Error(`direct pnpm startup failed: ${versioned.stderr}`);
  }
  const modelStarted = performance.now();
  const listed = runPnpm(root, ["list", "-r", "--json", "--depth", "0"]);
  const modelQueryMs = Math.round(performance.now() - modelStarted);
  if (listed.status !== 0) {
    throw new Error(`direct pnpm orientation failed: ${listed.stderr}`);
  }
  const packages = JSON.parse(listed.stdout);
  if (!Array.isArray(packages)) {
    throw new Error("direct pnpm orientation returned a non-array model");
  }
  const manifestStarted = performance.now();
  const rows = packages.map((pkg) => {
    const packageRoot = path.resolve(pkg.path);
    const file = path.join(packageRoot, "package.json");
    return {
      pkg,
      packageRoot,
      file,
      manifest: JSON.parse(fs.readFileSync(file, "utf8")),
    };
  });
  const unique = [...new Set(rows.map((row) => row.file))];
  const manifestReadMs = Math.round(performance.now() - manifestStarted);
  const names = new Map(
    rows.map((row) => [
      row.packageRoot,
      row.manifest.name ?? row.pkg.name ?? directFile(root, row.packageRoot),
    ]),
  );
  const dependencyFacts = new Set();
  const rootFacts = new Set();
  const entrypointFacts = new Set();
  for (const row of rows) {
    const from = names.get(row.packageRoot);
    for (const dependency of Object.values({
      ...(row.pkg.dependencies ?? {}),
      ...(row.pkg.devDependencies ?? {}),
      ...(row.pkg.optionalDependencies ?? {}),
    })) {
      if (typeof dependency?.path !== "string") continue;
      const to = names.get(path.resolve(dependency.path));
      if (to !== undefined) dependencyFacts.add(`${from} -> ${to}`);
    }
    for (const declared of directRoots(row.packageRoot, row.manifest)) {
      rootFacts.add(directFile(root, declared));
    }
    for (const target of directEntrypoints(row.manifest)) {
      entrypointFacts.add(
        directFile(root, path.resolve(row.packageRoot, target)),
      );
    }
  }
  const facts = {
    projects: ["."],
    packages: sortedUnique(names.values()),
    roots: sortedUnique(rootFacts),
    entrypoints: sortedUnique(entrypointFacts),
    dependencies: sortedUnique(dependencyFacts),
  };
  return {
    shellCalls: 2,
    rgCalls: 0,
    directoryWalks: 0,
    rawManifestReads: unique.length,
    tool: "pnpm",
    toolVersion: versioned.stdout.trim(),
    toolStartupMs,
    modelQueryMs,
    manifestReadMs,
    packages: facts.packages.length,
    roots: facts.roots.length,
    entrypoints: facts.entrypoints.length,
    dependencies: facts.dependencies.length,
    facts,
    elapsedMs: Math.round(performance.now() - started),
  };
}

function runPnpm(root, args) {
  return cp.spawnSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    args,
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      shell: process.platform === "win32",
    },
  );
}

function directRoots(packageRoot, manifest) {
  const roots = [];
  for (const value of Array.isArray(manifest.files) ? manifest.files : []) {
    if (!directSimplePath(value)) continue;
    const absolute = path.resolve(packageRoot, value);
    const stat = fs.statSync(absolute, { throwIfNoEntry: false });
    if (
      stat?.isDirectory() === true ||
      (stat === undefined && /^(?:lib|dist|build|out)(?:[\\/]|$)/.test(value))
    ) {
      roots.push(absolute);
    }
  }
  return roots;
}

function directSimplePath(value) {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !value.includes("*") &&
    !value.startsWith("!") &&
    !path.isAbsolute(value) &&
    path.win32.parse(value).root === "" &&
    !value.replaceAll("\\", "/").split("/").includes("..")
  );
}

function directEntrypoints(manifest) {
  const values = [];
  for (const value of [
    manifest.main,
    manifest.module,
    manifest.types ?? manifest.typings,
  ]) {
    if (typeof value === "string") values.push(value);
  }
  if (typeof manifest.bin === "string") values.push(manifest.bin);
  else if (manifest.bin !== null && typeof manifest.bin === "object") {
    for (const value of Object.values(manifest.bin)) {
      if (typeof value === "string") values.push(value);
    }
  }
  collectDirectExportTargets(manifest.exports, values);
  return values;
}

function collectDirectExportTargets(value, output) {
  if (typeof value === "string") output.push(value);
  else if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      collectDirectExportTargets(child, output);
    }
  }
}

function directFile(root, file) {
  return path.relative(root, file).replaceAll("\\", "/") || ".";
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareText);
}

function sameStrings(left, right) {
  return (
    JSON.stringify(sortedUnique(left)) === JSON.stringify(sortedUnique(right))
  );
}

function compareText(left, right) {
  return left < right ? -1 : 1;
}
