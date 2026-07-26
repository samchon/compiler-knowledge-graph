import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { GraphEdgeKind, GraphLanguage } from "../../typings";
import { assertGraphSnapshotContract } from "../assertGraphSnapshotContract";
import { BatchGraphSession } from "../BatchGraphSession";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { IGraphProvider } from "../IGraphProvider";
import { adaptLuaExport } from "./adaptLuaExport";

/**
 * Runs the Lua exporter inside lua-language-server and adapts what it wrote.
 *
 * The shape follows `ScipSession` rather than `SidecarSession`: a sidecar hands
 * back a complete snapshot, and this producer cannot. lua-language-server ships
 * no hashing primitive anywhere in its source, so source digests are computed
 * on this side, which makes the artifact raw material rather than a snapshot.
 *
 * What it claims is deliberately narrow. `diskDigests` and not `sourceDigests`:
 * the bytes are read from disk after the run, which says what is on disk and
 * not what the checker consumed. Claiming the latter would be the conflation
 * `movedConsumedSource` exists to catch, and the generation fence above this
 * session is what actually establishes that the two agreed.
 */
export class LuaGraphSession implements IBulkGraphSession {
  public readonly kind = "bulk" as const;
  public readonly languages: readonly GraphLanguage[];
  public readonly root: string;

  private readonly batch: BatchGraphSession;

  public constructor(options: LuaGraphSession.IOptions) {
    const provider = options.provider;
    this.batch = new BatchGraphSession({
      root: options.root,
      languages: options.languages,
      provider,
      command: options.command,
      // The exporter writes this filename into whatever directory it is given,
      // so naming the artifact after it makes the directory the session already
      // created the one the server writes into.
      artifactName: LuaGraphSession.ARTIFACT,
      indexArgs: options.indexArgs,
      inputs: options.inputs,
      ...(options.configuration === undefined
        ? {}
        : { configuration: options.configuration }),
      load: (props) => this.load(props, options.root, provider),
      validate: (snapshot) => {
        assertGraphSnapshotContract(
          snapshot,
          {
            name: provider,
            authority: "analyzer",
            facts: LuaGraphSession.FACTS,
          },
          options.languages,
          options.root,
        );
      },
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
    root: string,
    provider: string,
  ): Promise<IBulkGraphSession.ISnapshot> {
    const report = adaptLuaExport.parse(
      JSON.parse(fs.readFileSync(props.artifact, "utf8")),
      provider,
    );
    const adapted = adaptLuaExport(report, provider);

    const sources = new Map<string, IBulkGraphSession.ISourceDigest>();
    for (const file of adapted.files) {
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(path.join(root, file));
      } catch {
        // A file the server indexed and that cannot be read back is a moved
        // generation, not a snapshot to publish around.
        throw new Error(
          `${provider}: ${file} was indexed but could not be read back`,
        );
      }
      sources.set(file, {
        // Empty on purpose: `sourceDigests` is not claimed, and the contract
        // refuses a digest for a capability the provider did not declare.
        checkerDigest: "",
        diskDigest: createHash("sha256").update(bytes).digest("hex"),
      });
    }

    return Promise.resolve({
      languages: [...this.languages],
      nodes: adapted.nodes,
      edges: adapted.edges,
      diagnostics: [],
      sources,
      provenance: {
        provider,
        authority: "analyzer",
        facts: [...LuaGraphSession.FACTS],
        schemaVersion: report.schemaVersion,
        tool: "lua-language-server",
        toolVersion: "",
        compilerVersion: "",
        protocolVersion: 1,
        universe: props.universe,
        // `universe` because the snapshot carries one and the contract requires
        // a provider to say so. `diskDigests` and deliberately not
        // `sourceDigests`: the bytes are read from disk after the run, which
        // says what is on disk rather than what the checker consumed.
        capabilities: ["universe", "diskDigests"],
      },
      warnings: adapted.warnings,
    });
  }
}

export namespace LuaGraphSession {
  /** The filename the exporter writes; see `sidecars/lua/export.lua`. */
  export const ARTIFACT = "samchon-graph-lua.json";

  /**
   * The only relationship this index proves.
   *
   * `vm.getRefs` answers "where else does this symbol appear", and nothing in
   * the exporter distinguishes a call from a read or an assignment. Declaring
   * `calls` from a reference would be inference dressed as a fact, which is
   * what the provider contract exists to stop.
   */
  export const FACTS: readonly GraphEdgeKind[] = ["references"];

  export interface IOptions {
    root: string;
    languages: readonly GraphLanguage[];
    provider: string;
    command: IGraphProvider.ICommand;
    indexArgs: (artifact: string) => string[];
    inputs: () => string[];
    configuration?: () => readonly string[];
  }
}
