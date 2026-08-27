import path from "node:path";

import { IRepositoryContextProvider } from "./IRepositoryContextProvider";
import { IRepositoryContextSession } from "./IRepositoryContextSession";
import { RepositoryContextProtocol } from "./RepositoryContextProtocol";
import { repositoryContextFacts } from "./repositoryContextFacts";

const { repositoryContextPathDigest } = repositoryContextFacts;

/** Build the common atomic resident shell around an owning-tool collector. */
export function createRepositoryContextSession(
  provider: Pick<
    IRepositoryContextProvider,
    "name" | "ecosystem" | "authority" | "families" | "buildInputs"
  >,
  props: IRepositoryContextProvider.IOpenProps,
  collect: IRepositoryContextProvider.Collector,
): IRepositoryContextSession {
  const store = new RepositoryContextProtocol.Store();
  let generation = 0;
  let closed = false;
  let inputState: string | undefined;
  let queue = Promise.resolve();
  let currentWarnings: string[] = [];

  return {
    kind: "repository-context",
    provider: provider.name,
    ecosystem: provider.ecosystem,
    root: props.root,
    get generation() {
      return generation;
    },
    get current() {
      return store.current;
    },
    refresh(options = {}) {
      return enqueue(async () => {
        assertOpen();
        throwIfAborted(options.signal);
        const observed = createRepositoryContextSession.observeInputGeneration(
          props.root,
          provider.buildInputs,
          store.current?.sources.map((source) => source.file),
          props.env,
        );
        if (store.current !== undefined && observed === inputState) {
          return {
            changed: false,
            generation,
            mode: "unchanged" as const,
            snapshot: store.current,
            warnings: [...currentWarnings],
          };
        }

        const collected = await collect({ ...props, signal: options.signal });
        assertOpen();
        throwIfAborted(options.signal);
        const sources = collected.shards.flatMap((shard) => shard.sources);
        const afterCollection =
          createRepositoryContextSession.observeInputGeneration(
          props.root,
          provider.buildInputs,
          sources.map((source) => source.file),
          props.env,
        );
        const consumed = consumedInputState(
          props.root,
          provider.buildInputs,
          sources,
          props.env,
        );
        if (afterCollection !== consumed) {
          throw new Error(
            `repository context provider ${provider.name} inputs changed while its model was being collected`,
          );
        }
        const manifest = RepositoryContextProtocol.manifestDigest(sources);
        const sequence = generation + 1;
        const token = RepositoryContextProtocol.digest({
          provider: provider.name,
          sequence,
          universe: collected.universe,
          manifest,
        });
        const previous = store.current;
        const priorShards = new Map(
          previous?.generation.shards.map((entry) => [entry.key, entry.digest]) ??
            [],
        );
        const nextShards = new Map(
          collected.shards.map((shard) => [
            shard.key,
            RepositoryContextProtocol.shardDigest(shard),
          ]),
        );
        const frames: RepositoryContextProtocol.Frame[] = [
          {
            type: "hello",
            protocolVersion: 1,
            schemaVersion: 1,
            producerSchemaVersion: collected.producerSchemaVersion,
            provider: provider.name,
            ecosystem: provider.ecosystem,
            authority: provider.authority,
            tool: collected.tool,
            toolVersion: collected.toolVersion,
            supportedFamilies: [...provider.families],
            capabilities: [...collected.capabilities],
          },
          {
            type: "begin",
            sequence,
            generation: token,
            ...(previous !== undefined
              ? {
                  baseSequence: previous.generation.sequence,
                  baseGeneration: previous.generation.token,
                }
              : {}),
            inputGeneration: RepositoryContextProtocol.digest({
              universe: collected.universe,
              manifest,
            }),
            universe: collected.universe,
            target: collected.target,
            manifest,
          },
        ];
        for (const key of [...priorShards.keys()].sort(compare)) {
          if (!nextShards.has(key)) frames.push({ type: "deleteShard", key });
        }
        for (const shard of [...collected.shards].sort((left, right) =>
          compare(left.key, right.key),
        )) {
          const digest = nextShards.get(shard.key)!;
          if (priorShards.get(shard.key) !== digest) {
            frames.push({
              type: "upsertShard",
              digest,
              shard,
            });
          }
        }
        const facts = {
          nodes: collected.shards.flatMap((shard) => shard.nodes),
          edges: collected.shards.flatMap((shard) => shard.edges),
          coverage: collected.shards.flatMap((shard) => shard.coverage),
        };
        frames.push({
          type: "commit",
          sequence,
          generation: token,
          shards: [...nextShards]
            .sort(([left], [right]) => compare(left, right))
            .map(([key, digest]) => ({ key, digest })),
          contentDigest: RepositoryContextProtocol.contentDigest(facts),
        });
        const snapshot = store.apply(frames, options);
        generation = sequence;
        currentWarnings = [...collected.warnings];
        inputState = createRepositoryContextSession.observeInputGeneration(
          props.root,
          provider.buildInputs,
          snapshot.sources.map((source) => source.file),
          props.env,
        );
        return {
          changed: true,
          generation,
          mode:
            previous === undefined
              ? ("initial" as const)
              : previous.begin.universe === snapshot.begin.universe
                ? ("incremental" as const)
                : ("reload" as const),
          snapshot,
          warnings: [...currentWarnings],
        };
      });
    },
    close() {
      closed = true;
      return queue;
    },
  };

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.catch(() => undefined).then(task);
    queue = result.then(() => undefined).catch(() => undefined);
    return result;
  }

  function assertOpen(): void {
    if (closed) {
      throw new Error(
        `repository context provider ${provider.name} is closed`,
      );
    }
  }
}

export namespace createRepositoryContextSession {
/** Fingerprint the current declared and previously published provider inputs. */
  export function observeInputGeneration(
  root: string,
  declared: readonly string[],
  published: readonly string[] | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const files = new Set([
    ...declared.map((file) => normalize(root, file)),
    ...(published ?? []).map((file) => normalize(root, file)),
  ]);
  const rows = [...files].sort(compare).map((file) => ({
    file: relative(root, file),
    digest: repositoryContextPathDigest(file),
  }));
  return RepositoryContextProtocol.digest({
    rows,
    path: env.PATH ?? "",
  });
}
/* c8 ignore start -- declaration merging emits a namespace creation arm after
 * the function object already exists, so that arm is unreachable. */
}
/* c8 ignore stop */

function consumedInputState(
  root: string,
  declared: readonly string[],
  published: readonly { file: string; digest: string }[],
  env: NodeJS.ProcessEnv,
): string {
  const consumed = new Map(
    published.map((source) => [
      normalize(root, source.file),
      source.digest,
    ]),
  );
  for (const file of declared.map((entry) => normalize(root, entry))) {
    if (!consumed.has(file)) {
      consumed.set(file, repositoryContextPathDigest(file));
    }
  }
  return RepositoryContextProtocol.digest({
    rows: [...consumed]
      .sort(([left], [right]) => compare(left, right))
      .map(([file, digest]) => ({
        file: relative(root, file),
        digest,
      })),
    path: env.PATH ?? "",
  });
}

function normalize(root: string, file: string): string {
  return path.resolve(root, file);
}

function relative(root: string, file: string): string {
  return path.relative(root, file).replaceAll("\\", "/") || ".";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("repository context provider refresh cancelled");
  }
}

function compare(left: string, right: string): number {
  // Two-way: canonical input paths and shard keys are distinct, so the equal
  // arm cannot run and an ignore directive over it would remove the reachable
  // arms from the coverage gate as well.
  return left < right ? -1 : 1;
}
