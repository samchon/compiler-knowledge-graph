import fs from "node:fs";
import path from "node:path";

import { createResidentGraphSource } from "@samchon/graph";

import { compilationDatabaseLifecycle } from "./compilation-database-lifecycle.mjs";
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
      outputBytes: Buffer.byteLength(JSON.stringify(next), "utf8"),
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
      fixture,
      experiment.language,
      fixture.createFile,
    );
    assertCreatedEdge(created, fixture, experiment.language);

    fs.renameSync(createFile, renamedFile);
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
      fixture,
      experiment.language,
      fixture.renamedFile,
    );
    assertCreatedEdge(renamed, fixture, experiment.language);

    fs.rmSync(renamedFile);
    if (compilationDatabase !== undefined) {
      compilationDatabaseLifecycle.remove(compilationDatabase, renamedFile);
    }
    const deleted = await load("delete", CHANGED_MODES);
    if (deleted.nodes.some((node) => node.name === fixture.createdSymbol)) {
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
      // that the producer ignored the input completely. The universe moves, the
      // facts and the source manifest do not, and the row publishes all three so
      // a reader can see which one carried the change.
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
      // The claim itself. Content and manifest cover the facts and the source
      // evidence; capabilities and this provider's warnings are the rest of what
      // a reader can observe, and neither digest carries them. A producer that
      // quietly gave up a capability, or started explaining itself, has not
      // ignored the input.
      const spoken = (report) =>
        (report.warnings ?? [])
          .filter((warning) => warning.startsWith(`${experiment.strictProvider}:`))
          .sort()
          .join(SEPARATOR);
      if (
        provenance.content !== prior.content ||
        provenance.manifest !== prior.manifest ||
        [...provenance.capabilities].sort().join(",") !==
          [...prior.capabilities].sort().join(",") ||
        spoken(tolerated) !== spoken(priorDump)
      ) {
        throw new Error(
          `${experiment.language}: the catalog records this input as ignored, but the published facts, source manifest, capabilities, or provider warnings changed with it`,
        );
      }
      // The other half of the catalog's claim, as a delta rather than an
      // absolute: diagnostics this corpus already had are not evidence about
      // this input, and the dump carries every lane's diagnostics, not only
      // this provider's slice.
      const diagnosticCount = tolerated.diagnostics?.length ?? 0;
      if (diagnosticCount !== previousDiagnostics) {
        throw new Error(
          `${experiment.language}: the catalog records this producer as reporting nothing about a malformed build input, but diagnostics moved from ${String(previousDiagnostics)} to ${String(diagnosticCount)}`,
        );
      }
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
        throw new Error(
          `${experiment.language}: the catalog records a degraded publication, but only the declared build input changed`,
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
    if (retried.nodes.some((node) => node.name === fixture.createdSymbol)) {
      throw new Error(
        `${experiment.language}: retry retained a removed lifecycle declaration`,
      );
    }
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

function assertCreatedSymbol(dump, fixture, language, expectedFile) {
  const created = dump.nodes.find(
    (node) => node.name === fixture.createdSymbol,
  );
  if (created === undefined || created.file !== expectedFile) {
    throw new Error(
      `${language}: lifecycle declaration was not published from ${expectedFile}`,
    );
  }
}

function assertCreatedEdge(dump, fixture, language) {
  if (fixture.createdEdge === undefined) return;
  const nodes = new Map(dump.nodes.map((node) => [node.id, node]));
  const found = dump.edges.some((edge) => {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    return (
      edge.kind === fixture.createdEdge.kind &&
      from?.name === fixture.createdEdge.from &&
      to?.name === fixture.createdEdge.to
    );
  });
  if (!found) {
    throw new Error(
      `${language}: lifecycle lost ${fixture.createdEdge.kind} ${fixture.createdEdge.from} -> ${fixture.createdEdge.to}`,
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
  if (prior.content !== next.content) changed.push("content");
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
  if (
    (priorDump.diagnostics?.length ?? 0) !==
    (nextDump.diagnostics?.length ?? 0)
  ) {
    changed.push("diagnostics");
  }
  return changed;
}

/** A separator no warning can contain, so two lists cannot collide. */
const SEPARATOR = String.fromCharCode(0);

const CHANGED_MODES = ["reload", "incremental", "rebuild"];
