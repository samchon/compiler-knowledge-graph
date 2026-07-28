import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  GraphEdgeKind,
  GraphLanguage,
  GraphProviderAuthority,
} from "../../typings";
import { fileFromUri } from "../../utils/fileFromUri";
import { assertGraphSnapshotContract } from "../assertGraphSnapshotContract";
import { BatchGraphSession } from "../BatchGraphSession";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { IGraphProvider } from "../IGraphProvider";
import { adaptScipIndex } from "./adaptScipIndex";
import { ScipEnrichment } from "./ScipEnrichment";
import { IScipIndex } from "./IScipIndex";
import { parseScipIndex } from "./parseScipIndex";

/**
 * A strict bulk session over a language-owned SCIP indexer.
 *
 * SCIP-specific work is deliberately limited to decoding, validating, and
 * adapting the artifact. Exact-child ownership, cancellation, input fencing,
 * serialization, bounded output, and atomic publication live in
 * {@link BatchGraphSession}, so a compiler/analyzer sidecar cannot drift onto
 * a weaker lifecycle when it implements the same provider contract.
 */
export class ScipSession implements IBulkGraphSession {
  public readonly kind = "bulk" as const;
  public readonly languages: readonly GraphLanguage[];
  public readonly root: string;

  private readonly options: ScipSession.IOptions;
  private readonly maxArtifactBytes: number;
  private readonly batch: BatchGraphSession;

  public constructor(options: ScipSession.IOptions) {
    const enrichment =
      options.enrichment === undefined
        ? undefined
        : ScipEnrichment.slice(options.enrichment, options.languages);
    this.options = {
      ...options,
      languages: [...options.languages],
      ...(enrichment === undefined ? {} : { enrichment }),
    };
    const configured = this.options;
    const maxArtifactBytes =
      configured.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1) {
      throw new TypeError(
        `${configured.provider}: maxArtifactBytes must be a positive safe integer`,
      );
    }
    // Minus what this producer is known not to emit. Every SCIP entry
    // inherited the same fact list, so a provider whose indexer never
    // populates a field still advertised the family derived from it — a
    // consumer degrading against scip-python was told containment was proven
    // and then found none, which reads as a project with no structure rather
    // than an indexer that cannot describe one.
    const omitted = new Set(configured.omitFacts ?? []);
    const facts = [
      ...adaptScipIndex.EDGE_KINDS,
      ...(configured.enrichment?.facts ?? []),
    ].filter((fact) => !omitted.has(fact));
    this.maxArtifactBytes = maxArtifactBytes;
    this.batch = new BatchGraphSession({
      root: configured.root,
      languages: configured.languages,
      provider: configured.provider,
      command: configured.command,
      artifactName: "index.scip",
      indexArgs: configured.indexArgs,
      ...(configured.artifactFrom === undefined
        ? {}
        : { artifactFrom: configured.artifactFrom }),
      inputs: configured.inputs,
      ...(configured.configuration === undefined
        ? {}
        : { configuration: configured.configuration }),
      load: (props) => this.load(props),
      validate: (snapshot) => {
        configured.validate?.(snapshot);
        assertGraphSnapshotContract(
          snapshot,
          {
            name: configured.provider,
            authority: configured.authority,
            facts,
          },
          configured.languages,
          configured.root,
        );
      },
      ...(configured.maxStdoutBytes === undefined
        ? {}
        : { maxStdoutBytes: configured.maxStdoutBytes }),
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

  public refresh(
    options: { signal?: AbortSignal } = {},
  ): Promise<IBulkGraphSession.IRefresh> {
    return this.batch.refresh(options);
  }

  public close(): Promise<void> {
    return this.batch.close();
  }

  private async load(
    props: BatchGraphSession.ILoadProps,
  ): Promise<IBulkGraphSession.ISnapshot> {
    const size = fs.statSync(props.artifact).size;
    if (size > this.maxArtifactBytes) {
      throw new Error(
        `${this.options.provider}: SCIP artifact exceeded the ${String(this.maxArtifactBytes)} byte artifact limit`,
      );
    }
    const json = await props.run(this.options.decode, [props.artifact]);
    const decoded = JSON.parse(json) as unknown;
    this.bindInvocationProjectRoot(decoded);
    // Folding several translation units into one document is a fact about the
    // index rather than a detail: a C source compiled more than once is indexed
    // more than once, and a reader deserves to know which files that happened
    // to before trusting an occurrence count.
    const indexWarnings: string[] = [];
    const index = parseScipIndex(
      decoded,
      this.options.provider,
      indexWarnings,
    );
    this.assertProjectRoot(index.metadata.projectRoot);
    const adapted = adaptScipIndex({
      index,
      root: this.root,
      provider: this.options.provider,
      languages: this.languages,
      languageOf: this.options.languageOf,
      ...(this.options.preferFileLanguage === undefined
        ? {}
        : { preferFileLanguage: this.options.preferFileLanguage }),
    });
    const enriched = ScipEnrichment.apply({
      enrichment: this.options.enrichment,
      index,
      root: this.root,
      provider: this.options.provider,
      languages: this.languages,
      common: adapted,
    });
    const manifest = this.manifest(
      index,
      adapted.files,
      this.options.sourceText !== false,
    );
    return {
      languages: [...this.languages],
      nodes: adapted.nodes,
      edges: enriched.edges,
      diagnostics: adapted.diagnostics,
      sources: manifest.sources,
      provenance: {
        provider: this.options.provider,
        authority: this.options.authority,
        facts: [
          ...adaptScipIndex.EDGE_KINDS,
          ...(this.options.enrichment?.facts ?? []),
        ].filter((fact) => !(this.options.omitFacts ?? []).includes(fact)),
        schemaVersion: SCIP_SCHEMA_VERSION,
        tool: index.metadata.toolInfo?.name ?? this.options.provider,
        toolVersion: index.metadata.toolInfo?.version ?? "",
        // Read from the rows this universe was computed from, never asked
        // again. A second probe is a second instant: one row held to its last
        // established value while the other re-asks can put a compiler in the
        // provenance that this universe never saw.
        compilerVersion:
          this.options.compilerVersion?.(props.configuration) ?? "",
        protocolVersion: protocolVersionOf(
          index.metadata.version,
          this.options.provider,
        ),
        universe: props.universe,
        capabilities: manifest.proven
          ? [
              ...SCIP_CAPABILITIES,
              SOURCE_DIGESTS_CAPABILITY,
              ...(this.options.enrichment === undefined
                ? []
                : [ScipEnrichment.capability(this.options.enrichment)]),
            ]
          : [
              ...SCIP_CAPABILITIES,
              ...(this.options.enrichment === undefined
                ? []
                : [ScipEnrichment.capability(this.options.enrichment)]),
            ],
      },
      warnings: manifest.proven
        ? [...indexWarnings, ...adapted.warnings, ...enriched.warnings]
        : [
            ...indexWarnings,
            ...adapted.warnings,
            ...enriched.warnings,
            `${this.options.provider}: the index carries no document text, so its facts cannot be tied to the bytes they were computed from; source display falls back to what this graph can prove itself`,
          ],
    };
  }

  /** Build source evidence only from bytes the producer actually supplied. */
  private manifest(
    index: IScipIndex,
    files: readonly string[],
    sourceText: boolean,
  ): { sources: Map<string, IBulkGraphSession.ISourceDigest>; proven: boolean } {
    const indexed = new Map<string, string>();
    if (sourceText) {
      for (const document of index.documents) {
        const text = document.text;
        if (text !== undefined) {
          indexed.set(
            path.resolve(this.root, document.relativePath),
            createHash("sha256").update(text, "utf8").digest("hex"),
          );
        }
      }
    }

    const sources = new Map<string, IBulkGraphSession.ISourceDigest>();
    let proven = files.length > 0;
    for (const file of files) {
      const absolute = path.resolve(this.root, file);
      const checkerDigest = indexed.get(absolute) ?? "";
      if (checkerDigest === "") proven = false;
      let diskDigest = "";
      try {
        diskDigest = createHash("sha256")
          .update(fs.readFileSync(absolute))
          .digest("hex");
        /* c8 ignore start -- a document the indexer read and that vanished
         * before this read is a race no hermetic fixture can stage. */
      } catch {
        diskDigest = "";
      }
      /* c8 ignore stop */
      sources.set(absolute, { checkerDigest, diskDigest });
    }
    if (!proven) {
      // Capabilities apply to the whole snapshot, not selected rows. Retaining
      // a few checker digests while omitting sourceDigests would create evidence
      // the common contract correctly refuses as unlicensed.
      for (const [file, source] of sources) {
        sources.set(file, { ...source, checkerDigest: "" });
      }
    }
    return { sources, proven };
  }

  private assertProjectRoot(projectRoot: string): void {
    if (projectRoot === "") {
      throw new Error(`${this.options.provider}: the index has no project root`);
    }
    const declared = projectRoot.startsWith("file://")
      ? fileFromUri(projectRoot)
      : projectRoot;
    if (!samePath(declared, this.root)) {
      throw new Error(
        `${this.options.provider}: the index was produced for ${declared}, not ${this.root}`,
      );
    }
  }

  private bindInvocationProjectRoot(decoded: unknown): void {
    if (
      this.options.projectRootFromInvocation !== true ||
      typeof decoded !== "object" ||
      decoded === null ||
      Array.isArray(decoded)
    ) {
      return;
    }
    const metadata = (decoded as Record<string, unknown>).metadata;
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      Array.isArray(metadata)
    ) {
      return;
    }
    const record = metadata as Record<string, unknown>;
    if (record.projectRoot !== undefined || record.project_root !== undefined) {
      return;
    }
    // Some stock indexers serialize protobuf defaults by omission. This is
    // allowed only for providers whose isolated invocation itself fixes the
    // root: an explicit producer value is still parsed and checked unchanged.
    record.projectRoot = pathToFileURL(this.root).href;
  }
}

export namespace ScipSession {
  export interface IOptions {
    root: string;
    languages: readonly GraphLanguage[];
    provider: string;
    authority: GraphProviderAuthority;
    command: IGraphProvider.ICommand;
    decode: IGraphProvider.ICommand;
    indexArgs: (artifact: string) => string[];
    artifactFrom?: (root: string) => string;
    inputs: () => string[];
    configuration?: BatchGraphSession.IOptions["configuration"];
    compilerVersion?: (configuration: readonly string[]) => string;

    /**
     * Fact families this indexer provably does not emit.
     *
     * Declared rather than inferred: an index with no containment edges may be
     * a flat project or a producer that cannot describe nesting, and only
     * reading the producer tells you which.
     */
    omitFacts?: readonly GraphEdgeKind[];
    sourceText?: boolean;
    projectRootFromInvocation?: boolean;
    languageOf: (file: string) => GraphLanguage;
    preferFileLanguage?: boolean;
    enrichment?: ScipEnrichment.IContract;
    maxStdoutBytes?: number;
    maxArtifactBytes?: number;
    validate?: (snapshot: IBulkGraphSession.ISnapshot) => void;
  }
}

const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const SCIP_SCHEMA_VERSION = 5;
const SCIP_CAPABILITIES: readonly string[] = ["universe", "diskDigests"];
const SOURCE_DIGESTS_CAPABILITY = "sourceDigests";

/**
 * Publish the producer's protocol, not the decoder's schema assumption.
 *
 * The parser retains unknown non-negative enum numbers so a newer producer can
 * still be consumed. Named future versions cannot honestly be projected onto
 * the public numeric provenance contract until this client learns their
 * number, so they fail closed instead of being mislabeled as version zero.
 */
function protocolVersionOf(
  version: string | undefined,
  provider: string,
): number {
  if (version === undefined || version === "UnspecifiedProtocolVersion") {
    return 0;
  }
  if (/^(?:0|[1-9]\d*)$/.test(version)) {
    return Number(version);
  }
  throw new Error(
    `${provider}: SCIP protocol version ${JSON.stringify(version)} cannot be represented as a non-negative integer`,
  );
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  /* c8 ignore next 3 -- only one platform arm runs on a given OS. */
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
