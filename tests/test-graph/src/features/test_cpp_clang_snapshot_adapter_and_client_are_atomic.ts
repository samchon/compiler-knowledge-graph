import { TestValidator } from "@nestia/e2e";
import {
  CPP_CLANG_PROVIDER,
  CPP_CLANG_PRODUCER_COMMIT,
  CppGraphClient,
  CppGraphSnapshotAdapter,
  GRAPH_EDGE_KINDS,
  cppGraphProvider,
  type ICppGraphSnapshot,
} from "@samchon/graph";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { GraphPaths } from "../internal/GraphPaths.js";

const COMMIT = CPP_CLANG_PRODUCER_COMMIT;

/**
 * Proves the pinned clangd snapshot's native trust boundary, C/C++ slice
 * projection, source identities, resident lifecycle, pagination, and fallback
 * registration as one atomic compiler-owned provider contract.
 */
export const test_cpp_clang_snapshot_adapter_and_client_are_atomic = async () => {
  const root = fixtureRoot();
  const raw = nativeSnapshot(root);
  const adapter = new CppGraphSnapshotAdapter(root, COMMIT);
  const initial = adapter.apply(raw, () => undefined);
  TestValidator.equals(
    "the Clang adapter preserves both compilation configurations and semantic facts",
    [
      initial.mode,
      initial.snapshot.languages,
      new Set(initial.snapshot.protocol?.targets).size,
      [...new Set(initial.snapshot.edges.map((edge) => edge.kind))].sort(),
      initial.snapshot.coverage?.length,
      initial.snapshot.unresolved?.every(
        (site) => site.reason === "provider-gap" || site.reason === "dynamic",
      ),
      initial.snapshot.provenance.provider,
      initial.snapshot.sources.size,
      [...initial.snapshot.sources.keys()].every(
        (file) => file.startsWith("bundled:///") || path.isAbsolute(file),
      ),
    ],
    [
      "initial",
      ["c", "cpp"],
      2,
      [
        "accesses",
        "calls",
        "contains",
        "exports",
        "extends",
        "imports",
        "instantiates",
        "overrides",
        "references",
        "type_ref",
      ],
      GRAPH_EDGE_KINDS.length * 4,
      true,
      CPP_CLANG_PROVIDER,
      2,
      true,
    ],
  );
  const nodes = new Map(initial.snapshot.nodes.map((node) => [node.id, node]));
  TestValidator.predicate(
    "Clang RelationBaseOf becomes derived-to-base inheritance",
    initial.snapshot.edges.some(
      (edge) =>
        edge.kind === "extends" &&
        nodes.get(edge.from)?.name === "Derived" &&
        nodes.get(edge.to)?.name === "Base",
    ),
  );
  const overlaid = new CppGraphSnapshotAdapter(root, COMMIT).apply(
    nativeSnapshot(root, ["--checker-overlay"]),
    () => undefined,
  );
  const overlaidSource = overlaid.snapshot.sources.get(
    path.resolve(root, "main.cpp"),
  );
  TestValidator.predicate(
    "checker overlays preserve a distinct native disk digest",
    overlaidSource !== undefined &&
      overlaidSource.checkerDigest !== overlaidSource.diskDigest &&
      overlaidSource.diskDigest ===
        sha256(fs.readFileSync(path.resolve(root, "main.cpp"), "utf8")),
  );
  const edgeCases = new CppGraphSnapshotAdapter(root, COMMIT).apply(
    nativeSnapshot(root, ["--edge-cases"]),
    () => undefined,
  );
  TestValidator.predicate(
    "the adapter preserves valid empty locations, URI forms, and unknown native kinds",
    edgeCases.snapshot.nodes.some(
      (node) =>
        node.name === "caller" && node.qualifiedName === "fixture::caller",
    ) &&
      edgeCases.snapshot.nodes.some(
        (node) => node.name === "Derived" && node.kind === "external_symbol",
      ) &&
      edgeCases.snapshot.nodes.some(
        (node) => node.name === "c:@F@external#" && node.external,
      ) &&
      edgeCases.snapshot.diagnostics.some(
        (diagnostic) => diagnostic.line === 0 && diagnostic.column === 0,
      ) &&
      edgeCases.snapshot.edges.some(
        (edge) => edge.kind === "overrides" && edge.evidence === undefined,
      ) &&
      edgeCases.snapshot.sources.has("bundled:///fixture/system.h") &&
      edgeCases.snapshot.sources.has(path.resolve(root, "relative.cpp")),
  );
  TestValidator.error(
    "a source URI that cannot canonicalize fails the common protocol closed",
    () =>
      new CppGraphSnapshotAdapter(root, COMMIT).apply(
        nativeSnapshot(root, ["--invalid-source-uri"]),
        () => undefined,
      ),
  );
  TestValidator.error(
    "an unsupported source URI cannot impersonate a project-local file",
    () =>
      new CppGraphSnapshotAdapter(root, COMMIT).apply(
        nativeSnapshot(root, ["--unsupported-source-uri"]),
        () => undefined,
      ),
  );
  assertCrossVolumeIdentity(root, raw);
  assertUnicodeManifestOrdering();
  assertNativeRefusals(root, raw);
  await assertProvider(root);
  await assertClientLifecycle(root);
  await assertClientInputShapes();
  await assertClientReportsItsOwnSize();
  await assertClientReadsPublishedBodies(publishedFixtureRoot());
  await assertClientPagination();
  await assertClientFailures(fixtureRoot());
};

function fixtureRoot(): string {
  const root = GraphPaths.createTempDirectory("samchon-graph-cpp-native-");
  fs.mkdirSync(path.join(root, "include"));
  fs.writeFileSync(path.join(root, "main.cpp"), "void caller() {}\n");
  fs.writeFileSync(path.join(root, "absolute.cpp"), "void absolute() {}\n");
  fs.writeFileSync(path.join(root, "include", "fixture.h"), "void callee();\n");
  fs.writeFileSync(
    path.join(root, "compile_commands.json"),
    JSON.stringify([
      {
        directory: root,
        file: "main.cpp",
        arguments: ["clang", "-x", "c", "-c", "main.cpp"],
      },
      {
        directory: root,
        file: "main.cpp",
        arguments: ["clang++", "-x", "c++", "-c", "main.cpp"],
      },
    ]),
  );
  return root;
}

async function assertProvider(root: string): Promise<void> {
  const override = "SAMCHON_GRAPH_CLANGD_SNAPSHOT";
  const command = nodeShim(root, "samchon-clangd", COMMIT);
  const wrong = nodeShim(root, "wrong-clangd", "f".repeat(40));
  const prefixCollision = nodeShim(
    root,
    "prefix-collision-clangd",
    `${COMMIT.slice(0, 9)}${"f".repeat(31)}`,
  );
  const resolved = cppGraphProvider.resolve(root, {
    ...process.env,
    [override]: command,
  });
  TestValidator.equals(
    "the C/C++ provider resolves only its pinned compiler producer",
    [
      resolved !== undefined,
      cppGraphProvider.resolve(root, {
        ...process.env,
        [override]: wrong,
      }),
      cppGraphProvider.resolve(root, {
        ...process.env,
        [override]: prefixCollision,
      }),
      cppGraphProvider.fallbacks?.map((provider) => provider.name),
      cppGraphProvider.configuration?.(root, { [override]: command }),
      cppGraphProvider.configuration?.(root, {}),
    ],
    [
      true,
      undefined,
      undefined,
      ["scip-clang"],
      [`producer-commit=${COMMIT}`, `${override}=${command}`],
      [`producer-commit=${COMMIT}`, `${override}=unconfigured`],
    ],
  );
  TestValidator.predicate(
    "whole-database Clang generations refuse bounded and caller-owned modes",
    cppGraphProvider.refuse({ maxFiles: 1 })?.includes("maxFiles") === true &&
      cppGraphProvider.refuse({ server: "clangd" })?.includes("server") === true &&
      cppGraphProvider
        .refuse({ lspReferenceLimit: 1 })
        ?.includes("lspReferenceLimit") === true &&
      cppGraphProvider.refuse({}) === undefined,
  );
  const session = cppGraphProvider.open({
    root,
    command: resolved!,
    languages: ["c", "cpp"],
    options: {},
  });
  try {
    TestValidator.equals(
      "the registered C/C++ provider opens its pinned producer contract",
      (await session.refresh()).snapshot.provenance.authority,
      "compiler",
    );
  } finally {
    await session.close();
  }
  // Asked to pass the server's log through, the provider also asks the server
  // to write one. A producer that stops answering explains itself there and
  // nowhere else, and a run that waited twenty minutes for one had nothing
  // but its own request lines to show.
  process.env.SAMCHON_GRAPH_LSP_SERVER_LOG = "1";
  const cppOnly = cppGraphProvider.open({
    root,
    command: resolved!,
    languages: ["cpp"],
    options: {},
  });
  delete process.env.SAMCHON_GRAPH_LSP_SERVER_LOG;
  try {
    const selected = await cppOnly.refresh();
    TestValidator.predicate(
      "one requested language projects its slice from the producer's atomic mixed C/C++ universe",
      selected.snapshot.languages.length === 1 &&
        selected.snapshot.languages[0] === "cpp" &&
        selected.snapshot.nodes.every((node) => node.language === "cpp"),
    );
  } finally {
    await cppOnly.close();
  }
  const absent = GraphPaths.createTempDirectory("samchon-graph-cpp-no-cdb-");
  fs.writeFileSync(path.join(absent, "compile_commands.json"), "[]");
  fs.mkdirSync(path.join(absent, "build"));
  fs.writeFileSync(path.join(absent, "build", "compile_commands.json"), "bad");
  TestValidator.error(
    "the C/C++ provider refuses a project without a compilation database",
    () => cppGraphProvider.prepare?.(absent, {}),
  );
  fs.writeFileSync(path.join(absent, "compile_commands.json"), "bad");
  fs.writeFileSync(
    path.join(absent, "build", "compile_commands.json"),
    JSON.stringify([{ directory: absent, file: "main.cpp" }]),
  );
  cppGraphProvider.prepare?.(absent, {});
}

function nativeSnapshot(
  root: string,
  args: readonly string[] = [],
): ICppGraphSnapshot {
  const result = spawnSync(
    process.execPath,
    [
      GraphPaths.fakeCppGraphServer,
      "--snapshot",
      `--commit=${COMMIT}`,
      ...args,
    ],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (result.status !== 0 || result.error !== undefined) {
    throw result.error ?? new Error(result.stderr);
  }
  return JSON.parse(result.stdout) as ICppGraphSnapshot;
}

function assertCrossVolumeIdentity(
  root: string,
  valid: ICppGraphSnapshot,
): void {
  if (process.platform !== "win32") return;
  const rootDrive = path.parse(root).root.slice(0, 1).toUpperCase();
  const foreignDrive = rootDrive === "C" ? "D" : "C";
  const foreign = path.join(`${foreignDrive}:\\`, "sdk", "foreign.hpp");
  const foreignUri = pathToFileURL(foreign).href;
  const candidate = structuredClone(valid);
  const graph = candidate.upserts[0]!.graph;
  graph.sources.push({
    uri: foreignUri,
    digest: sha256("foreign checker source"),
    diskDigest: sha256("foreign disk source"),
    flags: 0,
  });
  // The caller, by name: a fixture's symbol order is not this test's subject.
  graph.symbols.find((symbol) => symbol.name === "caller")!.definition.file =
    foreignUri;
  resealSnapshot(candidate);
  const snapshot = new CppGraphSnapshotAdapter(root, COMMIT).apply(
    candidate,
    () => undefined,
  ).snapshot;
  TestValidator.predicate(
    "a Windows source on another volume keeps a real manifest path and an opaque external graph identity",
    snapshot.sources.has(path.normalize(foreign)) &&
      snapshot.nodes.some(
        (node) =>
          node.name === "caller" &&
          node.external &&
          node.file.startsWith("bundled:///clang/filesystem/"),
      ),
  );
}

function assertUnicodeManifestOrdering(): void {
  const root = GraphPaths.createTempDirectory("samchon-graph-cpp-unicode-");
  const supplementary = "\u{10000}.cpp";
  const privateUse = "\uE000.cpp";
  const commands = [supplementary, privateUse].map((file) => {
    fs.writeFileSync(path.join(root, file), "void caller() {}\n");
    return {
      directory: root,
      file,
      arguments: ["clang++", "-x", "c++", "-c", file],
    };
  });
  fs.writeFileSync(
    path.join(root, "compile_commands.json"),
    JSON.stringify(commands),
  );
  const raw = nativeSnapshot(root);
  const snapshot = new CppGraphSnapshotAdapter(root, COMMIT).apply(
    raw,
    () => undefined,
  ).snapshot;
  TestValidator.equals(
    "native manifest order compares raw UTF-8 bytes instead of UTF-16 code units",
    [
      raw.upserts.map((shard) => path.basename(shard.source)),
      snapshot.sources.size,
    ],
    [[privateUse, supplementary], 2],
  );
}

function assertNativeRefusals(
  root: string,
  valid: ICppGraphSnapshot,
): void {
  const rejects = (
    label: string,
    mutate: (value: ICppGraphSnapshot) => void,
  ): void => {
    TestValidator.error(label, () => {
      const candidate = structuredClone(valid);
      mutate(candidate);
      new CppGraphSnapshotAdapter(root, COMMIT).apply(candidate, () => undefined);
    });
  };
  rejects("a foreign Clang producer is refused", (value) => {
    value.producer.commit = "wrong";
  });
  rejects("an unsupported native protocol is refused", (value) => {
    value.protocolVersion = 2;
  });
  rejects("a malformed native envelope is refused", (value) => {
    value.sequence = 0;
  });
  rejects("a malformed native base is refused", (value) => {
    value.baseGeneration = "bad";
  });
  rejects("a malformed Clang universe is refused", (value) => {
    value.universe.targets.reverse();
    value.universe.targets.push("duplicate");
  });
  rejects("a malformed native phase is refused", (value) => {
    value.phases.totalMillis = -1;
  });
  rejects("a malformed assembled native page is refused", (value) => {
    value.page.offset = 1;
  });
  rejects("a malformed native delete set is refused", (value) => {
    value.deletes = ["z", "a"];
  });
  rejects("a non-canonical native manifest is refused", (value) => {
    value.manifest.push({ ...value.manifest[0]! });
  });
  rejects("a malformed native source is refused", (value) => {
    value.upserts[0]!.graph.sources[0]!.digest = "wrong";
  });
  rejects("a malformed native disk digest is refused", (value) => {
    value.upserts[0]!.graph.sources[0]!.diskDigest = "wrong";
  });
  rejects("a malformed native shard is refused", (value) => {
    value.upserts[0]!.source = "";
  });
  rejects("a foreign compiler fingerprint is refused", (value) => {
    value.upserts[0]!.graph.producerFingerprint = "0".repeat(64);
  });
  rejects("a malformed native symbol is refused", (value) => {
    value.upserts[0]!.graph.symbols[0]!.name = "";
  });
  rejects("an unsupported URI cannot hide in an unselected native range", (value) => {
    value.upserts[0]!.graph.symbols[0]!.declaration.file =
      "repo:///hidden-declaration.cpp";
    resealSnapshot(value);
  });
  rejects("a malformed native occurrence is refused", (value) => {
    value.upserts[0]!.graph.occurrences[0]!.usr = "";
  });
  rejects("a malformed native relation is refused", (value) => {
    value.upserts[0]!.graph.relations[0]!.subjectId = "";
  });
  rejects("a malformed native macro is refused", (value) => {
    value.upserts[0]!.graph.macros[0]!.name = "";
  });
  rejects("a malformed native include is refused", (value) => {
    value.upserts[0]!.graph.includes[0]!.source = "";
  });
  rejects("a malformed native module is refused", (value) => {
    value.upserts[0]!.graph.modules[0]!.name = "";
  });
  rejects("a malformed native diagnostic is refused", (value) => {
    value.upserts[0]!.graph.diagnostics[0]!.message = "";
  });
  rejects("a reversed native range is refused", (value) => {
    const range = value.upserts[0]!.graph.occurrences[0]!.spelling;
    range.startColumn = range.endColumn + 1;
  });
  rejects("a negative native range is refused", (value) => {
    value.upserts[0]!.graph.occurrences[0]!.spelling.startLine = -1;
  });
  rejects("a non-array native universe coordinate is refused", (value) => {
    (value.universe as unknown as { targets: null }).targets = null;
  });
  rejects("a non-string native universe coordinate is refused", (value) => {
    (value.universe.targets as unknown[])[0] = 1;
  });
  rejects("an empty required native universe coordinate is refused", (value) => {
    value.universe.targets[0] = "";
  });
  rejects("an incomplete native coverage matrix is refused", (value) => {
    value.upserts[0]!.coverage.pop();
  });
  rejects("an invalid native coverage row is refused", (value) => {
    value.upserts[0]!.coverage[0]!.state = "wrong" as "complete";
  });
  rejects("a mismatched native main source is refused", (value) => {
    value.upserts[0]!.source += ".other";
  });
  rejects("a mismatched native shard digest is refused", (value) => {
    value.upserts[0]!.digest = "0".repeat(64);
  });
  // The outer digest carries the symbol payload only through this term, so a
  // body whose exported interface no longer matches the fingerprint it was
  // published under is the one substitution the outer check cannot see.
  rejects("a mismatched native interface fingerprint is refused", (value) => {
    value.upserts[0]!.interfaceFingerprint = "0".repeat(64);
  });
  // Resealed, so the shard is intact and the only thing wrong with it is what
  // the compiler said about the unit. That is the case the ordering exists
  // for: an intact body from a failed compile must be refused as such rather
  // than reported as malformed.
  rejects("an intact native shard from a failed compile is refused", (value) => {
    value.upserts[0]!.graph.hadErrors = true;
    resealSnapshot(value);
  });
  rejects("a mismatched native generation is refused", (value) => {
    value.generation = "0".repeat(64);
  });
  rejects("a shard-extraneous native universe is refused", (value) => {
    value.universe.targets = ["other-target"];
  });
  rejects("a malformed native graph is refused", (value) => {
    value.upserts[0]!.graph.targetTriple = "";
  });
  const stale = new CppGraphSnapshotAdapter(root, COMMIT);
  stale.apply(structuredClone(valid), () => undefined);
  const malformedNoop = structuredClone(valid);
  malformedNoop.baseGeneration = valid.generation;
  malformedNoop.upserts = [];
  malformedNoop.deletes = [];
  malformedNoop.manifest = [];
  malformedNoop.page = { offset: 0, count: 0, total: 0, nextCursor: null };
  malformedNoop.phases.cacheHit = true;
  malformedNoop.universe.targets = ["foreign-target"];
  TestValidator.error(
    "an unchanged frame still proves that its universe describes the resident shards",
    () => stale.apply(malformedNoop, () => undefined),
  );
  const delta = structuredClone(valid);
  delta.baseGeneration = "0".repeat(64);
  TestValidator.error("a Clang delta must name the exact resident base", () =>
    stale.apply(delta, () => undefined),
  );
  const invalidDelete = structuredClone(valid);
  invalidDelete.baseGeneration = valid.generation;
  invalidDelete.deletes = ["missing-shard"];
  TestValidator.error("a Clang delta cannot delete an absent shard", () =>
    stale.apply(invalidDelete, () => undefined),
  );
  const duplicateDelta = structuredClone(valid);
  duplicateDelta.baseGeneration = valid.generation;
  duplicateDelta.deletes = [duplicateDelta.upserts[0]!.key];
  TestValidator.error("a Clang delta cannot delete and replace one shard", () =>
    stale.apply(duplicateDelta, () => undefined),
  );
  const manifestMismatch = structuredClone(valid);
  manifestMismatch.manifest[0]!.digest = "0".repeat(64);
  TestValidator.error("native shards must exactly match their manifest", () =>
    new CppGraphSnapshotAdapter(root, COMMIT).apply(
      manifestMismatch,
      () => undefined,
    ),
  );

  const partial = structuredClone(valid);
  partial.baseGeneration = valid.generation;
  partial.sequence += 1;
  const changed = partial.upserts[0]!;
  changed.graph.diagnostics[0]!.message += " (changed)";
  changed.digest = nativeShardDigest(changed);
  partial.upserts = [changed];
  partial.manifest = partial.manifest.map((entry) =>
    entry.key === changed.key ? { key: entry.key, digest: changed.digest } : entry,
  );
  partial.generation = nativeGeneration(
    partial.universe.digest,
    partial.manifest,
  );
  partial.page = { offset: 0, count: 1, total: 1, nextCursor: null };
  const partialAdapter = new CppGraphSnapshotAdapter(root, COMMIT);
  partialAdapter.apply(structuredClone(valid), () => undefined);
  TestValidator.equals(
    "a same-universe native delta retains unchanged graph shards",
    partialAdapter.apply(partial, () => undefined).mode,
    "incremental",
  );

  const database = path.join(root, "compile_commands.json");
  const commands = JSON.parse(fs.readFileSync(database, "utf8")) as unknown[];
  fs.writeFileSync(database, JSON.stringify(commands.slice(1)));
  const reloaded = stale.apply(nativeSnapshot(root), () => undefined);
  TestValidator.equals(
    "a full native generation with a changed language universe reloads atomically",
    [reloaded.mode, reloaded.snapshot.languages],
    ["reload", ["cpp"]],
  );
  fs.writeFileSync(database, JSON.stringify(commands));

  // `open` is the shape the client streams into, and streaming replaces two
  // things the envelope used to carry on its own: how many shards a generation
  // holds, and whether it holds any. A caller that promises a count and then
  // hands over fewer has produced a generation nobody validated the size of,
  // and a generation the producer says did not move has nothing to close.
  const promised = new CppGraphSnapshotAdapter(root, COMMIT);
  const opened = promised.open(
    structuredClone(valid),
    valid.upserts.length,
    () => undefined,
  );
  TestValidator.error(
    "an ingest handed fewer shards than it was promised is refused",
    () => opened.finish(),
  );

  const settledAdapter = new CppGraphSnapshotAdapter(root, COMMIT);
  const settledBase = structuredClone(valid);
  settledAdapter.apply(settledBase, () => undefined);
  const still = structuredClone(valid);
  still.baseGeneration = settledBase.generation;
  still.upserts = [];
  still.manifest = [];
  still.deletes = [];
  still.page = { offset: 0, count: 0, total: 0, nextCursor: null };
  still.phases = { ...still.phases, cacheHit: true };
  const unchanged = settledAdapter.apply(still, () => undefined);
  TestValidator.equals(
    "a generation the producer says did not move is the prior one",
    [unchanged.changed, unchanged.mode, unchanged.snapshot === settledBase],
    [false, "unchanged", false],
  );
  const settled = settledAdapter.open(still, 0, () => undefined);
  TestValidator.error(
    "a settled generation has nothing to finish",
    () => settled.finish(),
  );

  const cppCommands = commands.map((row, index) => ({
    ...(row as Record<string, unknown>),
    arguments: [
      "clang++",
      "-x",
      "c++",
      `-DGRAPH_CONFIGURATION=${String(index)}`,
      "-c",
      "main.cpp",
    ],
  }));
  fs.writeFileSync(database, JSON.stringify(cppCommands));
  const sameLanguage = new CppGraphSnapshotAdapter(root, COMMIT);
  const both = nativeSnapshot(root);
  sameLanguage.apply(both, () => undefined);
  fs.writeFileSync(database, JSON.stringify(cppCommands.slice(1)));
  const one = nativeSnapshot(root);
  const deletionDelta = structuredClone(one);
  deletionDelta.baseGeneration = both.generation;
  deletionDelta.deletes = both.manifest
    .filter(
      (entry) => !one.manifest.some((candidate) => candidate.key === entry.key),
    )
    .map((entry) => entry.key)
    .sort();
  deletionDelta.upserts = [];
  deletionDelta.page = { offset: 0, count: 0, total: 0, nextCursor: null };
  // A universe move re-adapts every surviving shard, and this adapter
  // remembers a published shard by seven strings rather than by its body, so a
  // delta has nothing to re-adapt from. It refuses before it assigns anything;
  // the client answers by forgetting its generation and asking again, and the
  // producer -- which still holds every shard -- sends a whole one.
  TestValidator.error(
    "a moved universe cannot be served by a delta",
    () => sameLanguage.apply(deletionDelta, () => undefined),
  );
  const universeReload = sameLanguage.apply(one, () => undefined);
  TestValidator.equals(
    "a configuration-universe deletion reloads every surviving shard",
    [universeReload.mode, universeReload.snapshot.languages],
    ["reload", ["cpp"]],
  );

  // The other half of why a surviving delta never has anything to delete. A
  // shard owns the only configuration naming its own compile command, so
  // dropping one while claiming the universe stood still is a generation that
  // does not describe its own shards. Above, a delta that admits the universe
  // moved is refused and comes back whole. Between the two there is no delta
  // that both passes validation and carries a delete.
  fs.writeFileSync(database, JSON.stringify(cppCommands));
  const standing = new CppGraphSnapshotAdapter(root, COMMIT);
  const base = nativeSnapshot(root);
  standing.apply(structuredClone(base), () => undefined);
  const contradictory = structuredClone(base);
  contradictory.baseGeneration = base.generation;
  contradictory.upserts = [];
  contradictory.deletes = [base.manifest[0]!.key];
  contradictory.manifest = base.manifest.slice(1);
  contradictory.page = { offset: 0, count: 0, total: 0, nextCursor: null };
  TestValidator.error(
    "a delta that deletes a shard while the universe stands still is refused",
    () => standing.apply(contradictory, () => undefined),
  );
  fs.writeFileSync(database, JSON.stringify(commands));
}

async function assertClientLifecycle(root: string): Promise<void> {
  const requestLog = path.join(root, "requests.ndjson");
  const watchLog = path.join(root, "watches.ndjson");
  const client = cppClient(root, [
    `--request-log=${requestLog}`,
    `--watch-log=${watchLog}`,
  ]);
  const initial = await client.refresh();
  const unchanged = await client.refresh();
  fs.writeFileSync(path.join(root, "main.cpp"), "void edited() {}\n");
  const edited = await client.refresh();
  const database = path.join(root, "compile_commands.json");
  const commands = JSON.parse(fs.readFileSync(database, "utf8")) as unknown[];
  fs.writeFileSync(database, JSON.stringify(commands.slice(1)));
  const deleted = await client.refresh();
  TestValidator.equals(
    "the resident Clang client reuses no-ops and commits one edited delta",
    [
      [initial.changed, initial.mode, initial.generation],
      [unchanged.changed, unchanged.mode, unchanged.generation],
      [edited.changed, edited.mode, edited.generation],
      [deleted.changed, deleted.mode, deleted.generation],
      client.generation,
      edited.snapshot.nodes.some((node) => node.name === "editedCaller"),
      // A refresh opens with the one request that carries no cursor, and that
      // is where it declares the generation it already holds. Continuations
      // are answers to a cursor, so they are not asked that question again --
      // reading only the openers keeps this about the handshake, not the page
      // size the client happens to ask for.
      readLines(requestLog)
        .filter((row) => row.cursor === undefined)
        .map((row) => row.knownGeneration !== undefined),
      readLines(watchLog).map((row) => row.changes[0]?.type),
    ],
    [
      [true, "initial", 1],
      [false, "unchanged", 1],
      [true, "incremental", 2],
      [true, "reload", 3],
      3,
      true,
      // Five openers for four refreshes. Deleting a compile command moves the
      // universe, which re-adapts every surviving shard -- and the adapter
      // remembers a shard by seven strings, not by its body, so it refuses the
      // delta and the client asks again with no generation to build on. That
      // second opener declaring nothing is the recovery, and the `reload` mode
      // above is what it recovered.
      [false, true, true, true, false],
      [1, 2, 2],
    ],
  );
  await client.close();
  await client.close();
  await rejected(
    "a closed Clang graph session rejects refresh",
    client.refresh(),
    "session is closed",
  );
}

async function assertClientReportsItsOwnSize(): Promise<void> {
  // Three hosts died on this route before any stage said what it held, and the
  // trace is off in every run but the one that needs it -- so the arm that is
  // on has to be exercised somewhere. It writes to the stderr descriptor
  // rather than through `process.stderr.write`, which is the point of writing
  // it that way and the reason this needs its own process to be read back.
  //
  // Its own corpus, and a large one, because the walk reports every stride of
  // shards and a two-shard project never reaches the first. A run that dies
  // partway is exactly the run whose reading matters, so the case that proves
  // the walk speaks has to be long enough for it to speak.
  const root = GraphPaths.createTempDirectory("samchon-graph-cpp-walk-");
  const commands: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 70; ++index) {
    const file = `walk-${String(index).padStart(2, "0")}.cpp`;
    fs.writeFileSync(path.join(root, file), "void walked() {}\n");
    commands.push({
      directory: root,
      file,
      arguments: ["clang++", "-x", "c++", "-c", file],
    });
  }
  fs.writeFileSync(
    path.join(root, "compile_commands.json"),
    JSON.stringify(commands),
  );
  const clientModule = pathToFileURL(
    path.join(
      GraphPaths.graphPackageRoot,
      "lib",
      "provider",
      "cpp",
      "CppGraphClient.js",
    ),
  ).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        `const { CppGraphClient } = await import(${JSON.stringify(clientModule)});`,
        "const client = new CppGraphClient({",
        `  root: ${JSON.stringify(root)},`,
        '  languages: ["c", "cpp"],',
        `  command: ${JSON.stringify(process.execPath)},`,
        `  args: [${JSON.stringify(GraphPaths.fakeCppGraphServer)}, ${JSON.stringify(`--commit=${COMMIT}`)}],`,
        `  producerCommit: ${JSON.stringify(COMMIT)},`,
        "  requestTimeoutMs: 5000,",
        "  readyTimeoutMs: 10000,",
        "});",
        "try { await client.refresh(); } finally { await client.close(); }",
      ].join("\n"),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, SAMCHON_GRAPH_CPP_HEAP_TRACE: "1" },
      windowsHide: true,
    },
  );
  const reported = child.stderr
    .split("\n")
    .filter((line) => line.startsWith("@samchon/graph: cpp-heap "))
    .map((line) =>
      line.replace(
        / (?:elapsedMs|producer[A-Za-z]*Ms|adaptMs|nodes[A-Za-z]*|nodes|heap[A-Za-z]*MiB|rssMiB)=\d+/gu,
        "",
      ),
    );
  const stages = reported.map((line) => /stage=(\w+)/u.exec(line)?.[1]);
  const counts = reported.map((line) =>
    Number(/shards=(\d+)/u.exec(line)?.[1] ?? "-1"),
  );
  // Seventy translation units at four shards to a page crosses the stride
  // once, so the walk speaks once on the way and the two boundaries speak
  // exactly. A trace that only spoke at the end would say nothing about the
  // runs that never reach one -- which is every run this instrument was added
  // for. The figures are the host's, not this suite's, so the shape is what is
  // pinned: a progress report short of the total, then the whole generation
  // twice.
  TestValidator.equals(
    "a long walk reports its progress and then both boundaries",
    [
      child.status,
      child.signal,
      stages,
      counts[0] === 64,
      counts[1] === 70 && counts[2] === 70,
    ],
    [0, null, ["walking", "paged", "committed"], true, true],
  );
}

/**
 * A root of four units: two define what the shared header declares, two only
 * include it.
 *
 * That is the case splitting bodies exists for, and the shape every C project
 * has. Publishing whole bodies writes the header's facts once per including
 * unit and reading them parses the same facts again for each. Split and named
 * by content, the two units that merely include the header point at one file,
 * written once and parsed once; the unit that compiles the definition knows
 * something they do not and gets its own.
 */
function publishedFixtureRoot(): string {
  const root = GraphPaths.createTempDirectory("samchon-graph-cpp-published-");
  fs.mkdirSync(path.join(root, "include"));
  fs.writeFileSync(
    path.join(root, "include", "fixture.h"),
    "void callee();\n",
  );
  const files = ["first.cpp", "second.cpp", "third.cpp", "fourth.cpp"];
  for (const file of files)
    fs.writeFileSync(
      path.join(root, file),
      `#include "include/fixture.h"\nvoid caller_${file.slice(0, -4)}() {}\n`,
    );
  fs.writeFileSync(
    path.join(root, "compile_commands.json"),
    JSON.stringify(
      files.map((file) => ({
        directory: root,
        file,
        arguments: ["clang++", "-x", "c++", "-c", file],
      })),
    ),
  );
  return root;
}

async function assertClientReadsPublishedBodies(root: string): Promise<void> {
  // A page names its bodies instead of carrying them. That takes the largest
  // object this route moves out of the request path: no `json::Value` tree on
  // the producer's side, no serialization between, and no megabytes of JSON
  // through a pipe that hands them over in sixty-four kibibyte pieces.
  //
  // The name is the body's own digest, so reading it is also checking it: the
  // file that answers to a digest either hashes to it or is not the body this
  // generation was planned against, whoever wrote it.
  const bodyRoot = path.join(root, "published-bodies");
  const client = cppClient(root, [`--body-root=${bodyRoot}`]);
  try {
    const refreshed = await client.refresh();
    const files = fs.readdirSync(bodyRoot);
    TestValidator.equals(
      "a generation whose bodies were published reads the same as one that carried them",
      [
        refreshed.snapshot.sources.size > 0,
        refreshed.snapshot.nodes.length > 0,
        files.length,
        files.every((name) => name.endsWith(".graph.json")),
      ],
      // Seven files for four units of two pieces each. The four main pieces
      // differ. So does the header as each defining unit sees it, because
      // that piece records where the definition is. The two units that only
      // include the header agree exactly and share one piece: a piece carries
      // no unit identity and its name is its own content. Eight would mean
      // the split had bought nothing.
      [true, true, 7, true],
    );
    // The same generation out of a cache that keeps nothing.
    //
    // Pieces are kept parsed only to save reading them again, and a walk over
    // a real compilation database is the only thing that reaches the budget
    // where the oldest start being dropped. A budget of one byte reaches it
    // on the first piece, so every naming reads the file again -- and what
    // comes out has to be the same generation, or the cache is not a cache,
    // it is part of the answer.
    const frugal = cppClient(root, [`--body-root=${bodyRoot}`], {
      pieceBudgetBytes: 1,
    });
    try {
      const spare = await frugal.refresh();
      TestValidator.equals(
        "a cache that keeps nothing publishes the generation a cache that keeps everything does",
        [
          spare.snapshot.nodes.length,
          spare.snapshot.edges.length,
          spare.snapshot.sources.size,
        ],
        [
          refreshed.snapshot.nodes.length,
          refreshed.snapshot.edges.length,
          refreshed.snapshot.sources.size,
        ],
      );
    } finally {
      await frugal.close();
    }

    // A body read from a file is still a body the digest chain answers for:
    // `assertShard` rebuilds that chain from what it was handed, so bytes
    // swapped underneath a published name are refused rather than adapted.
    // That is the only thing standing between a shared directory and a graph
    // nobody can account for.
    for (const name of files)
      fs.writeFileSync(path.join(bodyRoot, name), "{\"tampered\":true}");
    const tampered = cppClient(root, [`--body-root=${bodyRoot}`]);
    try {
      await rejected(
        "a published body swapped underneath its name is refused",
        tampered.refresh(),
        "published body is not a graph",
      );
    } finally {
      await tampered.close();
    }

    // The three ways a producer can break the contract it just took on. A page
    // that names nothing has published nothing; a name pointing at no file is
    // a body this client cannot read; and a file that is not a body is not
    // one, however it is named. None of them may become an empty graph.
    for (const [fault, message] of [
      ["unnamed", "carries neither a body nor a path"],
      ["absent", "published body cannot be read"],
      ["malformed", "published body is not valid JSON"],
    ] as const) {
      const broken = cppClient(root, [
        `--body-root=${path.join(root, `broken-${fault}`)}`,
        `--body-fault=${fault}`,
      ]);
      try {
        await rejected(
          `a producer that publishes ${fault} bodies is refused`,
          broken.refresh(),
          message,
        );
      } finally {
        await broken.close();
      }
    }
  } finally {
    await client.close();
  }
}

async function assertClientPagination(): Promise<void> {
  const root = GraphPaths.createTempDirectory("samchon-graph-cpp-pages-");
  const commands: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 35; ++index) {
    const file = `page-${String(index).padStart(2, "0")}.cpp`;
    fs.writeFileSync(path.join(root, file), "void caller() {}\n");
    commands.push({
      directory: root,
      file,
      arguments: ["clang++", "-x", "c++", "-c", file],
    });
  }
  fs.writeFileSync(
    path.join(root, "compile_commands.json"),
    JSON.stringify(commands),
  );
  const requestLog = path.join(root, "requests.ndjson");
  const client = cppClient(root, [`--request-log=${requestLog}`]);
  try {
    const refreshed = await client.refresh();
    const requests = readLines(requestLog);
    TestValidator.equals(
      "the resident client assembles bounded native pages before one atomic commit",
      [
        refreshed.snapshot.sources.size,
        refreshed.snapshot.protocol?.shards.length,
        requests.length,
        [...new Set(requests.map((request) => request.maxShards))],
        // Exactly one request opens the generation. Counting them rather than
        // listing the sequence keeps this independent of the page size, without
        // letting a continuation that silently restarted the walk pass as one
        // more `undefined` among many.
        requests.filter((request) => request.cursor === undefined).length,
        typeof requests[0]?.cursor,
      ],
      // Four shards to a page, so 35 translation units are nine requests: the
      // first opens the generation and every later one carries the cursor it
      // was given. The count follows the page size, and the two facts beside it
      // -- one opener, and that opener declaring nothing -- do not.
      [35, 35, 9, [4], 1, "undefined"],
    );
    for (const [corruption, message] of [
      ["generation", "malformed paged generation"],
      ["envelope", "malformed snapshot page envelope"],
      ["telemetry", "malformed page telemetry"],
      ["arithmetic", "page telemetry does not add up"],
      ["cache", "malformed page cache state"],
      ["early", "paged generation ended early"],
      ["cursor", "invalid continuation cursor"],
      ["metadata", "continuation repeated generation metadata"],
      ["cross-generation", "continuation crossed generations"],
    ] as const) {
      const broken = cppClient(root, [`--page-corruption=${corruption}`]);
      await rejected(
        `the client rejects ${corruption} pagination corruption`,
        broken.refresh(),
        message,
      );
      await broken.close();
    }
  } finally {
    await client.close();
  }
  const defaultArgs = new CppGraphClient({
    root,
    languages: ["cpp"],
    command: process.execPath,
    producerCommit: COMMIT,
    requestTimeoutMs: 10,
  });
  await defaultArgs.close();
}

async function assertClientInputShapes(): Promise<void> {
  const root = GraphPaths.createTempDirectory("samchon-graph-cpp-inputs-");
  const build = path.join(root, "build");
  fs.mkdirSync(build);
  fs.writeFileSync(path.join(root, "compile_commands.json"), "{}");
  for (const file of ["fallback.cpp", "direct.cpp", "absolute.cpp"]) {
    fs.writeFileSync(path.join(root, file), "void caller() {}\n");
  }
  fs.writeFileSync(path.join(build, "fallback.cpp"), "void caller() {}\n");
  const absolute = path.join(root, "absolute.cpp");
  const buildCommands = [
    {},
    { file: "" },
    { file: "fallback.cpp" },
    { directory: root, file: "direct.cpp" },
    { directory: "", file: absolute },
  ];
  fs.writeFileSync(
    path.join(build, "compile_commands.json"),
    JSON.stringify(buildCommands),
  );
  const watchLog = path.join(root, "input-watches.ndjson");
  const client = new CppGraphClient({
    root,
    languages: ["c", "cpp"],
    command: process.execPath,
    args: [
      GraphPaths.fakeCppGraphServer,
      `--commit=${COMMIT}`,
      `--watch-log=${watchLog}`,
    ],
    producerCommit: COMMIT,
    requestTimeoutMs: 5_000,
    readyTimeoutMs: 10_000,
  });
  try {
    await client.refresh();
    fs.writeFileSync(path.join(root, ".clangd"), "Diagnostics: {}\n");
    await client.refresh();
    fs.unlinkSync(path.join(root, ".clangd"));
    await client.refresh();
    fs.writeFileSync(
      path.join(build, "compile_commands.json"),
      JSON.stringify(
        buildCommands.filter(
          (row) => !("file" in row) || row.file !== "direct.cpp",
        ),
      ),
    );
    await client.refresh();
    await client.refresh();
    fs.unlinkSync(absolute);
    fs.writeFileSync(
      path.join(build, "compile_commands.json"),
      JSON.stringify(
        buildCommands.filter(
          (row) =>
            !("file" in row) ||
            (row.file !== "direct.cpp" && row.file !== absolute),
        ),
      ),
    );
    await client.refresh();
    await client.refresh();
    const watched = readLines(watchLog).flatMap((row) => row.changes);
    TestValidator.equals(
      "CDB input discovery accepts fallback directories and tracks null-to-file transitions",
      watched
        .filter((change) => String(change.uri).endsWith("/.clangd"))
        .map((change) => change.type),
      [1, 3],
    );
    TestValidator.equals(
      "a file removed only from the compilation database is not falsely deleted on the following refresh",
      watched
        .filter((change) => String(change.uri).endsWith("/direct.cpp"))
        .map((change) => change.type),
      [1],
    );
    TestValidator.equals(
      "a deleted source is notified once and never reborn from a stale null baseline",
      watched
        .filter((change) => String(change.uri).endsWith("/absolute.cpp"))
        .map((change) => change.type),
      [1, 3],
    );
  } finally {
    await client.close();
  }
}

async function assertClientFailures(root: string): Promise<void> {
  const retry = cppClient(root, ["--retry=1", "--content-modified=1"]);
  TestValidator.equals(
    "retryable Clang readiness and movement errors are polled to success",
    (await retry.refresh()).changed,
    true,
  );
  await retry.close();

  const movementRoot = fixtureRoot();
  const movementWatchLog = path.join(movementRoot, "movement-watches.ndjson");
  const movement = cppClient(movementRoot, [
    "--content-modified=1",
    "--move-input-on-content-modified",
    `--watch-log=${movementWatchLog}`,
  ]);
  await movement.refresh();
  await movement.close();
  TestValidator.equals(
    "input movement discovered during a snapshot retry is notified",
    readLines(movementWatchLog).map((row) => row.changes[0]?.type),
    [1, 2],
  );

  const postSnapshotRoot = fixtureRoot();
  const postSnapshotWatchLog = path.join(
    postSnapshotRoot,
    "post-snapshot-watches.ndjson",
  );
  let moveAfterSnapshot = true;
  const postSnapshot = cppClient(
    postSnapshotRoot,
    [`--watch-log=${postSnapshotWatchLog}`],
    {
      validate: () => {
        if (!moveAfterSnapshot) return;
        moveAfterSnapshot = false;
        fs.writeFileSync(
          path.join(postSnapshotRoot, "main.cpp"),
          "void movedAfterSnapshot() {}\n",
        );
      },
    },
  );
  await postSnapshot.refresh();
  await postSnapshot.refresh();
  await postSnapshot.close();
  TestValidator.equals(
    "input movement after a frozen snapshot remains visible to the next refresh",
    readLines(postSnapshotWatchLog).map((row) => row.changes[0]?.type),
    [1, 2],
  );

  const unknownDiskRoot = fixtureRoot();
  const unknownDiskWatchLog = path.join(
    unknownDiskRoot,
    "unknown-disk-watches.ndjson",
  );
  const unknownDisk = cppClient(unknownDiskRoot, [
    "--edge-cases",
    "--empty-disk-digest",
    `--watch-log=${unknownDiskWatchLog}`,
  ]);
  await unknownDisk.refresh();
  await unknownDisk.refresh();
  await unknownDisk.close();
  TestValidator.equals(
    "a source without a producer disk identity is conservatively re-notified",
    readLines(unknownDiskWatchLog)
      .flatMap((row) => row.changes)
      .filter((change) => String(change.uri).endsWith("/main.cpp"))
      .map((change) => change.type),
    [1, 1],
  );

  const timedOut = cppClient(root, ["--content-modified=1"], {
    readyTimeoutMs: 0,
  });
  await rejected(
    "retryable movement still obeys the readiness deadline",
    timedOut.refresh(),
    "did not become ready",
  );
  await timedOut.close();

  const configured = cppClient(
    root,
    [
      "--request-configuration",
      "--request-empty-configuration",
      "--request-unknown",
    ],
    { initializationOptions: { graph: true } },
  );
  await configured.refresh({ signal: new AbortController().signal });
  await configured.close();

  const initializeError = cppClient(root, ["--initialize-error"]);
  await rejected(
    "initialization failures reject the resident session",
    initializeError.refresh({ signal: new AbortController().signal }),
    "fixture initialize failure",
  );
  await initializeError.close();

  const initializing = cppClient(root, ["--hang-initialize"]);
  const initializationAbort = new AbortController();
  const initialization = initializing.refresh({ signal: initializationAbort.signal });
  initializationAbort.abort("initialize cancellation");
  await rejected(
    "an initializing Clang session remains cancellable",
    initialization,
    "cancel",
  );
  await initializing.close();

  const malformed = cppClient(root, ["--malformed"]);
  await rejected(
    "a malformed Clang response fails closed",
    malformed.refresh(),
    "identity/commit mismatch",
  );
  await malformed.close();

  const internal = cppClient(root, ["--internal-error"]);
  await rejected(
    "a non-retryable Clang producer error is surfaced",
    internal.refresh(),
    "fixture internal failure",
  );
  await internal.close();

  const hanging = cppClient(root, ["--hang"]);
  const abort = new AbortController();
  const refresh = hanging.refresh({ signal: abort.signal });
  setTimeout(() => abort.abort("fixture cancellation"), 20).unref?.();
  await rejected(
    "an active Clang snapshot request remains cancellable",
    refresh,
    "abort|cancel",
  );
  await hanging.close();

  const delaying = cppClient(root, ["--retry=100"]);
  await (
    delaying as unknown as {
      initialize(signal: AbortSignal): Promise<void>;
    }
  ).initialize(new AbortController().signal);
  const delayAbort = new AbortController();
  const delayed = delaying.refresh({ signal: delayAbort.signal });
  setTimeout(() => delayAbort.abort("delay cancellation"), 20).unref?.();
  await rejected(
    "retry delay remains cancellable",
    delayed,
    "cancel",
  );
  await delaying.close();

  const queued = cppClient(root, ["--hang"]);
  const activeAbort = new AbortController();
  const active = queued.refresh({ signal: activeAbort.signal });
  const queuedAbort = new AbortController();
  const waiting = queued.refresh({ signal: queuedAbort.signal });
  queuedAbort.abort("queued cancellation");
  await rejected("a queued Clang refresh is cancellable", waiting, "cancel");
  activeAbort.abort("active cancellation");
  await rejected("the active refresh is also cancelled", active, "cancel");
  await queued.close();

  const alreadyAborted = cppClient(root, []);
  const aborted = new AbortController();
  aborted.abort("preflight cancellation");
  await rejected(
    "an already-cancelled refresh never enters the queue",
    alreadyAborted.refresh({ signal: aborted.signal }),
    "cancel",
  );
  await alreadyAborted.close();

  const preinitializing = cppClient(root, []);
  await (
    preinitializing as unknown as {
      initialize(signal: AbortSignal): Promise<void>;
    }
  ).initialize(new AbortController().signal);
  const preinitializedAbort = new AbortController();
  preinitializedAbort.abort("preinitialized cancellation");
  await rejected(
    "the initialization race rejects an already-aborted caller signal",
    (
      preinitializing as unknown as {
        initialize(signal: AbortSignal): Promise<void>;
      }
    ).initialize(preinitializedAbort.signal),
    "cancel",
  );
  await preinitializing.close();

  const directCancellation = cppClient(root, []);
  await rejected(
    "the snapshot loop checks cancellation before requesting a page",
    (
      directCancellation as unknown as {
        requestSnapshot(signal: AbortSignal): Promise<unknown>;
      }
    ).requestSnapshot({ aborted: true, reason: undefined } as AbortSignal),
    "cancel",
  );
  await directCancellation.close();

  const stringFailure = cppClient(root, [], {
    validate: () => {
      throw "fixture validation string";
    },
  });
  await rejected(
    "non-Error validation failures are normalized",
    stringFailure.refresh(),
    "fixture validation string",
  );
  await stringFailure.close();

  const absent = GraphPaths.createTempDirectory("samchon-graph-cpp-empty-client-");
  const noDatabase = cppClient(absent, []);
  await rejected(
    "an empty compilation database fails closed",
    noDatabase.refresh(),
    "universe|generation",
  );
  await noDatabase.close();
}

function cppClient(
  root: string,
  args: readonly string[],
  options: {
    initializationOptions?: unknown;
    readyTimeoutMs?: number;
    pieceBudgetBytes?: number;
    validate?: () => void;
  } = {},
): CppGraphClient {
  return new CppGraphClient({
    root,
    languages: ["c", "cpp"],
    command: process.execPath,
    args: [GraphPaths.fakeCppGraphServer, `--commit=${COMMIT}`, ...args],
    producerCommit: COMMIT,
    initializationOptions: options.initializationOptions,
    requestTimeoutMs: 5_000,
    readyTimeoutMs: options.readyTimeoutMs ?? 10_000,
    ...(options.pieceBudgetBytes === undefined
      ? {}
      : { pieceBudgetBytes: options.pieceBudgetBytes }),
    validate: options.validate,
  });
}

function nodeShim(
  root: string,
  name: string,
  commit: string,
): string {
  const directory = path.join(root, "shims");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(
    directory,
    process.platform === "win32" ? `${name}.cmd` : name,
  );
  const invocation = [
    `"${process.execPath}"`,
    `"${GraphPaths.fakeCppGraphServer}"`,
    `--commit=${commit}`,
  ].join(" ");
  fs.writeFileSync(
    file,
    process.platform === "win32"
      ? `@echo off\r\n${invocation} %*\r\n`
      : `#!/bin/sh\nexec ${invocation} "$@"\n`,
  );
  if (process.platform !== "win32") fs.chmodSync(file, 0o755);
  return file;
}

function readLines(file: string): Array<Record<string, any>> {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, any>);
}

// The pinned producer's three-step composition, so a fixture that edits a body
// reseals it the way clangd would rather than by a rule only this file knows.
function lengthPrefixed(value: string): string {
  return `${String(Buffer.byteLength(value, "utf8"))}:${value}`;
}

function nativeInterfaceFingerprint(graph: ICppGraphSnapshot.ITU): string {
  return sha256(
    graph.symbols
      .filter((symbol) => symbol.exported)
      .map(
        (symbol) =>
          `${lengthPrefixed(symbol.id)}${lengthPrefixed(symbol.signature)}`,
      )
      // Ordered by bytes, as the producer does. An interface is what a unit
      // exports, and a body published in pieces comes back in a different
      // order than it left.
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
      )
      .join(""),
  );
}

function nativeBodyDigest(graph: ICppGraphSnapshot.ITU): string {
  return sha256(
    lengthPrefixed(graph.producerFingerprint) +
      lengthPrefixed(graph.mainFileUri) +
      lengthPrefixed(graph.commandDigest) +
      lengthPrefixed(graph.toolchainFingerprint) +
      lengthPrefixed(graph.targetTriple) +
      lengthPrefixed(graph.language) +
      (graph.hadErrors ? "!" : ".") +
      graph.sources
        .map(
          (source) =>
            `${lengthPrefixed(source.uri)}${lengthPrefixed(source.digest)}`,
        )
        .join("") +
      [
        graph.symbols.length,
        graph.occurrences.length,
        graph.relations.length,
        graph.macros.length,
        graph.includes.length,
        graph.missingIncludes.length,
        graph.modules.length,
        graph.diagnostics.length,
      ]
        .map((count) => `${String(count)},`)
        .join(""),
  );
}

function nativeShardDigest(shard: ICppGraphSnapshot.IShard): string {
  const disk = shard.graph.sources
    .map(
      (source) =>
        `${lengthPrefixed(source.uri)}${lengthPrefixed(source.diskDigest)}`,
    )
    .join("");
  return sha256(
    [
      shard.key,
      shard.checkerDigest,
      shard.interfaceFingerprint,
      nativeBodyDigest(shard.graph),
      disk,
    ].join("\n"),
  );
}

function resealSnapshot(snapshot: ICppGraphSnapshot): void {
  for (const shard of snapshot.upserts) {
    shard.interfaceFingerprint = nativeInterfaceFingerprint(shard.graph);
    shard.digest = nativeShardDigest(shard);
  }
  const digests = new Map(
    snapshot.upserts.map((shard) => [shard.key, shard.digest]),
  );
  snapshot.manifest = snapshot.manifest.map((entry) => ({
    key: entry.key,
    digest: digests.get(entry.key) ?? entry.digest,
  }));
  snapshot.generation = nativeGeneration(
    snapshot.universe.digest,
    snapshot.manifest,
  );
}

function nativeGeneration(
  universe: string,
  manifest: readonly { key: string; digest: string }[],
): string {
  return sha256(
    universe +
      manifest
        .map(
          (entry) =>
            `${Buffer.byteLength(entry.key, "utf8")}:${entry.key}${entry.digest}`,
        )
        .join(""),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function rejected(
  label: string,
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  let error: Error | undefined;
  try {
    await promise;
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }
  TestValidator.predicate(
    label,
    error !== undefined &&
      message.split("|").some((candidate) => error!.message.includes(candidate)),
  );
}
