import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { IDiagnostic, LspClient } from "../lsp";
import { SamchonGraphSourceReader } from "../SamchonGraphSourceReader";
import {
  ISamchonGraphDiagnostic,
  ISamchonGraphDump,
  ISamchonGraphEdge,
  ISamchonGraphNode,
} from "../structures";
import { GraphLanguage } from "../typings";
import { projectRelative, readText } from "../utils/fs";
import { fileFromUri, fileUri, isSubPath } from "../utils/path";
import { spawnableCommand } from "../utils/spawnableCommand";
import { assertGraphSnapshotContract } from "../provider/assertGraphSnapshotContract";
import { dumpProvenanceOf } from "../provider/dumpProvenanceOf";
import { IBulkGraphSession } from "../provider/IBulkGraphSession";
import { isBulkGraphSession } from "../provider/isBulkGraphSession";
import { mergeGraphSlices } from "../provider/mergeGraphSlices";
import { GRAPH_PROVIDERS } from "../provider/GRAPH_PROVIDERS";
import { IGraphProvider } from "../provider/IGraphProvider";
import { selectGraphProviders } from "../provider/selectGraphProviders";
import { appendAll } from "./appendAll";
import { commitProjectInputGeneration } from "./commitProjectInputGeneration";
import { dedupeEdges } from "./dedupeEdges";
import { dedupeNodes } from "./dedupeNodes";
import { ensureCompileCommands } from "./ensureCompileCommands";
import { ensurePubDeps } from "./ensurePubDeps";
import { finalizeGraph } from "./finalizeGraph";
import { IBuildGraphOptions } from "./IBuildGraphOptions";
import { IIndexerResult } from "./IIndexerResult";
import { ILspSession } from "./ILspSession";
import { languageIdOf } from "./languageIdOf";
import { mergeProviderSourceDigests } from "./mergeProviderSourceDigests";
import { specOf } from "./languages";
import { scanSession } from "./scanSession";
import { IGraphSourceSelection } from "./IGraphSourceSelection";
import { selectGraphSources } from "./selectGraphSources";
import { IStaticGraphParts } from "./IStaticGraphParts";
import { staticGraphParts } from "./staticGraphParts";
import { wireEdges } from "./wireEdges";
import { wireNodes } from "./wireNodes";

interface IBuildLspGraphDependencies {
  /**
   * The registry discovery reads.
   *
   * The seam is the registry, not the selection. Letting a caller replace
   * `selectGraphProviders` itself would mean that refusal, command resolution,
   * project preparation, and the one-owner-per-language check never run on any
   * path a test exercises — the integration would be proved by a stub standing
   * exactly where the logic under test belongs. Substituting an entry instead
   * leaves every one of those steps running against it.
   */
  providers: readonly IGraphProvider[];
  collectProviderGraph: typeof collectProviderGraph;
  collectLanguageGraph: typeof collectLanguageGraph;
}

const DEFAULT_DEPENDENCIES: IBuildLspGraphDependencies = {
  providers: GRAPH_PROVIDERS,
  collectProviderGraph,
  collectLanguageGraph,
};

export async function buildLspGraph(
  options: IBuildGraphOptions = {},
  dependencies: Partial<IBuildLspGraphDependencies> = {},
): Promise<IIndexerResult> {
  const resolvedDependencies: IBuildLspGraphDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...dependencies,
  };
  const committed = await commitProjectInputGeneration(
    options,
    resolvedDependencies.providers,
    () => buildLspGraphAttempt(options, resolvedDependencies),
    async (result) =>
      // A one-shot attempt has already closed its own sessions; only resident
      // candidates hand any back for this discard path to retire.
      result.sessions === undefined
        ? []
        : closeKeptSessions(result.sessions),
  );
  if (options.keepAlive) {
    const { providerSourceDigests: _providerSourceDigests, ...result } =
      committed;
    void _providerSourceDigests;
    return result;
  }
  const {
    sources: _consumedSources,
    providerSourceDigests: _providerSourceDigests,
    ...result
  } = committed;
  void _consumedSources;
  void _providerSourceDigests;
  return result;
}

async function buildLspGraphAttempt(
  options: IBuildGraphOptions,
  resolvedDependencies: IBuildLspGraphDependencies,
): Promise<IIndexerResult> {
  const root = path.resolve(options.cwd ?? process.cwd());
  const selected = selectGraphSources(root, options);
  const languages = selected.languages;
  const nodes: ISamchonGraphNode[] = [];
  const edges: ISamchonGraphEdge[] = [];
  const strictNodes: ISamchonGraphNode[] = [];
  const strictEdges: ISamchonGraphEdge[] = [];
  const diagnostics: ISamchonGraphDiagnostic[] = [];
  const warnings: string[] = [];
  const staticFallbackLanguages: GraphLanguage[] = [];
  const sessions = new Map<GraphLanguage, ILspSession | IBulkGraphSession>();
  const sources = new Map<string, string>();
  const strictDigests = new Map<
    string,
    IBulkGraphSession.ISourceDigest
  >();
  const snapshotSource = (): SamchonGraphSourceReader =>
    new SamchonGraphSourceReader(root, {
      texts: sources,
      digests: strictDigests,
    });
  const provenance: ISamchonGraphDump.IProvenance[] = [];
  const modes = new Map<string, IBulkGraphSession.Mode>();
  const providers = new Map<GraphLanguage, IGraphProvider>();
  const servedLanguages = new Set<GraphLanguage>();
  let compileCommandsDir: string | undefined;
  let compileCommandsOwner: TemporaryDirectoryOwner | undefined;
  let pubPrepared = false;
  let semanticSliceCount = 0;
  try {
    // Every strict provider runs before the generic loop, and the loop then
    // serves whatever they did not claim. The selection this replaces was an
    // `if (language === "typescript")` arm in the middle of that loop: adding a
    // provider meant adding a branch, nothing could enumerate the set, and a
    // caller whose options disqualified the compiler-owned lane fell through
    // without a word — a fallback success indistinguishable from the strict
    // result it had silently replaced.
    const strictLanguages = new Set<GraphLanguage>();
    const withSources = languages.filter(
      (language) => (selected.byLanguage.get(language) ?? []).length > 0,
    );
    const selection = selectGraphProviders(
      root,
      withSources,
      options,
      process.env,
      resolvedDependencies.providers,
    );
    appendAll(warnings, selection.warnings);
    // Said before the work starts, not after it finishes.
    //
    // Everything else this build reports — the provenance line, every warning —
    // is written once the dump is complete, so a run that never completes
    // reports nothing at all. Two benchmark lanes spent an hour each and left an
    // empty log three times over: no provider named, no reason recorded, and no
    // way to tell a slow strict indexer from a slow fallback.
    announceProviderSelection(selection.candidates);
    for (const candidate of selection.candidates) {
      try {
        const { refresh, session } =
          await resolvedDependencies.collectProviderGraph(
            root,
            candidate,
            options,
          );
        const snapshot = refresh.snapshot;
        try {
          assertGraphSnapshotContract(
            snapshot,
            candidate.provider,
            candidate.languages,
            root,
          );
          // Closing a one-shot session is part of accepting its candidate. A
          // close failure declines it before its manifest or facts can enter
          // the aggregate. Resident candidates stay live only after the same
          // collision gate admits their source evidence.
          if (!options.keepAlive) await session.close();
          mergeProviderSourceDigests(strictDigests, snapshot.sources);
        } catch (error) {
          // `collectProviderGraph` has handed this live session to the
          // coordinator, but a rejected snapshot never enters `sessions`.
          // Close it here: otherwise a resident build falls through to the
          // generic lane while the invalid provider's child remains orphaned.
          try {
            await session.close();
          } catch (closeError) {
            throw new AggregateError(
              [error, closeError],
              "@samchon/graph: strict provider snapshot was refused and its unpublished session could not close",
            );
          }
          throw error;
        }
        appendAll(strictNodes, snapshot.nodes);
        appendAll(strictEdges, snapshot.edges);
        appendAll(diagnostics, snapshot.diagnostics);
        appendAll(warnings, snapshot.warnings);
        // The manifest names the files, and the provider owns the fact that it
        // does. Nothing reads their text here: the strict lane's facts are
        // already resolved, and the only thing the generic lane wanted text for
        // — deriving export edges — is work this provider has already done
        // against the real checker.
        provenance.push(dumpProvenanceOf(snapshot));
        modes.set(candidate.provider.name, refresh.mode);
        // A complete strict slice can legitimately contain no declarations.
        // The provider still answered for its languages, with provenance,
        // diagnostics, and an exact manifest. Counting nodes as proof that it
        // answered relabelled that valid empty slice as static fallback and
        // let a later resident generation change lane authority underneath the
        // same kept session.
        semanticSliceCount += 1;
        // A candidate may own more languages than its snapshot published — a
        // Clang provider asked for C and C++ can answer with only the
        // translation units it found. Whatever it did not publish falls to the
        // generic lane, and that has to be said: a caller who selected a
        // compiler-owned provider for C would otherwise be handed navigation
        // facts for it with nothing to distinguish them.
        const published = new Set(snapshot.languages);
        const unpublished = candidate.languages.filter(
          (language) => !published.has(language),
        );
        if (unpublished.length > 0) {
          warnings.push(
            `${unpublished.join(", ")}: the ${candidate.provider.name} ${candidate.provider.authority} provider owns these languages but published no slice for them, so they fall through to the generic language-server lane.`,
          );
        }
        for (const language of snapshot.languages) {
          strictLanguages.add(language);
          servedLanguages.add(language);
          // A multi-language provider is one session under several keys. The
          // map stays keyed by language because every consumer asks it a
          // language question; deduplication is the consumers' job and they do
          // it by session identity, not by key.
          if (options.keepAlive) {
            sessions.set(language, session);
            providers.set(language, candidate.provider);
          }
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        warnings.push(
          `${candidate.languages.join(", ")}: the ${candidate.provider.name} ${candidate.provider.authority} provider failed, so these languages fall through to the generic language-server lane: ${(error as Error).message}`,
        );
      }
    }

    for (const language of languages) {
      const files = selected.byLanguage.get(language) ?? [];
      if (files.length === 0) continue;
      if (strictLanguages.has(language)) continue;
      // Preparation belongs to the generic lane that consumes it. Running it
      // before strict-provider selection mutates/builds projects even when a
      // compiler-owned snapshot answers without clangd or Analysis Server.
      if (
        (language === "cpp" || language === "c") &&
        compileCommandsDir === undefined
      ) {
        compileCommandsDir = ensureCompileCommands(
          root,
          options.cmakeCommand,
        );
        if (compileCommandsDir !== undefined) {
          compileCommandsOwner = new TemporaryDirectoryOwner(
            compileCommandsDir,
          );
        }
      }
      if (language === "dart" && !pubPrepared) {
        ensurePubDeps(root, options.pubCommand);
        pubPrepared = true;
      }
      const spec = specOf(language);
      if (spec?.lsp === undefined) {
        warnings.push(`${language}: no built-in LSP server is configured.`);
        staticFallbackLanguages.push(language);
        continue;
      }
      const command = options.server ?? spec.lsp.command;
      const baseArgs =
        options.serverArgs ??
        (isTtscserverCommand(command)
          ? [...spec.lsp.args, "--cwd", root]
          : spec.lsp.args);
      // Appended regardless of a custom serverArgs override — which binary to
      // run and which compilation database to hint at are orthogonal, and a
      // test/user overriding serverArgs to swap the server binary should not
      // also have to know to re-specify this.
      const args =
        (language === "cpp" || language === "c") &&
        compileCommandsDir !== undefined
          ? [...baseArgs, `--compile-commands-dir=${compileCommandsDir}`]
          : baseArgs;
      const resolved = resolveCommand(command, root);
      if (resolved === undefined) {
        warnings.push(`${language}: LSP server not found on PATH: ${command}`);
        staticFallbackLanguages.push(language);
        continue;
      }
      // npm installs Windows servers as .cmd shims, which CreateProcess cannot
      // spawn directly; run those through cmd.exe so ttscserver,
      // pyright-langserver, and friends work from a plain package install.
      const spawnable = spawnableCommand(resolved, args);
      try {
        const { result, session } =
          await resolvedDependencies.collectLanguageGraph(
            root,
            language,
            spawnable.command,
            spawnable.args,
            files,
            options,
            spawnable.windowsVerbatimArguments,
          );
        if (options.keepAlive && compileCommandsOwner !== undefined) {
          compileCommandsOwner.attach(session.client);
        }
        if (result.nodes.length === 0) {
          warnings.push(
            `${language}: LSP returned no symbols; using static fallback.`,
          );
          staticFallbackLanguages.push(language);
          if (options.keepAlive) await session.client.close();
        } else {
          for (const opened of session.opened.values()) {
            sources.set(opened.abs, opened.text);
          }
          appendAll(nodes, result.nodes);
          appendAll(edges, result.edges);
          appendAll(diagnostics, result.diagnostics);
          appendAll(warnings, result.warnings);
          semanticSliceCount += 1;
          servedLanguages.add(language);
          if (options.keepAlive) sessions.set(language, session);
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        warnings.push(
          `${language}: LSP indexing failed: ${(error as Error).message}`,
        );
        staticFallbackLanguages.push(language);
      }
    }

    // The static lane is merged before the graph is finalized, not after: the
    // export surface is followed once across the whole project, so a barrel in one
    // lane can still publish a symbol declared in the other.
    if (staticFallbackLanguages.length > 0) {
      const fallback = staticGraphParts(
        {
          ...options,
          cwd: root,
          mode: "static",
          languages: staticFallbackLanguages,
        },
        filesForLanguages(selected, staticFallbackLanguages),
      );
      appendSources(sources, fallback.sources);
      for (const language of fallback.languages) servedLanguages.add(language);
      if (semanticSliceCount === 0) {
        const dump = staticDump(fallback, warnings);
        return {
          dump,
          warnings: dump.warnings,
          source: snapshotSource(),
          sources,
          ...(options.keepAlive ? { sessions, providers } : {}),
        };
      }
      appendAll(nodes, fallback.nodes);
      appendAll(edges, fallback.edges);
      appendAll(warnings, fallback.warnings);
    }

    if (semanticSliceCount === 0) {
      const fallback = staticGraphParts(options, selected.files);
      appendSources(sources, fallback.sources);
      const dump = staticDump(fallback, warnings);
      return {
        dump,
        warnings: dump.warnings,
        source: snapshotSource(),
        sources,
        ...(options.keepAlive ? { sessions, providers } : {}),
      };
    }

    const finalized = mergeGraphSlices({
      root,
      // Only generic lanes need source-derived export edges. Strict providers
      // already publish compiler-resolved exports, and their complete manifest
      // can contain external or virtual identities that must never be reopened.
      files: [...sources.keys()],
      genericNodes: nodes,
      genericEdges: edges,
      strictNodes,
      strictEdges,
    });
    warnings.push(...finalized.warnings);
    return {
      dump: {
        project: root,
        languages: languages.filter((language) => servedLanguages.has(language)),
        // Only a static fallback makes the graph a hybrid; a benign warning (e.g.
        // the reference cap) on a pure-LSP run must not relabel it.
        indexer: staticFallbackLanguages.length > 0 ? "hybrid" : "lsp",
        nodes: wireNodes(finalized.nodes),
        edges: wireEdges(finalized.edges, finalized.nodes),
        diagnostics,
        warnings,
        ...dumpProvenanceOf.fieldOf(provenance),
      },
      warnings,
      source: snapshotSource(),
      modes,
      sources,
      providerSourceDigests: strictDigests,
      ...(options.keepAlive ? { sessions, providers } : {}),
    };
  } catch (error) {
    const closeErrors = await closeKeptSessions(sessions);
    if (closeErrors.length > 0) {
      throw new AggregateError(
        [error, ...closeErrors],
        "@samchon/graph: indexing failed and accumulated sessions could not all close",
      );
    }
    throw error;
  /* c8 ignore start -- V8 reports a synthetic branch on `finally`; cleanup
   * itself runs on both the success and failure tests above. */
  } finally {
  /* c8 ignore stop */
    compileCommandsOwner?.seal();
  }
}

function filesForLanguages(
  selected: IGraphSourceSelection,
  languages: readonly GraphLanguage[],
): string[] {
  // A fallback language is added only after this exact selection supplied one
  // of its files, so each partition is present here.
  const allowed = new Set(
    languages.flatMap((language) => selected.byLanguage.get(language)!),
  );
  return selected.files.filter((file) => allowed.has(file));
}

async function closeKeptSessions(
  sessions: ReadonlyMap<GraphLanguage, ILspSession | IBulkGraphSession>,
): Promise<Error[]> {
  const failures: Error[] = [];
  for (const session of new Set(sessions.values())) {
    try {
      if (isBulkGraphSession(session)) await session.close();
      else await session.client.close();
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return failures;
}

/**
 * Open one strict provider candidate and take its first snapshot.
 *
 * The session is closed if refresh itself fails; after a successful refresh
 * the caller owns it until validation either rejects it or retains its slice.
 * That split keeps an invalid first snapshot from escaping cleanup before it
 * has ever reached the resident state.
 */
async function collectProviderGraph(
  root: string,
  candidate: selectGraphProviders.ICandidate,
  options: IBuildGraphOptions,
): Promise<{
  refresh: IBulkGraphSession.IRefresh;
  session: IBulkGraphSession;
}> {
  const session = candidate.provider.open({
    root,
    command: candidate.command,
    languages: candidate.languages,
    options,
  });
  try {
    assertBulkSessionContract(root, candidate, session);
    const refresh = await session.refresh({ signal: options.signal });
    if (session.current !== refresh.snapshot) {
      throw new Error(
        `@samchon/graph: provider "${candidate.provider.name}" returned a snapshot that is not its current generation`,
      );
    }
    if (session.generation !== refresh.generation) {
      throw new Error(
        `@samchon/graph: provider "${candidate.provider.name}" returned generation ${String(refresh.generation)} while its session reports ${String(session.generation)}`,
      );
    }
    return { refresh, session };
  } catch (error) {
    try {
      await session.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "@samchon/graph: strict provider refresh failed and its unpublished session could not close",
      );
    }
    throw error;
  }
}

/** A provider may not widen or move the candidate the registry selected. */
function assertBulkSessionContract(
  root: string,
  candidate: selectGraphProviders.ICandidate,
  session: IBulkGraphSession,
): void {
  const label = `@samchon/graph: provider "${candidate.provider.name}"`;
  if (!samePath(session.root, root)) {
    throw new Error(
      `${label} opened a session for ${session.root}, not the selected project ${root}`,
    );
  }
  const actual = JSON.stringify(
    [...new Set(session.languages)].sort(compareOrdinal),
  );
  const expected = JSON.stringify(
    [...candidate.languages].sort(compareOrdinal),
  );
  if (actual !== expected) {
    throw new Error(
      `${label} opened a session for [${session.languages.join(", ")}] after the registry selected [${candidate.languages.join(", ")}]`,
    );
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  // Only one arm runs on a given operating system.
  /* c8 ignore next 3 */
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function compareOrdinal(left: string, right: string): number {
  /* c8 ignore next 2 -- compared language names are distinct set members. */
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Every language fell back to the static parser: the dump is that parse. */
function staticDump(
  parts: IStaticGraphParts,
  warnings: readonly string[],
): ISamchonGraphDump & { warnings: string[] } {
  const finalized = finalizeGraph(
    parts.root,
    [...parts.sources.keys()],
    parts.nodes,
    parts.edges,
  );
  const dedupeWarnings = [...finalized.warnings];
  const nodes = dedupeNodes(finalized.nodes, (id, count) =>
    dedupeWarnings.push(
      `@samchon/graph: generic semantic declaration has ${count} locations; retaining canonical declaration and implementation spans: ${id}`,
    ),
  );
  return {
    project: parts.root,
    languages: parts.languages,
    indexer: "static",
    nodes: wireNodes(nodes),
    edges: wireEdges(dedupeEdges(finalized.edges), nodes),
    warnings: [...parts.warnings, ...warnings, ...dedupeWarnings],
  };
}

function appendSources(
  target: Map<string, string>,
  source: ReadonlyMap<string, string>,
): void {
  for (const [file, text] of source) target.set(file, text);
}

/**
 * Retain a generated compilation database until every clangd using it closes.
 *
 * clangd's global compilation database caches and refreshes this directory
 * throughout a resident session, and its background index lives beside it.
 * Deleting the directory after the first scan silently downgrades later edits.
 */
class TemporaryDirectoryOwner {
  private leases = 0;
  private sealed = false;
  private cleaned = false;

  public constructor(private readonly directory: string) {}

  public attach(client: ILspSession["client"]): void {
    this.leases += 1;
    const close = client.close.bind(client);
    let closing: Promise<void> | undefined;
    client.close = () => {
      closing ??= close().finally(() => {
        this.leases -= 1;
        this.cleanupIfReleased();
      });
      return closing;
    };
  }

  public seal(): void {
    this.sealed = true;
    this.cleanupIfReleased();
  }

  private cleanupIfReleased(): void {
    if (!this.sealed || this.leases !== 0 || this.cleaned) return;
    this.cleaned = true;
    fs.rmSync(this.directory, { recursive: true, force: true });
  }
}

// Opens a fresh LSP connection and hands back BOTH the extracted graph slice
// and the live session (opened files, diagnostics buffer). The caller decides
// whether to close the client (a one-shot `dump`) or keep it (a resident
// server, so `refreshLanguageSession` can reuse it later without paying
// `initialize` again — the dominant cost for servers like kotlin-language-server
// that resolve a whole Gradle project before answering it).
async function collectLanguageGraph(
  root: string,
  language: GraphLanguage,
  command: string,
  args: readonly string[],
  files: readonly string[],
  options: IBuildGraphOptions,
  windowsVerbatimArguments?: boolean,
): Promise<{
  result: {
    nodes: ISamchonGraphNode[];
    edges: ISamchonGraphEdge[];
    diagnostics: ISamchonGraphDiagnostic[];
    warnings: string[];
  };
  session: ILspSession;
}> {
  const session = await openLanguageSession(
    root,
    language,
    command,
    args,
    files,
    options,
    windowsVerbatimArguments,
  );
  let result: {
    nodes: ISamchonGraphNode[];
    edges: ISamchonGraphEdge[];
    diagnostics: ISamchonGraphDiagnostic[];
    warnings: string[];
  };
  try {
    result = await scanSession(session, options);
  } catch (error) {
    // A session that failed mid-scan is not safely reusable; close it
    // regardless of keepAlive so a later refresh starts a fresh one instead
    // of leaking this process.
    await session.client.close();
    throw error;
  }
  if (!options.keepAlive) await session.client.close();
  return { result, session };
}

async function openLanguageSession(
  root: string,
  language: GraphLanguage,
  command: string,
  args: readonly string[],
  files: readonly string[],
  options: IBuildGraphOptions,
  windowsVerbatimArguments?: boolean,
): Promise<ILspSession> {
  // Normal callers remain unlimited. Bounded callers such as the real-server
  // experiment can opt into a request deadline.
  const client = new LspClient(
    command,
    args,
    options.lspTimeoutMs,
    root,
    options.lspMaxMessageBytes,
    windowsVerbatimArguments,
  );
  const diagnostics = new Map<string, ISamchonGraphDiagnostic[]>();
  let lastProgressAt = 0;
  let progressVersion = 0;
  let lastLifecycleEndVersion = 0;
  const activeProgress = new Set<string | number>();
  client.onNotification("$/progress", (params) => {
    lastProgressAt = Date.now();
    progressVersion += 1;
    const progress = params as {
      token?: string | number;
      value?: { kind?: string };
    };
    if (
      typeof progress.token !== "string" &&
      typeof progress.token !== "number"
    ) {
      return;
    }
    if (progress.value?.kind === "begin") {
      activeProgress.add(progress.token);
    } else if (progress.value?.kind === "end") {
      activeProgress.delete(progress.token);
      lastLifecycleEndVersion = progressVersion;
    }
  });
  client.onNotification("textDocument/publishDiagnostics", (params) => {
    const typed = params as { uri?: string; diagnostics?: IDiagnostic[] };
    /* c8 ignore next */
    if (typed.uri === undefined || typed.diagnostics === undefined) return;
    const file = fileFromUri(typed.uri);
    /* c8 ignore next */
    if (!isSubPath(root, file)) return;
    const rel = projectRelative(root, file);
    // A `publishDiagnostics` notification is a *replacement* for the document it
    // names — that is what the protocol says it means — so it replaces. Appending
    // instead kept a re-analysed file's findings twice and a deleted file's
    // forever, and the dump became a function of the session's edit history
    // rather than of the source on disk.
    diagnostics.set(
      rel,
      typed.diagnostics.map((diagnostic) => convertDiagnostic(rel, diagnostic)),
    );
  });

  try {
    await client.request(
      "initialize",
      {
        processId: process.pid,
        rootUri: fileUri(root),
        initializationOptions: options.initializationOptions,
        capabilities: {
          window: { workDoneProgress: true },
          textDocument: {
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            references: { dynamicRegistration: false },
          },
        },
        workspaceFolders: [{ uri: fileUri(root), name: path.basename(root) }],
      },
      undefined,
      options.signal,
    );
    throwIfAborted(options.signal, "initialization");
    client.notify("initialized", {});

    const quietMs = options.lspReadyQuietMs ?? 1_500;
    const session: ILspSession = {
      client,
      root,
      language,
      opened: new Map(),
      diagnostics,
      progressVersion: () => progressVersion,
      waitForReady: (since, allowStart, signal) =>
        waitForIndexing(
          since,
          allowStart,
          () => progressVersion,
          () => lastProgressAt,
          () => lastLifecycleEndVersion,
          () => activeProgress.size,
          quietMs,
          options.lspReadyTimeoutMs,
          signal,
        ),
    };
    const didOpenFence = session.progressVersion!();
    await openFiles(session, files);

    // Wait for the server's initial indexing BEFORE asking for symbols. Servers
    // that load a project asynchronously differ in how they answer early
    // requests: jdtls blocks them (a longer request timeout suffices), but
    // csharp-ls answers documentSymbol with an empty list until its solution is
    // loaded — collecting symbols first would silently index nothing.
    //
    // The wait ends once progress goes quiet for `lspReadyQuietMs`. Its overall
    // ceiling is optional, so normal callers still wait as long as needed.
    await session.waitForReady!(didOpenFence, true, options.signal);
    return session;
  } catch (error) {
    // A server that never answers `initialize` (or fails before the session
    // is usable) still holds a live child process; nothing else references
    // this client yet, so this is the only place that can close it before
    // the failure propagates to the static fallback.
    await client.close();
    throw error;
  }
}

// Opens every file for a freshly-initialized session (its `opened` map always
// starts empty; a later refresh reconciles instead of calling this again).
async function openFiles(session: ILspSession, files: readonly string[]): Promise<void> {
  for (const abs of files) {
    const text = readText(abs);
    /* c8 ignore next */
    if (text === undefined) continue;
    const rel = projectRelative(session.root, abs);
    session.opened.set(rel, { abs, text, version: 1 });
    session.client.notify("textDocument/didOpen", {
      textDocument: {
        uri: fileUri(abs),
        languageId: languageIdOf(session.language),
        version: 1,
        text,
      },
    });
  }
}

async function waitForIndexing(
  since: number,
  allowStart: boolean,
  currentVersion: () => number,
  lastProgressAt: () => number,
  lastLifecycleEndVersion: () => number,
  activeProgressCount: () => number,
  quietMs: number,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const start = Date.now();
  // A work-done `begin` remains active until its matching `end`, even when the
  // server emits no intermediate reports for longer than `quietMs`. Cargo
  // metadata and source-root scans have exactly those silent phases; treating
  // the gap as readiness makes rust-analyzer return valid but empty reference
  // arrays and silently strips every semantic edge from the graph.
  //
  // Some servers only emit `report` notifications, so retain the quiet-period
  // fallback for progress without a lifecycle. A server that never emits
  // progress (lastProgressAt stays 0) is ready after its initial quiet fence.
  // An explicit timeout remains an overall ceiling for both forms.
  // `didOpen` is the one operation for which no progress yet is not evidence
  // of readiness: csharp-ls can begin solution loading more than a second
  // later. Its fence therefore waits one configured quiet window for a begin.
  // A lazy reference request uses `allowStart=false`; it waits only if the
  // request advanced the generation, avoiding another unconditional delay.
  for (;;) {
    throwIfAborted(signal, "indexing readiness");
    const now = Date.now();
    if (timeoutMs !== undefined && now - start >= timeoutMs) return;
    if (activeProgressCount() === 0) {
      // A matching lifecycle `end` is an explicit readiness signal; it does
      // not need an additional quiet delay after the server declared the work
      // complete.
      if (lastLifecycleEndVersion() > since) return;
      if (currentVersion() === since) {
        if (!allowStart || now - start >= quietMs) return;
      } else if (now - lastProgressAt() >= quietMs) return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  phase: string,
): void {
  if (signal?.aborted !== true) return;
  const error = new Error(`LSP request aborted: ${phase}`);
  error.name = "AbortError";
  throw error;
}

function convertDiagnostic(file: string, diagnostic: IDiagnostic): ISamchonGraphDiagnostic {
  return {
    file,
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    code: diagnostic.code ?? diagnostic.source ?? "unknown",
    message: diagnostic.message,
    severity: severityOf(diagnostic.severity),
  };
}

function severityOf(value: number | undefined): ISamchonGraphDiagnostic["severity"] {
  switch (value) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    case undefined:
      return undefined;
    /* c8 ignore next 2 */
    default:
      return undefined;
  }
}

function isTtscserverCommand(command: string): boolean {
  return /^ttscserver(?:\.(?:cmd|bat|exe))?$/i.test(path.basename(command));
}

// Resolve a server command to the concrete path PATH lookup would run, so the
// caller can see whether it is a .cmd/.bat shim that needs a cmd.exe wrapper.
function resolveCommand(command: string, root: string): string | undefined {
  if (
    path.isAbsolute(command) ||
    command.includes("/") ||
    command.includes("\\")
  ) {
    const resolved = path.resolve(root, command);
    return fs.existsSync(resolved) ? resolved : undefined;
  }
  /* c8 ignore start -- each CI operating system has exactly one command
   * lookup primitive, so no single run can enter both native arms. */
  const lookup =
    process.platform === "win32"
      ? spawnableCommand.windowsSystem("where.exe")
      : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  /* c8 ignore stop */
  const result = spawnSync(lookup, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(root, "node_modules", ".bin")}${path.delimiter}${
        /* c8 ignore next */
        process.env.PATH ?? ""
      }`,
    },
    shell: process.platform !== "win32",
    windowsHide: true,
  });
  if (result.status !== 0) return undefined;
  // `where` lists every shim: npm emits an extensionless sh script FIRST, then
  // the .cmd Windows can actually run. Rank Windows-executable extensions ahead
  // of the rest (branchlessly, so every platform exercises the same lines) and
  // take the winner.
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const executable = lines.filter((line) => /\.(exe|cmd|bat)$/i.test(line));
  return [...executable, ...lines][0];
}

/**
 * Name the providers about to run, on stderr, before any of them does.
 *
 * A build that finishes explains itself; a build that is killed explains
 * nothing, and the expensive cases are exactly the ones that get killed. One
 * line up front costs nothing and turns "this lane timed out" into "this lane
 * timed out running scip-ruby".
 *
 * stderr because stdout is the payload, and unconditional because a build with
 * no strict candidate is the case most worth being able to see.
 */
function announceProviderSelection(
  candidates: readonly { provider: { name: string }; languages: readonly GraphLanguage[] }[],
): void {
  const named =
    candidates.length === 0
      ? "no strict provider selected"
      : candidates
          .map(
            (candidate) =>
              `${candidate.provider.name}(${candidate.languages.join(",")})`,
          )
          .join(" ");
  process.stderr.write(`@samchon/graph: indexing with ${named}\n`);
}
