import { TestValidator } from "@nestia/e2e";
import {
  buildLspGraph,
  buildStaticGraphResult,
  createResidentGraphSource,
  type GraphLanguage,
  type IBulkGraphSession,
  type ILspSession,
  type ISamchonGraphNode,
} from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";
import { ProviderFixtures } from "../internal/ProviderFixtures";

type BuildDependencies = NonNullable<Parameters<typeof buildLspGraph>[1]>;

/** Requested languages share one source cap across one-shot and resident lanes. */
export const test_requested_languages_are_normalized_before_global_source_selection = async () => {
  const root = GraphPaths.createTempDirectory("samchon-graph-language-cap-");
  fs.writeFileSync(path.join(root, "a.go"), "package main\nfunc First() {}\n");
  fs.writeFileSync(path.join(root, "b.ts"), "export const second = 2;\n");
  fs.writeFileSync(path.join(root, "c.lua"), "function third() end\n");
  fs.writeFileSync(path.join(root, "z.go"), "package main\nfunc Last() {}\n");
  installCommand(root, "gopls");
  installCommand(root, "ttscserver");

  await assertGenericDuplicatesAndGlobalCap(root);
  await assertStrictDuplicatesAreNotOpenedTwice(root);
  await assertFallbackDuplicatesAndStaticResidentCap(root);
  await assertUnsupportedExplicitLanguageFailsBeforeIndexing(root);
  await assertEmptyStrictSliceRemainsStrict(root);
  await assertSessionCannotWidenItsCandidate(root);
  await assertSessionMayNameItsCandidateInAnyOrder(root);
  await assertInitialBuildInputFence();
};

async function assertGenericDuplicatesAndGlobalCap(root: string): Promise<void> {
  const calls: GraphLanguage[] = [];
  const dependencies: BuildDependencies = {
    // No strict provider is registered, so every language reaches the generic
    // lane and this case measures what it was written to measure.
    providers: [],
    collectLanguageGraph: async (_root, language) => {
      calls.push(language);
      return {
        result: {
          nodes: [graphNode(language, language === "go" ? "a.go" : "b.ts")],
          edges: [],
          diagnostics: [],
          warnings: [],
        },
        session: genericSession(language),
      };
    },
  };
  const capped = await buildLspGraph(
    {
      cwd: root,
      languages: ["go", "typescript", "go"],
      maxFiles: 1,
      keepAlive: true,
    },
    dependencies,
  );
  TestValidator.equals(
    "one globally selected file opens only its language once",
    calls,
    ["go"],
  );
  TestValidator.equals(
    "a duplicate generic language cannot overwrite a kept session",
    capped.sessions?.size,
    1,
  );

  calls.length = 0;
  const unlimited = await buildLspGraph(
    {
      cwd: root,
      languages: ["go", "typescript", "go"],
      keepAlive: true,
    },
    dependencies,
  );
  TestValidator.equals(
    "unlimited selection still retains the first requested-language order",
    calls,
    ["go", "typescript"],
  );
  await closeSessions(capped, unlimited);
}

async function assertStrictDuplicatesAreNotOpenedTwice(root: string): Promise<void> {
  let calls = 0;
  let closes = 0;
  const snapshot = strictSnapshot(root);
  const session: IBulkGraphSession = {
    kind: "bulk",
    languages: ["typescript"],
    root,
    generation: 1,
    current: snapshot,
    refresh: async () => ({
      changed: false,
      generation: 1,
      mode: "unchanged",
      snapshot,
    }),
    close: async () => {
      closes += 1;
    },
  };
  const result = await buildLspGraph(
    {
      cwd: root,
      languages: ["typescript", "typescript"],
      keepAlive: true,
    },
    {
      providers: [ProviderFixtures.provider()],
      collectProviderGraph: async () => {
        calls += 1;
        return {
          refresh: {
            changed: true,
            generation: 1,
            mode: "initial",
            snapshot,
          },
          session,
        };
      },
    },
  );
  TestValidator.equals("one strict language is opened once", calls, 1);
  TestValidator.equals("one strict session is retained", result.sessions?.size, 1);
  await session.close();
  TestValidator.equals("the retained strict session closes once", closes, 1);
}

async function assertFallbackDuplicatesAndStaticResidentCap(root: string): Promise<void> {
  const fallback = await buildLspGraph({
    cwd: root,
    languages: ["lua", "lua"],
    server: "samchon-graph-missing-lsp",
    keepAlive: true,
  });
  TestValidator.equals("one fallback language is reported", fallback.dump.languages, ["lua"]);
  TestValidator.equals(
    "duplicate fallback languages produce one unavailable-server warning",
    fallback.warnings.filter((warning) => warning.includes("LSP server not found")).length,
    1,
  );

  const staticResult = buildStaticGraphResult({
    cwd: root,
    languages: ["go", "typescript"],
    maxFiles: 1,
  });
  TestValidator.equals(
    "the static lane consumes the same globally capped source set",
    [...staticResult.sources!.keys()].map((file) => path.basename(file)),
    ["a.go"],
  );

  const resident = createResidentGraphSource({
    cwd: root,
    mode: "static",
    languages: ["go", "typescript"],
    maxFiles: 1,
  });
  const initial = await resident.load();
  fs.writeFileSync(path.join(root, "a.go"), "package main\nfunc Changed() {}\n");
  const refreshed = await resident.load();
  TestValidator.predicate(
    "resident refresh keeps the shared cap and observes its selected source",
    initial.nodes.some((node) => node.name === "First") &&
      refreshed.nodes.some((node) => node.name === "Changed") &&
      refreshed.nodes.every((node) => node.language === "go"),
  );
  await resident.close();
}

async function assertUnsupportedExplicitLanguageFailsBeforeIndexing(
  root: string,
): Promise<void> {
  await TestValidator.error("an explicit unknown language is rejected", async () => {
    await buildLspGraph({
      cwd: root,
      languages: ["unknown"],
    });
  });
  await TestValidator.error("runtime language drift is rejected precisely", () =>
    buildStaticGraphResult({
      cwd: root,
      languages: [123 as unknown as GraphLanguage],
    }),
  );
}

async function assertEmptyStrictSliceRemainsStrict(root: string): Promise<void> {
  const snapshot = ProviderFixtures.snapshot({ provider: "empty-strict" });
  const session = ProviderFixtures.session({ root, snapshots: [snapshot] });
  const result = await buildLspGraph(
    { cwd: root, languages: ["typescript"], keepAlive: true },
    {
      providers: [
        ProviderFixtures.provider({
          name: "empty-strict",
          open: () => session,
        }),
      ],
    },
  );
  TestValidator.predicate(
    "a valid declaration-free strict slice keeps its authority and language",
    result.dump.indexer === "lsp" &&
      result.dump.languages.includes("typescript") &&
      result.dump.nodes.length === 0 &&
      result.dump.provenance?.[0]?.provider === "empty-strict" &&
      result.sessions?.get("typescript") === session,
  );
  await session.close();
}

async function assertSessionMayNameItsCandidateInAnyOrder(
  root: string,
): Promise<void> {
  // The contract compares what a session opened for against what the registry
  // selected, and both are sets: `[typescript, go]` and `[go, typescript]` are
  // one route named twice. Every earlier case here opens for a single language,
  // so the comparison never had to order anything, and a contract that happened
  // to compare the two lists positionally would have passed all of them.
  const reordering = ProviderFixtures.session({
    root,
    languages: ["typescript", "go"],
    snapshots: [
      ProviderFixtures.snapshot({
        provider: "reordering",
        languages: ["go", "typescript"],
      }),
    ],
  });
  const result = await buildLspGraph(
    { cwd: root, languages: ["go", "typescript"], keepAlive: true },
    {
      providers: [
        ProviderFixtures.provider({
          name: "reordering",
          languages: ["go", "typescript"],
          open: () => reordering,
        }),
      ],
    },
  );
  TestValidator.equals(
    "a session that names the selected languages in another order is accepted",
    [
      result.dump.indexer,
      [...result.dump.languages].sort(),
      result.sessions?.get("go") === reordering,
      result.sessions?.get("typescript") === reordering,
      result.warnings.some((warning) => warning.includes("opened a session for")),
    ],
    ["lsp", ["go", "typescript"], true, true, false],
  );
  await reordering.close();
}

async function assertSessionCannotWidenItsCandidate(root: string): Promise<void> {
  let closes = 0;
  let genericCalls = 0;
  const snapshot = ProviderFixtures.snapshot({ provider: "widening" });
  const widening = ProviderFixtures.session({
    root,
    languages: ["go"],
    snapshots: [snapshot],
    onClose: () => {
      closes += 1;
    },
  });
  const generic = genericSession("typescript");
  const result = await buildLspGraph(
    { cwd: root, languages: ["typescript"] },
    {
      providers: [
        ProviderFixtures.provider({
          name: "widening",
          open: () => widening,
        }),
      ],
      collectLanguageGraph: async () => {
        genericCalls += 1;
        return {
          result: {
            nodes: [graphNode("typescript", "b.ts")],
            edges: [],
            diagnostics: [],
            warnings: [],
          },
          session: generic,
        };
      },
    },
  );
  TestValidator.predicate(
    "a provider-controlled language widening is refused, closed, and reported",
    closes === 1 &&
      genericCalls === 1 &&
      result.warnings.some((warning) => warning.includes("opened a session for")),
  );
  await generic.client.close();

  await assertRejectedStrictSession(root, "wrong-root", (snapshot) => ({
    kind: "bulk",
    languages: ["typescript"],
    root: path.join(root, "another-project"),
    generation: 1,
    current: snapshot,
    refresh: async () => ({
      changed: true,
      generation: 1,
      mode: "initial",
      snapshot,
    }),
    close: async () => undefined,
  }), "not the selected project");
  await assertRejectedStrictSession(root, "wrong-current", (snapshot) => ({
    kind: "bulk",
    languages: ["typescript"],
    root,
    generation: 1,
    current: undefined,
    refresh: async () => ({
      changed: true,
      generation: 1,
      mode: "initial",
      snapshot,
    }),
    close: async () => undefined,
  }), "not its current generation");
  await assertRejectedStrictSession(root, "wrong-generation", (snapshot) => ({
    kind: "bulk",
    languages: ["typescript"],
    root,
    generation: 2,
    current: snapshot,
    refresh: async () => ({
      changed: true,
      generation: 1,
      mode: "initial",
      snapshot,
    }),
    close: async () => undefined,
  }), "session reports 2");
}

async function assertRejectedStrictSession(
  root: string,
  name: string,
  sessionOf: (snapshot: IBulkGraphSession.ISnapshot) => IBulkGraphSession,
  warning: string,
): Promise<void> {
  const snapshot = ProviderFixtures.snapshot({ provider: name });
  const session = sessionOf(snapshot);
  const generic = genericSession("typescript");
  const result = await buildLspGraph(
    { cwd: root, languages: ["typescript"] },
    {
      providers: [ProviderFixtures.provider({ name, open: () => session })],
      collectLanguageGraph: async () => ({
        result: {
          nodes: [graphNode("typescript", "b.ts")],
          edges: [],
          diagnostics: [],
          warnings: [],
        },
        session: generic,
      }),
    },
  );
  TestValidator.predicate(
    `${name} is refused before publication`,
    result.warnings.some((entry) => entry.includes(warning)),
  );
  await generic.client.close();
}

async function assertInitialBuildInputFence(): Promise<void> {
  const root = GraphPaths.createTempDirectory("samchon-graph-initial-fence-");
  const source = path.join(root, "a.ts");
  const config = path.join(root, "generated.inputs");
  fs.writeFileSync(source, "export const value = 1;\n");
  fs.writeFileSync(config, "first\n");
  installCommand(root, "ttscserver");

  let builds = 0;
  let staleCloses = 0;
  const result = await buildLspGraph(
    { cwd: root, languages: ["typescript"], keepAlive: true },
    {
      providers: [
        ProviderFixtures.provider({
          name: "declared-inputs",
          buildInputs: ["generated.inputs"],
          refuse: () => "use the generic lane for this fence fixture",
        }),
      ],
      collectLanguageGraph: async () => {
        builds += 1;
        const session = genericSession("typescript");
        session.client.close = async () => {
          staleCloses += 1;
        };
        if (builds === 1) fs.writeFileSync(config, "second\n");
        return {
          result: {
            nodes: [graphNode("typescript", "a.ts")],
            edges: [],
            diagnostics: [],
            warnings: [],
          },
          session,
        };
      },
    },
  );
  TestValidator.predicate(
    "an initial build retries a moved provider-declared input and closes its candidate",
    builds === 2 && staleCloses === 1,
  );
  const kept = result.sessions?.get("typescript");
  if (kept !== undefined && !("kind" in kept)) await kept.client.close();

  fs.writeFileSync(config, "one-shot first\n");
  let oneShotBuilds = 0;
  let oneShotCloses = 0;
  await buildLspGraph(
    { cwd: root, languages: ["typescript"] },
    {
      providers: [
        ProviderFixtures.provider({
          name: "one-shot-inputs",
          buildInputs: ["generated.inputs"],
          refuse: () => "use the generic lane for this fence fixture",
        }),
      ],
      collectLanguageGraph: async () => {
        oneShotBuilds += 1;
        const session = genericSession("typescript");
        session.client.close = async () => {
          oneShotCloses += 1;
        };
        if (oneShotBuilds === 1) {
          fs.writeFileSync(config, "one-shot second\n");
        }
        // The production collector closes a one-shot session before returning
        // it. This dependency preserves that contract while staging the input
        // move at the seam the commit helper must detect.
        await session.client.close();
        return {
          result: {
            nodes: [graphNode("typescript", "a.ts")],
            edges: [],
            diagnostics: [],
            warnings: [],
          },
          session,
        };
      },
    },
  );
  TestValidator.equals(
    "a stale one-shot build retries after its collector closed each session",
    [oneShotBuilds, oneShotCloses],
    [2, 2],
  );

  const busyRoot = GraphPaths.createTempDirectory(
    "samchon-graph-initial-fence-busy-",
  );
  const busyConfig = path.join(busyRoot, "generated.inputs");
  fs.writeFileSync(path.join(busyRoot, "a.ts"), "export const value = 1;\n");
  fs.writeFileSync(busyConfig, "revision 0\n");
  installCommand(busyRoot, "ttscserver");
  let attempts = 0;
  let closes = 0;
  let busyFailure: unknown;
  try {
    await buildLspGraph(
      { cwd: busyRoot, languages: ["typescript"], keepAlive: true },
      {
        providers: [
          ProviderFixtures.provider({
            name: "busy-inputs",
            buildInputs: ["generated.inputs"],
            refuse: () => "use the generic lane for this fence fixture",
          }),
        ],
        collectLanguageGraph: async () => {
          attempts += 1;
          const session = genericSession("typescript");
          session.client.close = async () => {
            closes += 1;
          };
          fs.writeFileSync(busyConfig, `revision ${String(attempts)}\n`);
          return {
            result: {
              nodes: [graphNode("typescript", "a.ts")],
              edges: [],
              diagnostics: [],
              warnings: [],
            },
            session,
          };
        },
      },
    );
  } catch (error) {
    busyFailure = error;
  }
  TestValidator.predicate(
    "a continuously moving initial manifest exhausts a bounded retry",
    busyFailure instanceof Error &&
      busyFailure.message.includes("bounded attempts") &&
      attempts === 3 &&
      closes === 3,
  );

  let cleanupFailure: unknown;
  try {
    await buildLspGraph(
      { cwd: busyRoot, languages: ["typescript"], keepAlive: true },
      {
        providers: [
          ProviderFixtures.provider({
            name: "failed-cleanup",
            buildInputs: ["generated.inputs"],
            refuse: () => "use the generic lane for this fence fixture",
          }),
        ],
        collectLanguageGraph: async () => {
          const session = genericSession("typescript");
          session.client.close = async () => {
            throw new Error("candidate cleanup failed");
          };
          fs.writeFileSync(busyConfig, `cleanup ${Date.now()}\n`);
          return {
            result: {
              nodes: [graphNode("typescript", "a.ts")],
              edges: [],
              diagnostics: [],
              warnings: [],
            },
            session,
          };
        },
      },
    );
  } catch (error) {
    cleanupFailure = error;
  }
  TestValidator.predicate(
    "a stale candidate cleanup failure is retained instead of retried away",
    cleanupFailure instanceof AggregateError &&
      cleanupFailure.errors.some(
        (error) => error instanceof Error && error.message === "candidate cleanup failed",
      ),
  );
}

function genericSession(language: GraphLanguage): ILspSession {
  return {
    client: { close: async () => undefined } as ILspSession["client"],
    root: "",
    language,
    opened: new Map(),
    diagnostics: new Map(),
  };
}

function graphNode(language: GraphLanguage, file: string): ISamchonGraphNode {
  return {
    id: `${file}#value:function`,
    kind: "function",
    language,
    name: "value",
    file,
    external: false,
  };
}

function strictSnapshot(root: string): IBulkGraphSession.ISnapshot {
  return ProviderFixtures.snapshot({
    root,
    nodes: [graphNode("typescript", "b.ts")],
  });
}

async function closeSessions(
  ...results: Awaited<ReturnType<typeof buildLspGraph>>[]
): Promise<void> {
  const sessions = new Set(
    results.flatMap((result) => [...(result.sessions?.values() ?? [])]),
  );
  for (const session of sessions) {
    if ("kind" in session) await session.close();
    else await session.client.close();
  }
}

function installCommand(root: string, command: string): void {
  const directory = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(
    directory,
    process.platform === "win32" ? `${command}.cmd` : command,
  );
  fs.writeFileSync(
    file,
    process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
  );
  if (process.platform !== "win32") fs.chmodSync(file, 0o755);
}
