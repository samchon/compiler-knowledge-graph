import path from "node:path";

import { ISamchonRepositoryContextDump } from "../structures";
import { IRepositoryContextProvider } from "./IRepositoryContextProvider";
import { IRepositoryContextSession } from "./IRepositoryContextSession";
import { IResidentRepositoryContextSource } from "./IResidentRepositoryContextSource";
import { REPOSITORY_CONTEXT_PROVIDERS } from "./REPOSITORY_CONTEXT_PROVIDERS";
import { RepositoryContextProtocol } from "./RepositoryContextProtocol";
import { createRepositoryContextSession } from "./createRepositoryContextSession";
import { repositoryContextFacts } from "./repositoryContextFacts";

const { compareRepositoryText } = repositoryContextFacts;

/** Open and atomically merge every detected repository-context provider. */
export function createResidentRepositoryContextSource(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  providers: readonly IRepositoryContextProvider[] = REPOSITORY_CONTEXT_PROVIDERS,
): IResidentRepositoryContextSource {
  const project = path.resolve(root);
  const sessions = providers
    .filter((provider) => provider.detect(project))
    .map((provider) => ({
      provider,
      session: provider.open({ root: project, env }),
    }));
  let current: ISamchonRepositoryContextDump | undefined;
  let sequence = 0;
  let queue = Promise.resolve();
  let closed = false;
  let priorFailures: string[] = [];

  return {
    load(options = {}) {
      return enqueue(async () => {
        assertOpen();
        const snapshots: Array<{
          provider: IRepositoryContextProvider;
          snapshot: NonNullable<IRepositoryContextSession["current"]>;
          warnings: string[];
        }> = [];
        const failures: IProviderFailure[] = [];
        let changed = current === undefined;
        for (const row of sessions) {
          try {
            const refresh = await row.session.refresh(options);
            changed ||= refresh.changed;
            snapshots.push({
              provider: row.provider,
              snapshot: refresh.snapshot,
              warnings: refresh.warnings,
            });
          } catch (error) {
            if (options.signal?.aborted) throw error;
            failures.push({
              provider: row.provider,
              inputGeneration:
                createRepositoryContextSession.observeInputGeneration(
                project,
                row.provider.buildInputs,
                row.session.current?.sources.map((source) => source.file),
                env,
              ),
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (
          !changed &&
          sameStrings(
            failures.map(failureIdentity),
            priorFailures,
          ) &&
          current !== undefined
        ) {
          return current;
        }
        const next = assemble(project, sequence + 1, snapshots, failures);
        sequence = next.generation.sequence;
        priorFailures = failures.map(failureIdentity);
        current = next;
        return next;
      });
    },
    close() {
      closed = true;
      return enqueue(async () => {
        let failure: Error | undefined;
        for (const row of sessions) {
          try {
            await row.session.close();
          } catch (error) {
            failure ??=
              error instanceof Error ? error : new Error(String(error));
          }
        }
        if (failure !== undefined) throw failure;
      }, true);
    },
  };

  function enqueue<T>(
    task: () => Promise<T>,
    allowClosed = false,
  ): Promise<T> {
    const result = queue
      .catch(() => undefined)
      .then(() => {
        if (!allowClosed) assertOpen();
        return task();
      });
    queue = result.then(() => undefined).catch(() => undefined);
    return result;
  }

  function assertOpen(): void {
    if (closed) {
      throw new Error("repository context source is closed");
    }
  }
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

interface IProviderFailure {
  provider: IRepositoryContextProvider;
  inputGeneration: string;
  message: string;
}

function failureIdentity(failure: IProviderFailure): string {
  return [
    failure.provider.name,
    failure.inputGeneration,
    failure.message,
  ].join("\0");
}

function assemble(
  project: string,
  sequence: number,
  rows: readonly {
    provider: IRepositoryContextProvider;
    snapshot: RepositoryContextProtocol.ISnapshot;
    warnings: readonly string[];
  }[],
  failures: readonly IProviderFailure[],
): ISamchonRepositoryContextDump {
  const nodes = rows.flatMap((row) => row.snapshot.nodes);
  const edges = rows.flatMap((row) => row.snapshot.edges);
  const coverage = rows.flatMap((row) => row.snapshot.coverage);
  for (const failure of failures) {
    coverage.push(
      ...RepositoryContextProtocol.RELATION_KINDS.map((family) => ({
        provider: failure.provider.name,
        ecosystem: failure.provider.ecosystem,
        target: "unavailable",
        family,
        state: "unsupported" as const,
      })),
    );
  }
  const sources = mergeSources(rows.flatMap((row) => row.snapshot.sources));
  const shards = rows
    .flatMap((row) =>
      row.snapshot.generation.shards.map((shard) => ({
        key: `${row.provider.name}/${shard.key}`,
        digest: shard.digest,
      })),
    )
    .sort((left, right) => compareRepositoryText(left.key, right.key));
  const inputGeneration = RepositoryContextProtocol.digest(
    [
      ...rows.map((row) => ({
        provider: row.provider.name,
        generation: row.snapshot.begin.inputGeneration,
      })),
      ...failures.map((failure) => ({
        provider: failure.provider.name,
        generation: failure.inputGeneration,
      })),
    ]
      .sort((left, right) =>
        compareRepositoryText(left.provider, right.provider),
      ),
  );
  const contentDigest = RepositoryContextProtocol.digest({
    nodes: [...nodes].sort((left, right) =>
      compareRepositoryText(left.id, right.id),
    ),
    edges: [...edges].sort(
      (left, right) =>
        compareRepositoryText(left.kind, right.kind) ||
        compareRepositoryText(left.from, right.from) ||
        compareRepositoryText(left.to, right.to),
    ),
    coverage,
  });
  const dump: ISamchonRepositoryContextDump = {
    project,
    schemaVersion: 1,
    inputGeneration,
    generation: {
      sequence,
      token: RepositoryContextProtocol.digest({
        sequence,
        inputGeneration,
        contentDigest,
      }),
      shards,
      contentDigest,
    },
    provenance: rows
      .map(({ provider, snapshot }) => ({
        provider: provider.name,
        ecosystem: provider.ecosystem,
        authority: provider.authority,
        tool: snapshot.hello.tool,
        toolVersion: snapshot.hello.toolVersion,
        schemaVersion: snapshot.hello.producerSchemaVersion,
        protocolVersion: snapshot.hello.protocolVersion,
        universe: snapshot.begin.universe,
        manifest: snapshot.begin.manifest,
        content: snapshot.generation.contentDigest,
        capabilities: [...snapshot.hello.capabilities],
      }))
      .sort((left, right) =>
        compareRepositoryText(left.provider, right.provider),
      ),
    coverage: coverage.sort(
      (left, right) =>
        compareRepositoryText(left.provider, right.provider) ||
        compareRepositoryText(left.family, right.family),
    ),
    nodes: dedupeNodes(nodes),
    edges: dedupeEdges(edges),
    files: [
      ...new Set(rows.flatMap((row) => row.snapshot.files)),
    ].sort(compareRepositoryText),
    sources,
    warnings: [
      ...rows.flatMap((row) => row.warnings),
      ...failures.map(
        (failure) =>
          `repository context unavailable: ${failure.provider.name}: ${failure.message}`,
      ),
    ].sort(compareRepositoryText),
  };
  freeze(dump);
  return dump;
}

function mergeSources(
  input: readonly ISamchonRepositoryContextDump.ISource[],
): ISamchonRepositoryContextDump.ISource[] {
  const rows = new Map<string, string>();
  for (const source of input) {
    const prior = rows.get(source.file);
    if (prior !== undefined && prior !== source.digest) {
      throw new Error(
        `repository context providers disagree about input ${source.file}`,
      );
    }
    rows.set(source.file, source.digest);
  }
  return [...rows]
    .sort(([left], [right]) => compareRepositoryText(left, right))
    .map(([file, digest]) => ({ file, digest }));
}

function dedupeNodes(
  input: readonly ISamchonRepositoryContextDump.INode[],
): ISamchonRepositoryContextDump.INode[] {
  const rows = new Map<string, ISamchonRepositoryContextDump.INode>();
  for (const node of input) {
    if (rows.has(node.id)) {
      throw new Error(
        `repository context providers published duplicate node ${node.id}`,
      );
    }
    rows.set(node.id, node);
  }
  return [...rows.values()].sort((left, right) =>
    compareRepositoryText(left.id, right.id),
  );
}

function dedupeEdges(
  input: readonly ISamchonRepositoryContextDump.IEdge[],
): ISamchonRepositoryContextDump.IEdge[] {
  const rows = new Map<string, ISamchonRepositoryContextDump.IEdge>();
  for (const edge of input) {
    const key = `${edge.kind}\0${edge.from}\0${edge.to}`;
    /* c8 ignore start -- an equal edge requires equal endpoint identities,
     * which dedupeNodes rejects before edge deduplication is reached. */
    if (rows.has(key)) {
      throw new Error(
        `repository context providers published duplicate edge ${edge.kind}`,
      );
    }
    /* c8 ignore stop */
    rows.set(key, edge);
  }
  return [...rows.values()].sort(
    /* c8 ignore start -- edge tuple keys are distinct after the guard above. */
    (left, right) =>
      compareRepositoryText(left.kind, right.kind) ||
      compareRepositoryText(left.from, right.from) ||
      compareRepositoryText(left.to, right.to),
    /* c8 ignore stop */
  );
}

function freeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}
