import { TestValidator } from "@nestia/e2e";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createResidentGraphSource } from "../../../../packages/graph/src/indexer/createResidentGraphSource";
import { IIndexerResult } from "../../../../packages/graph/src/indexer/IIndexerResult";
import { IBulkGraphSession } from "../../../../packages/graph/src/provider/IBulkGraphSession";
import { dumpProvenanceOf } from "../../../../packages/graph/src/provider/dumpProvenanceOf";
import { graphSnapshotDigests } from "../../../../packages/graph/src/provider/graphSnapshotDigests";

export const test_resident_bulk_provider_polls_generations_without_reprocessing_strict_facts =
  async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "samchon-graph-resident-bulk-"),
    );
    const file = path.join(root, "a.ts");
    const text = "export const answer = 1;\n";
    fs.writeFileSync(file, text);
    const first = snapshot(file, text, "first");
    const second = snapshot(file, text, "second");
    let current = first;
    let generation = 1;
    let refreshes = 0;
    let closes = 0;
    let builds = 0;
    const session: IBulkGraphSession = {
      kind: "bulk",
      languages: ["typescript"],
      root,
      get generation() {
        return generation;
      },
      get current() {
        return current;
      },
      async refresh() {
        refreshes += 1;
        if (refreshes === 2) {
          current = second;
          generation = 2;
          return {
            changed: true,
            generation,
            mode: "incremental",
            snapshot: current,
          };
        }
        if (refreshes === 3) throw new Error("synthetic provider failure");
        return {
          changed: false,
          generation,
          mode: "unchanged",
          snapshot: current,
        };
      },
      async close() {
        closes += 1;
      },
    };
    const initialDump = {
      project: root,
      // Exercise bookkeeping independently of the buildLspGraph regression:
      // an older/mocked pure-strict result may omit language metadata, but its
      // owned bulk session still determines the resident topology.
      languages: [] as const,
      indexer: "lsp" as const,
      nodes: first.nodes.map(({ evidence, ...node }) => ({
        ...node,
        evidence: {
          startLine: evidence!.startLine,
          endLine: evidence!.endLine,
        },
      })),
      edges: [],
      warnings: [],
    };
    const resident = createResidentGraphSource(
      { cwd: root, languages: ["typescript"] },
      {
        // Keep this hand-written legacy result independent of whichever
        // optional strict tools the coverage runner exposes through PATH.
        providers: [],
        buildLspGraph: async () => {
          builds += 1;
          return {
            dump: initialDump,
            warnings: [],
            sessions: new Map([["typescript", session]]),
            // The session must remain authoritative even before it has exposed
            // a source-text snapshot.
            sources: new Map(),
            modes: new Map<string, IBulkGraphSession.Mode>([
              ["ttscgraph", "initial"],
            ]),
          } as IIndexerResult;
        },
      },
    );

    TestValidator.equals(
      "resident modes are empty before the first generation",
      [...resident.modes()],
      [],
    );
    const loaded = await resident.load();
    TestValidator.equals(
      "the cold provider mode is observable",
      [...resident.modes()],
      [["ttscgraph", "initial"]],
    );
    const originalReadFileSync = fs.readFileSync;
    const originalReaddirSync = fs.readdirSync;
    let sourceReads = 0;
    let directoryReads = 0;
    fs.readFileSync = ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (typeof target === "string" && path.resolve(target) === file) {
        sourceReads += 1;
      }
      return Reflect.apply(originalReadFileSync, fs, [
        target,
        ...args,
      ]) as ReturnType<typeof fs.readFileSync>;
    }) as typeof fs.readFileSync;
    fs.readdirSync = ((...args: unknown[]) => {
      directoryReads += 1;
      return Reflect.apply(
        originalReaddirSync as (...values: unknown[]) => unknown,
        fs,
        args,
      );
    }) as typeof fs.readdirSync;
    let unchanged;
    try {
      unchanged = await resident.load();
    } finally {
      fs.readFileSync = originalReadFileSync;
      fs.readdirSync = originalReaddirSync;
    }
    TestValidator.equals(
      "an unchanged compiler-owned generation performs no coordinator corpus walk or source read",
      [directoryReads, sourceReads],
      [0, 0],
    );
    TestValidator.predicate(
      "an unchanged bulk generation reuses the resident dump object",
      unchanged === loaded,
    );
    TestValidator.equals(
      "an unchanged poll reports reuse independently of dump identity",
      [...resident.modes()],
      [["ttscgraph", "unchanged"]],
    );
    const changed = await resident.load();
    TestValidator.predicate(
      "a changed full slice atomically replaces the resident dump",
      changed !== loaded &&
        changed.nodes.length === 1 &&
        changed.nodes[0]?.name === "second" &&
        changed.nodes[0]?.ignored === true &&
        changed.nodes[0]?.closure === true,
    );
    TestValidator.equals(
      "a changed provider exposes its actual computation mode",
      [...resident.modes()],
      [["ttscgraph", "incremental"]],
    );
    await rejects(resident.load(), "a provider poll failure is surfaced");
    const recovered = await resident.load();
    TestValidator.predicate(
      "the last published generation survives a failed provider poll",
      recovered === changed && recovered.nodes[0]?.name === "second",
    );
    TestValidator.equals(
      "the recovered unchanged poll is measured without replacing the dump",
      [...resident.modes()],
      [["ttscgraph", "unchanged"]],
    );
    TestValidator.equals(
      "an empty dump language list cannot misclassify or replace its strict session",
      builds,
      1,
    );
    await resident.close();
    TestValidator.equals("resident shutdown closes its owned bulk session once", closes, 1);
    await testFactEquivalentBulkGeneration(file, root);
    await testFactEquivalentFallbacksAndRaces();
  };

async function testFactEquivalentBulkGeneration(
  originalFile: string,
  originalRoot: string,
): Promise<void> {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "samchon-graph-resident-equivalent-"),
  );
  const file = path.join(root, "a.ts");
  const companion = path.join(root, "b.ts");
  const external = path.join(root, "reference.dll");
  const firstText = "export function answer() { return 1; }\n";
  const secondText = "export function answer() { return 2; }\n";
  const companionText = "export const stable = 1;\n";
  const externalText = "fixture reference bytes\n";
  fs.writeFileSync(file, firstText);
  fs.writeFileSync(companion, companionText);
  fs.writeFileSync(external, externalText);
  const first = factEquivalentSnapshot(
    file,
    firstText,
    companion,
    companionText,
    external,
    externalText,
    1,
  );
  const second = factEquivalentSnapshot(
    file,
    secondText,
    companion,
    companionText,
    external,
    externalText,
    2,
  );
  const externalStale = factEquivalentSnapshot(
    file,
    secondText,
    companion,
    companionText,
    external,
    externalText,
    3,
  );
  const stale = factEquivalentSnapshot(
    file,
    secondText,
    companion,
    companionText,
    external,
    externalText,
    4,
  );
  const missing = factEquivalentSnapshot(
    file,
    secondText,
    companion,
    companionText,
    external,
    externalText,
    5,
  );
  let current = first;
  let generation = 1;
  let refreshes = 0;
  const session: IBulkGraphSession = {
    kind: "bulk",
    languages: ["typescript"],
    root,
    get generation() {
      return generation;
    },
    get current() {
      return current;
    },
    async refresh() {
      refreshes += 1;
      current =
        refreshes === 1
          ? second
          : refreshes === 2
            ? externalStale
            : refreshes === 3
              ? stale
              : missing;
      generation += 1;
      return {
        changed: true,
        generation,
        mode: "incremental",
        snapshot: current,
      };
    },
    async close() {},
  };
  const initialDump = {
    project: root,
    languages: ["typescript"] as const,
    indexer: "lsp" as const,
    nodes: first.nodes,
    edges: first.edges,
    diagnostics: first.diagnostics,
    coverage: first.coverage,
    unresolved: first.unresolved,
    warnings: first.warnings,
    provenance: [dumpProvenanceOf(first)],
  };
  const resident = createResidentGraphSource(
    { cwd: root, languages: ["typescript"] },
    {
      providers: [],
      buildLspGraph: async () =>
        ({
          dump: initialDump,
          warnings: [],
          sessions: new Map([["typescript", session]]),
          sources: new Map(),
          inputManifest: new Map([
            [file, hash(firstText)],
            [companion, hash(companionText)],
          ]),
          modes: new Map<string, IBulkGraphSession.Mode>([
            ["fixture-compiler", "initial"],
          ]),
        }) as IIndexerResult,
    },
  );
  const loaded = await resident.load();
  const initialGeneration = loaded.generation?.input;
  fs.writeFileSync(file, secondText);
  const originalReadFileSync = fs.readFileSync;
  const originalReaddirSync = fs.readdirSync;
  let sourceReads = 0;
  let directoryReads = 0;
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (
      typeof target === "string" &&
      [file, companion].includes(path.resolve(target))
    ) {
      sourceReads += 1;
    }
    return Reflect.apply(originalReadFileSync, fs, [
      target,
      ...args,
    ]) as ReturnType<typeof fs.readFileSync>;
  }) as typeof fs.readFileSync;
  fs.readdirSync = ((...args: unknown[]) => {
    directoryReads += 1;
    return Reflect.apply(
      originalReaddirSync as (...values: unknown[]) => unknown,
      fs,
      args,
    );
  }) as typeof fs.readdirSync;
  let changed;
  try {
    changed = await withRoslynTrace(() => resident.load());
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.readdirSync = originalReaddirSync;
  }
  TestValidator.predicate(
    "a fact-equivalent compiler generation advances only its manifest envelope",
    changed !== loaded &&
      changed.nodes === loaded.nodes &&
      changed.edges === loaded.edges &&
      changed.provenance?.[0]?.manifest ===
        graphSnapshotDigests.manifestOf(second) &&
      changed.generation?.input !== initialGeneration,
  );
  TestValidator.equals(
    "a fact-equivalent generation fences every tracked provider source without a directory walk",
    [directoryReads, sourceReads],
    [0, 2],
  );

  fs.writeFileSync(external, "moved reference bytes\n");
  await rejects(
    resident.load(),
    "an untracked provider source moved after fact-equivalent preparation is rejected",
  );
  TestValidator.predicate(
    "an untracked stale source leaves the published dump intact",
    changed.nodes === loaded.nodes && changed.provenance?.[0]?.manifest ===
      graphSnapshotDigests.manifestOf(second),
  );
  fs.writeFileSync(external, externalText);
  fs.writeFileSync(companion, "export const stable = 2;\n");
  await rejects(
    resident.load(),
    "a source moved after fact-equivalent preparation is rejected even when its provider digest is unchanged",
  );
  TestValidator.predicate(
    "an unrelated stale source leaves the published dump intact",
    changed.nodes === loaded.nodes && changed.provenance?.[0]?.manifest ===
      graphSnapshotDigests.manifestOf(second),
  );
  fs.writeFileSync(companion, companionText);
  fs.rmSync(file);
  await rejects(
    resident.load(),
    "a source deleted after fact-equivalent preparation is rejected",
  );
  TestValidator.predicate(
    "a rejected fact-equivalent generation leaves the published dump intact",
    changed.nodes === loaded.nodes && changed.provenance?.[0]?.manifest ===
      graphSnapshotDigests.manifestOf(second),
  );
  await resident.close();

  // Keep both temporary roots live until their resident sessions have closed;
  // the parent test's fixture remains an independent ordinary-refresh oracle.
  TestValidator.predicate(
    "fact-equivalent and ordinary refresh fixtures use isolated roots",
    originalFile.startsWith(originalRoot) && root !== originalRoot,
  );
}

async function testFactEquivalentFallbacksAndRaces(): Promise<void> {
  await testMetadataFallbacks();
  await testReplacedCandidateFence();
  await testCloseFence();
  await testMultipleBulkOwnerFallback();
}

async function testMetadataFallbacks(): Promise<void> {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "samchon-graph-resident-equivalent-metadata-"),
  );
  const file = path.join(root, "a.ts");
  const companion = path.join(root, "b.ts");
  const external = path.join(root, "reference.dll");
  const added = path.join(root, "added-reference.dll");
  const firstText = "export function answer() { return 1; }\n";
  const secondText = "export function answer() { return 2; }\n";
  const companionText = "export const stable = 1;\n";
  const externalText = "fixture reference bytes\n";
  const addedText = "added reference bytes\n";
  fs.writeFileSync(file, firstText);
  fs.writeFileSync(companion, companionText);
  fs.writeFileSync(external, externalText);
  fs.writeFileSync(added, addedText);
  const initial = factEquivalentSnapshot(
    file,
    firstText,
    companion,
    companionText,
    external,
    externalText,
    1,
  );
  const warningMoved = {
    ...factEquivalentSnapshot(
      file,
      secondText,
      companion,
      companionText,
      external,
      externalText,
      2,
    ),
    warnings: ["moved warning"],
  };
  const membershipMovedBase = factEquivalentSnapshot(
    file,
    secondText,
    companion,
    companionText,
    external,
    externalText,
    3,
  );
  const membershipMoved = {
    ...membershipMovedBase,
    sources: new Map([
      ...membershipMovedBase.sources,
      [
        added,
        {
          checkerDigest: hash(addedText),
          diskDigest: hash(addedText),
        },
      ] as const,
    ]),
    warnings: ["moved warning"],
  };
  let current: IBulkGraphSession.ISnapshot = initial;
  let generation = 1;
  let refreshes = 0;
  const session: IBulkGraphSession = {
    kind: "bulk",
    languages: ["typescript"],
    root,
    get generation() {
      return generation;
    },
    get current() {
      return current;
    },
    async refresh() {
      refreshes += 1;
      generation += 1;
      current = refreshes === 1 ? warningMoved : membershipMoved;
      return {
        changed: refreshes < 3,
        generation,
        mode: refreshes < 3 ? "incremental" : "unchanged",
        snapshot: current,
      };
    },
    async close() {},
  };
  const resident = residentFor(root, [file, companion], session, initial);
  await resident.load();
  fs.writeFileSync(file, secondText);
  const warningDump = await resident.load();
  const membershipDump = await resident.load();
  const generationOnlyDump = await resident.load();
  TestValidator.predicate(
    "warning and source-membership movement take the full transaction before a generation-only poll",
    warningDump.warnings.includes("moved warning") &&
      membershipDump.provenance?.[0]?.manifest ===
        graphSnapshotDigests.manifestOf(membershipMoved) &&
      generationOnlyDump.nodes.length === membershipDump.nodes.length,
  );
  await resident.close();
}

async function testReplacedCandidateFence(): Promise<void> {
  const fixture = singleSessionFixture("replaced");
  const returned = fixture.next;
  const replaced = {
    ...fixture.next,
    protocol: { ...fixture.next.protocol!, generation: "generation-3", sequence: 3 },
  };
  fixture.session.refresh = async () => {
    fixture.advance(replaced);
    return {
      changed: true,
      generation: fixture.session.generation,
      mode: "incremental",
      snapshot: returned,
    };
  };
  const resident = residentFor(
    fixture.root,
    [fixture.file, fixture.companion],
    fixture.session,
    fixture.initial,
  );
  await resident.load();
  fs.writeFileSync(fixture.file, fixture.secondText);
  await rejects(
    resident.load(),
    "a provider replacing its candidate during preparation is rejected",
  );
  await resident.close();
}

async function testCloseFence(): Promise<void> {
  const fixture = singleSessionFixture("close");
  fixture.session.refresh = async () => {
    fixture.advance(fixture.next);
    return {
      changed: true,
      generation: fixture.session.generation,
      mode: "incremental",
      snapshot: fixture.next,
    };
  };
  const resident = residentFor(
    fixture.root,
    [fixture.file, fixture.companion],
    fixture.session,
    fixture.initial,
  );
  await resident.load();
  fs.writeFileSync(fixture.file, fixture.secondText);
  const originalReadFileSync = fs.readFileSync;
  let closing: Promise<void> | undefined;
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    const value = Reflect.apply(originalReadFileSync, fs, [
      target,
      ...args,
    ]) as ReturnType<typeof fs.readFileSync>;
    if (
      closing === undefined &&
      typeof target === "string" &&
      path.resolve(target) === fixture.file
    ) {
      closing = resident.close();
    }
    return value;
  }) as typeof fs.readFileSync;
  try {
    await rejects(
      resident.load(),
      "closing during the final source fence aborts publication",
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  await closing;
}

async function testMultipleBulkOwnerFallback(): Promise<void> {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "samchon-graph-resident-multiple-bulk-"),
  );
  const typescript = path.join(root, "a.ts");
  const go = path.join(root, "b.go");
  const typescriptText = "export const answer = 1;\n";
  const goText = "package fixture\nvar Answer = 1\n";
  fs.writeFileSync(typescript, typescriptText);
  fs.writeFileSync(go, goText);
  const firstTypescript = languageSnapshot(
    typescript,
    typescriptText,
    "typescript",
    "typescript-first",
  );
  const secondTypescript = languageSnapshot(
    typescript,
    typescriptText,
    "typescript",
    "typescript-second",
  );
  const firstGo = languageSnapshot(go, goText, "go", "go-first");
  const secondGo = languageSnapshot(go, goText, "go", "go-second");
  const typescriptSession = changingSession(
    root,
    "typescript",
    firstTypescript,
    secondTypescript,
  );
  const goSession = changingSession(root, "go", firstGo, secondGo);
  const initialDump = {
    project: root,
    languages: ["typescript", "go"] as const,
    indexer: "lsp" as const,
    nodes: [...firstTypescript.nodes, ...firstGo.nodes],
    edges: [],
    diagnostics: [],
    warnings: [],
    provenance: [
      dumpProvenanceOf(firstTypescript),
      dumpProvenanceOf(firstGo),
    ],
  };
  const resident = createResidentGraphSource(
    { cwd: root, languages: ["typescript", "go"] },
    {
      providers: [],
      buildLspGraph: async () =>
        ({
          dump: initialDump,
          warnings: [],
          sessions: new Map([
            ["typescript", typescriptSession],
            ["go", goSession],
          ]),
          sources: new Map(),
          inputManifest: new Map([
            [typescript, hash(typescriptText)],
            [go, hash(goText)],
          ]),
          modes: new Map(),
        }) as IIndexerResult,
    },
  );
  await resident.load();
  const changed = await resident.load();
  TestValidator.equals(
    "distinct bulk owners bypass the single-owner fact reuse optimization",
    changed.nodes.map((node) => node.name).sort(),
    ["go-second", "typescript-second"],
  );
  await resident.close();
}

function residentFor(
  root: string,
  files: readonly string[],
  session: IBulkGraphSession,
  initial: IBulkGraphSession.ISnapshot,
) {
  const initialDump = {
    project: root,
    languages: ["typescript"] as const,
    indexer: "lsp" as const,
    nodes: initial.nodes,
    edges: initial.edges,
    diagnostics: initial.diagnostics,
    coverage: initial.coverage,
    unresolved: initial.unresolved,
    warnings: initial.warnings,
    provenance: [dumpProvenanceOf(initial)],
  };
  return createResidentGraphSource(
    { cwd: root, languages: ["typescript"] },
    {
      providers: [],
      buildLspGraph: async () =>
        ({
          dump: initialDump,
          warnings: [],
          sessions: new Map([["typescript", session]]),
          sources: new Map(),
          inputManifest: new Map(
            files.map((file) => [file, hash(fs.readFileSync(file))]),
          ),
          modes: new Map(),
        }) as IIndexerResult,
    },
  );
}

function singleSessionFixture(label: string) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `samchon-graph-resident-${label}-`),
  );
  const file = path.join(root, "a.ts");
  const companion = path.join(root, "b.ts");
  const external = path.join(root, "reference.dll");
  const firstText = "export function answer() { return 1; }\n";
  const secondText = "export function answer() { return 2; }\n";
  const companionText = "export const stable = 1;\n";
  const externalText = "fixture reference bytes\n";
  fs.writeFileSync(file, firstText);
  fs.writeFileSync(companion, companionText);
  fs.writeFileSync(external, externalText);
  const initial = factEquivalentSnapshot(
    file,
    firstText,
    companion,
    companionText,
    external,
    externalText,
    1,
  );
  const next = factEquivalentSnapshot(
    file,
    secondText,
    companion,
    companionText,
    external,
    externalText,
    2,
  );
  let current: IBulkGraphSession.ISnapshot = initial;
  let generation = 1;
  const session: IBulkGraphSession = {
    kind: "bulk",
    languages: ["typescript"],
    root,
    get generation() {
      return generation;
    },
    get current() {
      return current;
    },
    async refresh() {
      throw new Error("fixture refresh was not installed");
    },
    async close() {},
  };
  return {
    root,
    file,
    companion,
    firstText,
    secondText,
    initial,
    next,
    session,
    advance(snapshot: IBulkGraphSession.ISnapshot) {
      generation += 1;
      current = snapshot;
    },
  };
}

function changingSession(
  root: string,
  language: "typescript" | "go",
  initial: IBulkGraphSession.ISnapshot,
  next: IBulkGraphSession.ISnapshot,
): IBulkGraphSession {
  let current = initial;
  let generation = 1;
  return {
    kind: "bulk",
    languages: [language],
    root,
    get generation() {
      return generation;
    },
    get current() {
      return current;
    },
    async refresh() {
      generation += 1;
      current = next;
      return { changed: true, generation, mode: "incremental", snapshot: next };
    },
    async close() {},
  };
}

function languageSnapshot(
  file: string,
  text: string,
  language: "typescript" | "go",
  name: string,
): IBulkGraphSession.ISnapshot {
  const base = snapshot(file, text, name);
  const relative = path.basename(file);
  return {
    ...base,
    languages: [language],
    nodes: base.nodes.map((node) => ({
      ...node,
      id: `${relative}#${name}:variable`,
      kind: "variable",
      language,
      file: relative,
      evidence: { file: relative, startLine: 1, endLine: 1 },
    })),
    provenance: {
      ...base.provenance,
      provider: `fixture-${language}`,
      tool: `fixture-${language}`,
    },
  };
}

function snapshot(
  file: string,
  text: string,
  name: string,
): IBulkGraphSession.ISnapshot {
  const digest = createHash("sha256").update(text).digest("hex");
  return {
    languages: ["typescript"],
    nodes: [
      {
        id: `a.ts#${name}:function`,
        kind: "function",
        language: "typescript",
        name,
        file: "a.ts",
        external: false,
        ignored: true,
        closure: true,
        evidence: { file: "a.ts", startLine: 1, endLine: 1 },
      },
    ],
    edges: [],
    diagnostics: [],
    // A bulk snapshot names its files and the digest its checker read; it never
    // carries their text, so a resident refresh has nothing to re-read either.
    sources: new Map([[file, { checkerDigest: digest, diskDigest: digest }]]),
    provenance: {
      provider: "ttscgraph",
      authority: "compiler",
      facts: ["exports", "calls"],
      schemaVersion: 6,
      tool: "ttscgraph",
      toolVersion: "0.20.1",
      compilerVersion: "5.9.0",
      protocolVersion: 1,
      universe: createHash("sha256").update("universe").digest("hex"),
      capabilities: ["universe", "sourceDigests", "diskDigests", "diagnostics"],
    },
    warnings: [],
  };
}

function factEquivalentSnapshot(
  file: string,
  text: string,
  companion: string,
  companionText: string,
  external: string,
  externalText: string,
  sequence: number,
): IBulkGraphSession.ISnapshot {
  const base = snapshot(file, text, "stable");
  const companionDigest = hash(companionText);
  const externalDigest = hash(externalText);
  const sourceEntries = [
    ...base.sources,
    [
      companion,
      {
        checkerDigest: companionDigest,
        diskDigest: companionDigest,
      },
    ] as const,
    [
      external,
      {
        checkerDigest: externalDigest,
        diskDigest: externalDigest,
      },
    ] as const,
  ];
  if (sequence % 2 === 0) sourceEntries.reverse();
  return {
    ...base,
    sources: new Map(sourceEntries),
    provenance: {
      ...base.provenance,
      provider: "fixture-compiler",
    },
    protocol: {
      version: 1,
      sequence,
      generation: `generation-${sequence}`,
      ...(sequence === 1
        ? {}
        : {
            baseSequence: sequence - 1,
            baseGeneration: `generation-${sequence - 1}`,
          }),
      manifest: hash(text),
      targets: ["app"],
      shards: [],
      factDigest: hash("stable graph facts"),
    },
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function rejects(task: Promise<unknown>, label: string): Promise<void> {
  let error: unknown;
  try {
    await task;
  } catch (caught) {
    error = caught;
  }
  TestValidator.predicate(label, error instanceof Error);
}

async function withRoslynTrace<T>(task: () => Promise<T>): Promise<T> {
  const prior = process.env["SAMCHON_GRAPH_ROSLYN_TRACE"];
  process.env["SAMCHON_GRAPH_ROSLYN_TRACE"] = "1";
  try {
    return await task();
  } finally {
    if (prior === undefined) delete process.env["SAMCHON_GRAPH_ROSLYN_TRACE"];
    else process.env["SAMCHON_GRAPH_ROSLYN_TRACE"] = prior;
  }
}
