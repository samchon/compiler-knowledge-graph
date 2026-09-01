import fs from "node:fs";
import path from "node:path";

import { createResidentGraphSource } from "@samchon/graph";

import { compilationDatabaseLifecycle } from "./compilation-database-lifecycle.mjs";
import { measureLifecyclePerformance } from "./lifecycle-performance.mjs";
import { isolateCorpus, shell } from "./process.mjs";

/** Measure one strict provider without ever editing the pinned corpus clone. */
export const runStrictLifecycle = async (experiment, pinnedRoot) => {
  if (experiment.lifecycle === undefined) {
    throw new Error(
      `${experiment.language}: strict experiment has no lifecycle fixture`,
    );
  }
  const lifecycleRoot = isolateCorpus(experiment, pinnedRoot, "lifecycle");
  if (experiment.prepare !== undefined) {
    shell(experiment.prepare, { cwd: lifecycleRoot });
  }

  const fixture = experiment.lifecycle;
  const sourceFile = path.join(lifecycleRoot, fixture.sourceFile);
  const createFile = path.join(lifecycleRoot, fixture.createFile);
  const renamedFile = path.join(lifecycleRoot, fixture.renamedFile);
  const buildFile = path.join(lifecycleRoot, fixture.buildFile);
  const compilationDatabase =
    fixture.compilationDatabase === undefined
      ? undefined
      : path.join(lifecycleRoot, fixture.compilationDatabase);
  const failureFile = path.join(
    lifecycleRoot,
    fixture.failureFile ?? fixture.sourceFile,
  );
  const sourceText = fs.readFileSync(sourceFile, "utf8");
  const buildText = fs.readFileSync(buildFile, "utf8");
  const failureText = fs.readFileSync(failureFile, "utf8");
  const rows = [];
  if (experiment.nativeBaseline !== undefined) {
    const baselineRoot = isolateCorpus(
      experiment,
      pinnedRoot,
      "native-baseline",
    );
    if (experiment.prepare !== undefined) {
      shell(experiment.prepare, { cwd: baselineRoot });
    }
    const started = performance.now();
    shell(experiment.nativeBaseline, { cwd: baselineRoot });
    rows.push({
      name: "native-baseline",
      status: "passed",
      command: experiment.nativeBaseline,
      project: baselineRoot,
      elapsedMs: Math.round(performance.now() - started),
    });
  }
  const resident = createResidentGraphSource({
    cwd: lifecycleRoot,
    mode: "lsp",
    languages: [experiment.language],
    lspTimeoutMs: experiment.timeoutMs ?? 60_000,
    lspReadyTimeoutMs: experiment.readyTimeoutMs ?? 180_000,
    lspWarmupTimeoutMs: experiment.warmupTimeoutMs ?? 180_000,
  });
  let dump;
  let previousIdentity;
  let previousProvenance;
  let previousDiagnostics = 0;

  const load = async (name, expectedModes) => {
    const started = performance.now();
    const next = await resident.load();
    const elapsedMs = Math.round(performance.now() - started);
    const provenance = strictProvenance(next, experiment);
    const mode = resident.modes().get(experiment.strictProvider);
    if (!expectedModes.includes(mode)) {
      throw new Error(
        `${experiment.language}: ${name} reported ${String(mode)}, expected ${expectedModes.join(" or ")}`,
      );
    }
    const identity = [
      provenance.manifest,
      provenance.content,
      provenance.universe,
    ].join(":");
    const row = {
      name,
      status: "passed",
      mode,
      elapsedMs,
      changed: dump !== next,
      outputBytes: jsonBytes(next),
      manifest: provenance.manifest,
      content: provenance.content,
      universe: provenance.universe,
      nodeCount: next.nodes.length,
      edgeCount: next.edges.length,
      diagnosticCount: next.diagnostics?.length ?? 0,
    };
    if (name === "unchanged" && identity !== previousIdentity) {
      throw new Error(
        `${experiment.language}: unchanged refresh moved strict provenance`,
      );
    }
    if (
      name !== "cold" &&
      name !== "unchanged" &&
      identity === previousIdentity
    ) {
      throw new Error(
        `${experiment.language}: ${name} did not move content, manifest, or build universe`,
      );
    }
    dump = next;
    previousIdentity = identity;
    previousProvenance = provenance;
    previousDiagnostics = row.diagnosticCount;
    rows.push(row);
    return next;
  };

  try {
    const cold = await load("cold", ["initial"]);
    const unchanged = await load("unchanged", ["unchanged"]);
    if (cold !== unchanged) {
      throw new Error(
        `${experiment.language}: unchanged resident load replaced dump identity`,
      );
    }

    if (fixture.performance !== undefined) {
      const measured = await measureLifecyclePerformance({
        language: experiment.language,
        ...fixture.performance,
        sourceText,
        currentDump: dump,
        currentIdentity: previousIdentity,
        changedModes: CHANGED_MODES,
        writeSource: (text) => fs.writeFileSync(sourceFile, text),
        load: async () => {
          const started = performance.now();
          const next = await resident.load();
          const provenance = strictProvenance(next, experiment);
          return {
            dump: next,
            mode: resident.modes().get(experiment.strictProvider),
            identity: [
              provenance.manifest,
              provenance.content,
              provenance.universe,
            ].join(":"),
            elapsedMs: Math.round(performance.now() - started),
          };
        },
      });
      dump = measured.dump;
      previousIdentity = measured.identity;
      previousProvenance = strictProvenance(dump, experiment);
      previousDiagnostics = dump.diagnostics?.length ?? 0;
      rows.push(measured.row);
    }

    fs.writeFileSync(sourceFile, sourceText + fixture.editSuffix);
    await load("edit", CHANGED_MODES);

    fs.writeFileSync(createFile, fixture.createText);
    if (compilationDatabase !== undefined) {
      compilationDatabaseLifecycle.add(
        compilationDatabase,
        sourceFile,
        createFile,
      );
    }
    const created = await load("create", CHANGED_MODES);
    assertCreatedSymbol(
      created,
      experiment.language,
      fixture.createFile,
      fixture.createdSymbol,
    );
    assertCreatedEdge(created, fixture, experiment.language);

    fs.renameSync(createFile, renamedFile);
    if (fixture.renamedText !== undefined) {
      fs.writeFileSync(renamedFile, fixture.renamedText);
    }
    if (compilationDatabase !== undefined) {
      compilationDatabaseLifecycle.move(
        compilationDatabase,
        createFile,
        renamedFile,
      );
    }
    const renamed = await load("rename", CHANGED_MODES);
    assertCreatedSymbol(
      renamed,
      experiment.language,
      fixture.renamedFile,
      fixture.renamedSymbol ?? fixture.createdSymbol,
    );
    if (
      fixture.renamedSymbol !== undefined &&
      fixture.renamedSymbol !== fixture.createdSymbol &&
      renamed.nodes.some((node) => node.name === fixture.createdSymbol)
    ) {
      throw new Error(
        `${experiment.language}: rename retained lifecycle declaration ${fixture.createdSymbol}`,
      );
    }
    assertCreatedEdge(renamed, fixture, experiment.language);

    fs.rmSync(renamedFile);
    if (compilationDatabase !== undefined) {
      compilationDatabaseLifecycle.remove(compilationDatabase, renamedFile);
    }
    const deleted = await load("delete", CHANGED_MODES);
    if (hasLifecycleDeclaration(deleted, fixture)) {
      throw new Error(
        `${experiment.language}: deleted lifecycle declaration remained in the graph`,
      );
    }

    fs.writeFileSync(buildFile, `${buildText}\n`);
    await load("build-config", CHANGED_MODES);

    const failedAt = performance.now();
    fs.writeFileSync(failureFile, failureText + fixture.failureSuffix);
    if (fixture.failurePolicy === "reject") {
      let failure;
      try {
        await resident.load();
      } catch (error) {
        failure = error;
      }
      if (!(failure instanceof Error)) {
        throw new Error(
          `${experiment.language}: malformed project input unexpectedly published`,
        );
      }
      rows.push({
        name: "failure",
        status: "rejected",
        mode: resident.modes().get(experiment.strictProvider),
        elapsedMs: Math.round(performance.now() - failedAt),
        error: failure.message,
      });
    } else if (fixture.failurePolicy === "fallback") {
      if (
        typeof fixture.failureLimitation !== "string" ||
        fixture.failureLimitation === ""
      ) {
        throw new Error(
          `${experiment.language}: a fallback failure must state the limitation it accepts`,
        );
      }
      let fallback;
      try {
        fallback = await resident.load();
      } catch (error) {
        throw new Error(
          `${experiment.language}: the catalog records a strict-provider decline with fallback, but the resident rejected it: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (
        fallback.provenance?.some(
          (row) => row.provider === experiment.strictProvider,
        )
      ) {
        throw new Error(
          `${experiment.language}: the declined strict provider still published provenance`,
        );
      }
      const mode = resident.modes().get(experiment.strictProvider);
      if (mode !== undefined) {
        throw new Error(
          `${experiment.language}: the declined strict provider still reported mode ${String(mode)}`,
        );
      }
      const providerWarnings = (fallback.warnings ?? []).filter((warning) =>
        warning.includes(experiment.strictProvider),
      );
      if (providerWarnings.length === 0) {
        throw new Error(
          `${experiment.language}: strict-provider fallback did not name ${experiment.strictProvider}`,
        );
      }
      dump = fallback;
      rows.push({
        name: "failure",
        status: "fallback-with-limitation",
        mode,
        elapsedMs: Math.round(performance.now() - failedAt),
        nodeCount: fallback.nodes.length,
        edgeCount: fallback.edges.length,
        diagnosticCount: fallback.diagnostics?.length ?? 0,
        warnings: providerWarnings,
        limitation: fixture.failureLimitation,
      });
    } else if (fixture.failurePolicy === "tolerated") {
      // Some producers genuinely do not fail on this input class. Asserting a
      // rejection they never make would prove only that the harness agrees with
      // itself, and so would asserting that provenance moved: this step edits a
      // declared build input, so the build universe cannot help but move. What
      // is worth proving is the precise claim the catalog makes about upstream —
      // it tolerates the invalid input without an observable publication-plane
      // change. The universe moves, the facts and source manifest do not, and
      // the row publishes all three so a reader can see which one carried the
      // change.
      if (
        typeof fixture.failureLimitation !== "string" ||
        fixture.failureLimitation === ""
      ) {
        throw new Error(
          `${experiment.language}: a tolerated failure must publish the limitation it accepts`,
        );
      }
      const prior = previousProvenance;
      const priorDump = dump;
      let tolerated;
      try {
        tolerated = await resident.load();
      } catch (error) {
        throw new Error(
          `${experiment.language}: the catalog records this input as tolerated, but the provider rejected it: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const provenance = strictProvenance(tolerated, experiment);
      const mode = resident.modes().get(experiment.strictProvider);
      if (!CHANGED_MODES.includes(mode)) {
        throw new Error(
          `${experiment.language}: tolerated failure reported ${String(mode)}`,
        );
      }
      // Not a claim about the producer: it proves the row aimed its failure at
      // a file the provider actually declares as a build input. A `failureFile`
      // outside that set would leave every check below comparing a generation
      // to itself.
      if (provenance.universe === prior.universe) {
        throw new Error(
          `${experiment.language}: the malformed input did not move the build universe, so this step compared a generation to itself`,
        );
      }
      // Compare the observable publication planes directly. The aggregate
      // content digest is not independent evidence here: legacy coverage rows
      // use the build-universe digest as their target, so content necessarily
      // moves whenever the build input above moves even if every semantic fact
      // remains byte-identical.
      const changed = publicationChanges(
        prior,
        provenance,
        priorDump,
        tolerated,
        experiment.strictProvider,
      );
      if (changed.length !== 0) {
        throw new Error(
          `${experiment.language}: the catalog records this input as a tolerated unchanged publication, but these publication planes moved: ${changed.join(", ")}`,
        );
      }
      const diagnosticCount = tolerated.diagnostics?.length ?? 0;
      dump = tolerated;
      previousIdentity = [
        provenance.manifest,
        provenance.content,
        provenance.universe,
      ].join(":");
      previousProvenance = provenance;
      previousDiagnostics = diagnosticCount;
      rows.push({
        name: "failure",
        status: "tolerated",
        mode,
        elapsedMs: Math.round(performance.now() - failedAt),
        manifest: provenance.manifest,
        content: provenance.content,
        universe: provenance.universe,
        nodeCount: tolerated.nodes.length,
        edgeCount: tolerated.edges.length,
        diagnosticCount,
        limitation: fixture.failureLimitation,
      });
    } else if (fixture.failurePolicy === "published") {
      if (
        typeof fixture.failureLimitation !== "string" ||
        fixture.failureLimitation === ""
      ) {
        throw new Error(
          `${experiment.language}: a published failure must state the limitation it accepts`,
        );
      }
      const prior = previousProvenance;
      const priorDump = dump;
      let published;
      try {
        published = await resident.load();
      } catch (error) {
        throw new Error(
          `${experiment.language}: the catalog records this input as published with a limitation, but the provider rejected it: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const provenance = strictProvenance(published, experiment);
      const mode = resident.modes().get(experiment.strictProvider);
      if (!CHANGED_MODES.includes(mode)) {
        throw new Error(
          `${experiment.language}: published failure reported ${String(mode)}`,
        );
      }
      if (provenance.universe === prior.universe) {
        throw new Error(
          `${experiment.language}: the malformed input did not move the build universe, so this step compared a generation to itself`,
        );
      }
      const changed = publicationChanges(
        prior,
        provenance,
        priorDump,
        published,
        experiment.strictProvider,
      );
      if (changed.length === 0) {
        // Say what was compared, not only that it matched. A row claiming a
        // degraded publication is claiming the producer behaves a particular
        // way when its configuration breaks, and a bare refusal leaves the
        // next reader unable to tell an untrue claim from a producer that
        // stopped behaving that way — which is two runs of guessing before
        // anyone learns which counts stayed equal.
        throw new Error(
          `${experiment.language}: the catalog records a degraded publication, but only the declared build input changed: ` +
            [
              `manifest ${prior.manifest === provenance.manifest ? "equal" : "moved"}`,
              `content ${prior.content === provenance.content ? "equal" : "moved"}`,
              ...["nodes", "edges", "coverage", "unresolved", "diagnostics"].map(
                (plane) =>
                  `${plane} ${(priorDump[plane] ?? []).length}/${(published[plane] ?? []).length}`,
              ),
            ].join("; "),
        );
      }
      dump = published;
      previousIdentity = [
        provenance.manifest,
        provenance.content,
        provenance.universe,
      ].join(":");
      previousProvenance = provenance;
      previousDiagnostics = published.diagnostics?.length ?? 0;
      rows.push({
        name: "failure",
        status: "published-with-limitation",
        mode,
        elapsedMs: Math.round(performance.now() - failedAt),
        manifest: provenance.manifest,
        content: provenance.content,
        universe: provenance.universe,
        nodeCount: published.nodes.length,
        edgeCount: published.edges.length,
        diagnosticCount: previousDiagnostics,
        changed,
        limitation: fixture.failureLimitation,
      });
    } else if (
      fixture.failurePolicy === "diagnostic" ||
      fixture.failurePolicy === "reject-or-diagnostic"
    ) {
      const priorIdentity = previousIdentity;
      let diagnosed;
      let rejected;
      try {
        diagnosed = await resident.load();
      } catch (error) {
        rejected = error;
      }
      if (rejected !== undefined) {
        if (fixture.failurePolicy !== "reject-or-diagnostic") throw rejected;
        rows.push({
          name: "failure",
          status: "rejected",
          mode: resident.modes().get(experiment.strictProvider),
          elapsedMs: Math.round(performance.now() - failedAt),
          error: rejected instanceof Error ? rejected.message : String(rejected),
        });
      } else {
        if (diagnosed === undefined) {
          throw new Error(`${experiment.language}: failure produced no result`);
        }
        if ((diagnosed.diagnostics?.length ?? 0) === 0) {
          throw new Error(
            `${experiment.language}: malformed project input produced neither rejection nor diagnostics`,
          );
        }
        dump = diagnosed;
        const provenance = strictProvenance(diagnosed, experiment);
        const mode = resident.modes().get(experiment.strictProvider);
        if (!CHANGED_MODES.includes(mode)) {
          throw new Error(
            `${experiment.language}: diagnostic failure reported ${String(mode)}`,
          );
        }
        previousIdentity = [
          provenance.manifest,
          provenance.content,
          provenance.universe,
        ].join(":");
        if (previousIdentity === priorIdentity) {
          throw new Error(
            `${experiment.language}: diagnostic failure did not move strict provenance`,
          );
        }
        rows.push({
          name: "failure",
          status: "diagnostic-only",
          mode,
          elapsedMs: Math.round(performance.now() - failedAt),
          diagnosticCount: diagnosed.diagnostics?.length ?? 0,
        });
      }
    } else {
      throw new Error(
        `${experiment.language}: unknown failure policy ${String(fixture.failurePolicy)}`,
      );
    }

    fs.writeFileSync(failureFile, failureText);
    fs.writeFileSync(sourceFile, sourceText);
    fs.writeFileSync(buildFile, buildText);
    const retried = await load(
      "retry",
      fixture.failurePolicy === "fallback"
        ? ["initial", ...CHANGED_MODES]
        : CHANGED_MODES,
    );
    if (hasLifecycleDeclaration(retried, fixture)) {
      throw new Error(
        `${experiment.language}: retry retained a removed lifecycle declaration`,
      );
    }
    const coldProvenance = strictProvenance(cold, experiment);
    const retryProvenance = strictProvenance(retried, experiment);
    // Restoring the sources restores the generation, or the row says why not.
    //
    // This was written as two claims, on the theory that a source manifest is a
    // digest of files and so nothing about a producer's scheduling could move
    // it. The C++ lane disproved that on its first complete run: the manifest
    // moved too. It had to. scip-clang's own statistics flag warns that
    // "non-determinism may affect the number of files skipped by individual
    // indexing jobs", and a manifest lists the files the producer reported — so
    // a schedule that skips a different set publishes a different manifest.
    //
    // One claim, then, and the same exemption covers both halves. Most
    // producers reproduce their own generation and a silent difference in
    // either half is a defect; a row that names its limitation may differ, and
    // what actually moved is published either way rather than merely permitted.
    const reproducedManifest =
      coldProvenance.manifest === retryProvenance.manifest;
    const reproducedContent =
      coldProvenance.content === retryProvenance.content;
    const reproduced = reproducedManifest && reproducedContent;
    const limitation = experiment.regenerationLimitation;
    if (!reproduced && limitation === undefined) {
      const difference = firstGenerationDifference(cold, retried);
      throw new Error(
        `${experiment.language}: restoring the original sources did not reproduce the generation ` +
          `(manifest ${reproducedManifest ? "unchanged" : "moved"}, ` +
          `facts ${reproducedContent ? "unchanged" : "moved"}; ` +
          `cold ${String(cold.nodes.length)} nodes/${String(cold.edges.length)} edges, ` +
          `retry ${String(retried.nodes.length)} nodes/${String(retried.edges.length)} edges; ` +
          `first difference: ${difference})`,
      );
    }
    rows.push({
      name: "regeneration",
      status: reproduced ? "reproduced" : "limited",
      reproducedManifest,
      reproducedContent,
      coldManifest: coldProvenance.manifest,
      retryManifest: retryProvenance.manifest,
      coldContent: coldProvenance.content,
      retryContent: retryProvenance.content,
      coldNodes: cold.nodes.length,
      retryNodes: retried.nodes.length,
      coldEdges: cold.edges.length,
      retryEdges: retried.edges.length,
      ...(limitation === undefined ? {} : { limitation }),
    });
    return { dump: cold, rows, project: lifecycleRoot };
  } finally {
    await resident.close();
  }
};

function strictProvenance(dump, experiment) {
  const provenance = dump.provenance?.find(
    (row) => row.provider === experiment.strictProvider,
  );
  if (provenance === undefined) {
    const warnings = dump.warnings?.join("; ") ?? "no graph warnings";
    throw new Error(
      `${experiment.language}: strict lifecycle lost ${experiment.strictProvider} provenance: ${warnings}`,
    );
  }
  return provenance;
}

function firstGenerationDifference(left, right) {
  for (const plane of [
    "languages",
    "nodes",
    "edges",
    "diagnostics",
    "coverage",
    "unresolved",
  ]) {
    const before = left[plane] ?? [];
    const after = right[plane] ?? [];
    if (before.length !== after.length) {
      return `${plane}.length ${String(before.length)} -> ${String(after.length)}`;
    }
    for (let index = 0; index < before.length; index++) {
      const prior = canonicalGenerationValue(before[index]);
      const next = canonicalGenerationValue(after[index]);
      if (prior !== next) {
        return `${plane}[${String(index)}] ${boundedDifference(prior)} -> ${boundedDifference(next)}`;
      }
    }
  }
  return "normalized dump fact planes are equal; the strict slice moved before merge";
}

function canonicalGenerationValue(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalGenerationValue).join(",")}]`;
  }
  return `{${Object.entries(value)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(
      ([key, nested]) =>
        `${JSON.stringify(key)}:${canonicalGenerationValue(nested)}`,
    )
    .join(",")}}`;
}

function boundedDifference(value) {
  return value.length <= 320 ? value : `${value.slice(0, 317)}...`;
}

function assertCreatedSymbol(
  dump,
  language,
  expectedFile,
  expectedSymbol,
) {
  const created = dump.nodes.find(
    (node) => node.name === expectedSymbol,
  );
  if (created === undefined || created.file !== expectedFile) {
    // Say which of the two it was, and what the file did publish. A producer
    // that never compiled the new source and one that named its declaration
    // differently are different defects, and the sentence used to cover both
    // — which costs a CI round to tell apart every time it fires.
    const fromFile = dump.nodes
      .filter((node) => node.file === expectedFile)
      .map((node) => `${node.name}:${node.kind}`)
      .sort();
    throw new Error(
      `${language}: lifecycle declaration ${expectedSymbol} was not published from ${expectedFile}: ` +
        (created === undefined
          ? fromFile.length === 0
            ? "that file published no declaration at all"
            : `that file published ${fromFile.join(", ")}`
          : `it was published from ${created.file} instead`),
    );
  }
}

function hasLifecycleDeclaration(dump, fixture) {
  const symbols = new Set([
    fixture.createdSymbol,
    fixture.renamedSymbol ?? fixture.createdSymbol,
  ]);
  return dump.nodes.some((node) => symbols.has(node.name));
}

function assertCreatedEdge(dump, fixture, language) {
  if (fixture.createdEdge === undefined) return;
  const nodes = new Map(dump.nodes.map((node) => [node.id, node]));
  const found = dump.edges.find((edge) => {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    return (
      edge.kind === fixture.createdEdge.kind &&
      from?.name === fixture.createdEdge.from &&
      to?.name === fixture.createdEdge.to &&
      (fixture.createdEdge.crossFile !== true ||
        (typeof from.file === "string" &&
          from.file !== "" &&
          typeof to.file === "string" &&
          to.file !== "" &&
          from.file !== to.file))
    );
  });
  if (found === undefined) {
    throw new Error(
      `${language}: lifecycle lost ${fixture.createdEdge.crossFile === true ? "cross-file " : ""}${fixture.createdEdge.kind} ${fixture.createdEdge.from} -> ${fixture.createdEdge.to}`,
    );
  }
}

function publicationChanges(
  prior,
  next,
  priorDump,
  nextDump,
  provider,
) {
  const changed = [];
  if (prior.manifest !== next.manifest) changed.push("manifest");
  for (const plane of [
    "nodes",
    "edges",
    "coverage",
    "unresolved",
    "diagnostics",
  ]) {
    const before = normalizedPublicationPlane(priorDump, plane);
    const after = normalizedPublicationPlane(nextDump, plane);
    if (before !== after) changed.push(plane);
  }
  if (
    [...prior.capabilities].sort().join(",") !==
    [...next.capabilities].sort().join(",")
  ) {
    changed.push("capabilities");
  }
  const spoken = (report) =>
    (report.warnings ?? [])
      .filter((warning) => warning.startsWith(`${provider}:`))
      .sort()
      .join(SEPARATOR);
  if (spoken(priorDump) !== spoken(nextDump)) changed.push("warnings");
  return changed;
}

function normalizedPublicationPlane(dump, plane) {
  const rows = (dump[plane] ?? []).map((row) => {
    if (
      row === null ||
      typeof row !== "object" ||
      (plane !== "coverage" && plane !== "unresolved")
    ) {
      return row;
    }
    // These are generation coordinates, not an independently changed fact.
    // The branch already proves the build universe moved. Compare the coverage
    // state and unresolved evidence without counting that same movement twice.
    const { target: _target, universe: _universe, ...fact } = row;
    return fact;
  });
  return canonicalGenerationValue(rows);
}

/** A separator no warning can contain, so two lists cannot collide. */
const SEPARATOR = String.fromCharCode(0);

const CHANGED_MODES = ["reload", "incremental", "rebuild"];

/**
 * How many bytes `JSON.stringify` would produce, without producing them.
 *
 * A snapshot of a real project is longer than a string is allowed to be, and
 * measuring it by building it killed a run that had otherwise finished. The
 * count is the same; only the string is not made.
 */
function jsonBytes(value) {
  let total = 0;
  const add = (text) => {
    total += Buffer.byteLength(text, "utf8");
  };
  const walk = (entry) => {
    if (entry === null || typeof entry !== "object") {
      add(JSON.stringify(entry) ?? "null");
      return;
    }
    if (Array.isArray(entry)) {
      add("[");
      entry.forEach((item, index) => {
        if (index !== 0) add(",");
        walk(item);
      });
      add("]");
      return;
    }
    if (entry instanceof Map) {
      walk(Object.fromEntries(entry));
      return;
    }
    const keys = Object.keys(entry).filter(
      (key) => entry[key] !== undefined && typeof entry[key] !== "function",
    );
    add("{");
    keys.forEach((key, index) => {
      if (index !== 0) add(",");
      add(`${JSON.stringify(key)}:`);
      walk(entry[key]);
    });
    add("}");
  };
  walk(value);
  return total;
}
