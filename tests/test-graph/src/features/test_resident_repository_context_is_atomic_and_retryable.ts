import { TestValidator } from "@nestia/e2e";
import {
  IRepositoryContextProvider,
  RepositoryContextProtocol,
  createRepositoryContextSession,
  createResidentRepositoryContextMemorySource,
  createResidentRepositoryContextSource,
  repositoryContextFacts,
  validateRepositoryContextProviders,
} from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";

const {
  repositoryContextCoverage,
  repositoryContextId,
  repositoryContextSource,
} = repositoryContextFacts;

export const test_resident_repository_context_is_atomic_and_retryable =
  async () => {
    const root = GraphPaths.createTempDirectory(
      "samchon-graph-resident-repository-context-",
    );
    const input = path.join(root, "context.json");
    let invocations = 0;
    let failure = false;
    try {
      write(input, { name: "initial", file: "src/main.ts" });
      write(path.join(root, "src", "main.ts"), {});
      fs.mkdirSync(path.join(root, "members"), { recursive: true });
      const provider = fakeProvider(() => {
        invocations += 1;
        if (failure) throw new Error("fixture model failed");
        const model = JSON.parse(fs.readFileSync(input, "utf8")) as {
          name: string;
          file: string;
        };
        return collection(root, model);
      });
      const resident = createResidentRepositoryContextSource(
        root,
        process.env,
        [provider],
      );
      const initial = await resident.load();
      const unchanged = await resident.load();
      TestValidator.equals(
        "a validated no-op reuses the exact topology generation without invoking the model",
        [
          sourceName(initial),
          initial.generation.sequence,
          unchanged === initial,
          invocations,
        ],
        ["initial", 1, true, 1],
      );

      write(input, { name: "changed", file: "src/main.ts" });
      const changed = await resident.load();
      TestValidator.equals(
        "a manifest edit replaces one atomic topology generation",
        [
          sourceName(changed),
          changed.generation.sequence,
          invocations,
        ],
        ["changed", 2, 2],
      );

      write(input, { name: "broken", file: "src/main.ts" });
      failure = true;
      const unavailable = await resident.load();
      TestValidator.equals(
        "a changed provider input that cannot be modeled publishes explicit unavailability without stale facts",
        [
          sourceName(unavailable),
          unavailable.coverage.every(
            (row) =>
              row.provider === "fixture-context" &&
              row.target === "unavailable" &&
              row.state === "unsupported",
          ),
          unavailable.warnings.some((warning) =>
            warning.includes("fixture model failed"),
          ),
          unavailable.generation.sequence,
        ],
        [undefined, true, true, 3],
      );
      const sameFailure = await resident.load();
      TestValidator.equals(
        "an identical repeated failure does not publish another generation",
        [sameFailure === unavailable, sameFailure.generation.sequence],
        [true, 3],
      );

      write(input, { name: "still-broken", file: "src/main.ts" });
      const movedFailure = await resident.load();
      TestValidator.equals(
        "a different failed input still advances the unavailable generation",
        [
          movedFailure === unavailable,
          movedFailure.generation.sequence,
          sourceName(movedFailure),
        ],
        [false, 4, undefined],
      );

      failure = false;
      write(input, { name: "recovered", file: "src/main.ts" });
      const recovered = await resident.load();
      TestValidator.equals(
        "the next successful retry atomically replaces retained context",
        [
          sourceName(recovered),
          recovered.warnings.length,
          recovered.generation.sequence,
        ],
        ["recovered", 0, 5],
      );

      write(input, { name: "cancelled", file: "src/main.ts" });
      const aborted = new AbortController();
      aborted.abort();
      await TestValidator.error("a cancelled topology refresh rejects", () =>
        resident.load({ signal: aborted.signal }),
      );
      TestValidator.equals(
        "cancellation leaves the prior generation reachable",
        sourceName(await resident.load()),
        "cancelled",
      );

      const createdMember = path.join(root, "members", "created");
      const renamedMember = path.join(root, "members", "renamed");
      fs.mkdirSync(createdMember);
      const afterCreate = await resident.load();
      fs.renameSync(createdMember, renamedMember);
      const afterRename = await resident.load();
      fs.rmdirSync(renamedMember);
      const afterDelete = await resident.load();
      TestValidator.equals(
        "member create, rename and delete each replace one complete input generation",
        [
          afterCreate.generation.sequence,
          afterRename.generation.sequence,
          afterDelete.generation.sequence,
          sourceName(afterDelete),
        ],
        [7, 8, 9, "cancelled"],
      );

      await resident.close();
      await TestValidator.error(
        "a closed topology source refuses new loads",
        () => resident.load(),
      );
      TestValidator.error("duplicate registry names are refused", () =>
        validateRepositoryContextProviders([provider, provider]),
      );
      TestValidator.error("blank registry ecosystems are refused", () =>
        validateRepositoryContextProviders([
          { ...provider, name: "blank-ecosystem", ecosystem: "" },
        ]),
      );
      TestValidator.error("empty registry relation contracts are refused", () =>
        validateRepositoryContextProviders([
          { ...provider, name: "empty-families", families: [] },
        ]),
      );

      const memoryResident = {
        load: async () => initial,
        close: async () => {},
      };
      const loadMemory =
        createResidentRepositoryContextMemorySource(memoryResident);
      const memoryOne = await loadMemory();
      const memoryTwo = await loadMemory();
      TestValidator.equals(
        "resident topology memory is reused for the exact dump identity",
        memoryOne === memoryTwo,
        true,
      );
      memoryResident.load = async () => recovered;
      TestValidator.equals(
        "a replacement dump receives a replacement topology memory",
        (await loadMemory()) === memoryOne,
        false,
      );

      TestValidator.error("adapter source disagreement is refused", () =>
        repositoryContextFacts.uniqueRepositorySources([
          { file: "same", digest: "a".repeat(64) },
          { file: "same", digest: "b".repeat(64) },
        ]),
      );

      const movingInput = path.join(root, "moving.json");
      write(movingInput, { state: 1 });
      const movingProvider = fakeProvider(
        () => {
          const model = collection(root, {
            name: "moving",
            file: "src/main.ts",
          });
          model.shards[0]!.sources = [
            repositoryContextSource(root, movingInput),
          ];
          write(movingInput, { state: 2 });
          return model;
        },
        ["moving.json"],
      );
      const movingSession = movingProvider.open({ root, env: process.env });
      await TestValidator.error(
        "a provider input moving during collection refuses the generation",
        () => movingSession.refresh(),
      );
      await movingSession.close();

      const duplicateResident = createResidentRepositoryContextSource(
        root,
        process.env,
        [provider, provider],
      );
      await TestValidator.error(
        "duplicate facts across providers are refused",
        () => duplicateResident.load(),
      );
      await duplicateResident.close();

      const snapshotSession = provider.open({ root, env: process.env });
      const canonicalSnapshot = (await snapshotSession.refresh()).snapshot;
      await snapshotSession.close();
      const disagreeingSnapshot = structuredClone(canonicalSnapshot);
      disagreeingSnapshot.sources[0]!.digest = "f".repeat(64);
      const disagreeingResident = createResidentRepositoryContextSource(
        root,
        process.env,
        [
          snapshotProvider("source-left", canonicalSnapshot),
          snapshotProvider("source-right", disagreeingSnapshot),
        ],
      );
      await TestValidator.error(
        "provider source disagreement is refused before publication",
        () => disagreeingResident.load(),
      );
      await disagreeingResident.close();

      const closeFailure = createResidentRepositoryContextSource(
        root,
        process.env,
        [closingProvider("close-error", "fixture close failed")],
      );
      await TestValidator.error("provider close failures are surfaced", () =>
        closeFailure.close(),
      );
      const multipleCloseFailures = createResidentRepositoryContextSource(
        root,
        process.env,
        [
          closingProvider("close-first", new Error("first close failed")),
          closingProvider("close-second", "second close failed"),
        ],
      );
      await TestValidator.error(
        "the first provider close failure survives later close failures",
        () => multipleCloseFailures.close(),
      );

      const nonErrorFailure = createResidentRepositoryContextSource(
        root,
        process.env,
        [
          fakeProvider(() => {
            throw "non-error model failure";
          }),
        ],
      );
      TestValidator.predicate(
        "non-Error provider failures are normalized into explicit unavailability",
        (await nonErrorFailure.load()).warnings.some((warning) =>
          warning.includes("non-error model failure"),
        ),
      );
      await nonErrorFailure.close();

      const modeEnv = { ...process.env };
      const modeSession = provider.open({ root, env: modeEnv });
      TestValidator.equals(
        "a first provider collection is initial",
        (await modeSession.refresh()).mode,
        "initial",
      );
      modeEnv.PATH = `${modeEnv.PATH ?? ""}${path.delimiter}changed`;
      TestValidator.equals(
        "an environment-only input change reuses the same universe incrementally",
        (await modeSession.refresh()).mode,
        "incremental",
      );
      await modeSession.close();

      const noPathSession = provider.open({
        root,
        env: { ...process.env, PATH: undefined },
      });
      await noPathSession.refresh();
      await noPathSession.close();
      TestValidator.predicate(
        "root-relative input identity is stable without PATH",
        createRepositoryContextSession.observeInputGeneration(
          root,
          ["."],
          undefined,
          { PATH: undefined },
        ).length === 64,
      );

      let includeSecondShard = true;
      const shardSession = createRepositoryContextSession(
        {
          name: "shard-removal",
          ecosystem: "fixture",
          authority: "declared",
          families: ["contains", "joins-file"],
          buildInputs: ["context.json"],
        },
        { root, env: process.env },
        () => {
          const result = collection(root, {
            name: "sharded",
            file: "src/main.ts",
          });
          if (includeSecondShard) {
            result.shards.push({
              key: "fixture:secondary",
              target: "workspace",
              nodes: [
                {
                  id: repositoryContextId("fixture", "project", "secondary"),
                  kind: "project",
                  name: "secondary",
                  ecosystem: "fixture",
                  coordinate: "secondary",
                  configuration: "default",
                  external: false,
                },
              ],
              edges: [],
              coverage: repositoryContextCoverage(
                "shard-removal",
                "fixture",
                "workspace",
                ["contains", "joins-file"],
              ),
              files: [],
              sources: [repositoryContextSource(root, "context.json")],
            });
          }
          result.shards[0]!.coverage = repositoryContextCoverage(
            "shard-removal",
            "fixture",
            "workspace",
            ["contains", "joins-file"],
          );
          return result;
        },
      );
      TestValidator.equals(
        "the initial session can own multiple atomic shards",
        (await shardSession.refresh()).snapshot.generation.shards.length,
        2,
      );
      includeSecondShard = false;
      write(input, { name: "one-shard", file: "src/main.ts" });
      TestValidator.equals(
        "a later collection emits the removed shard delta",
        (await shardSession.refresh()).snapshot.generation.shards.length,
        1,
      );
      await shardSession.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

function fakeProvider(
  collect: IRepositoryContextProvider.Collector,
  buildInputs: readonly string[] = [
    "context.json",
    "undeclared-by-collector.json",
  ],
): IRepositoryContextProvider {
  const provider: IRepositoryContextProvider = {
    name: "fixture-context",
    ecosystem: "fixture",
    authority: "declared",
    families: ["contains", "joins-file"],
    buildInputs,
    detect: () => true,
    open: (props) =>
      createRepositoryContextSession(provider, props, collect),
  };
  return provider;
}

function closingProvider(
  name: string,
  failure: unknown,
): IRepositoryContextProvider {
  return {
    name,
    ecosystem: "fixture",
    authority: "declared",
    families: ["contains"],
    buildInputs: [],
    detect: () => true,
    open: ({ root }) => ({
      kind: "repository-context",
      provider: name,
      ecosystem: "fixture",
      root,
      generation: 0,
      current: undefined,
      refresh: async () => {
        throw new Error("unused");
      },
      close: async () => {
        throw failure;
      },
    }),
  };
}

function snapshotProvider(
  name: string,
  snapshot: RepositoryContextProtocol.ISnapshot,
): IRepositoryContextProvider {
  return {
    name,
    ecosystem: "fixture",
    authority: "declared",
    families: ["contains", "joins-file"],
    buildInputs: [],
    detect: () => true,
    open: ({ root }) => ({
      kind: "repository-context",
      provider: name,
      ecosystem: "fixture",
      root,
      generation: snapshot.generation.sequence,
      current: snapshot,
      refresh: async () => ({
        changed: true,
        generation: snapshot.generation.sequence,
        mode: "full",
        snapshot,
        warnings: [],
      }),
      close: async () => {},
    }),
  };
}

function collection(
  root: string,
  model: { name: string; file: string },
): IRepositoryContextProvider.ICollection {
  const workspace = repositoryContextId("fixture", "workspace", ".");
  const source = repositoryContextId("fixture", "source-root", "src");
  const shard = {
    key: "fixture:workspace",
    target: "workspace",
    nodes: [
      {
        id: workspace,
        kind: "workspace" as const,
        name: "fixture",
        ecosystem: "fixture",
        coordinate: ".",
        configuration: "default",
        external: false,
      },
      {
        id: source,
        kind: "source-root" as const,
        name: model.name,
        ecosystem: "fixture",
        coordinate: "src",
        configuration: "default",
        external: false,
      },
    ],
    edges: [
      { kind: "contains" as const, from: workspace, to: source },
      { kind: "joins-file" as const, from: source, to: model.file },
    ],
    coverage: repositoryContextCoverage(
      "fixture-context",
      "fixture",
      "workspace",
      ["contains", "joins-file"],
    ),
    files: [model.file],
    sources: [
      repositoryContextSource(root, "context.json"),
      repositoryContextSource(root, "members"),
    ],
  };
  return {
    producerSchemaVersion: 1,
    tool: "fixture-model",
    toolVersion: "1.0.0",
    capabilities: ["fixture"],
    universe: RepositoryContextProtocol.digest(shard.sources),
    target: "workspace",
    shards: [shard],
    warnings: [],
  };
}

function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function sourceName(snapshot: {
  nodes: readonly { kind: string; name: string }[];
}): string | undefined {
  return snapshot.nodes.find((node) => node.kind === "source-root")?.name;
}
