import { GraphEdgeKind } from "../typings/GraphEdgeKind";
import { GraphLanguage } from "../typings/GraphLanguage";
import { GraphProviderAuthority } from "../typings/GraphProviderAuthority";
import { ISamchonGraphDiagnostic } from "./ISamchonGraphDiagnostic";
import { ISamchonGraphEdge } from "./ISamchonGraphEdge";
import { ISamchonGraphCoverage } from "./ISamchonGraphCoverage";
import { ISamchonGraphNode } from "./ISamchonGraphNode";
import { ISamchonGraphSpan } from "./ISamchonGraphSpan";
import { ISamchonGraphUnresolved } from "./ISamchonGraphUnresolved";

/**
 * The whole-graph export `samchon-graph dump` writes and the MCP server loads —
 * the wire contract between the indexer and the code graph engine.
 *
 * It is the complete graph with none of the per-response caps the MCP tools
 * apply: every node and edge the build resolved. The server parses each changed
 * snapshot (typia-validated) into an in-memory resident graph and reuses that
 * warm model while project inputs stay unchanged.
 *
 * It is a pure function of its source: two dumps of the same unedited checkout
 * are byte-identical, so a graph can be cached, diffed, and trusted. Nothing
 * here records when it was built — a timestamp would move under an unchanged
 * source, which is exactly the property a cache and a diff depend on.
 *
 * `project` is the producer-local absolute locator. Every identity-bearing path
 * uses one schema-v6 coordinate relative to it: project files are ordinary
 * relative paths; same-filesystem siblings use `../` segments; package files
 * keep their full resolution context (including version/peer-store segments);
 * and a virtual compiler source stays `bundled:///…`. Raw absolute identities
 * are never emitted. A source on another drive or UNC share makes the producer
 * fail unless a future contract supplies a logical root for it. The same
 * coordinate flows through nodes, edges, evidence, diagnostics, and results.
 */
export interface ISamchonGraphDump {
  /** Absolute path of the project root the graph was built for. */
  project: string;

  /** The source languages present in this dump. */
  languages: GraphLanguage[];

  /** Which indexing strategy produced the graph. */
  indexer: "lsp" | "static" | "hybrid";

  /** What each strict provider proved about the slice it contributed, one row per provider, ordered by provider name so an unchanged checkout stays byte-identical. Absent when no strict provider served the build, and absent from dumps written before this field existed. Computation mode is deliberately not here: it belongs to one refresh rather than to the facts, so recording it would make two dumps of the same unedited checkout differ. */
  provenance?: ISamchonGraphDump.IProvenance[];

  /**
   * Exhaustive per-provider, language, target and relationship-family
   * completeness rows. Absent only on dumps written before protocol version 1.
   */
  coverage?: ISamchonGraphCoverage[];

  /**
   * Structured relationship sites that a producer could not resolve exactly.
   * An empty list is meaningful only together with exhaustive coverage.
   */
  unresolved?: ISamchonGraphUnresolved[];

  /** Every node the build recorded. */
  nodes: ISamchonGraphDump.INode[];

  /** Every edge the build resolved. */
  edges: ISamchonGraphDump.IEdge[];

  /**
   * What the language server said about the source while it indexed it. Absent
   * when the dump was built without one — a static parse has nobody to ask.
   */
  diagnostics?: ISamchonGraphDiagnostic[];

  /** Non-fatal problems encountered while building the graph. */
  warnings?: string[];
}

export namespace ISamchonGraphDump {
  /**
   * One strict provider's claim about the slice it contributed.
   *
   * The reference contract carries a single provenance object, because one
   * TypeScript `Program` produced its whole dump. A multi-language graph has no
   * such single program: TypeScript's checker, a Clang compilation universe,
   * and a Go semantic index can each own part of one dump, and collapsing them
   * into one row would have to invent a tool name, a version, and a build
   * fingerprint that describe none of them. So the claim is per provider, and a
   * reader asks which slice it is reading before trusting a fingerprint.
   */
  export interface IProvenance {
    /** Registry name of the provider that produced this slice. */
    provider: string;

    /** The languages it replaced atomically, in the order it published them. */
    languages: GraphLanguage[];

    /** What its facts are grounded in. */
    authority: GraphProviderAuthority;

    /**
     * The edge families it is registered to prove.
     *
     * A reader distinguishes "this provider proved there are no calls here"
     * from "this provider cannot prove calls at all" by asking whether `calls`
     * appears here — a question an empty edge list cannot answer.
     */
    facts: GraphEdgeKind[];

    /** What the producer claims it collected, in the producer's own words. */
    capabilities: string[];

    /** Which program produced the facts. */
    producer: IProducer;

    /**
     * Fingerprint of the inputs that decided which files are in the program.
     *
     * Facts must never be carried across a snapshot whose fingerprint moved: a
     * change to it can add or drop whole files, so the two generations are not
     * two views of one program.
     */
    universe: string;

    /** Digest over the exact input manifest the facts were computed from. */
    manifest: string;

    /** Digest over the facts this slice published, in publication order. */
    content: string;
  }

  /** The program that produced one slice. */
  export interface IProducer {
    /** The producing tool's name, such as `ttscgraph`. */
    tool: string;

    /** The tool's build version, or `""` when it carries none. */
    version: string;

    /**
     * The language version the tool's checker implements.
     *
     * Separate from {@link version} because a tool and the checker it embeds do
     * not share a version line, and a consumer comparing language behaviour
     * needs the checker's.
     */
    compiler: string;

    /** The version of the dump body contract the producer emitted. */
    schemaVersion: number;

    /** The wire protocol version the producer spoke. */
    protocolVersion: number;
  }

  /**
   * A node as the indexer sends it: the graph node, minus the file paths inside
   * its spans, which the loader puts back from the node's own `file`.
   *
   * A node's declaration span is in the node's file, always — the path in the
   * span was the same string a second time, once per node. It is the reader's
   * to reconstruct, and {@link SamchonGraphMemory} does, so nothing downstream
   * of the loader sees a span without its file.
   */
  export interface INode
    extends Omit<ISamchonGraphNode, "evidence" | "implementation"> {
    /** Declaration span; its file is this node's `file`. */
    evidence?: ISamchonGraphSpan;

    /**
     * Implementation span. This one keeps its file when it has one: an
     * implementation genuinely can live in another file from its declaration.
     */
    implementation?: ISamchonGraphSpan;
  }

  /**
   * An edge as the indexer sends it. Its span is in its source node's file,
   * looked up by the opaque id when necessary, so the path need not ride the
   * wire a second time on every edge.
   */
  export interface IEdge extends Omit<ISamchonGraphEdge, "evidence"> {
    /** Expression span; its file is the source node's declaration file. */
    evidence?: ISamchonGraphSpan;
  }
}
