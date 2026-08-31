import fs from "node:fs";
import path from "node:path";

import { GraphLanguage } from "../../typings";
import { BatchGraphSession } from "../BatchGraphSession";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { IGraphProvider } from "../IGraphProvider";
import { JavaGraphSnapshotAdapter } from "./JavaGraphSnapshotAdapter";

const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

/**
 * The strict Java route's session: one ordinary build, one graph generation.
 *
 * The producer is a javac plugin attached to the project's real compile tasks,
 * so a refresh is a normal Gradle or Maven build. That is the point of the
 * route rather than a limitation of it: the build tool's own incremental state
 * decides which sources are recompiled, and the shards it does not rewrite are
 * the ones this session does not resend.
 *
 * The lifecycle around that build is {@link BatchGraphSession}'s, shared with
 * every SCIP and sidecar route: an isolated generation directory, a bounded
 * cancellable child, an input fingerprint that decides whether the build has
 * to run at all, and publication only after the complete candidate loaded.
 */
export class JavaGraphSession implements IBulkGraphSession {
  public readonly kind = "bulk" as const;
  public readonly languages: readonly GraphLanguage[];
  public readonly root: string;

  private readonly provider: string;
  private readonly maxArtifactBytes: number;
  private readonly adapter: JavaGraphSnapshotAdapter;
  private readonly validate: (snapshot: IBulkGraphSession.ISnapshot) => void;
  private readonly batch: BatchGraphSession;

  public constructor(options: JavaGraphSession.IOptions) {
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
    this.adapter = new JavaGraphSnapshotAdapter(options.root);
    this.batch = new BatchGraphSession({
      root: options.root,
      languages: options.languages,
      provider: options.provider,
      command: options.command,
      artifactName: "graph.json",
      indexArgs: (artifact) => [
        "index",
        // The SCIP index is the launcher's primary output and it has a default
        // path relative to the working directory, which for `index` is the
        // project being indexed. Naming it inside this generation's own
        // directory keeps the strict route from writing into the tree it reads.
        "--output",
        path.join(path.dirname(artifact), "index.scip"),
        "--graph-output",
        artifact,
      ],
      inputs: options.inputs,
      configuration: options.configuration,
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
    return this.batch.close();
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
   * A raw `JSON.parse` throws `Unexpected token …` with no provider name and no
   * trace of the bytes, which is the least useful sentence available about a
   * build that printed a message where its graph should be — and a Gradle
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

export namespace JavaGraphSession {
  export interface IOptions {
    root: string;
    languages: readonly GraphLanguage[];
    provider: string;
    command: IGraphProvider.ICommand;
    inputs: () => string[];
    configuration: BatchGraphSession.IOptions["configuration"];
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
