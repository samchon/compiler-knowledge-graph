import fs from "node:fs";
import path from "node:path";

import {
  GraphEdgeKind,
  GraphLanguage,
  GraphProviderAuthority,
} from "../../typings";
import { normalizePath } from "../../utils/normalizePath";
import { fileFromUri } from "../../utils/fileFromUri";
import { BatchGraphSession } from "../BatchGraphSession";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { IGraphProvider } from "../IGraphProvider";
import { parseSidecarSnapshot } from "./parseSidecarSnapshot";

/** A strict batch session over the common compiler/analyzer sidecar wire. */
export class SidecarSession implements IBulkGraphSession {
  public readonly kind = "bulk" as const;
  public readonly languages: readonly GraphLanguage[];
  public readonly root: string;

  private readonly options: SidecarSession.IOptions;
  private readonly maxArtifactBytes: number;
  private readonly batch: BatchGraphSession;

  public constructor(options: SidecarSession.IOptions) {
    const maxArtifactBytes =
      options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1) {
      throw new TypeError(
        `${options.provider}: maxArtifactBytes must be a positive safe integer`,
      );
    }
    this.options = options;
    this.maxArtifactBytes = maxArtifactBytes;
    this.batch = new BatchGraphSession({
      root: options.root,
      languages: options.languages,
      provider: options.provider,
      command: options.command,
      artifactName: "snapshot.json",
      indexArgs: options.indexArgs,
      inputs: options.inputs,
      ...(options.configuration === undefined
        ? {}
        : { configuration: options.configuration }),
      load: (props) => this.load(props),
      ...(options.validate === undefined
        ? {}
        : { validate: options.validate }),
      ...(options.maxStdoutBytes === undefined
        ? {}
        : { maxStdoutBytes: options.maxStdoutBytes }),
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

  private load(
    props: BatchGraphSession.ILoadProps,
  ): Promise<IBulkGraphSession.ISnapshot> {
    const size = fs.statSync(props.artifact).size;
    if (size > this.maxArtifactBytes) {
      throw new Error(
        `${this.options.provider}: snapshot exceeded the ${String(this.maxArtifactBytes)} byte artifact limit`,
      );
    }
    const wire = parseSidecarSnapshot(
      this.decode(fs.readFileSync(props.artifact, "utf8")),
    );
    this.assertProjectRoot(wire.projectRoot);
    assertSameLanguages(wire.languages, this.languages, this.options.provider);
    assertUnique(wire.capabilities, `${this.options.provider}: capabilities`);
    assertNonEmpty(wire.tool.name, `${this.options.provider}: tool name`);
    assertNonEmpty(wire.universe, `${this.options.provider}: universe`);
    if (
      !Number.isSafeInteger(wire.tool.protocolVersion) ||
      wire.tool.protocolVersion < 0
    ) {
      throw new Error(
        `${this.options.provider}: protocolVersion must be a non-negative safe integer`,
      );
    }

    const sources = new Map<string, IBulkGraphSession.ISourceDigest>();
    for (const source of wire.sources) {
      const file = sourceIdentity(this.root, source.file);
      if (sources.has(file)) {
        throw new Error(
          `${this.options.provider}: duplicate source manifest entry: ${file}`,
        );
      }
      assertDigest(source.checkerDigest, `${file}.checkerDigest`);
      assertDigest(source.diskDigest, `${file}.diskDigest`);
      sources.set(file, {
        checkerDigest: source.checkerDigest,
        diskDigest: source.diskDigest,
      });
    }
    assertSourceDigests(wire.capabilities, sources, this.options.provider);

    return Promise.resolve({
      languages: [...wire.languages],
      nodes: wire.nodes,
      edges: wire.edges,
      diagnostics: wire.diagnostics,
      sources,
      provenance: {
        provider: this.options.provider,
        authority: this.options.authority,
        facts: [...this.options.facts],
        schemaVersion: wire.schemaVersion,
        tool: wire.tool.name,
        toolVersion: wire.tool.version,
        compilerVersion: wire.tool.compilerVersion,
        protocolVersion: wire.tool.protocolVersion,
        universe: wire.universe,
        capabilities: [...wire.capabilities],
      },
      warnings: wire.warnings,
    });
  }

  /**
   * Read the artifact, saying whose it is and what was in it when it will not.
   *
   * A raw `JSON.parse` throws `Unexpected token …` with no provider name and no
   * trace of the bytes, which is the least useful sentence available about a
   * producer that crashed mid-write or printed a message where its snapshot
   * should be. The head rather than the tail, because that is where a stray
   * line starts, and bounded because the rest of the file is a graph.
   */
  private decode(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      const head = text.trimStart().slice(0, 400);
      // Native JSON.parse rejects with SyntaxError; there is no alternate
      // thrown shape to branch on at this boundary.
      const message = (error as SyntaxError).message;
      throw new Error(
        `${this.options.provider}: the snapshot artifact is not JSON: ${message}${
          head === "" ? " (the file is empty)" : `: ${head}`
        }`,
      );
    }
  }

  private assertProjectRoot(projectRoot: string): void {
    if (projectRoot === "") {
      throw new Error(
        `${this.options.provider}: the snapshot has no project root`,
      );
    }
    const declared = projectRoot.startsWith("file://")
      ? fileFromUri(projectRoot)
      : projectRoot;
    if (!samePath(declared, this.root)) {
      throw new Error(
        `${this.options.provider}: the snapshot was produced for ${declared}, not ${this.root}`,
      );
    }
  }
}

export namespace SidecarSession {
  export interface IOptions {
    root: string;
    languages: readonly GraphLanguage[];
    provider: string;
    authority: GraphProviderAuthority;
    facts: readonly GraphEdgeKind[];
    command: IGraphProvider.ICommand;
    indexArgs: (artifact: string) => string[];
    inputs: () => string[];
    configuration?: BatchGraphSession.IOptions["configuration"];
    maxStdoutBytes?: number;
    maxArtifactBytes?: number;
    validate?: (snapshot: IBulkGraphSession.ISnapshot) => void;
  }
}

const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

function assertSameLanguages(
  actual: readonly GraphLanguage[],
  expected: readonly GraphLanguage[],
  provider: string,
): void {
  assertUnique(actual, `${provider}: languages`);
  if (
    actual.length !== expected.length ||
    actual.some((language) => !expected.includes(language))
  ) {
    throw new Error(
      `${provider}: snapshot languages [${actual.join(", ")}] do not match ` +
        `candidate languages [${expected.join(", ")}]`,
    );
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains a duplicate value`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (value === "") throw new Error(`${label} is empty`);
}

function assertDigest(value: string, label: string): void {
  if (value === "" || SHA256.test(value)) return;
  throw new Error(`${label} is not an empty value or lowercase SHA-256`);
}

function assertSourceDigests(
  capabilities: readonly string[],
  sources: ReadonlyMap<string, IBulkGraphSession.ISourceDigest>,
  provider: string,
): void {
  const checker = capabilities.includes("sourceDigests");
  const disk = capabilities.includes("diskDigests");
  for (const [file, digest] of sources) {
    if (checker && digest.checkerDigest === "") {
      throw new Error(
        `${provider}: sourceDigests is claimed but ${file}.checkerDigest is empty`,
      );
    }
    if (!checker && digest.checkerDigest !== "") {
      throw new Error(
        `${provider}: ${file}.checkerDigest is set without sourceDigests`,
      );
    }
    if (!disk && digest.diskDigest !== "") {
      throw new Error(
        `${provider}: ${file}.diskDigest is set without diskDigests`,
      );
    }
  }
}

function sourceIdentity(root: string, file: string): string {
  assertNonEmpty(file, "sidecar source file");
  if (file.startsWith("bundled:///")) return file;
  const normalized = normalizePath(file);
  if (!path.isAbsolute(file)) {
    const segments = normalized.split("/");
    if (
      segments.some(
        (segment) => segment === "" || segment === "." || segment === "..",
      )
    ) {
      throw new Error(`sidecar source path is not normalized: ${file}`);
    }
  }
  return path.isAbsolute(file) ? path.normalize(file) : path.resolve(root, file);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  /* c8 ignore next 3 -- only one platform arm runs on a given OS. */
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
