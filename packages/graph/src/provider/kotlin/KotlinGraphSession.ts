import fs from "node:fs";
import path from "node:path";

import { GraphLanguage } from "../../typings";
import { BatchGraphSession } from "../BatchGraphSession";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { IGraphProvider } from "../IGraphProvider";
import { KotlinGraphProducerClient } from "./KotlinGraphProducerClient";
import { KotlinGraphSnapshotAdapter } from "./KotlinGraphSnapshotAdapter";

const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

/**
 * The strict Kotlin route's session: one resident Gradle connection, one graph
 * generation per changed input universe.
 *
 * The producer is a kotlinc plugin attached to the project's real compile tasks,
 * so a refresh is a normal Gradle build. That is the point of the
 * route rather than a limitation of it: the build tool's own incremental state
 * decides which sources are recompiled, and the shards it does not rewrite are
 * the ones this session does not resend.
 *
 * The lifecycle around that build is {@link BatchGraphSession}'s, shared with
 * every SCIP and sidecar route: an isolated generation directory, a bounded
 * cancellable child, an input fingerprint that decides whether the build has
 * to run at all, and publication only after the complete candidate loaded.
 */
export class KotlinGraphSession implements IBulkGraphSession {
  public readonly kind = "bulk" as const;
  public readonly ownsProviderTopology = true;
  public readonly languages: readonly GraphLanguage[];
  public readonly root: string;

  private readonly provider: string;
  private readonly maxArtifactBytes: number;
  private readonly adapter: KotlinGraphSnapshotAdapter;
  private readonly validate: (snapshot: IBulkGraphSession.ISnapshot) => void;
  private readonly producer: KotlinGraphProducerClient;
  private readonly batch: BatchGraphSession;

  public constructor(options: KotlinGraphSession.IOptions) {
    const maxArtifactBytes =
      options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1) {
      throw new TypeError(
        `${options.provider}: maxArtifactBytes must be a positive safe integer`,
      );
    }
    this.provider = options.provider;
    this.maxArtifactBytes = maxArtifactBytes;
    this.validate = options.validate;
    this.adapter = new KotlinGraphSnapshotAdapter(options.root);
    this.producer = new KotlinGraphProducerClient({
      root: options.root,
      provider: options.provider,
      command: options.command,
    });
    let configuration:
      | ReturnType<NonNullable<KotlinGraphSession.IOptions["configuration"]>>
      | undefined;
    this.batch = new BatchGraphSession({
      root: options.root,
      languages: options.languages,
      provider: options.provider,
      command: options.command,
      artifactName: "graph.json",
      inputs: options.inputs,
      // This session owns the producer JVM and its Gradle connection. Their
      // versions cannot change underneath that live process, while probing
      // both launchers on every no-op costs more than the resident latency
      // budget. Establish the rows once; a restarted producer still states
      // its own exact identity in the next artifact and the adapter reloads if
      // that identity differs.
      configuration: () =>
        (configuration ??= options.configuration()),
      produce: ({ artifact, signal }) =>
        this.producer.produce(artifact, signal),
      load: (props) => this.load(props),
    });
    this.languages = this.batch.languages;
    this.root = this.batch.root;
  }

  public get generation(): number {
    return this.batch.generation;
  }

  public get current(): IBulkGraphSession.ISnapshot | undefined {
    return this.batch.current;
  }

  public async refresh(
    options: { signal?: AbortSignal } = {},
  ): Promise<IBulkGraphSession.IRefresh> {
    const result = await this.batch.refresh(options);
    // `BatchGraphSession` knows whether it had to run the build; only the
    // producer knows what the build then did. A generation that reused shards
    // from the one before it is an incremental compile, and reporting it as a
    // rebuild would tell a reader the whole workspace was recompiled when the
    // build tool recompiled one file.
    return result.changed
      ? { ...result, mode: this.adapter.lastMode }
      : result;
  }

  public close(): Promise<void> {
    return Promise.all([this.batch.close(), this.producer.close()]).then(
      () => undefined,
    );
  }

  private load(
    props: BatchGraphSession.ILoadProps,
  ): Promise<IBulkGraphSession.ISnapshot> {
    const size = fs.statSync(props.artifact).size;
    if (size > this.maxArtifactBytes) {
      throw new Error(
        `${this.provider}: the graph artifact exceeded the ${String(this.maxArtifactBytes)} byte limit`,
      );
    }
    return Promise.resolve(
      this.adapter.apply(this.decode(fs.readFileSync(props.artifact, "utf8")), {
        signal: props.signal,
        validate: this.validate,
      }),
    );
  }

  /**
   * Read the artifact, saying whose it is and what was in it when it will not.
   *
   * A raw `JSON.parse` throws `Unexpected token` with no provider name and no
   * trace of the bytes, which is the least useful sentence available about a
   * build that printed a message where its graph should be—and a Gradle
   * build prints a great deal.
   */
  private decode(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      const head = text.trimStart().slice(0, 400);
      const message = (error as SyntaxError).message;
      throw new Error(
        `${this.provider}: the graph artifact is not JSON: ${message}${
          head === "" ? " (the file is empty)" : `: ${head}`
        }`,
      );
    }
  }
}

export namespace KotlinGraphSession {
  export interface IOptions {
    root: string;
    languages: readonly GraphLanguage[];
    provider: string;
    command: IGraphProvider.ICommand;
    inputs: () => string[];
    configuration: NonNullable<BatchGraphSession.IOptions["configuration"]>;
    /**
     * The contract gate the registry entry owns.
     *
     * Required rather than optional: a generation that reached a consumer
     * without being held to the provider's declared languages, authority and
     * fact families is exactly what the gate exists to prevent, and an
     * optional gate is one a future call site can forget.
     */
    validate: (snapshot: IBulkGraphSession.ISnapshot) => void;
    maxArtifactBytes?: number;
  }
}
