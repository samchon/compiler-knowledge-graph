import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareOrdinal as compareText } from "@samchon/graph-sitter";

import {
  ISamchonGraphCoverage,
  ISamchonGraphDiagnostic,
  ISamchonGraphEdge,
  ISamchonGraphEvidence,
  ISamchonGraphNode,
  ISamchonGraphUnresolved,
} from "../../structures";
import {
  GRAPH_EDGE_KINDS,
  GraphEdgeKind,
  GraphLanguage,
  GraphNodeKind,
} from "../../typings";
import { GraphSnapshotProtocol } from "../GraphSnapshotProtocol";
import { IBulkGraphSession } from "../IBulkGraphSession";
import {
  IGraphSemanticIdentity,
  semanticGraphNodeId,
} from "../semanticIdentity";
import { CPP_CLANG_FACTS } from "./CPP_CLANG_FACTS";
import { CppGraphReloadRequired } from "./CppGraphReloadRequired";
import { CPP_CLANG_PROVIDER } from "./CPP_CLANG_PROVIDER";
import { ICppGraphSnapshot } from "./ICppGraphSnapshot";

const SHA256 = /^[a-f0-9]{64}$/u;
const ROLE = {
  declaration: 1 << 0,
  definition: 1 << 1,
  reference: 1 << 2,
  read: 1 << 3,
  write: 1 << 4,
  call: 1 << 5,
  dynamic: 1 << 6,
  childOf: 1 << 10,
  baseOf: 1 << 11,
  overrideOf: 1 << 12,
  calledBy: 1 << 14,
  extendedBy: 1 << 15,
  accessorOf: 1 << 16,
  containedBy: 1 << 17,
  specializationOf: 1 << 19,
  nameReference: 1 << 20,
} as const;
const TYPE_KINDS = new Set([6, 7, 8, 9, 10, 11, 12, 28, 29, 31]);
const CAPABILITIES = [
  "coverage",
  "diagnostics",
  "diskDigests",
  "incremental",
  "sourceDigests",
  "universe",
  "unresolved",
];

/**
 * What a published shard is remembered by between generations.
 *
 * Seven strings. The manifest is ordered by main file and configuration and
 * carries key and digest; the universe check reads target triple and toolchain
 * fingerprint; `hello` reads the language. Nothing between generations reads a
 * node, an edge, an occurrence or a source -- and on a 242 translation-unit
 * project those are gigabytes held to answer questions about names.
 */
interface IRetainedShard {
  key: string;
  digest: string;
  configuration: string;
  graph: {
    mainFile: string;
    targetTriple: string;
    toolchainFingerprint: string;
    language: string;
  };
}

function retain(shard: ICppGraphSnapshot.IShard): IRetainedShard {
  return {
    key: shard.key,
    digest: shard.digest,
    configuration: shard.configuration,
    graph: {
      mainFile: shard.graph.mainFile,
      targetTriple: shard.graph.targetTriple,
      toolchainFingerprint: shard.graph.toolchainFingerprint,
      language: shard.graph.language,
    },
  };
}

/** Converts one validated native clangd generation into the common protocol. */
export class CppGraphSnapshotAdapter {
  public readonly store: GraphSnapshotProtocol.Store;
  private readonly selectedLanguages: ReadonlySet<GraphLanguage>;
  private rawShards = new Map<string, IRetainedShard>();
  private rawGeneration: string | undefined;

  public constructor(
    private readonly root: string,
    private readonly producerCommit: string,
    languages: readonly GraphLanguage[] = ["c", "cpp"],
  ) {
    this.store = new GraphSnapshotProtocol.Store(root);
    this.selectedLanguages = new Set(languages);
  }

  public get generation(): string | undefined {
    return this.rawGeneration;
  }

  /** Drop the generation, so the next request asks for a whole one. */
  public forget(): void {
    this.rawGeneration = undefined;
  }

  /**
   * Adapt one whole generation.
   *
   * Kept as the shape every fixture uses, and routed through the same three
   * phases the client streams into, so a case that hands over a complete
   * generation exercises exactly the path a paged one takes.
   */
  public apply(
    raw: ICppGraphSnapshot,
    validate: (snapshot: IBulkGraphSession.ISnapshot) => void,
  ): CppGraphSnapshotAdapter.IResult {
    const opened = this.open(raw, raw.upserts.length, validate);
    if (opened.settled !== undefined) return opened.settled;
    for (const shard of raw.upserts) opened.shard(shard);
    return opened.finish();
  }

  /**
   * Begin a generation, to be given its shards one at a time.
   *
   * A whole-compilation-database producer answered a 242 translation-unit
   * project with 469 shards -- a file built under two configurations publishes
   * a view of each -- and holding them all as parsed JSON until the last
   * one arrives is what exhausted this consumer: it died inside `JSON.parse`
   * with the generation still incomplete, before it had adapted anything. So a
   * shard is adapted as it is handed over and the parsed form released, leaving
   * the graph rather than the graph and the producer's rendering of it.
   *
   * `shards` is what the envelope's page claims the generation holds. It is
   * checked against what arrives, because a caller that streams is making a
   * promise the envelope alone can no longer verify.
   */
  public open(
    envelope: ICppGraphSnapshot,
    shards: number,
    validate: (snapshot: IBulkGraphSession.ISnapshot) => void,
  ): CppGraphSnapshotAdapter.IIngest {
    assertSnapshot(envelope, this.producerCommit, shards);
    if (
      envelope.baseGeneration !== null &&
      envelope.baseGeneration !== this.rawGeneration
    ) {
      throw new Error("C/C++ clang graph: stale producer base generation");
    }
    const prior = this.store.current;
    if (
      prior !== undefined &&
      envelope.generation === this.rawGeneration &&
      envelope.baseGeneration === this.rawGeneration &&
      shards === 0 &&
      envelope.deletes.length === 0 &&
      envelope.manifest.length === 0 &&
      envelope.page.total === 0 &&
      envelope.phases.cacheHit &&
      envelope.universe.digest === prior.provenance.universe
    ) {
      assertNativeGeneration(
        envelope,
        nativeManifest(this.rawShards),
        this.rawShards,
      );
      return {
        settled: { changed: false, mode: "unchanged", snapshot: prior },
      };
    }
    const nextRaw =
      envelope.baseGeneration === null
        ? new Map<string, IRetainedShard>()
        : new Map(this.rawShards);
    // A reload starts from nothing and a delta starts from the prior graph,
    // and which it is follows from the base generation alone: a reload that
    // arrives as a delta is refused in `finish`, so every generation that
    // reaches there with a base has one to build on.
    // Seeded from the store's own published generation rather than from a
    // second copy of it. These are read here and handed back to `apply`, which
    // deep-clones what it retains, so the generation being built never shares
    // structure with the one it replaces.
    const nextGraph =
      envelope.baseGeneration === null
        ? new Map<string, GraphSnapshotProtocol.IShard>()
        : new Map(this.store.shards);
    const touched = new Set<string>();
    // A shard carries the entities it derived, so a shard that goes away
    // would take them with it -- and a header's declarations belong to
    // whichever unit read them first, which may be the unit that was removed.
    // No delta can do that: a shard owns the only configuration naming its
    // own compile command, so losing one moves the universe, and a delta that
    // admits the universe moved is refused and comes back whole. The two
    // rules leave no delta that both passes validation and carries a delete.
    for (const key of envelope.deletes) {
      if (touched.has(key) || !nextRaw.delete(key)) {
        throw new Error(`C/C++ clang graph: invalid delete ${key}`);
      }
      touched.add(key);
    }
    const fingerprint = producerFingerprint(envelope.producer);
    // The producer's own coverage rows for each shard adapted here, fifteen to
    // a shard. The matrix a shard publishes names every language the generation
    // serves, and that set is only settled once the last shard has arrived --
    // so adaptation leaves it empty and `finish` fills it, which is what lets a
    // shard be adapted before the generation is complete.
    const pending = new Map<string, IPendingCoverage>();
    const census: CppGraphSnapshotAdapter.ICensus = {
      nodes: 0,
      offMain: 0,
      entities: 0,
      relationships: 0,
    };
    // One instance per node and per edge, for the whole walk.
    //
    // Shards name the same entity: a header's declarations belong to every
    // unit that included it, and each of those units adapts them again. The
    // facts are equal, so what is kept is one object the shards share -- the
    // walk then holds an array slot per naming rather than a whole node, and
    // a generation costs what the project declares instead of what its units
    // read.
    // Read once for the walk, so every shard agrees on it: the protocol
    // refuses a generation whose shards disagree about a source.
    const database = compilationDatabaseSource(this.root);
    const canonical: ICanonical = {
      nodes: new Map(),
      edges: new Map(),
      drawn: { count: 0 },
      ids: new Map(),
    };
    let delivered = 0;
    return {
      census,
      shard: (shard) => {
        assertShard(shard, fingerprint);
        if (touched.has(shard.key)) {
          throw new Error(`C/C++ clang graph: duplicate delta ${shard.key}`);
        }
        touched.add(shard.key);
        delivered += 1;
        nextRaw.set(shard.key, retain(shard));
        const key = graphKey(shard.key);
        const language = shard.graph.language;
        if (
          (language !== "c" && language !== "cpp") ||
          !this.selectedLanguages.has(language)
        ) {
          nextGraph.delete(key);
          pending.delete(key);
          return;
        }
        const adapted = adaptShard(
          this.root,
          envelope.universe.digest,
          shard,
          canonical,
          database,
        );
        // A shard is one translation unit's view, so a node whose file is not
        // this unit's main file came from something it included -- and will
        // arrive again from every other unit that includes the same header.
        const main = graphFile(this.root, shard.graph.mainFile);
        census.nodes += adapted.nodes.length;
        for (const node of adapted.nodes)
          if (node.file !== main) census.offMain += 1;
        census.entities = canonical.nodes.size;
        census.relationships = canonical.drawn.count;
        nextGraph.set(key, adapted);
        pending.set(key, {
          rows: shard.coverage,
          mainFileUri: shard.graph.mainFileUri,
        });
      },
      finish: () => {
        if (delivered !== shards) {
          throw new Error(
            "C/C++ clang graph: generation delivered " +
              `${String(delivered)} of ${String(shards)} shards`,
          );
        }
        const expectedManifest = nativeManifest(nextRaw);
        if (
          expectedManifest.length !== envelope.manifest.length ||
          expectedManifest.some(
            (entry, index) =>
              entry.key !== envelope.manifest[index]?.key ||
              entry.digest !== envelope.manifest[index]?.digest,
          )
        ) {
          throw new Error("C/C++ clang graph: producer manifest mismatch");
        }
        assertNativeGeneration(envelope, expectedManifest, nextRaw);

        const hello = helloOf(envelope, nextRaw, this.selectedLanguages);
        const languagesChanged =
          prior !== undefined &&
          JSON.stringify(prior.languages) !== JSON.stringify(hello.languages);
        const universeChanged =
          prior !== undefined &&
          envelope.universe.digest !== prior.provenance.universe;
        // A database that moved cannot be carried by a delta either.
        //
        // Every shard names it, and a delta keeps the shards it was not sent
        // -- which still name the digest the last walk read. One generation
        // cannot hold two answers about one file, and the shards that would
        // have to be corrected are exactly the ones the producer did not
        // send. A database that moved is also when the set of units may have
        // moved, so a whole generation is the honest answer rather than an
        // expensive one.
        const databaseMoved =
          prior !== undefined &&
          database !== undefined &&
          prior.sources.get(database.file)?.checkerDigest !==
            database.checkerDigest;
        const requiresReload =
          languagesChanged || universeChanged || databaseMoved;
        if (requiresReload && envelope.baseGeneration !== null) {
          // Nothing has been assigned yet, so refusing here leaves this adapter
          // exactly as it was and the caller free to ask again.
          throw new CppGraphReloadRequired(
            languagesChanged
              ? "the served languages moved"
              : universeChanged
                ? "the universe moved"
                : "the compilation database moved",
          );
        }
        for (const [key, source] of pending) {
          completeCoverage(
            this.root,
            nextGraph.get(key)!,
            source,
            envelope.universe.digest,
            hello.languages,
          );
        }
        const sequence = (prior?.protocol?.sequence ?? 0) + 1;
        const manifest = [...nextGraph]
          .sort(([left], [right]) => compareText(left, right))
          .map(([key, shard]) => ({
            key,
            digest: GraphSnapshotProtocol.shardDigest(shard),
          }));
        const ordered = manifest.map((entry) => nextGraph.get(entry.key)!);
        const targets = [...new Set(ordered.map((shard) => shard.target))].sort(
          compareText,
        );
        const begin: GraphSnapshotProtocol.IBegin = {
          type: "begin",
          sequence,
          generation: envelope.generation,
          ...(envelope.baseGeneration !== null &&
          prior !== undefined &&
          !requiresReload
            ? {
                baseSequence: prior.protocol!.sequence,
                baseGeneration: prior.protocol!.generation,
              }
            : {}),
          universe: envelope.universe.digest,
          manifest: GraphSnapshotProtocol.manifestDigest(
            ordered.flatMap((shard) => shard.sources),
          ),
          targets,
        };
        const facts = factsOf(hello, begin, ordered);
        const commit: GraphSnapshotProtocol.ICommit = {
          type: "commit",
          sequence,
          generation: envelope.generation,
          shards: manifest,
          factDigest: GraphSnapshotProtocol.factDigest(facts),
        };
        const frames = framesOf(
          hello,
          begin,
          commit,
          manifest,
          nextGraph,
          prior,
        );
        // A delta is proved against the full generation it claims to be
        // equivalent to, by replaying that generation into a fresh store and
        // requiring it to be accepted on its own.
        //
        // Only a delta needs it. When `begin` carries no base -- an initial
        // generation, or a reload -- `framesOf` already emits every shard in
        // the manifest, and `fullBegin` differs from `begin` only by clearing
        // a base that is not there. The two transactions are the same frames
        // in the same order, so replaying is applying the commit twice and
        // proving that it equals itself.
        //
        // It is not free to do that. `Store.apply` deep-clones every shard it
        // retains, so the replay holds a second whole generation beside the
        // one being committed, at the moment the adapter is already holding
        // the graph it built. On libuv that is three copies of 469 shards, and
        // the initial walk -- the one case where the replay proves nothing --
        // is where the consumer runs out of heap.
        // A delta whose surviving shards name an entity nobody carries any
        // more must be answered with a whole generation, not with an error.
        //
        // A shard carries the entities it derived, and which shard that is
        // settles per walk. A unit that stops including a header stops
        // deriving what it declared, and a unit that did not change still
        // names it -- so the generation is short an entity its own edges
        // point at. Nothing in a delta can re-derive it, because only the
        // changed units are sent. Refusing is right; refusing in a way the
        // client cannot answer is not, and this adapter already has the
        // answer: forget the base and ask for the whole thing.
        const whole = (task: () => void): void => {
          try {
            task();
          } catch (error) {
            if (
              begin.baseGeneration === undefined ||
              !(error instanceof Error) ||
              !error.message.includes("absent endpoint")
            ) {
              throw error;
            }
            throw new CppGraphReloadRequired(
              "a delta lost an entity its surviving shards still name",
            );
          }
        };
        if (begin.baseGeneration !== undefined) {
          const fullBegin: GraphSnapshotProtocol.IBegin = {
            ...begin,
            baseSequence: undefined,
            baseGeneration: undefined,
          };
          const fullFrames: GraphSnapshotProtocol.Frame[] = [hello, fullBegin];
          for (const entry of manifest) {
            fullFrames.push({
              type: "upsertShard",
              digest: entry.digest,
              shard: nextGraph.get(entry.key)!,
            });
          }
          fullFrames.push(commit);
          // Adopted, like the store that keeps the result. This one exists to
          // prove the delta rebuilds what a full load would and is dropped on
          // the next line, so the generation it holds is the same one already
          // in hand -- copying it deeply meant deserializing a second whole
          // graph beside the first, which is where a delta ran out of heap
          // after a walk that had finished.
          whole(() => {
            new GraphSnapshotProtocol.Store(this.root).apply(fullFrames, {
              validate,
              adopt: true,
            });
          });
        }
        // Adopted, not copied. `nextGraph` is built here and released as
        // this returns -- the adapter has kept no map of its own since the
        // store began publishing its committed generation -- so the copy the
        // store would otherwise make is a second whole graph guarding against
        // a reference that no longer exists. On libuv that copy is what the
        // commit ran out of heap for, immediately after a walk that finally
        // finished.
        let snapshot!: IBulkGraphSession.ISnapshot;
        whole(() => {
          snapshot = this.store.apply(frames, { validate, adopt: true });
        });
        this.rawShards = nextRaw;
        this.rawGeneration = envelope.generation;
        return {
          changed: true,
          mode:
            prior === undefined
              ? "initial"
              : begin.baseGeneration === undefined
                ? "reload"
                : "incremental",
          snapshot,
        };
      },
    };
  }
}

export namespace CppGraphSnapshotAdapter {
  /**
   * One generation, either already answered or waiting for its shards.
   *
   * Two members rather than one with unreachable halves: a producer that
   * reported no movement has nothing to hand over and nothing to close, and an
   * open generation always has both. Modelling it as one shape meant a `shard`
   * that could never be called and a `finish` that could only throw.
   */
  export type IIngest = ISettled | IOpen;

  /** A generation the producer says did not move. */
  export interface ISettled {
    settled: IResult;
  }

  /** A generation being built, one shard at a time. */
  export interface IOpen {
    settled?: undefined;
    shard: (shard: ICppGraphSnapshot.IShard) => void;
    finish: () => IResult;

    /** Nodes adapted so far, and how many came from outside the main file. */
    readonly census: ICensus;
  }

  /** What a walk has materialised, for the trace to report. */
  export interface ICensus {
    nodes: number;
    offMain: number;
    /** Distinct entities and relationships the walk has derived so far. */
    entities: number;
    relationships: number;
  }

  export interface IResult {
    changed: boolean;
    mode: IBulkGraphSession.Mode;
    snapshot: IBulkGraphSession.ISnapshot;
  }
}

// Frames carry the shards themselves. `Store.apply` deep-clones what it
// retains, so cloning on the way in produced a copy that was copied again and
// then dropped -- one whole corpus of garbage per generation, on the path that
// already holds the largest object this process builds.
function framesOf(
  hello: GraphSnapshotProtocol.IHello,
  begin: GraphSnapshotProtocol.IBegin,
  commit: GraphSnapshotProtocol.ICommit,
  manifest: readonly IBulkGraphSession.IShard[],
  shards: ReadonlyMap<string, GraphSnapshotProtocol.IShard>,
  prior: IBulkGraphSession.ISnapshot | undefined,
): GraphSnapshotProtocol.Frame[] {
  const frames: GraphSnapshotProtocol.Frame[] = [hello, begin];
  if (begin.baseGeneration === undefined) {
    for (const entry of manifest) {
      frames.push({
        type: "upsertShard",
        digest: entry.digest,
        shard: shards.get(entry.key)!,
      });
    }
  } else {
    const old = new Map(
      prior!.protocol!.shards.map((entry) => [entry.key, entry.digest]),
    );
    for (const entry of manifest) {
      if (old.get(entry.key) === entry.digest) continue;
      frames.push({
        type: "upsertShard",
        digest: entry.digest,
        shard: shards.get(entry.key)!,
      });
    }
  }
  frames.push(commit);
  return frames;
}

interface IContext {
  root: string;
  universe: string;
  shard: ICppGraphSnapshot.IShard;
  graph: ICppGraphSnapshot.ITU;
  language: GraphLanguage;
  target: string;
  nodes: Map<string, ISamchonGraphNode>;
  ids: Map<string, string>;
  files: Map<string, string>;
  edges: ISamchonGraphEdge[];
  unresolved: ISamchonGraphUnresolved[];
  canonical: ICanonical;
}

/**
 * What the whole walk has already made of an entity, rather than this shard.
 *
 * A node id is a digest of the coordinates the entity has -- and since those
 * coordinates no longer include the unit that read it, a header's declaration
 * hashes to the same id in every unit that includes it. Computing it again
 * per unit was ninety-six percent of a C walk: four hundred and sixty-nine
 * units named six and a half million nodes, and all but forty thousand of
 * them were the same declarations seen again from the next unit.
 */
interface ICanonical {
  nodes: Map<string, ISamchonGraphNode>;
  edges: Map<string, Map<string, Set<GraphEdgeKind>>>;
  /** How many distinct relationships the walk has drawn. The edge map is
   * nested by endpoint, so its size counts subjects rather than edges. */
  drawn: { count: number };

  /** Producer key to node id, for entities whose id does not depend on a unit. */
  ids: Map<string, string>;
}

/**
 * One shard's graph, without the coverage matrix.
 *
 * Everything here is derived from the shard and the one envelope field a
 * shard needs, so it can run before the generation is complete. The matrix
 * names every language the generation serves, which is not known until the
 * last shard has arrived, so `coverageMatrix` supplies it afterwards.
 */
/**
 * The exhaustive matrix one shard publishes, and the gaps it admits to.
 *
 * Every language the generation serves gets a row for every family, and a
 * family this shard's own language does not produce is `unsupported` rather
 * than absent. A `partial` family has to name at least one site it could
 * not resolve; where the producer claimed partial and the walk found
 * nothing to point at, the shard says so against its own main file rather
 * than publishing a partial nobody can check.
 *
 * Both are properties of the generation rather than of one shard -- the
 * language set is not settled until the last shard has arrived -- which is
 * why neither is part of adapting one.
 */
function completeCoverage(
  root: string,
  shard: GraphSnapshotProtocol.IShard,
  source: IPendingCoverage,
  universe: string,
  snapshotLanguages: readonly GraphLanguage[],
): void {
  const language = shard.languages[0]!;
  const byFamily = new Map(source.rows.map((row) => [row.family, row.state]));
  const advertised = new Set(CPP_CLANG_FACTS);
  shard.coverage = snapshotLanguages.flatMap((coverageLanguage) =>
    GRAPH_EDGE_KINDS.map((family) => ({
      provider: CPP_CLANG_PROVIDER,
      language: coverageLanguage,
      target: shard.target,
      family,
      state:
        coverageLanguage === language && advertised.has(family)
          ? (byFamily.get(family)! as ISamchonGraphCoverage["state"])
          : "unsupported",
    })),
  );
  const fallbackEvidence = evidenceOf(root, {
    file: source.mainFileUri,
    startLine: 0,
    startColumn: 0,
    endLine: 0,
    endColumn: 0,
  });
  for (const row of shard.coverage) {
    if (
      row.language !== language ||
      row.state !== "partial" ||
      shard.unresolved.some((site) => site.family === row.family)
    ) {
      continue;
    }
    shard.unresolved.push({
      provider: CPP_CLANG_PROVIDER,
      language,
      target: shard.target,
      universe,
      family: row.family,
      evidence: fallbackEvidence,
      reason: "provider-gap",
    });
  }
}

/** What a shard still owes its coverage matrix once the languages settle. */
interface IPendingCoverage {
  rows: ICppGraphSnapshot.IShard["coverage"];
  mainFileUri: string;
}

/**
 * The compilation database, as an input every unit in a generation depends on.
 *
 * It is not a source any translation unit consumes, so no producer reports it
 * among a unit's files -- and yet it is the file that decides what every unit
 * is: which commands exist, with which flags, for which targets. A project
 * whose database is rewritten is a project that may build differently, and a
 * generation that does not carry it cannot say so. Every other language's
 * build file is already in its manifest for the same reason.
 *
 * Read once per walk, so every shard agrees on it -- the protocol refuses a
 * generation whose shards disagree about a source.
 */
function compilationDatabaseSource(
  root: string,
): IBulkGraphSession.ISourceDigest & { file: string } | undefined {
  for (const candidate of [
    path.join(root, "compile_commands.json"),
    path.join(root, "build", "compile_commands.json"),
  ]) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(candidate);
    } catch {
      continue;
    }
    // Refused rather than digested when it is not a database.
    //
    // A project whose build file cannot be read is a project this provider
    // cannot describe: the commands are what every unit is, and a generation
    // published from the last ones that parsed would describe a checkout
    // nobody has. The producer would keep serving those commands quite
    // happily -- it is holding what it last loaded -- so the refusal has to
    // come from the side that reads the file.
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new Error(
        `C/C++ clang graph: compilation database is not valid JSON: ${candidate}`,
      );
    }
    // A file that parses but is not a list of commands is not this project's
    // database at all, and the next candidate may be: that is how the client
    // that watches these paths already reads them.
    if (!Array.isArray(parsed)) continue;
    const digest = createHash("sha256").update(bytes).digest("hex");
    return { file: path.normalize(candidate), checkerDigest: digest, diskDigest: digest };
  }
  return undefined;
}

function adaptShard(
  root: string,
  universe: string,
  shard: ICppGraphSnapshot.IShard,
  canonical: ICanonical,
  database: (IBulkGraphSession.ISourceDigest & { file: string }) | undefined,
): GraphSnapshotProtocol.IShard {
  const graph = shard.graph;
  const language = graph.language as GraphLanguage;
  const context: IContext = {
    root,
    universe,
    shard,
    graph,
    language,
    target: `${graph.targetTriple}#${graph.commandDigest}`,
    nodes: new Map(),
    ids: new Map(),
    files: new Map(),
    edges: [],
    unresolved: [],
    canonical,
  };
  for (const source of graph.sources) fileNode(context, source.uri);
  for (const symbol of graph.symbols) symbolNode(context, symbol);
  for (const macro of graph.macros) macroNode(context, macro);
  for (const module of graph.modules) {
    moduleNode(context, module.name, module.evidence);
  }

  for (const symbol of graph.symbols) {
    const id = endpoint(context, symbol.id);
    const owner =
      symbol.ownerUsr === "" ? undefined : endpoint(context, symbol.ownerUsr);
    const location = preferredRange(symbol);
    addEdge(
      context,
      owner ?? fileNode(context, location.file),
      id,
      "contains",
      location,
    );
    if (symbol.exported) {
      addEdge(
        context,
        fileNode(context, location.file),
        id,
        "exports",
        location,
      );
    }
  }
  for (const include of graph.includes) {
    addEdge(
      context,
      fileNode(context, include.source),
      fileNode(context, include.target),
      "imports",
      include.evidence,
    );
  }
  for (const module of graph.modules) {
    addEdge(
      context,
      fileNode(context, module.evidence.file || graph.mainFileUri),
      moduleNode(context, module.name, module.evidence),
      "imports",
      module.evidence,
    );
  }
  for (const occurrence of graph.occurrences) {
    adaptOccurrence(context, occurrence);
  }
  // Occurrences carry the exact use-site span. Add them before the coarser
  // semantic relation lane so endpoint-pair deduplication retains that span.
  for (const relation of graph.relations) adaptRelation(context, relation);
  for (const macro of graph.macros) adaptMacro(context, macro);

  const coverage: ISamchonGraphCoverage[] = [];
  const diagnostics: ISamchonGraphDiagnostic[] = graph.diagnostics.map(
    (row) => ({
      file: graphFile(root, row.range.file),
      line: row.range.file === "" ? 0 : row.range.startLine + 1,
      column: row.range.file === "" ? 0 : row.range.startColumn + 1,
      code: row.code,
      message: row.message,
      severity: row.severity as ISamchonGraphDiagnostic["severity"],
    }),
  );
  return {
    key: graphKey(shard.key),
    target: context.target,
    languages: [language],
    nodes: [...context.nodes.values()].sort((left, right) =>
      compareText(left.id, right.id),
    ),
    edges: context.edges.sort(compareEdge),
    diagnostics,
    coverage,
    unresolved: context.unresolved,
    sources: [
      ...graph.sources.map((source) => ({
        file: sourceFile(root, source.uri),
        checkerDigest: source.digest,
        diskDigest: source.diskDigest,
      })),
      // The file that says what this unit is. No producer reports it among a
      // unit's sources because no unit consumes it, and a generation that
      // leaves it out cannot say that a project's commands were rewritten.
      ...(database === undefined ? [] : [database]),
    ],
  };
}

/**
 * The build coordinates that are part of a C/C++ node's identity.
 *
 * A function declared in a header is one entity, however many translation
 * units include that header. Scoping every node by the unit that happened to
 * read it made the same function a different node in each of them: on a
 * project whose headers are included everywhere, the graph held one copy of
 * every header's facts per including unit, and a walk ran out of heap before
 * it could commit a generation.
 *
 * So the coordinates are the ones the entity actually has -- the target it is
 * built for and the file it is written in. Entities that share a file are
 * separated by `native.key`, the producer's own symbol id, which already adds
 * a declaring-file or owner coordinate wherever a raw USR would collide.
 *
 * Only an entity with no file at all keeps the unit in its scope, because
 * nothing else places it. Linkage is not the test: the parameters and members
 * a header declares have no linkage and are still one declaration, and making
 * them per-unit gave libuv six and a half million nodes for a project that
 * declares a small fraction of that.
 */
function scopeOf(
  context: IContext,
  file: string,
  unitScoped: boolean,
): IGraphSemanticIdentity.IScope {
  return {
    target: context.graph.targetTriple,
    ...(unitScoped
      ? {
          translationUnit: graphFile(context.root, context.graph.mainFileUri),
        }
      : {}),
    ...(file === "" ? {} : { document: file }),
  };
}

/**
 * The instance this walk already made for an entity, if it made one.
 *
 * A cached instance is reused whole: the id is a digest, and digesting the
 * same coordinates again to arrive at the same string is the work this
 * avoids. What one unit knows and the instance does not is merged into it
 * rather than kept as a second node, so a unit that compiled a definition
 * still contributes where the implementation is without anyone building a
 * second copy of the entity.
 */
/**
 * The key an entity is remembered under for the rest of the walk.
 *
 * It carries exactly the coordinates the node id is derived from, because
 * anything the id separates the cache has to separate too. The same header
 * compiled as C and as C++ declares two entities, not one, and a cache keyed
 * on the producer's symbol alone would hand a C node to a C++ unit.
 */
function canonicalKey(
  context: IContext,
  lane: string,
  file: string,
  native: string,
): string {
  return [lane, context.language, context.graph.targetTriple, file, native].join(
    String.fromCharCode(0),
  );
}

function reuse(
  context: IContext,
  key: string | undefined,
  implementation?: ISamchonGraphEvidence,
): string | undefined {
  if (key === undefined) return undefined;
  const id = context.canonical.ids.get(key);
  if (id === undefined) return undefined;
  const node = context.canonical.nodes.get(id)!;
  // What this unit knows and the instance does not is merged into it. The
  // unit that compiled a definition knows where the implementation is and
  // the units that only included the declaration do not, and any of them may
  // have come first; adding it to the copy they all point at means every
  // shard tells the same story without any of them holding a second node.
  if (implementation !== undefined && node.implementation === undefined)
    node.implementation = implementation;
  // Not added to this shard. A shard lists the entities it derived, not every
  // entity it saw: an entity belongs to the generation once, and the shard
  // that first derived it is the one that carries it. Listing every naming
  // instead made 469 shards carry six and a half million entries for the
  // thirty-eight thousand entities a project has, which is what the walk
  // spent its time building and the commit spent its time digesting.
  return id;
}

/** Remember an entity's instance for the units that name it next. */
function remember(
  context: IContext,
  key: string | undefined,
  id: string,
  node: ISamchonGraphNode,
): void {
  if (key === undefined) return;
  context.canonical.ids.set(key, id);
  context.canonical.nodes.set(id, node);
}

function symbolNode(
  context: IContext,
  symbol: ICppGraphSnapshot.ISymbol,
): string {
  const range = preferredRange(symbol);
  const file = graphFile(context.root, range.file || context.graph.mainFileUri);
  // Identity follows the declaration, not the preferred range. A function
  // declared in a header and defined in one source file is one entity: the
  // unit that compiles the definition and every unit that only sees the
  // declaration have to arrive at the same node, and they only do if the
  // coordinate is the one they agree on.
  const declared = graphFile(
    context.root,
    symbol.declaration.file ||
      symbol.definition.file ||
      context.graph.mainFileUri,
  );
  const kind = nodeKind(symbol.kind);
  const display = symbol.qualifiedName || symbol.name;
  // An entity with a file of its own is that file's, not the reading unit's.
  //
  // Linkage was the rule here before, and it was the wrong one: the
  // parameters and members a header declares have no linkage, so every unit
  // that included the header got its own copy of each. On libuv that was six
  // and a half million nodes for a project that declares a small fraction of
  // that, and it is why a walk cost minutes and a generation could not be
  // serialized at all.
  //
  // What separates two entities that share a file is the producer's own
  // symbol id, which already adds a declaring-file or owner coordinate
  // wherever a raw USR would collide -- so the file and that id are the
  // coordinates, and the unit is not one of them. Only an entity with no file
  // at all falls back to the unit that saw it, because nothing else places
  // it.
  const key =
    (symbol.declaration.file || symbol.definition.file) === ""
      ? undefined
      : canonicalKey(context, "symbol", declared, symbol.id);
  const implementation =
    validRange(symbol.definition) &&
    symbol.definition.file !== symbol.declaration.file
      ? evidenceOf(context.root, symbol.definition)
      : undefined;
  const known = reuse(context, key, implementation);
  if (known !== undefined) {
    context.ids.set(symbol.id, known);
    return known;
  }
  const id = semanticGraphNodeId(
    {
      version: 2,
      language: context.language,
      symbol: symbol.id,
      role: kind,
      native: { key: symbol.id, stability: "semantic" },
      scope: scopeOf(context, declared, key === undefined),
      stability: "persistent",
    },
    display,
  );
  const node: ISamchonGraphNode = {
    id,
    kind,
    language: context.language,
    name: symbol.name,
    ...(symbol.qualifiedName !== "" && symbol.qualifiedName !== symbol.name
      ? { qualifiedName: symbol.qualifiedName }
      : {}),
    file,
    external: isExternal(file),
    exported: symbol.exported,
    ...(symbol.signature === "" ? {} : { signature: symbol.signature }),
    ...(validRange(range) ? { evidence: evidenceOf(context.root, range) } : {}),
    // Where it is implemented, when that is somewhere other than where it is
    // declared. A unit that compiles a definition knows this and a unit that
    // only included the declaration does not, and they publish the same node.
    ...(implementation === undefined ? {} : { implementation }),
    ...(symbol.attributes.length === 0
      ? {}
      : {
          decorators: symbol.attributes.map((attribute) => ({
            name: attribute.name,
            arguments: [],
          })),
        }),
  };
  context.ids.set(symbol.id, id);
  context.nodes.set(id, node);
  remember(context, key, id, node);
  return id;
}

function macroNode(context: IContext, macro: ICppGraphSnapshot.IMacro): string {
  const found = context.ids.get(macro.id);
  if (found !== undefined) return found;
  const spelled =
    macro.definition.file || macro.spelling.file || macro.expansion.file;
  const file = graphFile(context.root, spelled || context.graph.mainFileUri);
  // Cacheable when the macro has a file of its own. One that does not falls
  // back to the unit's main file, and then its id is this unit's alone.
  const key =
    spelled === ""
      ? undefined
      : canonicalKey(context, "macro", file, macro.id);
  const known = reuse(context, key);
  if (known !== undefined) {
    context.ids.set(macro.id, known);
    return known;
  }
  const id = semanticGraphNodeId(
    {
      version: 2,
      language: context.language,
      symbol: macro.id,
      role: "variable",
      native: { key: macro.id, stability: "semantic" },
      scope: scopeOf(context, file, false),
      stability: "persistent",
    },
    macro.name,
  );
  const node: ISamchonGraphNode = {
    id,
    kind: "variable",
    language: context.language,
    name: macro.name,
    file,
    external: isExternal(file),
    ...(validRange(macro.definition)
      ? { evidence: evidenceOf(context.root, macro.definition) }
      : {}),
  };
  context.ids.set(macro.id, id);
  context.nodes.set(id, node);
  remember(context, key, id, node);
  return id;
}

function moduleNode(
  context: IContext,
  name: string,
  range: ICppGraphSnapshot.IRange,
): string {
  const raw = `module:${name}`;
  const found = context.ids.get(raw);
  if (found !== undefined) return found;
  const file = graphFile(context.root, range.file || context.graph.mainFileUri);
  // Cacheable when the evidence names a file. Without one the module is
  // placed in whichever unit saw it, and that placement is not shared.
  const key =
    range.file === ""
      ? undefined
      : canonicalKey(context, "module", file, raw);
  const known = reuse(context, key);
  if (known !== undefined) {
    context.ids.set(raw, known);
    return known;
  }
  const id = semanticGraphNodeId(
    {
      version: 2,
      language: context.language,
      symbol: raw,
      role: "module",
      native: { key: raw, stability: "semantic" },
      scope: scopeOf(context, file, false),
      stability: "persistent",
    },
    name,
  );
  const node: ISamchonGraphNode = {
    id,
    kind: "module",
    language: context.language,
    name,
    file,
    external: isExternal(file),
  };
  context.ids.set(raw, id);
  context.nodes.set(id, node);
  remember(context, key, id, node);
  return id;
}

function fileNode(context: IContext, uri: string): string {
  const key = uri || context.graph.mainFileUri;
  const found = context.files.get(key);
  if (found !== undefined) return found;
  const file = graphFile(context.root, key);
  // A file is the same file in every unit that read it, so its node is made
  // once for the walk.
  const shared = canonicalKey(context, "file", file, key);
  const known = reuse(context, shared);
  if (known !== undefined) {
    context.files.set(key, known);
    return known;
  }
  const id = semanticGraphNodeId(
    {
      version: 2,
      language: context.language,
      symbol: `file:${key}`,
      role: "file",
      native: { key, stability: "semantic" },
      scope: scopeOf(context, file, false),
      stability: "persistent",
    },
    file,
  );
  const node: ISamchonGraphNode = {
    id,
    kind: "file",
    language: context.language,
    name: path.posix.basename(file),
    qualifiedName: file,
    file,
    external: isExternal(file),
  };
  context.files.set(key, id);
  context.nodes.set(id, node);
  remember(context, shared, id, node);
  return id;
}

function endpoint(context: IContext, raw: string): string {
  const found = context.ids.get(raw);
  if (found !== undefined) return found;
  const name = raw;
  // An unresolved endpoint is named the same way by every unit that mentions
  // it, and it carries no file, so nothing about it is this unit's.
  const shared = canonicalKey(context, "external", "", raw);
  const known = reuse(context, shared);
  if (known !== undefined) {
    context.ids.set(raw, known);
    return known;
  }
  const id = semanticGraphNodeId(
    {
      version: 2,
      language: context.language,
      symbol: name,
      role: "external_symbol",
      native: { key: name, stability: "semantic" },
      scope: scopeOf(context, "", false),
      stability: "persistent",
    },
    name,
  );
  const node: ISamchonGraphNode = {
    id,
    kind: "external_symbol",
    language: context.language,
    name,
    file: "bundled:///clang/external",
    external: true,
  };
  context.ids.set(raw, id);
  context.nodes.set(id, node);
  remember(context, shared, id, node);
  return id;
}

function adaptRelation(
  context: IContext,
  relation: ICppGraphSnapshot.IRelation,
): void {
  const subject = endpoint(context, relation.subjectId);
  const object = endpoint(context, relation.objectId);
  if (relation.roles & (ROLE.childOf | ROLE.containedBy)) {
    addEdge(context, object, subject, "contains", relation.evidence);
  }
  if (relation.roles & ROLE.baseOf) {
    addEdge(context, object, subject, "extends", relation.evidence);
  }
  if (relation.roles & ROLE.extendedBy) {
    addEdge(context, object, subject, "extends", relation.evidence);
  }
  if (relation.roles & ROLE.overrideOf) {
    addEdge(context, subject, object, "overrides", relation.evidence);
  }
  if (relation.roles & ROLE.calledBy) {
    addEdge(context, object, subject, "calls", relation.evidence);
  }
  if (relation.roles & ROLE.accessorOf) {
    addEdge(context, subject, object, "accesses", relation.evidence);
  }
  if (relation.roles & ROLE.specializationOf) {
    addEdge(context, subject, object, "instantiates", relation.evidence);
  }
}

function adaptOccurrence(
  context: IContext,
  occurrence: ICppGraphSnapshot.IOccurrence,
): void {
  const target = endpoint(context, occurrence.id);
  const range = validRange(occurrence.expansion)
    ? occurrence.expansion
    : occurrence.spelling;
  const owner =
    occurrence.containerId === ""
      ? fileNode(context, range.file)
      : endpoint(context, occurrence.containerId);
  if (occurrence.roles & ROLE.call) {
    addEdge(context, owner, target, "calls", range);
  }
  if (occurrence.roles & ROLE.call && occurrence.targetKind === 23) {
    addEdge(context, owner, target, "instantiates", range);
  }
  if (occurrence.roles & (ROLE.read | ROLE.write)) {
    addEdge(context, owner, target, "accesses", range);
  }
  if (occurrence.roles & ROLE.reference) {
    addEdge(context, owner, target, "references", range);
  }
  if (
    occurrence.roles & (ROLE.reference | ROLE.nameReference) &&
    TYPE_KINDS.has(occurrence.targetKind)
  ) {
    addEdge(context, owner, target, "type_ref", range);
  }
  if (occurrence.roles & ROLE.dynamic && validRange(range)) {
    context.unresolved.push({
      provider: CPP_CLANG_PROVIDER,
      language: context.language,
      target: context.target,
      universe: context.universe,
      family: "dispatches",
      evidence: evidenceOf(context.root, range),
      reason: "dynamic",
      candidates: [target],
    });
  }
}

function adaptMacro(context: IContext, macro: ICppGraphSnapshot.IMacro): void {
  const target = macroNode(context, macro);
  const range = validRange(macro.expansion) ? macro.expansion : macro.spelling;
  const definitionFile = macro.definition.file || context.graph.mainFileUri;
  if (macro.roles & ROLE.reference) {
    addEdge(
      context,
      fileNode(context, range.file || definitionFile),
      target,
      "references",
      range,
    );
  }
  if (macro.roles & (ROLE.declaration | ROLE.definition)) {
    addEdge(
      context,
      fileNode(context, definitionFile),
      target,
      "contains",
      macro.definition,
    );
  }
}

function addEdge(
  context: IContext,
  from: string,
  to: string,
  kind: GraphEdgeKind,
  range: ICppGraphSnapshot.IRange,
): void {
  if (from === to) return;
  // Remembered as a pair rather than under a joined key. An endpoint id is a
  // hundred characters and a unit draws one edge per occurrence it saw, so
  // building a three-hundred-character string to ask whether a relationship
  // is already known cost more than the answer.
  //
  // The same relationship between the same two entities is drawn by every
  // unit that sees both; after the first there is nothing new in it, and the
  // shard that drew it is the one that carries it.
  let byTo = context.canonical.edges.get(from);
  if (byTo === undefined) {
    byTo = new Map();
    context.canonical.edges.set(from, byTo);
  }
  let kinds = byTo.get(to);
  if (kinds === undefined) {
    kinds = new Set();
    byTo.set(to, kinds);
  }
  if (kinds.has(kind)) return;
  kinds.add(kind);
  context.canonical.drawn.count += 1;
  context.edges.push({
    from,
    to,
    kind,
    ...(validRange(range) ? { evidence: evidenceOf(context.root, range) } : {}),
  });
}

function preferredRange(
  symbol: ICppGraphSnapshot.ISymbol,
): ICppGraphSnapshot.IRange {
  return validRange(symbol.definition) ? symbol.definition : symbol.declaration;
}

function evidenceOf(
  root: string,
  range: ICppGraphSnapshot.IRange,
): ISamchonGraphEvidence {
  return {
    file: graphFile(root, range.file),
    startLine: range.startLine + 1,
    startCol: range.startColumn + 1,
    endLine: range.endLine + 1,
    endCol: range.endColumn + 1,
  };
}

/**
 * Repository-relative paths, remembered by the URI they came from.
 *
 * A project has as many source files as it has files, and a generation names
 * them once per fact: parsing a `file:` URI and relativising it is the same
 * answer every time, and on libuv it was asked six and a half million times
 * for a thousand distinct files. The map is keyed by root as well, because a
 * process may hold graphs for more than one checkout.
 */
const graphFiles = new Map<string, string>();

function graphFile(root: string, source: string): string {
  if (source === "") return "";
  const key = `${root}${String.fromCharCode(0)}${source}`;
  const known = graphFiles.get(key);
  if (known !== undefined) return known;
  const answer = deriveGraphFile(root, source);
  graphFiles.set(key, answer);
  return answer;
}

function deriveGraphFile(root: string, source: string): string {
  assertSupportedSource(source);
  let absolute = source;
  if (source.startsWith("file:")) {
    absolute = fileURLToPath(source);
  }
  if (!path.isAbsolute(absolute)) return absolute.replaceAll("\\", "/");
  const relative = path.relative(root, absolute).replaceAll("\\", "/");
  /* c8 ignore next -- only Windows cross-volume or UNC sources reach this guard. */
  if (path.isAbsolute(relative)) return externalGraphFile(absolute);
  return relative;
}

/* c8 ignore start -- only Windows cross-volume or UNC sources reach this helper. */
function externalGraphFile(source: string): string {
  const normalized = path.normalize(source);
  const identity = normalized.toLowerCase();
  const basename = encodeURIComponent(path.basename(normalized) || "source");
  return `bundled:///clang/filesystem/${sha256(identity)}/${basename}`;
}
/* c8 ignore stop */

/** Absolute host paths, remembered the same way and for the same reason. */
const sourceFiles = new Map<string, string>();

function sourceFile(root: string, source: string): string {
  const key = `${root}${String.fromCharCode(0)}${source}`;
  const known = sourceFiles.get(key);
  if (known !== undefined) return known;
  const answer = deriveSourceFile(root, source);
  sourceFiles.set(key, answer);
  return answer;
}

function deriveSourceFile(root: string, source: string): string {
  assertSupportedSource(source);
  if (source.startsWith("bundled:///")) return source;
  if (source.startsWith("file:")) {
    return path.normalize(fileURLToPath(source));
  }
  return path.normalize(
    path.isAbsolute(source) ? source : path.resolve(root, source),
  );
}

function assertSupportedSource(source: string): void {
  /* c8 ignore next 3 -- assertGraph validates every native source before adaptation. */
  if (!isSupportedSource(source)) {
    throw new Error(`unsupported C/C++ graph source URI: ${source}`);
  }
}

/**
 * Whether a producer's source string is one this consumer can place,
 * remembered by the string itself.
 *
 * Every range on every fact is checked, and a translation unit's facts name
 * the same few hundred files over and over: parsing a `file:` URI to find out
 * whether it is absolute is the same answer every time, and it was six
 * percent of a walk.
 */
const supportedSources = new Map<string, boolean>();

function isSupportedSource(source: string): boolean {
  const known = supportedSources.get(source);
  if (known !== undefined) return known;
  const answer = deriveSupportedSource(source);
  supportedSources.set(source, answer);
  return answer;
}

function deriveSupportedSource(source: string): boolean {
  if (source.startsWith("bundled:///")) {
    const relative = source.slice("bundled:///".length);
    return (
      relative !== "" &&
      !relative.includes("\\") &&
      path.posix.normalize(relative) === relative &&
      relative
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== "..")
    );
  }
  if (source.startsWith("file:")) {
    try {
      return path.isAbsolute(fileURLToPath(source));
    } catch {
      return false;
    }
  }
  return path.isAbsolute(source) || !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(source);
}

function graphKey(raw: string): string {
  return `cpp-shard:${sha256(raw)}`;
}

function isExternal(file: string): boolean {
  return file.startsWith("../") || file.startsWith("bundled:///");
}

function validRange(range: ICppGraphSnapshot.IRange): boolean {
  return range.file !== "";
}

function nodeKind(kind: number): GraphNodeKind {
  return NODE_KINDS[kind] ?? "external_symbol";
}

const NODE_KINDS: Record<number, GraphNodeKind> = {
  1: "module",
  2: "namespace",
  3: "namespace",
  4: "variable",
  5: "file",
  6: "enum",
  7: "class",
  8: "class",
  9: "interface",
  10: "type",
  11: "type",
  12: "type",
  13: "function",
  14: "variable",
  15: "field",
  16: "field",
  17: "method",
  18: "method",
  19: "method",
  20: "property",
  21: "property",
  22: "property",
  23: "constructor",
  24: "method",
  25: "method",
  26: "parameter",
  27: "type",
  28: "type",
  29: "type",
  30: "parameter",
  31: "interface",
};

function helloOf(
  raw: ICppGraphSnapshot,
  shards: ReadonlyMap<string, IRetainedShard>,
  selectedLanguages: ReadonlySet<GraphLanguage>,
): GraphSnapshotProtocol.IHello {
  const languages = new Set<GraphLanguage>();
  for (const shard of shards.values()) {
    if (
      (shard.graph.language === "c" || shard.graph.language === "cpp") &&
      selectedLanguages.has(shard.graph.language)
    ) {
      languages.add(shard.graph.language);
    }
  }
  return {
    type: "hello",
    protocolVersion: 1,
    schemaVersion: 1,
    producerSchemaVersion: raw.schemaVersion,
    provider: CPP_CLANG_PROVIDER,
    producer: raw.producer.name,
    producerVersion: `${raw.producer.version} (${raw.producer.commit})`,
    compilerVersion: raw.producer.version,
    languages: [...languages].sort(compareText),
    authority: "compiler",
    supportedFacts: [...CPP_CLANG_FACTS],
    capabilities: [...CAPABILITIES],
  };
}

function factsOf(
  hello: GraphSnapshotProtocol.IHello,
  begin: GraphSnapshotProtocol.IBegin,
  shards: readonly GraphSnapshotProtocol.IShard[],
): Pick<
  IBulkGraphSession.ISnapshot,
  | "languages"
  | "nodes"
  | "edges"
  | "diagnostics"
  | "coverage"
  | "unresolved"
  | "provenance"
> {
  // Folded, not concatenated: an entity named by every unit that read its
  // header is one node, and this path has to arrive at the same graph the
  // store's streaming path does.
  const folded = GraphSnapshotProtocol.fold(shards);
  return {
    languages: [...hello.languages],
    nodes: folded.nodes,
    edges: folded.edges,
    diagnostics: folded.diagnostics,
    coverage: shards.flatMap((shard) => shard.coverage),
    unresolved: folded.unresolved,
    provenance: {
      provider: hello.provider,
      authority: hello.authority,
      facts: [...hello.supportedFacts],
      schemaVersion: hello.producerSchemaVersion,
      tool: hello.producer,
      toolVersion: hello.producerVersion,
      compilerVersion: hello.compilerVersion,
      protocolVersion: hello.protocolVersion,
      universe: begin.universe,
      capabilities: [...hello.capabilities],
    },
  };
}

function assertSnapshot(
  raw: ICppGraphSnapshot,
  commit: string,
  shards: number,
): void {
  if (
    raw === null ||
    typeof raw !== "object" ||
    raw.protocolVersion !== 1 ||
    raw.schemaVersion !== 1
  ) {
    throw new Error("C/C++ clang graph: unsupported producer protocol/schema");
  }
  if (
    raw.producer?.name !== "samchon-clangd" ||
    typeof raw.producer.version !== "string" ||
    typeof raw.producer.commit !== "string" ||
    !raw.producer.commit.includes(commit) ||
    raw.producer.version === ""
  ) {
    throw new Error("C/C++ clang graph: producer identity/commit mismatch");
  }
  if (
    !SHA256.test(raw.universe?.digest) ||
    !SHA256.test(raw.generation) ||
    !Number.isSafeInteger(raw.sequence) ||
    raw.sequence < 1 ||
    !Array.isArray(raw.upserts) ||
    !Array.isArray(raw.deletes) ||
    !Array.isArray(raw.manifest) ||
    !isRecord(raw.page) ||
    !isRecord(raw.phases)
  ) {
    throw new Error("C/C++ clang graph: malformed generation envelope");
  }
  if (raw.baseGeneration !== null && !SHA256.test(raw.baseGeneration)) {
    throw new Error("C/C++ clang graph: malformed base generation");
  }
  if (
    !isRecord(raw.universe) ||
    !canonicalStrings(raw.universe.targets, false) ||
    raw.universe.targets.length === 0 ||
    !canonicalStrings(raw.universe.workspaceRoots, true) ||
    !canonicalStrings(raw.universe.toolchains, false) ||
    !canonicalStrings(raw.universe.configurations, false)
  ) {
    throw new Error("C/C++ clang graph: malformed universe");
  }
  if (!canonicalStrings(raw.deletes, false)) {
    throw new Error("C/C++ clang graph: malformed delete set");
  }
  if (
    !nonnegativeInteger(raw.page.offset) ||
    !nonnegativeInteger(raw.page.count) ||
    !nonnegativeInteger(raw.page.total) ||
    raw.page.offset !== 0 ||
    // Against what the generation is said to hold, not against what this
    // envelope carries: a streamed generation arrives with its shards
    // separately, and its envelope has none.
    raw.page.count !== shards ||
    raw.page.total !== shards ||
    raw.page.nextCursor !== null
  ) {
    throw new Error("C/C++ clang graph: malformed assembled page");
  }
  const manifestKeys = new Set<string>();
  for (const entry of raw.manifest) {
    if (
      !isRecord(entry) ||
      typeof entry.key !== "string" ||
      entry.key === "" ||
      manifestKeys.has(entry.key) ||
      typeof entry.digest !== "string" ||
      !SHA256.test(entry.digest)
    ) {
      throw new Error("C/C++ clang graph: malformed native manifest");
    }
    manifestKeys.add(entry.key);
  }
  if (
    !nonnegativeInteger(raw.phases.validationMillis) ||
    !nonnegativeInteger(raw.phases.semanticMillis) ||
    !nonnegativeInteger(raw.phases.shardMillis) ||
    !nonnegativeInteger(raw.phases.encodeMillis) ||
    !nonnegativeInteger(raw.phases.totalMillis) ||
    typeof raw.phases.cacheHit !== "boolean" ||
    raw.phases.totalMillis !==
      raw.phases.validationMillis +
        raw.phases.semanticMillis +
        raw.phases.shardMillis +
        raw.phases.encodeMillis
  ) {
    throw new Error("C/C++ clang graph: malformed phase telemetry");
  }
}

function assertShard(
  shard: ICppGraphSnapshot.IShard,
  expectedProducerFingerprint: string,
): void {
  if (
    !isRecord(shard) ||
    typeof shard.key !== "string" ||
    shard.key === "" ||
    typeof shard.source !== "string" ||
    shard.source === "" ||
    typeof shard.configuration !== "string" ||
    !SHA256.test(shard.digest) ||
    !SHA256.test(shard.checkerDigest) ||
    !SHA256.test(shard.interfaceFingerprint) ||
    !Array.isArray(shard.coverage) ||
    !isRecord(shard.graph) ||
    shard.configuration !== shard.graph.commandDigest
  ) {
    throw new Error(`C/C++ clang graph: malformed shard ${shard.key}`);
  }
  assertGraph(shard.graph, shard.key);
  if (shard.graph.producerFingerprint !== expectedProducerFingerprint) {
    throw new Error(
      `C/C++ clang graph: compiler fingerprint mismatch ${shard.key}`,
    );
  }
  const source = shard.graph.sources.find(
    (entry) => entry.uri === shard.graph.mainFileUri,
  );
  if (
    source?.digest !== shard.checkerDigest ||
    shard.source !== shard.graph.mainFile
  ) {
    throw new Error(`C/C++ clang graph: mismatched main source ${shard.key}`);
  }
  // Rebuilt from the transmitted body, in the pinned producer's own assembly
  // order, so the shard the consumer holds is tied to the digest the manifest
  // names it by. That tie is what the resident delta rests on: a shard whose
  // digest still matches its stored one is skipped without being read again.
  //
  // The producer composes it in three steps and so does this. Recomputing only
  // the last would leave the interface and body terms unchecked, and they are
  // where the payload actually lives — the outer digest carries nothing of the
  // symbols, occurrences or relations except through them.
  if (interfaceFingerprintOf(shard.graph) !== shard.interfaceFingerprint) {
    throw new Error(
      `C/C++ clang graph: interface fingerprint mismatch ${shard.key}`,
    );
  }
  const expected = sha256(
    [
      shard.key,
      shard.checkerDigest,
      shard.interfaceFingerprint,
      bodyDigestOf(shard.graph),
      diskMaterialOf(shard.graph),
    ].join("\n"),
  );
  if (expected !== shard.digest) {
    throw new Error(`C/C++ clang graph: shard digest mismatch ${shard.key}`);
  }
  // A translation unit that failed to compile is refused rather than
  // published — but only once its integrity is proved. A reader has to be
  // able to tell a corrupt payload from a body that compiled with errors, and
  // checking this first would report every such body as malformed. The body
  // digest covers the flag, so a producer cannot clear it in transit either.
  if (shard.graph.hadErrors) {
    throw new Error(
      `C/C++ clang graph: shard reports a failed translation unit ${shard.key}`,
    );
  }
  const families = new Set<string>();
  for (const row of shard.coverage) {
    if (
      families.has(row.family) ||
      !GRAPH_EDGE_KINDS.includes(row.family as GraphEdgeKind) ||
      !["complete", "partial", "unsupported"].includes(row.state)
    ) {
      throw new Error(`C/C++ clang graph: invalid coverage ${shard.key}`);
    }
    families.add(row.family);
  }
  if (families.size !== GRAPH_EDGE_KINDS.length) {
    throw new Error(`C/C++ clang graph: incomplete coverage ${shard.key}`);
  }
}

function assertGraph(graph: ICppGraphSnapshot.ITU, key: string): void {
  if (
    typeof graph.producerFingerprint !== "string" ||
    !SHA256.test(graph.producerFingerprint) ||
    typeof graph.mainFileUri !== "string" ||
    graph.mainFileUri === "" ||
    !isSupportedSource(graph.mainFileUri) ||
    typeof graph.mainFile !== "string" ||
    graph.mainFile === "" ||
    !isSupportedSource(graph.mainFile) ||
    typeof graph.directory !== "string" ||
    !canonicalStrings(graph.commandLine, true, false) ||
    typeof graph.output !== "string" ||
    typeof graph.commandDigest !== "string" ||
    !SHA256.test(graph.commandDigest) ||
    typeof graph.toolchainFingerprint !== "string" ||
    !SHA256.test(graph.toolchainFingerprint) ||
    typeof graph.targetTriple !== "string" ||
    graph.targetTriple === "" ||
    (graph.language !== "c" && graph.language !== "cpp") ||
    typeof graph.hadErrors !== "boolean" ||
    !Array.isArray(graph.sources) ||
    !Array.isArray(graph.symbols) ||
    !Array.isArray(graph.occurrences) ||
    !Array.isArray(graph.relations) ||
    !Array.isArray(graph.macros) ||
    !Array.isArray(graph.includes) ||
    !Array.isArray(graph.missingIncludes) ||
    graph.missingIncludes.length !== 0 ||
    !Array.isArray(graph.modules) ||
    !Array.isArray(graph.diagnostics)
  ) {
    throw new Error(`C/C++ clang graph: malformed graph ${key}`);
  }
  const sources = new Set<string>();
  for (const source of graph.sources) {
    if (
      !isRecord(source) ||
      typeof source.uri !== "string" ||
      source.uri === "" ||
      !isSupportedSource(source.uri) ||
      sources.has(source.uri) ||
      typeof source.digest !== "string" ||
      !SHA256.test(source.digest) ||
      typeof source.diskDigest !== "string" ||
      (source.diskDigest !== "" && !SHA256.test(source.diskDigest)) ||
      !nonnegativeInteger(source.flags)
    ) {
      throw new Error(`C/C++ clang graph: malformed source ${key}`);
    }
    sources.add(source.uri);
  }
  const symbols = new Set<string>();
  for (const symbol of graph.symbols) {
    if (
      !isRecord(symbol) ||
      typeof symbol.usr !== "string" ||
      symbol.usr === "" ||
      typeof symbol.id !== "string" ||
      symbol.id === "" ||
      symbols.has(symbol.id) ||
      typeof symbol.name !== "string" ||
      symbol.name === "" ||
      typeof symbol.qualifiedName !== "string" ||
      typeof symbol.ownerUsr !== "string" ||
      typeof symbol.signature !== "string" ||
      !nonnegativeInteger(symbol.kind) ||
      !nonnegativeInteger(symbol.subKind) ||
      !nonnegativeInteger(symbol.properties) ||
      typeof symbol.local !== "boolean" ||
      typeof symbol.internal !== "boolean" ||
      typeof symbol.anonymous !== "boolean" ||
      typeof symbol.exported !== "boolean" ||
      !validNativeRange(symbol.declaration) ||
      !validNativeRange(symbol.definition) ||
      !Array.isArray(symbol.attributes) ||
      symbol.attributes.some(
        (attribute) =>
          !isRecord(attribute) ||
          typeof attribute.name !== "string" ||
          attribute.name === "" ||
          !validNativeRange(attribute.range),
      )
    ) {
      throw new Error(`C/C++ clang graph: malformed symbol ${key}`);
    }
    symbols.add(symbol.id);
  }
  for (const occurrence of graph.occurrences) {
    if (
      !isRecord(occurrence) ||
      typeof occurrence.usr !== "string" ||
      occurrence.usr === "" ||
      typeof occurrence.id !== "string" ||
      occurrence.id === "" ||
      typeof occurrence.containerId !== "string" ||
      !nonnegativeInteger(occurrence.roles) ||
      !nonnegativeInteger(occurrence.targetKind) ||
      !validNativeRange(occurrence.spelling) ||
      !validNativeRange(occurrence.expansion)
    ) {
      throw new Error(`C/C++ clang graph: malformed occurrence ${key}`);
    }
  }
  for (const relation of graph.relations) {
    if (
      !isRecord(relation) ||
      typeof relation.subjectId !== "string" ||
      relation.subjectId === "" ||
      typeof relation.objectId !== "string" ||
      relation.objectId === "" ||
      !nonnegativeInteger(relation.roles) ||
      !validNativeRange(relation.evidence)
    ) {
      throw new Error(`C/C++ clang graph: malformed relation ${key}`);
    }
  }
  // Macro rows are occurrences. Definition and reference rows intentionally
  // share the stable macro endpoint ID.
  for (const macro of graph.macros) {
    if (
      !isRecord(macro) ||
      typeof macro.usr !== "string" ||
      macro.usr === "" ||
      typeof macro.id !== "string" ||
      macro.id === "" ||
      typeof macro.name !== "string" ||
      macro.name === "" ||
      !nonnegativeInteger(macro.roles) ||
      !validNativeRange(macro.definition) ||
      !validNativeRange(macro.spelling) ||
      !validNativeRange(macro.expansion)
    ) {
      throw new Error(`C/C++ clang graph: malformed macro ${key}`);
    }
  }
  for (const include of graph.includes) {
    if (
      !isRecord(include) ||
      typeof include.source !== "string" ||
      include.source === "" ||
      !isSupportedSource(include.source) ||
      typeof include.target !== "string" ||
      include.target === "" ||
      !isSupportedSource(include.target) ||
      typeof include.spelling !== "string" ||
      typeof include.angled !== "boolean" ||
      typeof include.moduleImported !== "boolean" ||
      !validNativeRange(include.evidence)
    ) {
      throw new Error(`C/C++ clang graph: malformed include ${key}`);
    }
  }
  for (const module of graph.modules) {
    if (
      !isRecord(module) ||
      typeof module.name !== "string" ||
      module.name === "" ||
      !nonnegativeInteger(module.roles) ||
      !validNativeRange(module.evidence)
    ) {
      throw new Error(`C/C++ clang graph: malformed module ${key}`);
    }
  }
  for (const diagnostic of graph.diagnostics) {
    if (
      !isRecord(diagnostic) ||
      typeof diagnostic.message !== "string" ||
      diagnostic.message === "" ||
      typeof diagnostic.code !== "string" ||
      diagnostic.code === "" ||
      !["error", "warning", "info", "hint"].includes(diagnostic.severity) ||
      !validNativeRange(diagnostic.range)
    ) {
      throw new Error(`C/C++ clang graph: malformed diagnostic ${key}`);
    }
  }
}

function nativeManifest(
  shards: ReadonlyMap<string, IRetainedShard>,
): Array<{ key: string; digest: string }> {
  return [...shards.values()]
    .sort((left, right) => {
      const mainFile = Buffer.compare(
        Buffer.from(left.graph.mainFile, "utf8"),
        Buffer.from(right.graph.mainFile, "utf8"),
      );
      if (mainFile !== 0) return mainFile;
      return Buffer.compare(
        Buffer.from(left.configuration, "utf8"),
        Buffer.from(right.configuration, "utf8"),
      );
    })
    .map((shard) => ({ key: shard.key, digest: shard.digest }));
}

function assertNativeGeneration(
  raw: ICppGraphSnapshot,
  manifest: Array<{ key: string; digest: string }>,
  shards: ReadonlyMap<string, IRetainedShard>,
): void {
  const configurations = [
    ...new Set([...shards.values()].map((shard) => shard.configuration)),
  ].sort(compareText);
  const targets = [
    ...new Set([...shards.values()].map((shard) => shard.graph.targetTriple)),
  ].sort(compareText);
  const toolchains = [
    ...new Set(
      [...shards.values()].map((shard) => shard.graph.toolchainFingerprint),
    ),
  ].sort(compareText);
  if (
    JSON.stringify(configurations) !==
      JSON.stringify(raw.universe.configurations) ||
    JSON.stringify(targets) !== JSON.stringify(raw.universe.targets) ||
    JSON.stringify(toolchains) !== JSON.stringify(raw.universe.toolchains)
  ) {
    throw new Error("C/C++ clang graph: universe does not describe its shards");
  }
  const generationMaterial = manifest
    .map(
      (entry) =>
        `${Buffer.byteLength(entry.key, "utf8")}:${entry.key}${entry.digest}`,
    )
    .join("");
  let universeMaterial = coordinate(
    "producer",
    producerFingerprint(raw.producer),
  );
  for (const target of raw.universe.targets)
    universeMaterial += coordinate("target", target);
  for (const root of raw.universe.workspaceRoots)
    universeMaterial += coordinate("root", root);
  for (const toolchain of raw.universe.toolchains)
    universeMaterial += coordinate("toolchain", toolchain);
  for (const configuration of raw.universe.configurations)
    universeMaterial += coordinate("configuration", configuration);
  const universe = sha256(universeMaterial);
  if (
    universe !== raw.universe.digest ||
    sha256(universe + generationMaterial) !== raw.generation
  ) {
    throw new Error("C/C++ clang graph: generation digest mismatch");
  }
}

function coordinate(label: string, value: string): string {
  return `${label}:${Buffer.byteLength(value, "utf8")}:${value}`;
}

function producerFingerprint(producer: ICppGraphSnapshot.IProducer): string {
  return sha256(
    `samchon-graph-schema:1\nversion:${producer.version}\nrepository:${producer.commit}`,
  );
}

function validNativeRange(value: unknown): value is ICppGraphSnapshot.IRange {
  if (
    !isRecord(value) ||
    typeof value.file !== "string" ||
    !nonnegativeInteger(value.startLine) ||
    !nonnegativeInteger(value.startColumn) ||
    !nonnegativeInteger(value.endLine) ||
    !nonnegativeInteger(value.endColumn)
  ) {
    return false;
  }
  if (value.file === "") {
    return (
      value.startLine === 0 &&
      value.startColumn === 0 &&
      value.endLine === 0 &&
      value.endColumn === 0
    );
  }
  return (
    isSupportedSource(value.file) &&
    (value.endLine > value.startLine ||
      (value.endLine === value.startLine &&
        value.endColumn >= value.startColumn))
  );
}

function canonicalStrings(
  value: unknown,
  allowEmpty: boolean,
  canonical = true,
): value is string[] {
  if (!Array.isArray(value)) return false;
  let prior: string | undefined;
  for (const entry of value) {
    if (typeof entry !== "string" || (!allowEmpty && entry === "")) {
      return false;
    }
    if (canonical && prior !== undefined && entry <= prior) return false;
    prior = entry;
  }
  return true;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * One length-prefixed field, exactly as the producer's `Field` writes it.
 *
 * The prefix is the value's UTF-8 byte count because that is what
 * `llvm::StringRef::size()` reports; a code-unit count would agree only for
 * ASCII, and a non-ASCII path or signature is where it would stop agreeing.
 */
function graphField(value: string): string {
  return `${String(Buffer.byteLength(value, "utf8"))}:${value}`;
}

/**
 * The producer's `InterfaceFingerprint`: every exported symbol's id and
 * signature, in the order the translation unit published them.
 */
function interfaceFingerprintOf(graph: ICppGraphSnapshot.ITU): string {
  // Ordered by id, because an interface is what a unit exports, not the
  // sequence a compiler happened to walk it in. A body arrives reassembled
  // from the pieces it was published as, and the pieces are filed by the file
  // each fact was found in -- so the symbols come back in a different order
  // than they left, and a fingerprint that depended on that order would
  // reject every body the producer split.
  const material = graph.symbols
    .filter((symbol) => symbol.exported)
    .map((symbol) => `${graphField(symbol.id)}${graphField(symbol.signature)}`)
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    )
    .join("");
  return sha256(material);
}

/**
 * The producer's `BodyDigest`: what identifies a published body rather than
 * what it contains.
 *
 * The producer used to serialize the whole body to derive this, which cost a
 * second pass over every occurrence in a translation unit and exhausted a
 * 16 GiB host on C++. It now names the coordinates a body is published under
 * and the size of each fact family, which is enough because a published body
 * is only ever replaced by a reindex — and a reindex moves a source digest,
 * which is part of this.
 *
 * Disk digests are deliberately absent: they belong to the snapshot that
 * validated a source, not to the body, so a body identifies the same way
 * whether it was just produced or just read back from its shard.
 */
function bodyDigestOf(graph: ICppGraphSnapshot.ITU): string {
  let material =
    graphField(graph.producerFingerprint) +
    graphField(graph.mainFileUri) +
    graphField(graph.commandDigest) +
    graphField(graph.toolchainFingerprint) +
    graphField(graph.targetTriple) +
    graphField(graph.language) +
    (graph.hadErrors ? "!" : ".");
  for (const source of graph.sources) {
    material += `${graphField(source.uri)}${graphField(source.digest)}`;
  }
  for (const count of [
    graph.symbols.length,
    graph.occurrences.length,
    graph.relations.length,
    graph.macros.length,
    graph.includes.length,
    graph.missingIncludes.length,
    graph.modules.length,
    graph.diagnostics.length,
  ]) {
    material += `${String(count)},`;
  }
  return sha256(material);
}

/** The disk state this snapshot validated each source against. */
function diskMaterialOf(graph: ICppGraphSnapshot.ITU): string {
  let material = "";
  for (const source of graph.sources) {
    material += `${graphField(source.uri)}${graphField(source.diskDigest)}`;
  }
  return material;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareEdge(
  left: ISamchonGraphEdge,
  right: ISamchonGraphEdge,
): number {
  return compareText(
    `${left.from}\0${left.to}\0${left.kind}`,
    `${right.from}\0${right.to}\0${right.kind}`,
  );
}
