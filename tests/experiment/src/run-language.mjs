import fs from "node:fs";
import path from "node:path";

import { buildGraphDump } from "@samchon/graph";

import { findExperiment } from "./catalog.mjs";
import {
  assertPinnedCorpus,
  cloneRepository,
  ensureDir,
  isolateCorpus,
  parseArgs,
  resultsRoot,
  shell,
  toolManifest,
} from "./process.mjs";
import { runStrictLifecycle } from "./strict-lifecycle.mjs";

const args = parseArgs(process.argv.slice(2));
const experiment = findExperiment(args.language);
const pinned = cloneRepository(experiment, { refresh: args.refresh === "true" });
// Some language servers need the checkout prepared before they can boot —
// ruby-lsp, for one, composes a bundle from the project's Gemfile. That runs in
// a copy for both lanes, so the clone keeps proving which revision was measured.
const strict = experiment.strictProvider !== undefined;

// Read before anything is indexed: a row that cannot be satisfied should
// fail in seconds rather than after a full real-server build.
//
// A default here would let a row inherit a claim it never made. "The compiler
// resolved this" and "an index built from a navigation skeleton reports this"
// are different grades of evidence, and a row that does not say which one it
// expects cannot detect a provider that silently changed grade.
if (strict) {
  for (const field of [
    "strictAuthority",
    "strictTool",
    "requiredCapabilities",
    "semanticEdges",
    "crossFileEdge",
  ]) {
    if (experiment[field] === undefined) {
      throw new Error(
        `${experiment.language}: a strict row must state its expected ${field}`,
      );
    }
  }
}
let dump;
let elapsedMs;
let lifecycle;
let cwd;
if (strict) {
  lifecycle = await runStrictLifecycle(experiment, pinned);
  dump = lifecycle.dump;
  cwd = lifecycle.project;
  const cold = lifecycle.rows.find((row) => row.name === "cold");
  if (cold === undefined) {
    throw new Error(`${experiment.language}: strict lifecycle omitted cold row`);
  }
  elapsedMs = cold.elapsedMs;
} else {
  cwd = isolateCorpus(experiment, pinned, "prepared");
  if (experiment.prepare !== undefined) shell(experiment.prepare, { cwd });
  const started = performance.now();
  dump = await buildGraphDump({
    cwd,
    mode: "lsp",
    languages: [experiment.language],
    maxFiles: experiment.maxFiles,
    lspReferenceLimit: experiment.referenceLimit ?? 250,
    lspTimeoutMs: experiment.timeoutMs ?? 60_000,
    lspReadyTimeoutMs: experiment.readyTimeoutMs ?? 180_000,
    lspWarmupTimeoutMs: experiment.warmupTimeoutMs ?? 180_000,
  });
  elapsedMs = Math.round(performance.now() - started);
}
const warnings = dump.warnings ?? [];

if (dump.indexer === "static") {
  throw new Error(`${experiment.language}: expected real LSP indexing, got static fallback: ${warnings.join("; ")}`);
}
if (dump.languages.includes(experiment.language) === false) {
  throw new Error(`${experiment.language}: dump languages did not include ${experiment.language}`);
}
if (!strict && dump.nodes.length < experiment.minNodes) {
  throw new Error(`${experiment.language}: expected at least ${experiment.minNodes} nodes, got ${dump.nodes.length}`);
}
const minEdges = experiment.minEdges ?? 0;
if (!strict && dump.edges.length < minEdges) {
  throw new Error(`${experiment.language}: expected at least ${minEdges} relationship edges, got ${dump.edges.length}`);
}
const provenance = strict
  ? dump.provenance?.find((row) => row.provider === experiment.strictProvider)
  : undefined;
if (strict && provenance === undefined) {
  throw new Error(
    `${experiment.language}: strict provider ${experiment.strictProvider} did not publish provenance: ${warnings.join("; ")}`,
  );
}
if (
  provenance !== undefined &&
  (provenance.authority !== experiment.strictAuthority ||
    provenance.producer.tool !== experiment.strictTool ||
    provenance.producer.version === "" ||
    provenance.producer.compiler === "" ||
    // A resolved-but-absent tool answers the shape of the question and not the
    // question, and a row that accepted it would go green on a provenance
    // saying nothing about which runtime resolved its facts.
    provenance.producer.compiler.endsWith("=unavailable") ||
    experiment.requiredCapabilities.some(
      (capability) => !provenance.capabilities.includes(capability),
    ))
) {
  throw new Error(
    `${experiment.language}: strict provenance is incomplete: ${JSON.stringify(provenance)}`,
  );
}
const edgeKindCounts = Object.fromEntries(
  [...new Set(dump.edges.map((edge) => edge.kind))]
    .sort()
    .map((kind) => [
      kind,
      dump.edges.filter((edge) => edge.kind === kind).length,
    ]),
);
for (const kind of experiment.semanticEdges ?? []) {
  if ((edgeKindCounts[kind] ?? 0) === 0) {
    throw new Error(
      `${experiment.language}: strict corpus produced no ${kind} semantic edge; observed ${JSON.stringify(edgeKindCounts)}`,
    );
  }
}
// The negative twin of the list above. Requiring the declared families proves
// the provider found what it claims; this proves it published nothing else —
// so a family it cannot prove stays absent instead of arriving relabelled from
// a generic or static lane that quietly served the same language.
if (provenance !== undefined) {
  const undeclared = Object.keys(edgeKindCounts).filter(
    (kind) => !provenance.facts.includes(kind),
  );
  if (undeclared.length > 0) {
    throw new Error(
      `${experiment.language}: the published graph carries ${undeclared.join(", ")} edges although ${provenance.provider} is registered to prove only ${provenance.facts.join(", ")}`,
    );
  }
}
const nodeFiles = new Map(dump.nodes.map((node) => [node.id, node.file]));
const crossFileEdge = experiment.crossFileEdge ?? "calls";
const crossFileCalls = dump.edges.filter(
  (edge) =>
    edge.kind === "calls" &&
    nodeFiles.get(edge.from) !== undefined &&
    nodeFiles.get(edge.to) !== undefined &&
    nodeFiles.get(edge.from) !== nodeFiles.get(edge.to),
).length;
const crossFileRelationships = dump.edges.filter(
  (edge) =>
    edge.kind === crossFileEdge &&
    nodeFiles.get(edge.from) !== undefined &&
    nodeFiles.get(edge.to) !== undefined &&
    nodeFiles.get(edge.from) !== nodeFiles.get(edge.to),
).length;
// Naming a family the provider is not registered to prove would make this row
// unsatisfiable for a correct provider, which is the failure that produced the
// `calls` default it replaces.
if (provenance !== undefined && !provenance.facts.includes(crossFileEdge)) {
  throw new Error(
    `${experiment.language}: the row expects cross-file ${crossFileEdge} relationships although ${provenance.provider} is registered to prove only ${provenance.facts.join(", ")}`,
  );
}
if (strict && crossFileRelationships === 0) {
  throw new Error(
    `${experiment.language}: strict corpus produced no cross-file ${crossFileEdge} relationship`,
  );
}
console.log(`${experiment.language}: ${dump.nodes.length} nodes, ${dump.edges.length} edges (indexer=${dump.indexer}).`);
if (warnings.some((warning) => /LSP indexing failed|LSP returned no symbols|server not found/.test(warning))) {
  throw new Error(`${experiment.language}: LSP warning failed experiment: ${warnings.join("; ")}`);
}

// Read after the whole run rather than before it: what has to be proved is that
// nothing this run did — preparation, indexing, or lifecycle editing — reached
// the clone whose commit the result publishes.
assertPinnedCorpus(experiment, pinned);

ensureDir(resultsRoot);
const result = {
  language: experiment.language,
  repository: experiment.repository,
  commit: experiment.commit,
  corpus: pinned,
  preparedCorpus: cwd,
  tools: toolManifest(experiment.language),
  project: dump.project,
  lifecycleProject: lifecycle?.project,
  indexer: dump.indexer,
  elapsedMs,
  nodeCount: dump.nodes.length,
  edgeCount: dump.edges.length,
  diagnosticCount: dump.diagnostics?.length ?? 0,
  strictProvider: experiment.strictProvider,
  provenance,
  edgeKindCounts,
  semanticLimitation: experiment.semanticLimitation,
  crossFileCalls,
  crossFileRelationships,
  lifecycle: lifecycle?.rows,
  warnings,
  sampleNodes: dump.nodes.slice(0, 20).map((node) => ({
    id: node.id,
    kind: node.kind,
    name: node.qualifiedName ?? node.name,
    file: node.file,
  })),
};
const out = path.join(resultsRoot, `${experiment.language}.json`);
fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
