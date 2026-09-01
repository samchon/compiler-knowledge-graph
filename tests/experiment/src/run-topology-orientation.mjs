#!/usr/bin/env node
import cp from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createResidentRepositoryContextSource } from "@samchon/graph";

import { parseArgs, repositoryRoot } from "./process.mjs";
import { TOPOLOGY_ORIENTATION_ORACLE } from "./topology-orientation-oracle.mjs";

const QUESTION =
  "Explain the workspaces, applications and packages, their source/test/generated roots and entrypoints, and the project dependency flow relevant to @samchon/graph.";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.cwd ?? repositoryRoot);
const out =
  args.out === undefined ? undefined : path.resolve(process.cwd(), args.out);

const baseline = directOrientation(root);
const oracleInputDigest = orientationInputDigest(
  root,
  TOPOLOGY_ORIENTATION_ORACLE.inputFiles,
);
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
  env: { ...process.env, SAMCHON_GRAPH_TOPOLOGY_TRACE: "1" },
});
const topologyResident = createResidentRepositoryContextSource(root);
let serverStderr = "";

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
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk) => {
    serverStderr += chunk;
  });
  const mcpReadyMs = Math.round(performance.now() - readyStarted);
  const coldStarted = performance.now();
  const cold = await callTopology(client, request);
  const coldMs = Math.round(performance.now() - coldStarted);
  await new Promise((resolve) => setImmediate(resolve));
  const phaseTrace = topologyPhaseRows(serverStderr);
  const toolStartupPhase = onePhase(
    phaseTrace,
    "pnpm-workspace",
    "tool-startup",
  );
  const modelQueryPhase = onePhase(
    phaseTrace,
    "pnpm-workspace",
    "model-query",
  );
  const normalizationPhase = onePhase(
    phaseTrace,
    "pnpm-workspace",
    "normalization",
  );
  const joinPhase = onePhase(phaseTrace, "repository-context", "join");
  const toolStartupMs = toolStartupPhase.durationMs;
  const modelQueryMs = modelQueryPhase.durationMs;
  const normalizationMs = normalizationPhase.durationMs;
  const joinMs = joinPhase.durationMs;
  const normalizationJoinMs = normalizationMs + joinMs;
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
  const semanticFollowUpFiles = [
    "packages/graph/src/index.ts",
    "packages/graph/src/SamchonGraphApplication.ts",
  ].filter((file) => joinedFiles.has(file));
  const unsupported = cold.result.coverage
    .filter((row) => row.state === "unsupported")
    .map((row) => row.family)
    .sort(compareText);
  const oracleNodes = TOPOLOGY_ORIENTATION_ORACLE.nodes;
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
        toolStartupMs,
        modelQueryMs,
        normalizationMs,
        joinMs,
        normalizationJoinMs,
        mcpReadyMs,
      },
      phaseTrace,
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
        projects,
        packages,
        roots,
        entrypoints,
        dependencies,
      },
    },
    oracle: {
      inputFiles: TOPOLOGY_ORIENTATION_ORACLE.inputFiles,
      inputDigest: oracleInputDigest,
    },
    direct: baseline,
    correctness: {
      oracleInputsMatch:
        oracleInputDigest === TOPOLOGY_ORIENTATION_ORACLE.inputDigest,
      projectFactsMatch: factSetMatches(
        projects,
        oracleNodes.filter((node) =>
          ["workspace", "project"].includes(node.kind),
        ),
      ),
      packageFactsMatch: factSetMatches(
        packages,
        oracleNodes.filter((node) => node.kind === "package"),
      ),
      rootFactsMatch: factSetMatches(
        roots,
        oracleNodes.filter((node) =>
          ["source-root", "generated-root"].includes(node.kind),
        ),
      ),
      entrypointFactsMatch: factSetMatches(
        entrypoints,
        oracleNodes.filter((node) => node.kind === "entrypoint"),
      ),
      dependencyFactsMatch: factSetMatches(
        dependencies,
        TOPOLOGY_ORIENTATION_ORACLE.dependencies,
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
      tracedActualJoinWasCompatible:
        joinPhase.compatible === true &&
        typeof joinPhase.codeFiles === "number" &&
        joinPhase.codeFiles > joins.length,
      semanticFollowUpReachedGraphApi: semanticFollowUpFiles.length === 2,
    },
    limitations: [
      "The direct comparison uses pnpm's resolved member list plus raw manifests; it does not claim shell or source reads are eliminated.",
      "The public MCP boundary exposes handshake, cold-call and warm-call latency; those calls include code-graph validation and wire costs, while the separate topology-model no-op is the issue's validated-input target.",
      "The opt-in phase trace comes from the actual MCP server's pnpm provider, transaction normalizer and full generation-fenced code-file join; these nested durations are not claimed to sum to the independently measured cold MCP call.",
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

function topologyPhaseRows(stderr) {
  const prefix = "@samchon/graph: topology-phase=";
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)));
}

function onePhase(rows, provider, phase) {
  const matches = rows.filter(
    (row) => row.provider === provider && row.phase === phase,
  );
  if (
    matches.length !== 1 ||
    typeof matches[0].durationMs !== "number" ||
    matches[0].durationMs < 0
  ) {
    throw new Error(
      `topology orientation expected one ${provider}/${phase} phase: ` +
        JSON.stringify(matches),
    );
  }
  return matches[0];
}

function orientationInputDigest(root, files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function factSetMatches(actual, expected) {
  return (
    JSON.stringify(
      actual
        .map((value) => JSON.stringify(canonicalFact(value)))
        .sort(compareText),
    ) ===
    JSON.stringify(
      expected
        .map((value) => JSON.stringify(canonicalFact(value)))
        .sort(compareText),
    )
  );
}

function canonicalFact(value) {
  if (Array.isArray(value)) return value.map(canonicalFact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, canonicalFact(child)]),
    );
  }
  return value;
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
  const unique = [
    ...new Set(
      packages.map((pkg) =>
        path.join(path.resolve(pkg.path), "package.json"),
      ),
    ),
  ];
  for (const file of unique) JSON.parse(fs.readFileSync(file, "utf8"));
  const manifestReadMs = Math.round(performance.now() - manifestStarted);
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
    packages: packages.length,
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

function compareText(left, right) {
  return left < right ? -1 : 1;
}
