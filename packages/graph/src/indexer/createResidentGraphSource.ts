import { createHash } from "node:crypto";
import path from "node:path";
import {
  ISamchonGraphDiagnostic,
  ISamchonGraphDump,
  ISamchonGraphEdge,
  ISamchonGraphNode,
} from "../structures";
import { GraphLanguage } from "../typings";
import { SamchonGraphSourceReader } from "../SamchonGraphSourceReader";
import { assertGraphSnapshotContract } from "../provider/assertGraphSnapshotContract";
import { dumpProvenanceOf } from "../provider/dumpProvenanceOf";
import { IGraphProvider } from "../provider/IGraphProvider";
import { GRAPH_PROVIDERS } from "../provider/GRAPH_PROVIDERS";
import { IBulkGraphSession } from "../provider/IBulkGraphSession";
import { isBulkGraphSession } from "../provider/isBulkGraphSession";
import { mergeGraphSlices } from "../provider/mergeGraphSlices";
import { providerTopology } from "../provider/providerTopology";
import { readText } from "../utils/fs";
import { buildLspGraph } from "./buildLspGraph";
import { buildStaticGraphResult } from "./buildStaticGraphResult";
import { commitProjectInputGeneration } from "./commitProjectInputGeneration";
import { staticGraphParts } from "./staticGraphParts";
import { discoverLanguages } from "./discoverLanguages";
import { IBuildGraphOptions } from "./IBuildGraphOptions";
import { ILspSession } from "./ILspSession";
import { IResidentGraphSource } from "./IResidentGraphSource";
import { languageOf } from "./languageOf";
import { mergeProviderSourceDigests } from "./mergeProviderSourceDigests";
import { movedConsumedSource } from "./movedConsumedSource";
import { movedProviderSource } from "./movedProviderSource";
import { providerBuildInputs } from "./providerBuildInputs";
import { refreshLanguageSession } from "./refreshLanguageSession";
import { IGraphSourceSelection } from "./IGraphSourceSelection";
import { selectGraphSources } from "./selectGraphSources";
import { wireEdges } from "./wireEdges";
import { wireNodes } from "./wireNodes";
import { projectInputManifest } from "./projectInputManifest";
import { sameProjectInputManifest } from "./sameProjectInputManifest";
import { projectInputGeneration } from "./projectInputGeneration";

/**
 * How many times one `load` may prepare a candidate before giving up on the
 * project holding still long enough to publish it.
 */
const COMMIT_ATTEMPTS = 3;

interface IResidentState {
  dump: ISamchonGraphDump;
  sessions: Map<GraphLanguage, ILspSession | IBulkGraphSession>;
  generations: Map<GraphLanguage, number>;
  staticLanguages: GraphLanguage[];
  languages: GraphLanguage[];
  hashes: Map<string, string>;
  source: SamchonGraphSourceReader;

  /** What each provider did to compute the currently published generation. */
  modes: Map<string, IBulkGraphSession.Mode>;

  /** The registry entry behind each kept strict session, by language. */
  providers: Map<GraphLanguage, IGraphProvider>;

  /** Source/config/build inputs that fenced the published dump. */
  inputManifest: Map<string, string>;
  inputGeneration: string;
  buildInputs: string[];
  providerTopology: string;

  /**
   * The rows behind {@link providerTopology}, kept so an unasked configuration
   * entry can be restored instead of moving the topology.
   *
   * The serialized form alone cannot do that: substituting requires matching a
   * provider's entries against the last ones that established something, and a
   * string has no rows.
   */
  providerTopologyRows: readonly providerTopology.IRow[];
  /** An available strict candidate fell back while this state was built. */
  providerFallback: boolean;
}

interface IResidentDependencies {
  buildLspGraph: typeof buildLspGraph;
  buildStaticGraphResult?: typeof buildStaticGraphResult;
  providers?: readonly IGraphProvider[];

  /**
   * The static lane's parse, substitutable so the commit fence can be proved.
   *
   * The fence exists for the moment between a lane reading its source and the
   * refresh publishing what it read. In production that moment belongs to
   * whoever else is editing the checkout; in a test it belongs to nobody,
   * because the last read and the fence are adjacent statements with no seam
   * between them. A safety net that cannot be made to catch anything is not
   * one — so the parse that closes the preparation phase is a dependency, and
   * a test can move the project inside it.
   */
  staticGraphParts?: typeof staticGraphParts;
}

const DEFAULT_DEPENDENCIES: IResidentDependencies = {
  buildLspGraph,
  buildStaticGraphResult,
  providers: GRAPH_PROVIDERS,
};

// Languages that fell back to static parsing (no LSP session to hold) are
// simply re-parsed from scratch on every refresh; `buildStaticGraph` has no
// warm state to lose, so there is nothing to reuse there.
export function createResidentGraphSource(
  options: IBuildGraphOptions = {},
  dependencies: IResidentDependencies = DEFAULT_DEPENDENCIES,
): IResidentGraphSource.IObservable {
  const root = path.resolve(options.cwd ?? process.cwd());
  let state: IResidentState | undefined;
  let queue: Promise<void> = Promise.resolve();
  let closed = false;
  let activeAbort: AbortController | undefined;
  let closing: Promise<void> | undefined;
  const sessionClosures = new WeakMap<
    ILspSession | IBulkGraphSession,
    Promise<void>
  >();

  async function buildFresh(signal: AbortSignal): Promise<IResidentState> {
    // `keepAlive: true` above guarantees `buildLspGraph` always returns a
    // sessions map, even an empty one.
    const result =
      options.mode === "static"
        ? await commitProjectInputGeneration(
            { ...options, signal },
            [],
            () =>
              (dependencies.buildStaticGraphResult ?? buildStaticGraphResult)(
                options,
              ),
          )
        : await dependencies.buildLspGraph({
            ...options,
            keepAlive: true,
            signal,
          });
    const sessions = result.sessions ?? new Map();
    try {
      const selected = selectGraphSources(root, options);
      const texts = result.sources ?? new Map<string, string>();
      const buildInputs =
        result.buildInputs ??
        residentBuildInputs(selected.languages, dependencies.providers) ??
        [];
      const inputManifest =
        result.inputManifest ??
        projectInputManifest(
          root,
          options,
          buildInputs,
          selected.files,
        );
      const providerSnapshots = [...new Set(sessions.values())]
        .filter(isBulkGraphSession)
        .flatMap((session) =>
          session.current === undefined ? [] : [session.current],
        );
      const served = new Set(
        [...(result.providers ?? new Map()).values()].map(
          (provider) => provider.name,
        ),
      );
      const availableTopology = providerTopology.available(
        root,
        selected.presentLanguages,
        options,
        process.env,
        dependencies.providers ?? [],
        served,
      );
      return {
        dump: result.dump,
        sessions,
        generations: bulkGenerationsOf(sessions),
        staticLanguages: staticLanguagesOf(result.dump, sessions),
        languages: languagesOf(result.sources, root, options, sessions),
        hashes:
          result.sources === undefined
            ? snapshotSources(root, options, bulkLanguagesOf(sessions))
            : hashSources(result.sources),
        source: result.source ?? sourceReaderOf(root, texts, sessions),
        modes: result.modes ?? new Map(),
        providers: result.providers ?? new Map(),
        inputManifest,
        inputGeneration:
          result.inputGeneration ??
          projectInputGeneration({
            sourceFiles: selected.files,
            buildInputFiles: buildInputs.map((input) =>
              path.resolve(root, input),
            ),
            manifest: inputManifest,
            consumedSources: texts,
            providerSources: providerSourcesOf(providerSnapshots),
            provenance:
              result.dump.provenance ??
              providerSnapshots.map(dumpProvenanceOf),
          }),
        buildInputs,
        providerTopology: providerTopology.serialize(availableTopology),
        providerTopologyRows: availableTopology,
        providerFallback: availableTopology.some((row) =>
          row.languages.some(
            (language) =>
              (result.providers ?? new Map()).get(language)?.name !==
              row.provider,
          ),
        ),
      };
    } catch (error) {
      // Once the build hands its sessions to this source, every later failure
      // on the path to publishing the state belongs to us to clean up.
      await closeSessions(sessions, sessionClosures);
      throw error;
    }
  }

  async function refreshStale(
    current: IResidentState,
    prefetched: ReadonlyMap<GraphLanguage, IBulkGraphSession.IRefresh>,
    inputManifest: ReadonlyMap<string, string>,
    signal: AbortSignal,
  ): Promise<void> {
    const nodes: ISamchonGraphNode[] = [];
    const edges: ISamchonGraphEdge[] = [];
    const strictNodes: ISamchonGraphNode[] = [];
    const strictEdges: ISamchonGraphEdge[] = [];
    // Rebuilt from what the servers say now, exactly like the nodes and the
    // edges. Carrying the previous dump's array forward made `diagnostics` a
    // function of the session's edit history — a deleted file's findings survived
    // forever, a re-analysed file's were duplicated on every refresh — inside a
    // dump whose own contract is that it is a function of its source (§6a). The
    // session holds them per file now, and a `didClose` drops the file's.
    const diagnostics: ISamchonGraphDiagnostic[] = [];
    const warnings: string[] = [];
    const sources = new Map<string, string>();
    const generations = new Map(current.generations);
    const provenance: ISamchonGraphDump.IProvenance[] = [];
    const modes = new Map<string, IBulkGraphSession.Mode>();
    const selected = selectGraphSources(root, options);

    // One slice per distinct bulk session, not per key: a provider that owns
    // two languages appears twice in `sessions` pointing at one object, and
    // merging its snapshot once per key would publish every node it produced
    // twice. The value is the exact snapshot this transaction took, so the
    // fence below can ask whether it is still what the session holds.
    const merged = new Map<IBulkGraphSession, IBulkGraphSession.ISnapshot>();
    for (const [language, session] of current.sessions) {
      if (isBulkGraphSession(session)) {
        // `load` refreshes every bulk session through `refreshBulkSessions`
        // before it decides to refresh at all, and hands those results here as
        // `prefetched`. Both loops walk the same `state.sessions` map, which is
        // never mutated in place, so a bulk session reached here is always one
        // that was already prefetched — its snapshot is present without a second
        // (double-counting) refresh.
        const refresh = prefetched.get(language)!;
        assertOpen();
        generations.set(language, refresh.generation);
        if (merged.has(session)) continue;
        merged.set(session, refresh.snapshot);
        // Held to the same contract as the first snapshot, on every refresh.
        // Checking only the initial build would leave a session unexamined for
        // its entire working life — a provider whose second generation
        // published an unclaimed edge family or another language's nodes would
        // be merged straight into the dump.
        const provider = current.providers.get(language);
        if (provider !== undefined) {
          assertGraphSnapshotContract(
            refresh.snapshot,
            provider,
            session.languages,
            root,
          );
        }
        strictNodes.push(...refresh.snapshot.nodes);
        strictEdges.push(...refresh.snapshot.edges);
        // Rebuilt from what the compiler says now, exactly like the nodes and
        // the edges, and for the same reason the LSP lane stopped carrying them
        // forward: a diagnostic belongs to the generation that produced it.
        diagnostics.push(...refresh.snapshot.diagnostics);
        warnings.push(...refresh.snapshot.warnings);
        provenance.push(dumpProvenanceOf(refresh.snapshot));
        modes.set(refresh.snapshot.provenance.provider, refresh.mode);
        continue;
      }
      // `sameLanguages` only admits this refresh while discovery still sees
      // every live session language in the selected source snapshot.
      const files = selected.byLanguage.get(language)!;
      const result = await refreshLanguageSession(
        session,
        files,
        options,
        signal,
      );
      assertOpen();
      nodes.push(...result.nodes);
      edges.push(...result.edges);
      diagnostics.push(...result.diagnostics);
      warnings.push(...result.warnings);
      for (const opened of session.opened.values()) {
        sources.set(opened.abs, opened.text);
      }
    }
    if (current.staticLanguages.length > 0) {
      const fallback = (dependencies.staticGraphParts ?? staticGraphParts)(
        {
          ...options,
          cwd: root,
          mode: "static",
          languages: current.staticLanguages,
        },
        filesForLanguages(selected, current.staticLanguages),
      );
      nodes.push(...fallback.nodes);
      edges.push(...fallback.edges);
      warnings.push(...fallback.warnings);
      for (const [file, text] of fallback.sources) sources.set(file, text);
    }

    const finalized = mergeGraphSlices({
      root,
      // Bulk slices already contain compiler-resolved export edges. Reopening
      // their manifest would break snapshot ownership and can target virtual or
      // external identities; only generic source text belongs in this pass.
      files: [...sources.keys()],
      genericNodes: nodes,
      genericEdges: edges,
      strictNodes,
      strictEdges,
    });
    warnings.push(...finalized.warnings);

    // The commit fence. Every slice above was prepared at its own moment: the
    // bulk providers answered first, each generic session re-read its documents
    // next, and the static lane parsed last. That the final object swap is
    // atomic to a reader says nothing about the inputs — a file edited between
    // the compiler's export and the static parse produces a dump whose halves
    // describe two different checkouts, and the audit riding on it claims one.
    //
    // Bulk slices are not re-read here, and must not be: a provider's manifest
    // is the provider's statement about the program it resolved, and opening
    // its files behind its back answers a different question with bytes the
    // checker never saw. Their revision token is the manifest digest each
    // candidate carries.
    // …but the token has to be checked, or naming it is just a sentence. A
    // provider polled at the start of this transaction can have rebuilt while
    // the generic lanes were still reading, and its candidate would then be one
    // program's facts committed beside another's — the exact mixture the fence
    // exists to refuse, arriving through the one lane the fence was not
    // watching.
    for (const [session, snapshot] of merged) {
      if (session.current === snapshot) continue;
      throw new StaleCandidateError(
        `@samchon/graph: the ${snapshot.provenance.provider} provider replaced its snapshot while this refresh was preparing, so no slice of that generation may be published`,
      );
    }

    const committedSelection = selectGraphSources(root, options);
    const committedBuildInputs = residentBuildInputs(
      committedSelection.languages,
      dependencies.providers,
    ) ?? current.buildInputs;
    if (!sameStringArray(current.buildInputs, committedBuildInputs)) {
      throw new StaleCandidateError(
        "@samchon/graph: the project build-input set changed while this refresh was preparing, so none of its language slices may be published",
      );
    }
    const committedInputs = projectInputManifest(
      root,
      options,
      committedBuildInputs,
      committedSelection.files,
    );
    if (!sameProjectInputManifest(inputManifest, committedInputs)) {
      throw new StaleCandidateError(
        "@samchon/graph: the project source/config/build input manifest changed while this refresh was preparing, so none of its language slices may be published",
      );
    }
    // Compare the exact generic bytes to the final coordinator digest as well
    // as to one last disk read. Without the manifest relation, a source could
    // change after the generic lane consumed it and revert before publication:
    // equal outer manifests would then fence A around facts computed from B.
    const moved = movedConsumedSource(sources, committedInputs);
    if (moved !== undefined) {
      throw new StaleCandidateError(
        `@samchon/graph: ${moved} changed while this refresh was preparing, so no slice of it may be published`,
      );
    }
    const providerSources = providerSourcesOf([...merged.values()]);
    const providerMovement = movedProviderSource(
      providerSources,
      inputManifest,
      committedInputs,
    );
    if (providerMovement !== undefined) {
      throw new StaleCandidateError(
        `@samchon/graph: ${providerMovement}, so no slice of that generation may be published`,
      );
    }
    const inputGeneration = projectInputGeneration({
      sourceFiles: committedSelection.files,
      buildInputFiles: committedBuildInputs.map((input) =>
        path.resolve(root, input),
      ),
      manifest: committedInputs,
      consumedSources: sources,
      providerSources,
      provenance,
    });

    // Written out rather than spread from the previous dump, because a spread
    // carries forward whatever this refresh did not replace — and `provenance`
    // is the field where that is worst. Its manifest and content digests are a
    // *proof* about one generation, so an inherited row states that a
    // generation nobody produced is still current, and a reader comparing
    // digests concludes nothing moved. The same reasoning already retired the
    // carried-forward `diagnostics` array above.
    //
    // Only the three facts a refresh cannot change survive: this is the same
    // project, and `sameLanguages` gated the call, so its language set and
    // indexing strategy are the ones the build established.
    const dump: ISamchonGraphDump = {
      project: current.dump.project,
      languages: current.dump.languages,
      indexer: current.dump.indexer,
      nodes: wireNodes(finalized.nodes),
      edges: wireEdges(finalized.edges, finalized.nodes),
      diagnostics,
      warnings,
      ...dumpProvenanceOf.fieldOf(provenance),
    };
    // One replacement, after the fence closed. Nothing above this line is
    // visible to a reader, so a throw anywhere in the transaction leaves the
    // previous generation whole.
    current.dump = dump;
    current.hashes = hashSources(sources);
    current.generations = generations;
    current.modes = modes;
    current.source = sourceReaderOf(root, sources, current.sessions);
    current.inputManifest = committedInputs;
    current.inputGeneration = inputGeneration;
  }

  async function replaceLanguages(
    current: IResidentState,
    signal: AbortSignal,
  ): Promise<void> {
    const fresh = await buildFresh(signal);
    if (closed) {
      await closeSessions(fresh.sessions, sessionClosures);
      throw closedError();
    }
    // Publish the complete replacement atomically before retiring the old
    // sessions. A failed fresh build leaves `current` untouched; a failed old
    // shutdown leaves the newly built state usable on the next call.
    state = fresh;
    await closeSessions(current.sessions, sessionClosures);
  }

  /**
   * Decide whether the project moved, and if it did, commit exactly one new
   * generation for it.
   *
   * The retry exists because "prepare a candidate" and "the project holds
   * still" are independent: a checkout under an active editor can move again
   * while the previous attempt was preparing, and an attempt that discards
   * itself has changed nothing a reader can see. Bounded, because a project
   * being rewritten continuously has no quiet moment to snapshot, and an
   * unbounded loop would answer that by never returning.
   *
   * Exhausting the bound rejects rather than returning the previous dump. That
   * generation does survive — nothing published it away, and the next quiet
   * load still has it — but handing it back to *this* call would attach the
   * result audit's "for the snapshot this call synced to" to a snapshot this
   * call did not sync to.
   */
  async function commitRefresh(
    current: IResidentState,
    signal: AbortSignal,
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const selected = selectGraphSources(root, options);
      const liveBuildInputs = residentBuildInputs(
        selected.languages,
        dependencies.providers,
      ) ?? current.buildInputs;
      // Restored row by row before it is compared. A candidate that is not
      // serving still gets its toolchain probed on every refresh, and a probe
      // that failed to launch used to move the topology — which is treated as
      // structural, so one `where.exe` that could not start reindexed every
      // language in a project it had nothing to do with. The exposure grows
      // with the registry: every provider registered for a language this
      // project does not use is another candidate to probe, and a
      // half-installed toolchain fails intermittently for the same reason it is
      // not serving.
      const liveRows = providerTopology.reestablish(
        providerTopology.available(
          root,
          selected.presentLanguages,
          options,
          process.env,
          dependencies.providers ?? [],
          new Set(
            [...current.providers.values()].map((provider) => provider.name),
          ),
        ),
        current.providerTopologyRows,
      );
      const liveTopology = providerTopology.serialize(liveRows);
      if (liveTopology !== current.providerTopology) {
        await replaceLanguages(current, signal);
        return;
      }
      if (!sameStringArray(current.buildInputs, liveBuildInputs)) {
        await replaceLanguages(current, signal);
        return;
      }
      const inputManifest = projectInputManifest(
        root,
        options,
        liveBuildInputs,
        selected.files,
      );
      if (
        current.providerFallback &&
        !sameProjectInputManifest(current.inputManifest, inputManifest)
      ) {
        // A stable failed candidate must not rebuild on every unchanged load,
        // but an input generation change is exactly when the reason it failed
        // may have been repaired. Re-run selection and preparation rather than
        // pinning the resident to fallback for its entire lifetime.
        await replaceLanguages(current, signal);
        return;
      }
      const prefetched = await refreshBulkSessions(current.sessions, signal);
      const bulkChanged = [...prefetched].some(
        ([language, refresh]) =>
          current.generations.get(language) !== refresh.generation,
      );
      const bulkSliceLanguagesChanged = !sameBulkSliceLanguages(
        current.sessions,
        prefetched,
        current.providers,
      );
      const providerMovement = movedProviderSource(
        providerSourcesOf(
          [...new Set(prefetched.values())].map(
            (refresh) => refresh.snapshot,
          ),
        ),
        current.inputManifest,
        inputManifest,
      );
      if (
        !bulkChanged &&
        !bulkSliceLanguagesChanged &&
        providerMovement === undefined &&
        sameProjectInputManifest(current.inputManifest, inputManifest) &&
        !isStale(current.hashes, root, options, bulkLanguagesOf(current.sessions))
      ) {
        current.modes = bulkModesOf(prefetched);
        return;
      }
      const discovered = discoverLanguages(root, options);
      if (
        !sameLanguages(current.languages, discovered) ||
        bulkSliceLanguagesChanged
      ) {
        // A language appearing or disappearing replaces every session, so the
        // transaction is the fresh build itself. So does a bulk slice gaining
        // or losing an already-discovered language: the old state has the
        // generic/static session topology for the former slice, which cannot
        // coexist with the provider that now owns it.
        await replaceLanguages(current, signal);
        return;
      }
      try {
        await refreshStale(current, prefetched, inputManifest, signal);
        return;
      } catch (error) {
        if (!isStaleCandidate(error)) throw error;
        if (attempt >= COMMIT_ATTEMPTS) {
          throw new Error(
            `@samchon/graph: the project kept changing while ${String(COMMIT_ATTEMPTS)} refreshes were preparing, so none of them describes a checkout that still exists: ${(error as Error).message}`,
          );
        }
      }
    }
  }

  return {
    load(): Promise<ISamchonGraphDump> {
      return enqueue(async () => {
        assertOpen();
        const controller = new AbortController();
        activeAbort = controller;
        try {
          if (state === undefined) {
            const fresh = await buildFresh(controller.signal);
            if (closed) {
              await closeSessions(fresh.sessions, sessionClosures);
              throw closedError();
            }
            state = fresh;
          } else {
            await commitRefresh(state, controller.signal);
          }
          assertOpen();
          return state.dump;
        } finally {
          if (activeAbort === controller) activeAbort = undefined;
        }
      });
    },
    source(): SamchonGraphSourceReader | undefined {
      return state?.source;
    },
    modes(): ReadonlyMap<string, IBulkGraphSession.Mode> {
      return new Map(state?.modes ?? []);
    },
    inputGeneration(): string | undefined {
      return state?.inputGeneration;
    },
    close(): Promise<void> {
      if (closing !== undefined) return closing;
      // Flip the bit synchronously. A load already inside an await observes it
      // before publishing a newly-built/refreshed graph, while calls queued
      // behind this point never start another language server.
      closed = true;
      activeAbort?.abort();
      const current = state;
      const immediateBulkClose =
        current === undefined
          ? Promise.resolve()
          : closeSessions(current.sessions, sessionClosures, true);
      closing = (async () => {
        let failure: Error | undefined;
        try {
          await immediateBulkClose;
        } catch (error) {
          failure = asError(error);
        }
        try {
          await enqueue(async () => {
            const final = state;
            state = undefined;
            if (final !== undefined) {
              await closeSessions(final.sessions, sessionClosures);
            }
          });
        } catch (error) {
          failure ??= asError(error);
        }
        if (failure !== undefined) throw failure;
      })();
      return closing;
    },
  };

  function residentBuildInputs(
    languages: readonly GraphLanguage[],
    providers: readonly IGraphProvider[] | undefined,
  ): string[] | undefined {
    if (options.mode === "static") {
      return providerBuildInputs(languages, [], root);
    }
    if (providers === undefined) return undefined;
    return providerBuildInputs(languages, providers, root);
  }

  /** One queue lane per public call, without caching a rejected lane. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    queue = queue
      .catch(() => undefined)
      .then(async () => {
        try {
          resolveResult(await task());
        } catch (error) {
          rejectResult(asError(error));
        }
      });
    return result;
  }

  function assertOpen(): void {
    if (closed) throw closedError();
  }
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function bulkModesOf(
  refreshed: ReadonlyMap<GraphLanguage, IBulkGraphSession.IRefresh>,
): Map<string, IBulkGraphSession.Mode> {
  const modes = new Map<string, IBulkGraphSession.Mode>();
  for (const refresh of refreshed.values()) {
    modes.set(refresh.snapshot.provenance.provider, refresh.mode);
  }
  return modes;
}

function providerSourcesOf(
  snapshots: readonly IBulkGraphSession.ISnapshot[],
): Map<string, IBulkGraphSession.ISourceDigest> {
  const sources = new Map<string, IBulkGraphSession.ISourceDigest>();
  for (const snapshot of snapshots) {
    mergeProviderSourceDigests(sources, snapshot.sources);
  }
  return sources;
}

function sourceReaderOf(
  root: string,
  texts: ReadonlyMap<string, string>,
  sessions: ReadonlyMap<GraphLanguage, ILspSession | IBulkGraphSession>,
): SamchonGraphSourceReader {
  const digests = new Map<string, IBulkGraphSession.ISourceDigest>();
  for (const session of sessions.values()) {
    if (!isBulkGraphSession(session)) continue;
    if (session.current !== undefined) {
      mergeProviderSourceDigests(digests, session.current.sources);
    }
  }
  return new SamchonGraphSourceReader(root, { texts, digests });
}

function languagesOf(
  sources: ReadonlyMap<string, string> | undefined,
  root: string,
  options: IBuildGraphOptions,
  sessions: ReadonlyMap<GraphLanguage, ILspSession | IBulkGraphSession>,
): GraphLanguage[] {
  const discovered =
    sources === undefined
      ? discoverLanguages(root, options)
      : [...sources.keys()]
          .map(languageOf)
          .filter((language) => language !== "unknown");
  return [
    ...new Set([...discovered, ...sessions.keys()]),
  ];
}

function sameLanguages(
  left: readonly GraphLanguage[],
  right: readonly GraphLanguage[],
): boolean {
  return (
    left.length === right.length &&
    left.every((language) => right.includes(language))
  );
}

function closedError(): Error {
  return new Error("@samchon/graph: resident graph source is closed");
}

async function closeSessions(
  sessions: Map<GraphLanguage, ILspSession | IBulkGraphSession>,
  closures: WeakMap<ILspSession | IBulkGraphSession, Promise<void>>,
  bulkOnly = false,
): Promise<void> {
  let failure: Error | undefined;
  for (const session of sessions.values()) {
    if (bulkOnly && !isBulkGraphSession(session)) continue;
    try {
      let closure = closures.get(session);
      if (closure === undefined) {
        closure = isBulkGraphSession(session)
          ? session.close()
          : session.client.close();
        closures.set(session, closure);
      }
      await closure;
    } catch (error) {
      // Close every resident process even when one shutdown handshake fails.
      failure ??= asError(error);
    }
  }
  if (failure !== undefined) throw failure;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * A prepared candidate that the project moved out from under before it could
 * be committed.
 *
 * Its own class because it is the one refresh failure that is not a defect:
 * nothing is wrong with the graph, the sessions, or the source — the answer
 * simply describes a checkout that no longer exists. The caller retries it a
 * bounded number of times instead of surfacing it, which it cannot do for a
 * failure it cannot distinguish.
 */
class StaleCandidateError extends Error {
  public readonly stale = true as const;
}

function isStaleCandidate(error: unknown): boolean {
  return error instanceof StaleCandidateError;
}

/**
 * The first consumed file whose bytes on disk no longer match what this
 * refresh read, or `undefined` when every one still matches.
 *
 * Content, not mtime: an editor that writes a file twice inside one clock
 * resolution, or a script that rewrites it to the same length, leaves the
 * timestamp where it was — and the fence would then certify a candidate built
 * from source that had already changed.
 */
// A language ended up in the static fallback if the dump reports it but no
// live session was returned for it (an LSP session is only kept for a
// language that actually produced real symbols).
function staticLanguagesOf(
  dump: ISamchonGraphDump,
  sessions: Map<GraphLanguage, ILspSession | IBulkGraphSession>,
): GraphLanguage[] {
  return dump.languages.filter(
    (language) => !sessions.has(language as GraphLanguage),
  ) as GraphLanguage[];
}

function bulkGenerationsOf(
  sessions: ReadonlyMap<GraphLanguage, ILspSession | IBulkGraphSession>,
): Map<GraphLanguage, number> {
  const generations = new Map<GraphLanguage, number>();
  for (const [language, session] of sessions) {
    if (isBulkGraphSession(session)) {
      generations.set(language, session.generation);
    }
  }
  return generations;
}

/**
 * Whether every bulk session still owns exactly the state keys that route to
 * it.
 *
 * A provider is allowed to publish fewer languages than its candidate owns,
 * with the rest served by a generic or static lane. If a later refresh adds
 * one of those languages (or withdraws one it did publish), merging it into
 * the old state would either collide with that fallback lane or leave the
 * withdrawn language without any lane. Rebuild the resident topology instead.
 */
function sameBulkSliceLanguages(
  sessions: ReadonlyMap<GraphLanguage, ILspSession | IBulkGraphSession>,
  prefetched: ReadonlyMap<GraphLanguage, IBulkGraphSession.IRefresh>,
  providers: ReadonlyMap<GraphLanguage, IGraphProvider>,
): boolean {
  const owned = new Map<IBulkGraphSession, GraphLanguage[]>();
  for (const [language, session] of sessions) {
    if (!isBulkGraphSession(session)) continue;
    const languages = owned.get(session) ?? [];
    languages.push(language);
    owned.set(session, languages);
  }
  for (const [session, languages] of owned) {
    const refresh = prefetched.get(languages[0]!)!;
    const provider = providers.get(languages[0]!);
    if (provider !== undefined) {
      assertGraphSnapshotContract(
        refresh.snapshot,
        provider,
        session.languages,
        session.root,
      );
    }
    if (!sameLanguages(languages, refresh.snapshot.languages)) return false;
  }
  return true;
}

/**
 * Poll every distinct bulk session once, and index the result by language.
 *
 * Deduplicated by session identity rather than by key. A provider that owns C
 * and C++ appears in the map twice, pointing at one object; refreshing per key
 * would ask that provider for two snapshots per load, advance its generation
 * twice, and then merge its facts into the dump twice — which the strict-slice
 * validator would reject as duplicated nodes, after the compiler had already
 * done the work a second time.
 */
async function refreshBulkSessions(
  sessions: ReadonlyMap<GraphLanguage, ILspSession | IBulkGraphSession>,
  signal?: AbortSignal,
): Promise<Map<GraphLanguage, IBulkGraphSession.IRefresh>> {
  const refreshed = new Map<GraphLanguage, IBulkGraphSession.IRefresh>();
  const bySession = new Map<IBulkGraphSession, IBulkGraphSession.IRefresh>();
  for (const [language, session] of sessions) {
    if (!isBulkGraphSession(session)) continue;
    let refresh = bySession.get(session);
    if (refresh === undefined) {
      refresh = await session.refresh({ signal });
      bySession.set(session, refresh);
    }
    refreshed.set(language, refresh);
  }
  return refreshed;
}

function bulkLanguagesOf(
  sessions: ReadonlyMap<GraphLanguage, ILspSession | IBulkGraphSession>,
): ReadonlySet<GraphLanguage> {
  const languages = new Set<GraphLanguage>();
  for (const [language, session] of sessions) {
    if (isBulkGraphSession(session)) languages.add(language);
  }
  return languages;
}

/**
 * What every source file on disk contains right now, as a content hash per file.
 *
 * The audit that rides on every result says the facts were resolved "for the
 * snapshot this call synced to", and that sentence is only true if the server
 * can actually tell that the snapshot moved. A timestamp cannot: a same-tick
 * edit — an editor writing a file twice inside one clock resolution, a script
 * rewriting a file to the same length — leaves the mtime where it was, and the
 * graph then answers a question about code that no longer exists while swearing
 * it is current (§1c).
 *
 * So freshness is the file's content, hashed, and nothing else. It costs one
 * read of each source file per call, which is what the walk already pays, and it
 * cannot be wrong.
 */
function snapshotSources(
  root: string,
  options: IBuildGraphOptions,
  excludedLanguages: ReadonlySet<GraphLanguage> = new Set(),
): Map<string, string> {
  const files = selectGraphSources(root, options).files;
  const snapshot = new Map<string, string>();
  for (const abs of files) {
    if (excludedLanguages.has(languageOf(abs))) continue;
    const text = readText(abs);
    // A file removed between the walk and the read is simply absent from the
    // snapshot, which itself is a difference the next comparison will catch.
    /* c8 ignore next */
    if (text === undefined) continue;
    snapshot.set(abs, createHash("sha256").update(text).digest("hex"));
  }
  return snapshot;
}

function filesForLanguages(
  selected: IGraphSourceSelection,
  languages: readonly GraphLanguage[],
): string[] {
  // Resident static languages came from this source-selection-backed dump, so
  // every partition is present before the fallback is refreshed.
  const allowed = new Set(
    languages.flatMap((language) => selected.byLanguage.get(language)!),
  );
  return selected.files.filter((file) => allowed.has(file));
}

/** Content hashes for the exact texts an index pass consumed. */
function hashSources(
  sources: ReadonlyMap<string, string>,
): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const [file, text] of sources) {
    snapshot.set(file, createHash("sha256").update(text).digest("hex"));
  }
  return snapshot;
}

function isStale(
  previous: Map<string, string>,
  root: string,
  options: IBuildGraphOptions,
  excludedLanguages: ReadonlySet<GraphLanguage>,
): boolean {
  const current = snapshotSources(root, options, excludedLanguages);
  if (current.size !== previous.size) return true;
  for (const [file, hash] of current) {
    if (previous.get(file) !== hash) return true;
  }
  return false;
}
