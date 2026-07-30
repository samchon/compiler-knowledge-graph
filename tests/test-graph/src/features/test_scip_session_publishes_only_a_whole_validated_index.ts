import { TestValidator } from "@nestia/e2e";
import { ScipSession, scipProvider } from "@samchon/graph";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";

/**
 * A SCIP session publishes whole validated generations, or nothing.
 *
 * Every failure below leaves the previously published snapshot exactly where it
 * was, because a snapshot that is half of one index and half of another is not
 * a smaller answer — it is a wrong one that no reader can detect. The lifecycle
 * is exercised against a real child process rather than a stub: the paths worth
 * proving here are precisely the ones a stub would replace, from an artifact
 * that never appears to a child that ignores its first signal.
 */
export const test_scip_session_publishes_only_a_whole_validated_index =
  async () => {
    await assertGenerations();
    await assertFailuresRetainTheGeneration();
    await assertCloseOwnsItsChildren();
    await assertTheRegistryEntryItBuilds();
  };

/**
 * A SCIP indexer becomes a registry entry through one description.
 *
 * The ingestion, validation, and lifecycle are identical for every SCIP
 * indexer; only the executable, its arguments, and its build inputs differ. So
 * a language provider is a description rather than a class, and the entries
 * built from it cannot drift apart in the parts meant to be the same.
 */
async function assertTheRegistryEntryItBuilds(): Promise<void> {
  const root = GraphPaths.createTempDirectory("samchon-graph-scip-provider-");
  fs.writeFileSync(path.join(root, "main.go"), "package main\n");

  const provider = scipProvider({
    name: "scip-fake",
    languages: ["go"],
    buildInputs: ["go.mod"],
    resolve: () => ({
      command: process.execPath,
      args: [GraphPaths.fakeScipIndexer],
    }),
    decode: () => ({
      command: process.execPath,
      args: [GraphPaths.fakeScipDecoder],
    }),
    indexArgs: (artifact) => [`--output=${artifact}`, `--root=${root}`],
    inputs: () => ["main.go"],
    configuration: () => ["GOOS=fixture"],
    compilerVersion: () => "rustc fixture; cargo fixture",
    languageOf: () => "go",
  });

  TestValidator.equals(
    "a SCIP entry claims only what a bare index proves",
    [...provider.facts].sort(),
    ["contains", "references", "type_ref"],
  );
  TestValidator.equals(
    "…and grounds them in a semantic index by default",
    provider.authority,
    "semantic-index",
  );

  // A whole-workspace artifact has no bounded mode, so a cap is refused rather
  // than approximated — the same refusal the compiler-owned lane makes.
  TestValidator.equals(
    "an unbounded build is served",
    provider.refuse({}),
    undefined,
  );
  for (const bounded of [
    { maxFiles: 10 },
    { lspReferenceLimit: 5 },
    { server: "other" },
  ]) {
    TestValidator.predicate(
      `a bounded build is refused with its reason: ${Object.keys(bounded)[0]!}`,
      (provider.refuse(bounded) ?? "").includes(Object.keys(bounded)[0]!),
    );
  }
  TestValidator.predicate(
    "several refused options are named in one sentence",
    (provider.refuse({ maxFiles: 1, lspReferenceLimit: 2 }) ?? "").includes(
      "those options",
    ),
  );
  // A refusal has to say which grade of fact was given up, not merely which
  // program did not run — that is what a reader actually loses.
  TestValidator.predicate(
    "a refusal names the authority as well as the provider",
    (provider.refuse({ maxFiles: 1 }) ?? "").includes("semantic-index provider"),
  );

  const session = provider.open({
    root,
    command: provider.resolve(root, process.env)!,
    languages: ["go"],
    options: {},
  });
  const refresh = await session.refresh();
  TestValidator.equals(
    "the entry's session publishes the index",
    refresh.snapshot.nodes.map((node) => node.name),
    ["first"],
  );
  TestValidator.equals(
    "the snapshot is attributed to the registered entry",
    [
      refresh.snapshot.provenance.provider,
      refresh.snapshot.provenance.compilerVersion,
    ],
    ["scip-fake", "rustc fixture; cargo fixture"],
  );
  await session.close();

  const unconfigured = scipProvider({
    name: "scip-unconfigured",
    languages: ["go"],
    resolve: provider.resolve,
    decode: () => ({
      command: process.execPath,
      args: [GraphPaths.fakeScipDecoder],
    }),
    indexArgs: (artifact) => [`--output=${artifact}`, `--root=${root}`],
    inputs: () => ["main.go"],
    languageOf: () => "go",
  });
  const unconfiguredSession = unconfigured.open({
    root,
    command: unconfigured.resolve(root, process.env)!,
    languages: ["go"],
    options: {},
  });
  await unconfiguredSession.refresh();
  await unconfiguredSession.close();

  // An entry whose project needs preparing declines with the reason rather
  // than failing the build.
  const unprepared = scipProvider({
    name: "scip-unprepared",
    languages: ["rust"],
    resolve: () => ({ command: process.execPath, args: [] }),
    prepare: () => {
      throw new Error("no manifest");
    },
    decode: () => ({ command: process.execPath, args: [] }),
    indexArgs: () => [],
    inputs: () => [],
    languageOf: () => "rust",
  });
  TestValidator.predicate(
    "a preparation failure is a declared prepare hook",
    unprepared.prepare !== undefined,
  );
  TestValidator.error("…and it reports rather than swallowing", () =>
    unprepared.prepare!(root, {}),
  );
}

async function assertGenerations(): Promise<void> {
  const root = GraphPaths.createTempDirectory("samchon-graph-scip-session-");
  fs.writeFileSync(path.join(root, "main.go"), "package main\n");
  const state = path.join(root, "generation.txt");
  const session = sessionOf(root, { state });

  TestValidator.equals(
    "a session starts before its first generation",
    [session.generation, session.current],
    [0, undefined],
  );

  const initial = await session.refresh();
  TestValidator.equals(
    "the first index is the initial generation",
    [initial.changed, initial.generation, initial.mode],
    [true, 1, "initial"],
  );
  TestValidator.equals(
    "the index's declarations are published",
    initial.snapshot.nodes.map((node) => node.name),
    ["first"],
  );
  TestValidator.equals(
    "the slice owns exactly the session's languages",
    initial.snapshot.languages,
    ["go"],
  );
  TestValidator.equals(
    "the producer behind the facts is reported",
    [
      initial.snapshot.provenance.tool,
      initial.snapshot.provenance.toolVersion,
      initial.snapshot.provenance.provider,
      initial.snapshot.provenance.authority,
      initial.snapshot.provenance.protocolVersion,
    ],
    ["fake-scip", "1.2.3", "scip-fake", "semantic-index", 0],
  );
  const futureProtocol = sessionOf(root, { protocolVersion: 1 });
  const future = await futureProtocol.refresh();
  TestValidator.equals(
    "the producer's unknown numeric protocol reaches public provenance",
    future.snapshot.provenance.protocolVersion,
    1,
  );
  await futureProtocol.close();
  const namedRoot = GraphPaths.createTempDirectory(
    "samchon-graph-scip-protocol-",
  );
  fs.writeFileSync(path.join(namedRoot, "main.go"), "package main\n");
  for (const rejectedVersion of [
    "FutureProtocolVersion",
    "9007199254740992",
    "1",
  ]) {
    const named = sessionOf(namedRoot, {
      state: path.join(namedRoot, `${rejectedVersion}.txt`),
      protocolVersionName: "UnspecifiedProtocolVersion",
      nextProtocolVersionName: rejectedVersion,
    });
    const known = await named.refresh();
    TestValidator.equals(
      "a known named protocol reaches public provenance",
      known.snapshot.provenance.protocolVersion,
      0,
    );
    fs.appendFileSync(path.join(namedRoot, "main.go"), "// changed\n");
    await rejects(
      named.refresh(),
      `an unrepresentable protocol is rejected: ${rejectedVersion}`,
    );
    TestValidator.equals(
      "a rejected protocol leaves the whole prior generation published",
      [named.generation, named.current === known.snapshot],
      [1, true],
    );
    await named.close();
  }
  // The index carries no document text, so there is no honest checker digest
  // to give: hashing the disk here and calling it one would let a reader
  // "prove" byte-identity against text the facts were never computed from.
  const entry = initial.snapshot.sources.get(path.join(root, "main.go"));
  TestValidator.equals(
    "a textless index proves no checker digest",
    entry?.checkerDigest,
    "",
  );
  TestValidator.predicate(
    "…but still reports what is on disk",
    (entry?.diskDigest ?? "") !== "",
  );
  TestValidator.predicate(
    "…and does not claim the capability that would license the proof",
    !initial.snapshot.provenance.capabilities.includes("sourceDigests"),
  );
  TestValidator.predicate(
    "…and says so rather than staying quiet",
    initial.snapshot.warnings.some((warning) =>
      warning.includes("no document text"),
    ),
  );

  // Unchanged is a statement about the inputs, not a guess from a counter: the
  // indexer is not even run, because nothing it reads has moved.
  const unchanged = await session.refresh();
  TestValidator.equals(
    "an unmoved input set reuses the published generation",
    [unchanged.changed, unchanged.generation, unchanged.mode],
    [false, 1, "unchanged"],
  );
  TestValidator.predicate(
    "…and reuses the identical snapshot object",
    unchanged.snapshot === initial.snapshot,
  );
  TestValidator.equals(
    "the indexer was not run a second time",
    fs.readFileSync(state, "utf8").trim(),
    "1",
  );

  // The positive twin: an index that carries its document text can state the
  // bytes its facts came from, so the digest is real and the capability that
  // licenses a reader to use it is claimed.
  const textual = sessionOf(root, { withText: true });
  const proven = await textual.refresh();
  TestValidator.equals(
    "an index carrying its text proves a checker digest",
    proven.snapshot.sources.get(path.join(root, "main.go"))?.checkerDigest,
    createHash("sha256").update("package main\n", "utf8").digest("hex"),
  );
  TestValidator.predicate(
    "…and claims the capability that licenses the comparison",
    proven.snapshot.provenance.capabilities.includes("sourceDigests"),
  );
  await textual.close();

  // `""` is document text too: its SHA-256 is the proof for an empty source
  // file. Treating the empty string as if the indexer omitted the field makes
  // an otherwise complete snapshot quietly lose its source-digest capability.
  const emptyRoot = GraphPaths.createTempDirectory("samchon-graph-scip-empty-");
  fs.writeFileSync(path.join(emptyRoot, "main.go"), "");
  const emptyTextual = sessionOf(emptyRoot, { withText: true });
  const empty = await emptyTextual.refresh();
  TestValidator.equals(
    "an index carrying empty document text proves the empty-file digest",
    empty.snapshot.sources.get(path.join(emptyRoot, "main.go"))?.checkerDigest,
    createHash("sha256").update("", "utf8").digest("hex"),
  );
  TestValidator.predicate(
    "and licenses a reader to use that empty-file proof",
    empty.snapshot.provenance.capabilities.includes("sourceDigests"),
  );
  await emptyTextual.close();

  const partialRoot = GraphPaths.createTempDirectory(
    "samchon-graph-scip-partial-text-",
  );
  fs.writeFileSync(path.join(partialRoot, "main.go"), "package main\n");
  fs.writeFileSync(path.join(partialRoot, "other.go"), "package main\n");
  const partialTextual = sessionOf(partialRoot, {
    withText: true,
    partialText: true,
  });
  const partial = await partialTextual.refresh();
  TestValidator.equals(
    "partial document text licenses no row as producer-byte evidence",
    [
      ...partial.snapshot.sources.values(),
    ].map((source) => source.checkerDigest),
    ["", ""],
  );
  TestValidator.predicate(
    "partial document text omits the whole-snapshot source capability",
    !partial.snapshot.provenance.capabilities.includes("sourceDigests"),
  );
  await partialTextual.close();

  // A provider may retain and reuse its input list. The session needs a sorted
  // view for a stable fingerprint, but sorting that returned array changes the
  // provider's own declaration of its build inputs behind its back.
  const orderedRoot = GraphPaths.createTempDirectory(
    "samchon-graph-scip-order-",
  );
  fs.writeFileSync(path.join(orderedRoot, "main.go"), "package main\n");
  fs.writeFileSync(path.join(orderedRoot, "b.go"), "package second\n");
  const orderedInputs = ["main.go", "b.go"];
  const ordered = sessionOf(orderedRoot, { inputs: orderedInputs });
  await ordered.refresh();
  TestValidator.equals(
    "fingerprinting does not reorder the provider's retained input list",
    orderedInputs,
    ["main.go", "b.go"],
  );
  await ordered.close();

  // `toolInfo` is optional, and a plain absolute project root is as legal as a
  // `file://` URI. Neither may make the snapshot say less than it knows: it
  // names the provider itself when the index does not name a tool.
  const bare = sessionOf(root, { bare: true, plainRoot: true });
  const anonymous = await bare.refresh();
  TestValidator.equals(
    "a toolless index is attributed to the provider that ran it",
    [
      anonymous.snapshot.provenance.tool,
      anonymous.snapshot.provenance.toolVersion,
    ],
    ["scip-fake", ""],
  );
  await bare.close();

  // A failure that is not an Error still has to arrive as one: a caller cannot
  // read `.message` off a string.
  const rethrown = new ScipSession({
    root,
    languages: ["go"],
    provider: "scip-fake",
    authority: "semantic-index",
    command: { command: process.execPath, args: [] },
    decode: { command: process.execPath, args: [] },
    indexArgs: () => [],
    inputs: () => {
      throw "not an error object";
    },
    languageOf: () => "go",
  });
  let message: string | undefined;
  try {
    await rethrown.refresh();
  } catch (error) {
    message = (error as Error).message;
  }
  TestValidator.equals(
    "a non-Error failure is normalized before it reaches the caller",
    message,
    "not an error object",
  );
  await rethrown.close();

  // A build input outside the language's own extensions still moves the file
  // set, which is the whole reason the fingerprint covers it.
  fs.writeFileSync(path.join(root, "go.mod"), "module example\n");
  const rebuilt = await session.refresh();
  TestValidator.equals(
    "a moved build input rebuilds the generation",
    [rebuilt.changed, rebuilt.generation, rebuilt.mode],
    [true, 2, "rebuild"],
  );
  TestValidator.equals(
    "the new generation replaces the old declarations whole",
    rebuilt.snapshot.nodes.map((node) => node.name),
    ["second"],
  );
  await session.close();
}

async function assertFailuresRetainTheGeneration(): Promise<void> {
  const root = GraphPaths.createTempDirectory("samchon-graph-scip-failure-");
  fs.writeFileSync(path.join(root, "main.go"), "package main\n");

  const goJson = sessionOf(root, {
    goJson: true,
    projectRootFromInvocation: true,
  });
  TestValidator.equals(
    "an explicit snake_case project root survives invocation-root binding",
    (await goJson.refresh()).snapshot.nodes.map((node) => node.name),
    ["first"],
  );
  await goJson.close();

  // An indexer that exits non-zero.
  await rejects(
    sessionOf(root, { mode: "fail" }).refresh(),
    "a non-zero indexer exit rejects",
  );
  const silentFailure = sessionOf(root, { mode: "silent-fail" });
  let silentFailureMessage = "";
  try {
    await silentFailure.refresh();
  } catch (error) {
    silentFailureMessage = (error as Error).message;
  }
  // A tool that failed and said so on stdout. The java lane came back as
  // `scip-java: … exited with code 1` and nothing else, because scip-java runs
  // the project's Gradle build and Gradle reports on stdout — so the entire
  // explanation was captured and then dropped for arriving on the wrong stream.
  const loudFailure = sessionOf(root, { mode: "stdout-fail" });
  let loudFailureMessage = "";
  try {
    await loudFailure.refresh();
  } catch (error) {
    loudFailureMessage = (error as Error).message;
  }
  TestValidator.predicate(
    "a failure explained only on stdout still reaches the message",
    loudFailureMessage.includes("FAILURE: compilation failed") &&
      loudFailureMessage.includes("no stderr"),
  );
  // Bounded, and bounded from the end: a build prints its failure last, and
  // stdout is the artifact channel for some providers.
  TestValidator.predicate(
    "and is truncated to its tail rather than pasted whole",
    !loudFailureMessage.includes("OPENING LINE") &&
      loudFailureMessage.includes("…"),
  );
  // The ordinary shape: one line, nothing to cut. An ellipsis here would claim
  // the tool said more than it did, which is the same kind of untruth as
  // dropping what it said.
  const shortFailure = sessionOf(root, { mode: "short-stdout-fail" });
  let shortFailureMessage = "";
  try {
    await shortFailure.refresh();
  } catch (error) {
    shortFailureMessage = (error as Error).message;
  }
  TestValidator.predicate(
    "a short stdout failure is carried whole and unmarked",
    shortFailureMessage.endsWith("cannot open project") &&
      !shortFailureMessage.includes("…"),
  );
  TestValidator.predicate(
    "a silent non-zero exit has no invented stderr suffix",
    silentFailureMessage.endsWith("exited with code 3"),
  );
  await silentFailure.close();

  // An indexer that exits cleanly having written nothing. Decoding whatever
  // happened to be at that path would publish another run's facts.
  await rejects(
    sessionOf(root, { mode: "silent" }).refresh(),
    "a missing artifact rejects rather than decoding a stale one",
  );

  // A decoder that fails, and one that answers with something unparseable.
  await rejects(
    sessionOf(root, { decodeMode: "fail" }).refresh(),
    "a failed decode rejects",
  );
  await rejects(
    sessionOf(root, { decodeMode: "garbage" }).refresh(),
    "an undecodable answer rejects",
  );
  await rejects(
    sessionOf(root, {
      decodeMode: "invalid-metadata",
      projectRootFromInvocation: true,
    }).refresh(),
    "invocation-root binding refuses a malformed metadata block",
  );

  // An index produced for another checkout describes another program.
  await rejects(
    sessionOf(root, { indexRoot: "/somewhere/else" }).refresh(),
    "an index built for another project rejects",
  );
  const emptyRoot = sessionOf(root, { emptyRoot: true });
  await rejects(
    emptyRoot.refresh(),
    "an index with an explicit empty project root rejects",
  );
  await emptyRoot.close();

  // A document in a language this session does not own.
  const foreign = sessionOf(root, { language: "rust" });
  const adapted = await foreign.refresh();
  TestValidator.equals(
    "a document outside the session's languages contributes nothing",
    adapted.snapshot.nodes,
    [],
  );
  TestValidator.predicate(
    "…and says so",
    adapted.snapshot.warnings.some((warning) => warning.includes("does not own")),
  );
  await foreign.close();

  // A failure after a published generation must leave that generation alone.
  const state = path.join(root, "generation.txt");
  const session = sessionOf(root, { state });
  const initial = await session.refresh();
  fs.writeFileSync(path.join(root, "main.go"), "package main // edited\n");
  const broken = sessionOf(root, { decodeMode: "fail" });
  await rejects(broken.refresh(), "a later failure still rejects");
  TestValidator.predicate(
    "a rejected refresh leaves the published generation standing",
    session.current === initial.snapshot && session.generation === 1,
  );
  await session.close();
  await broken.close();

  // A closed session answers, rather than starting another child.
  await rejects(session.refresh(), "a closed session refuses to refresh");
}

async function assertCloseOwnsItsChildren(): Promise<void> {
  const root = GraphPaths.createTempDirectory("samchon-graph-scip-close-");
  fs.writeFileSync(path.join(root, "main.go"), "package main\n");

  // A child that ignores its first signal must not hold shutdown open. The
  // refresh is left in flight on purpose: close is what has to reach it.
  const hung = sessionOf(root, { mode: "hang" });
  const pending = hung.refresh().catch(() => undefined);
  await settle();
  const closed = hung.close();
  // Idempotent by contract, and the second caller must wait for the same
  // shutdown rather than observing an already-emptied child set and returning
  // before those children exit.
  TestValidator.predicate("close is idempotent", hung.close() === closed);
  await closed;
  await pending;

  // A session that owns no language cannot be selected, so it cannot exist.
  TestValidator.error("a session must own at least one language", () =>
    sessionOf(root, { languages: [] }),
  );
  TestValidator.error("a zero output bound is refused", () =>
    sessionOf(root, { maxStdoutBytes: 0 }),
  );
  TestValidator.error("a fractional output bound is refused", () =>
    sessionOf(root, { maxStdoutBytes: 1.5 }),
  );
  TestValidator.error("a zero artifact bound is refused", () =>
    sessionOf(root, { maxArtifactBytes: 0 }),
  );
  TestValidator.error("a fractional artifact bound is refused", () =>
    sessionOf(root, { maxArtifactBytes: 1.5 }),
  );

  // An executable that is not there fails to spawn rather than exiting.
  const missing = new ScipSession({
    root,
    languages: ["go"],
    provider: "scip-missing",
    authority: "semantic-index",
    command: { command: path.join(root, "not-an-executable"), args: [] },
    decode: { command: process.execPath, args: [] },
    indexArgs: () => [],
    inputs: () => ["main.go"],
    languageOf: () => "go",
  });
  await rejects(missing.refresh(), "an unspawnable indexer rejects");
  await missing.close();

  const bounded = sessionOf(root, { maxStdoutBytes: 32 });
  await rejects(
    bounded.refresh(),
    "decoded SCIP output larger than the configured bound is refused",
  );
  TestValidator.equals(
    "a bounded-conversion failure publishes no generation",
    [bounded.generation, bounded.current],
    [0, undefined],
  );
  await bounded.close();

  const artifactBounded = sessionOf(root, { maxArtifactBytes: 1 });
  await rejects(
    artifactBounded.refresh(),
    "a SCIP artifact larger than the configured bound is refused before decoding",
  );
  TestValidator.equals(
    "an oversized artifact publishes no generation",
    [artifactBounded.generation, artifactBounded.current],
    [0, undefined],
  );
  await artifactBounded.close();

  // A signal can already be cancelled before a refresh reaches the session.
  // Starting a child in that state is wrong on its own, and a hanging indexer
  // would never see an event that was dispatched before its listener existed.
  const preAborted = sessionOf(root, { mode: "hang" });
  const preAbortedController = new AbortController();
  preAbortedController.abort();
  let preAbortedName: string | undefined;
  try {
    await preAborted.refresh({ signal: preAbortedController.signal });
  } catch (error) {
    preAbortedName = (error as Error).name;
  }
  TestValidator.equals(
    "an already-aborted refresh does not start an indexer",
    preAbortedName,
    "AbortError",
  );
  await preAborted.close();

  // Cancellation can land after refresh admitted the transaction but while it
  // is still forming the first child invocation. The spawn-boundary check must
  // refuse that child just as decisively as an already-cancelled refresh.
  const boundaryController = new AbortController();
  const boundary = sessionOf(root, {
    onIndexArgs: () => boundaryController.abort(),
  });
  let boundaryName: string | undefined;
  try {
    await boundary.refresh({ signal: boundaryController.signal });
  } catch (error) {
    boundaryName = (error as Error).name;
  }
  TestValidator.equals(
    "an abort at the process handoff spawns no indexer",
    [boundaryName, boundary.generation, boundary.current],
    ["AbortError", 0, undefined],
  );
  await boundary.close();

  let admissionName: string | undefined;
  const admission = sessionOf(root);
  try {
    await admission.refresh({ signal: abortsOnRead(2) });
  } catch (error) {
    admissionName = (error as Error).name;
  }
  TestValidator.equals(
    "an abort after queue admission stops before fingerprinting",
    [admissionName, admission.generation],
    ["AbortError", 0],
  );
  await admission.close();

  let listenerRaceName: string | undefined;
  const listenerRace = sessionOf(root);
  try {
    await listenerRace.refresh({ signal: abortsOnRead(4) });
  } catch (error) {
    listenerRaceName = (error as Error).name;
  }
  TestValidator.equals(
    "an abort between spawn and listener registration retires the child",
    [listenerRaceName, listenerRace.generation],
    ["AbortError", 0],
  );
  await listenerRace.close();

  // An aborted producer is the one failure that never explains itself
  // otherwise. Its snapshot is never published, so its warnings are never
  // printed, and the buffered output dies with the process holding it — two
  // benchmark lanes reached an hour cap four complete runs running and left the
  // provider's name and nothing else. Whatever the producer had already said
  // has to survive the abort that killed it.
  const announced = path.join(root, "announced.txt");
  const speaking = sessionOf(root, {
    mode: "hang",
    announce: "scip-fake: resolving 412 of 1204 translation units",
    announceSentinel: announced,
  });
  const speakingController = new AbortController();
  let speakingError: Error | undefined;
  const speakingRefresh = speaking
    .refresh({ signal: speakingController.signal })
    .catch((error: unknown) => {
      speakingError = error as Error;
      return undefined;
    });
  // Waited on the producer's own sentinel rather than on a clock. Aborting
  // after a fixed delay races the child's start-up and loses on a loaded
  // Windows runner, where the job object kills with none of the grace POSIX
  // gives — a red suite on a correct build.
  //
  // The bound is not a second clock to race. It exists so a fixture that stops
  // writing the sentinel at all fails as one assertion instead of hanging until
  // the job's own limit kills the whole suite, which says far less. Its budget
  // is an order of magnitude above what the gated spawn actually costs, so the
  // sentinel decides when this proceeds and the bound only decides how a broken
  // fixture is reported.
  for (
    let waited = 0;
    waited < 3_000 && !fs.existsSync(announced);
    waited += 10
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  speakingController.abort();
  await speakingRefresh;
  TestValidator.equals(
    "an aborted producer keeps the diagnosis it had already written",
    [
      speakingError?.name,
      speakingError?.message.includes("resolving 412 of 1204") === true,
    ],
    ["AbortError", true],
  );
  await speaking.close();

  // The same producer after an hour of it. A run that reaches a cap has usually
  // filled the whole stderr buffer, and the end of that is the part that says
  // where it had got to — so the message keeps the tail, drops the head, and
  // stays a size a log can hold.
  const flooded = path.join(root, "flooded.txt");
  const floodedSession = sessionOf(root, {
    mode: "hang",
    announce: `${"unit ".repeat(600)}LAST UNIT`,
    announceSentinel: flooded,
  });
  const floodedController = new AbortController();
  let floodedError: Error | undefined;
  const floodedRefresh = floodedSession
    .refresh({ signal: floodedController.signal })
    .catch((error: unknown) => {
      floodedError = error as Error;
      return undefined;
    });
  for (
    let waited = 0;
    waited < 3_000 && !fs.existsSync(flooded);
    waited += 10
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  floodedController.abort();
  await floodedRefresh;
  const floodedMessage = floodedError?.message ?? "";
  TestValidator.equals(
    "a flooded producer keeps its last words and not its first",
    [
      floodedError?.name,
      floodedMessage.includes("LAST UNIT"),
      floodedMessage.includes("…"),
      floodedMessage.length < 2_200,
    ],
    ["AbortError", true, true, true],
  );
  await floodedSession.close();

  const unchangedAborted = sessionOf(root);
  await unchangedAborted.refresh();
  const unchangedController = new AbortController();
  unchangedController.abort();
  let unchangedAbortName: string | undefined;
  try {
    await unchangedAborted.refresh({ signal: unchangedController.signal });
  } catch (error) {
    unchangedAbortName = (error as Error).name;
  }
  TestValidator.equals(
    "an aborted unchanged poll rejects instead of reusing the snapshot",
    unchangedAbortName,
    "AbortError",
  );
  await unchangedAborted.close();

  // An aborted refresh reaches the child it started, and rejects as an abort
  // rather than as the exit code killing it happens to produce.
  const aborted = sessionOf(root, { mode: "hang" });
  const controller = new AbortController();
  const inFlight = aborted.refresh({ signal: controller.signal });
  await settle();
  controller.abort();
  const abortedClose = aborted.close();
  let name: string | undefined;
  try {
    await inFlight;
  } catch (error) {
    name = (error as Error).name;
  }
  TestValidator.equals("an aborted refresh rejects as an abort", name, "AbortError");
  await abortedClose;

  const queued = sessionOf(root, { mode: "hang" });
  const blocker = queued.refresh().catch(() => undefined);
  await settle();
  const queuedController = new AbortController();
  const cancelled = queued.refresh({ signal: queuedController.signal });
  queuedController.abort();
  let queuedName: string | undefined;
  try {
    await cancelled;
  } catch (error) {
    queuedName = (error as Error).name;
  }
  const queuedClose = queued.close();
  await blocker;
  await queuedClose;
  await settle();
  TestValidator.equals(
    "a queued refresh cancelled before its task starts stays cancelled",
    queuedName,
    "AbortError",
  );

  const movingRoot = GraphPaths.createTempDirectory(
    "samchon-graph-scip-moving-input-",
  );
  fs.writeFileSync(path.join(movingRoot, "main.go"), "package main\n");
  const moving = sessionOf(movingRoot, { mutateInput: "main.go" });
  await rejects(
    moving.refresh(),
    "an input changed by the indexer run cannot publish under the earlier fingerprint",
  );
  TestValidator.equals(
    "a moved-input failure retains the unpublished generation",
    [moving.generation, moving.current],
    [0, undefined],
  );
  await moving.close();

  // Closing while a refresh is queued behind another makes the queued one find
  // the session already closed.
  const racing = sessionOf(root, { mode: "hang" });
  const first = racing.refresh().catch(() => undefined);
  const second = racing.refresh().catch((error: Error) => error.message);
  await settle();
  await racing.close();
  await first;
  TestValidator.predicate(
    "a refresh queued across a close is told the session is closed",
    ((await second) ?? "").includes("closed"),
  );
}

interface IFixtureOptions {
  state?: string;
  mode?: string;
  decodeMode?: string;
  indexRoot?: string;
  withText?: boolean;
  partialText?: boolean;
  emptyRoot?: boolean;
  inputs?: string[];
  bare?: boolean;
  plainRoot?: boolean;
  language?: "go" | "rust";
  languages?: ("go" | "rust")[];
  mutateInput?: string;
  goJson?: boolean;
  protocolVersion?: number;
  protocolVersionName?: string;
  nextProtocolVersionName?: string;
  projectRootFromInvocation?: boolean;
  maxStdoutBytes?: number;
  maxArtifactBytes?: number;
  onIndexArgs?: () => void;
  announce?: string;
  announceSentinel?: string;
}

function sessionOf(root: string, options: IFixtureOptions = {}): ScipSession {
  return new ScipSession({
    root,
    languages: options.languages ?? [options.language ?? "go"],
    provider: "scip-fake",
    authority: "semantic-index",
    command: {
      command: process.execPath,
      args: [GraphPaths.fakeScipIndexer],
    },
    decode: {
      command: process.execPath,
      args: [
        GraphPaths.fakeScipDecoder,
        ...(options.decodeMode === undefined
          ? []
          : [`--mode=${options.decodeMode}`]),
      ],
    },
    indexArgs: (artifact) => {
      options.onIndexArgs?.();
      return [
        `--output=${artifact}`,
        `--root=${options.indexRoot ?? root}`,
        ...(options.mode === undefined ? [] : [`--mode=${options.mode}`]),
        ...(options.withText === true ? ["--with-text"] : []),
        ...(options.partialText === true ? ["--partial-text"] : []),
        ...(options.emptyRoot === true ? ["--empty-root"] : []),
        ...(options.bare === true ? ["--no-tool-info"] : []),
        ...(options.plainRoot === true ? ["--plain-root"] : []),
        ...(options.goJson === true ? ["--go-json"] : []),
        ...(options.protocolVersion === undefined
          ? []
          : [`--protocol-version=${options.protocolVersion}`]),
        ...(options.protocolVersionName === undefined
          ? []
          : [`--protocol-version-name=${options.protocolVersionName}`]),
        ...(options.nextProtocolVersionName === undefined
          ? []
          : [`--next-protocol-version-name=${options.nextProtocolVersionName}`]),
        ...(options.state === undefined ? [] : [`--state=${options.state}`]),
        ...(options.mutateInput === undefined
          ? []
          : [`--mutate=${options.mutateInput}`]),
        ...(options.announce === undefined
          ? []
          : [
              `--announce=${options.announce}`,
              ...(options.announceSentinel === undefined
                ? []
                : [`--announce-sentinel=${options.announceSentinel}`]),
            ]),
      ];
    },
    inputs: () =>
      options.inputs ??
      fs
        .readdirSync(root)
        .filter((entry) => entry.endsWith(".go") || entry === "go.mod"),
    languageOf: () => "go",
    ...(options.projectRootFromInvocation === true
      ? { projectRootFromInvocation: true }
      : {}),
    ...(options.maxStdoutBytes === undefined
      ? {}
      : { maxStdoutBytes: options.maxStdoutBytes }),
    ...(options.maxArtifactBytes === undefined
      ? {}
      : { maxArtifactBytes: options.maxArtifactBytes }),
  });
}

async function rejects(task: Promise<unknown>, label: string): Promise<void> {
  let failed = false;
  try {
    await task;
  } catch {
    failed = true;
  }
  TestValidator.predicate(label, failed);
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

/** A deterministic signal for the two synchronous cancellation handoffs. */
function abortsOnRead(abortedAt: number): AbortSignal {
  let reads = 0;
  return {
    get aborted() {
      reads += 1;
      return reads >= abortedAt;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as AbortSignal;
}
