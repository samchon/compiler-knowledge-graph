import { TestValidator } from "@nestia/e2e";
import {
  JDT_GRAPH_PRODUCER_COMMIT,
  IJdtGraphSnapshot,
  JDT_GRAPH_PROVIDER,
  JdtGraphClient,
  JdtGraphSnapshotAdapter,
  assertGraphSnapshotContract,
  jdtGraphProvider,
  javaDeclarationSymbol,
  semanticGraphNodeId,
} from "@samchon/graph";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { GraphPaths } from "../internal/GraphPaths.js";

export const test_jdt_workspace_graph_is_bulk_atomic_and_fails_closed =
  async (): Promise<void> => {
    const root = GraphPaths.createTempDirectory("samchon-graph-jdt-");
    const source = path.join(root, "src", "Example.java");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(
      source,
      "package example; public final class Example { void run() {} }\n",
    );
    fs.writeFileSync(path.join(root, "src", "Zed.java"), "class Zed {}\n");

    await assertClientLifecycle(root, source);
    assertAdapterBoundaries(root, source);
  };

async function assertClientLifecycle(
  root: string,
  source: string,
): Promise<void> {
  const requestLog = path.join(root, "requests.ndjson");
  const marker = path.join(root, "closed.txt");
  let validations = 0;
  const client = new JdtGraphClient({
    root,
    command: process.execPath,
    args: [
      GraphPaths.fakeJdtGraphServer,
      `--request-log=${requestLog}`,
      `--marker=${marker}`,
    ],
    initializationOptions: { fixture: true },
    requestTimeoutMs: 10_000,
    maxMessageBytes: 16 * 1024 * 1024,
    validate: (snapshot) => {
      validations += 1;
      assertGraphSnapshotContract(
        snapshot,
        jdtGraphProvider,
        ["java"],
        root,
      );
    },
  });
  const active = new AbortController();
  const initial = await client.refresh({ signal: active.signal });
  const unchanged = await client.refresh();
  TestValidator.equals(
    "the JDT client publishes and reuses one compiler-owned workspace generation",
    [
      initial.changed,
      initial.mode,
      initial.generation,
      unchanged.changed,
      unchanged.mode,
      unchanged.snapshot === initial.snapshot,
      client.current === initial.snapshot,
      client.generation,
      initial.snapshot.provenance.provider,
      initial.snapshot.provenance.tool,
      initial.snapshot.coverage?.length,
      initial.snapshot.edges.map((edge) => edge.kind),
      initial.snapshot.diagnostics[0]?.severity,
      validations,
    ],
    [
      true,
      "initial",
      1,
      false,
      "unchanged",
      true,
      true,
      1,
      JDT_GRAPH_PROVIDER,
      IJdtGraphSnapshot.PRODUCER,
      15,
      ["contains", "contains"],
      "info",
      1,
    ],
  );
  TestValidator.predicate(
    "JDT declaration modifiers and structural ownership survive adaptation",
    initial.snapshot.nodes.some(
      (node) =>
        node.kind === "class" &&
        node.modifiers?.includes("readonly") === true,
    ) && initial.snapshot.nodes.some((node) => node.closure === true),
  );

  fs.writeFileSync(path.join(root, "src", "A.java"), "class A {}\n");
  fs.appendFileSync(source, "class Added {}\n");
  const incremental = await client.refresh();
  TestValidator.predicate(
    "a saved Java edit advances the resident generation incrementally",
    incremental.changed &&
      incremental.mode === "incremental" &&
      incremental.generation === 2 &&
      incremental.snapshot !== initial.snapshot,
  );
  fs.unlinkSync(source);
  const deleted = await client.refresh();
  TestValidator.predicate(
    "a deleted Java source leaves the resident generation without stale declarations",
    deleted.changed &&
      deleted.mode === "incremental" &&
      deleted.generation === 3 &&
      deleted.snapshot.nodes.length === 0,
  );
  fs.writeFileSync(
    source,
    "package example; public final class Example { void run() {} }\n",
  );
  const messages = fs
    .readFileSync(requestLog, "utf8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as { method?: string; params?: { command?: string } });
  TestValidator.equals(
    "each refresh asks for one bulk snapshot and never fans out by declaration",
    [
      messages.filter(
        (message) =>
          message.method === "workspace/executeCommand" &&
          message.params?.command === "java.graph.snapshot",
      ).length,
      messages.some((message) => message.method === "textDocument/references"),
      messages.some((message) => message.method === "textDocument/documentSymbol"),
      messages.filter(
        (message) => message.method === "workspace/didChangeWatchedFiles",
      ).length,
    ],
    [4, false, false, 3],
  );

  await Promise.all([client.close(), client.close()]);
  TestValidator.equals(
    "the JDT process closes through the LSP handshake",
    fs.readFileSync(marker, "utf8"),
    "closed",
  );
  await rejected(
    "a closed JDT session refuses refresh",
    client.refresh(),
    "session is closed",
  );

  const cancelled = new JdtGraphClient({
    root,
    command: process.execPath,
    args: [GraphPaths.fakeJdtGraphServer],
    validate: () => undefined,
  });
  const controller = new AbortController();
  controller.abort(new Error("caller stopped"));
  await rejected(
    "a pre-cancelled JDT refresh never enters the queue",
    cancelled.refresh({ signal: controller.signal }),
    "caller stopped",
  );
  await cancelled.close();

  await assertQueueCancellation(root, source);
  await assertInFlightCancellation(root);
  await assertInitializationFailure(root);
  await assertCommandCancellationRecovery(root);
  await assertInputMovementFence(root, source);
  await assertNonErrorValidationFailure(root);
  await assertRegisteredProvider(root);
}

async function assertQueueCancellation(root: string, source: string): Promise<void> {
  const client = directClient(root, ["--delay-command=100"]);
  const first = client.refresh();
  const controller = new AbortController();
  const queued = client.refresh({ signal: controller.signal });
  controller.abort(new Error("queued stop"));
  await rejected("a queued JDT refresh cancels before it starts", queued, "queued stop");
  await first;
  await client.close();
  TestValidator.predicate("the queue-cancellation fixture preserves its source", fs.existsSync(source));
}

async function assertInFlightCancellation(root: string): Promise<void> {
  const client = directClient(root, ["--delay-initialize=100"]);
  const controller = new AbortController();
  const pending = client.refresh({ signal: controller.signal });
  setTimeout(() => controller.abort(new Error("in-flight stop")), 10);
  await rejected("an in-flight JDT initialization observes caller cancellation", pending, "in-flight stop");
  await new Promise((resolve) => setTimeout(resolve, 120));
  await client.close();
}

async function assertInitializationFailure(root: string): Promise<void> {
  const client = directClient(root, ["--fail-initialize"]);
  const controller = new AbortController();
  await rejected(
    "an underlying JDT initialization failure wins the live caller signal race",
    client.refresh({ signal: controller.signal }),
    "fixture initialize failure",
  );
  await client.close();
}

async function assertCommandCancellationRecovery(root: string): Promise<void> {
  const requestLog = path.join(root, "command-cancel-requests.ndjson");
  const client = directClient(root, [
    "--delay-command=100",
    `--request-log=${requestLog}`,
  ]);
  const controller = new AbortController();
  const pending = client.refresh({ signal: controller.signal });
  await waitForRequest(requestLog, "workspace/executeCommand");
  controller.abort(new Error("command stop"));
  await rejected(
    "an in-flight JDT command observes caller cancellation",
    pending,
    "LSP request aborted: workspace/executeCommand",
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  const recovered = await client.refresh();
  TestValidator.equals(
    "a full unchanged producer snapshot resynchronizes after command cancellation",
    [
      recovered.changed,
      recovered.mode,
      recovered.generation,
      recovered.snapshot.protocol?.sequence,
      requestCount(requestLog, "workspace/didChangeWatchedFiles"),
    ],
    [true, "initial", 1, 1, 2],
  );
  await client.close();
}

async function assertInputMovementFence(root: string, source: string): Promise<void> {
  const requestLog = path.join(root, "input-fence-requests.ndjson");
  const client = directClient(root, [
    "--reuse-after-change",
    `--request-log=${requestLog}`,
  ]);
  await client.refresh();
  fs.appendFileSync(source, "// moved behind producer\n");
  await rejected(
    "a producer cannot reuse a generation after a watched source moves",
    client.refresh(),
    "watched Java inputs moved",
  );
  await rejected(
    "a stale producer remains fenced until it accepts the moved input",
    client.refresh(),
    "watched Java inputs moved",
  );
  TestValidator.equals(
    "the stale input notification is repeated until a generation accepts it",
    requestCount(requestLog, "workspace/didChangeWatchedFiles"),
    3,
  );
  fs.writeFileSync(
    source,
    "package example; public final class Example { void run() {} }\n",
  );
  await client.close();
}

async function assertNonErrorValidationFailure(root: string): Promise<void> {
  const requestLog = path.join(root, "validation-retry-requests.ndjson");
  let first = true;
  const client = directClient(root, [`--request-log=${requestLog}`], () => {
    if (!first) return;
    first = false;
    throw "fixture string failure";
  });
  await rejected(
    "a non-Error validation failure is still surfaced as an Error",
    client.refresh(),
    "fixture string failure",
  );
  const recovered = await client.refresh();
  TestValidator.equals(
    "a full unchanged producer snapshot resynchronizes after validation rejection",
    [
      recovered.changed,
      recovered.mode,
      recovered.generation,
      recovered.snapshot.protocol?.sequence,
      requestCount(requestLog, "workspace/didChangeWatchedFiles"),
    ],
    [true, "initial", 1, 1, 2],
  );
  await client.close();
}

async function assertRegisteredProvider(root: string): Promise<void> {
  const unconfigured = jdtGraphProvider.configuration?.(root, {});
  const configuration = jdtGraphProvider.configuration?.(root, {
    SAMCHON_GRAPH_JDT_WORKSPACE: process.execPath,
  });
  const resolved = jdtGraphProvider.resolve(root, {
    SAMCHON_GRAPH_JDT_WORKSPACE: process.execPath,
  });
  TestValidator.predicate(
    "the registered JDT route publishes its exact producer and override inputs",
    configuration?.[0] === `producer-commit=${JDT_GRAPH_PRODUCER_COMMIT}` &&
      configuration[1] === `SAMCHON_GRAPH_JDT_WORKSPACE=${process.execPath}` &&
      unconfigured?.[1] === "SAMCHON_GRAPH_JDT_WORKSPACE=unconfigured" &&
      resolved?.command === process.execPath,
  );
  TestValidator.predicate(
    "the registered JDT route accepts only whole-workspace requests",
    jdtGraphProvider.refuse({ cwd: root }) === undefined &&
      jdtGraphProvider
        .refuse({
          cwd: root,
          server: "jdtls",
          maxFiles: 1,
          lspReferenceLimit: 1,
        })
        ?.includes("server, maxFiles, lspReferenceLimit") === true,
  );
  const session = jdtGraphProvider.open({
    root,
    command: {
      command: process.execPath,
      args: [GraphPaths.fakeJdtGraphServer],
    },
    languages: ["java"],
    options: { cwd: root },
  });
  try {
    TestValidator.equals(
      "the registered JDT route enforces its compiler contract",
      (await session.refresh()).snapshot.provenance.provider,
      JDT_GRAPH_PROVIDER,
    );
  } finally {
    await session.close();
  }
}

function directClient(
  root: string,
  flags: string[],
  validate: ConstructorParameters<typeof JdtGraphClient>[0]["validate"] = () =>
    undefined,
): JdtGraphClient {
  return new JdtGraphClient({
    root,
    command: process.execPath,
    args: [GraphPaths.fakeJdtGraphServer, ...flags],
    validate,
  });
}

function assertAdapterBoundaries(root: string, source: string): void {
  fs.writeFileSync(
    path.join(root, "pom.xml"),
    "<project><modelVersion>4.0.0</modelVersion></project>\n",
  );
  const adapter = new JdtGraphSnapshotAdapter(root);
  const initial = rawSnapshot(root, source);
  const published = adapter.apply(initial, {
    validate: (snapshot) =>
      assertGraphSnapshotContract(
        snapshot,
        jdtGraphProvider,
        ["java"],
        root,
      ),
  });
  const singleSlash = rawSnapshot(root, source);
  const projectUri = singleSlashFileUri(root);
  const sourceUri = singleSlashFileUri(source);
  singleSlash.projects[0]!.location = projectUri;
  singleSlash.sources[0]!.uri = sourceUri;
  for (const node of singleSlash.nodes) {
    node.uri = sourceUri;
    node.evidence.uri = sourceUri;
  }
  for (const edge of singleSlash.edges) edge.evidence.uri = sourceUri;
  for (const diagnostic of singleSlash.diagnostics) {
    diagnostic.uri = sourceUri;
    diagnostic.evidence.uri = sourceUri;
  }
  TestValidator.predicate(
    "JDT single-slash file URIs resolve to the project files they name",
    new JdtGraphSnapshotAdapter(root)
      .apply(singleSlash)
      .snapshot.sources.has(path.normalize(source)),
  );
  const unchanged = structuredClone(initial);
  unchanged.mode = "unchanged";
  TestValidator.predicate(
    "the adapter reuses the exact object for an unchanged producer generation",
    adapter.apply(unchanged).snapshot === published.snapshot,
  );
  TestValidator.predicate(
    "the shared Java declaration key is signature-aware without using positions",
    javaDeclarationSymbol({
      kind: "method",
      name: "run",
      qualifiedName: "example.Example.run",
      signature: "(int):void",
    }).endsWith("|int") &&
      javaDeclarationSymbol({
        kind: "method",
        name: "run",
        qualifiedName: "example.Example.run(int)",
        displayName: "run(java.lang.String)",
      }).endsWith("|java.lang.String") &&
      javaDeclarationSymbol({
        kind: "class",
        name: "Example",
      }).endsWith("|Example|") &&
      javaDeclarationSymbol({
        kind: "method",
        name: "run",
        displayName: "run",
      }).endsWith("|run|") &&
      javaDeclarationSymbol({
        kind: "method",
        name: "run",
        signature: "run(",
      }).endsWith("|run|"),
  );

  const signed = rawSnapshot(root, source);
  signed.nodes[1]!.signature = "class Example";
  const signedSnapshot = new JdtGraphSnapshotAdapter(root).apply(signed).snapshot;
  const moduleRoot = path.join(root, "module");
  const moduleSource = path.join(moduleRoot, "src", "Example.java");
  fs.mkdirSync(path.dirname(moduleSource), { recursive: true });
  fs.writeFileSync(moduleSource, "package example; class Example {}\n");
  fs.writeFileSync(
    path.join(moduleRoot, "pom.xml"),
    "<project><modelVersion>4.0.0</modelVersion></project>\n",
  );
  const modular = rawSnapshot(root, moduleSource);
  modular.projects[0]!.location = pathToFileURL(moduleRoot).href;
  const moduleSnapshot = new JdtGraphSnapshotAdapter(root).apply(modular).snapshot;
  TestValidator.predicate(
    "persistent signatures and nested Maven project coordinates enter JDT identity",
    signedSnapshot.nodes.some(
      (node) => node.kind === "class" && node.signature === "class Example",
    ) &&
      moduleSnapshot.nodes.find((node) => node.kind === "class")?.id !==
        published.snapshot.nodes.find((node) => node.kind === "class")?.id,
  );

  const gradleRoot = path.join(root, "gradle");
  fs.mkdirSync(gradleRoot, { recursive: true });
  fs.writeFileSync(
    path.join(gradleRoot, "settings.gradle"),
    "rootProject.name = 'fixture'\ninclude 'module'\n",
  );
  fs.writeFileSync(path.join(gradleRoot, "build.gradle"), "plugins { id 'java' }\n");
  const gradleMain = path.join(
    gradleRoot,
    "src",
    "main",
    "java",
    "Example.java",
  );
  const gradleTest = path.join(
    gradleRoot,
    "src",
    "test",
    "java",
    "Example.java",
  );
  const gradleModule = path.join(
    gradleRoot,
    "module",
    "src",
    "main",
    "java",
    "Example.java",
  );
  for (const file of [gradleMain, gradleTest, gradleModule]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "package example; class Example {}\n");
  }
  fs.writeFileSync(
    path.join(gradleRoot, "module", "build.gradle"),
    "plugins { id 'java' }\n",
  );
  const gradleCases = [
    [gradleMain, ":compileJava"],
    [gradleTest, ":compileTestJava"],
    [gradleModule, ":module:compileJava"],
  ] as const;
  const gradleIds = gradleCases.map(([file]) => {
    const raw = rawSnapshot(gradleRoot, file);
    if (file === gradleModule) {
      raw.projects[0]!.location = pathToFileURL(
        path.join(gradleRoot, "module"),
      ).href;
    }
    const snapshot = new JdtGraphSnapshotAdapter(gradleRoot).apply(raw).snapshot;
    return snapshot.nodes.find((node) => node.kind === "class")?.id;
  });
  TestValidator.equals(
    "JDT derives the exact standard Gradle main, test and subproject task scopes",
    gradleIds,
    gradleCases.map(([, target]) => gradleJavaId(target)),
  );
  const gradleVariants = [
    ["settings-kts", "settings.gradle.kts", "src/main/java", ":compileJava"],
    ["build-only", "build.gradle", "src/main/java", ":compileJava"],
    ["build-kts-only", "build.gradle.kts", "src/test/java", ":compileTestJava"],
    ["custom-source", "build.gradle", "generated/java", "jdt:fixture"],
  ] as const;
  const variantIds = gradleVariants.map(
    ([name, buildFile, sourceDirectory]) => {
      const variantRoot = path.join(root, name);
      const variantSource = path.join(
        variantRoot,
        sourceDirectory,
        "Example.java",
      );
      fs.mkdirSync(path.dirname(variantSource), { recursive: true });
      fs.writeFileSync(variantSource, "package example; class Example {}\n");
      fs.writeFileSync(path.join(variantRoot, buildFile), "// fixture\n");
      const snapshot = new JdtGraphSnapshotAdapter(variantRoot).apply(
        rawSnapshot(variantRoot, variantSource),
      ).snapshot;
      return snapshot.nodes.find((node) => node.kind === "class")?.id;
    },
  );
  TestValidator.equals(
    "JDT recognizes both Gradle DSLs and declines custom task inference",
    variantIds,
    gradleVariants.map(([, , , target]) => gradleJavaId(target)),
  );

  const sameButIncremental = structuredClone(initial);
  sameButIncremental.mode = "incremental";
  TestValidator.predicate(
    "consumer history makes a repeated generation unchanged after producer cursor drift",
    adapter.apply(sameButIncremental).snapshot === published.snapshot,
  );
  const movedButUnchanged = movedSnapshot(initial);
  movedButUnchanged.mode = "unchanged";
  const resynchronized = adapter.apply(movedButUnchanged);
  TestValidator.predicate(
    "a full producer snapshot resynchronizes an unseen same-universe generation",
    resynchronized.changed && resynchronized.mode === "incremental",
  );

  const broken = structuredClone(initial);
  broken.complete = false;
  broken.mode = "error";
  broken.diagnostics = [
    {
      uri: pathToFileURL(source).href,
      severity: "error",
      code: "broken",
      message: "broken resident buffer",
      evidence: evidence(source),
    },
  ];
  refused(
    "an erroneous resident model retains the prior strict generation",
    () => adapter.apply(broken),
    "retained the prior strict generation",
  );
  TestValidator.predicate(
    "a refused JDT generation leaves current untouched",
    adapter.current === resynchronized.snapshot,
  );

  const moved = movedSnapshot(initial, "generation-three");
  moved.universe = digest("universe-two");
  const next = adapter.apply(moved);
  TestValidator.predicate(
    "a valid moved producer generation replaces current atomically",
    next.changed && next.mode === "reload" && adapter.current === next.snapshot,
  );

  const cases: Array<[string, (raw: IJdtGraphSnapshot) => unknown, string]> = [
    ["wrong schema", (raw) => (raw.schemaVersion = 2), "malformed producer snapshot"],
    ["wrong capability", (raw) => (raw.capabilities.resident = false), "incompatible capabilities"],
    ["duplicate project", (raw) => raw.projects.push(structuredClone(raw.projects[0]!)), "project universe"],
    ["bad source encoding", (raw) => (raw.sources[0]!.checkerEncoding = "utf8"), "source manifest"],
    ["duplicate symbol", (raw) => raw.nodes.push(structuredClone(raw.nodes[0]!)), "declaration"],
    ["absent edge endpoint", (raw) => (raw.edges[0]!.to = "missing"), "containment edge"],
    ["bad diagnostic", (raw) => (raw.diagnostics[0]!.severity = "error"), "completion state"],
    ["malformed diagnostic", (raw) => (raw.diagnostics[0]!.code = ""), "malformed diagnostic"],
    ["malformed evidence", (raw) => (raw.nodes[0]!.evidence = null as never), "malformed declaration"],
    ["foreign evidence", (raw) => {
      raw.nodes[0]!.evidence.uri = pathToFileURL(path.join(root, "src", "foreign.java")).href;
    }, "malformed declaration"],
    ["unresolved row", (raw) => raw.unresolved.push({}), "malformed producer snapshot"],
    ["escaped source", (raw) => {
      const outside = pathToFileURL(path.join(path.dirname(root), "outside.java")).href;
      raw.sources[0]!.uri = outside;
    }, "escaped the project root"],
  ];
  refused(
    "a non-object JDT response is refused",
    () => new JdtGraphSnapshotAdapter(root).apply(null),
    "not an object",
  );
  for (const [name, mutate, message] of cases) {
    const raw = rawSnapshot(root, source);
    mutate(raw);
    refused(name, () => new JdtGraphSnapshotAdapter(root).apply(raw), message);
  }
}

function rawSnapshot(root: string, source: string): IJdtGraphSnapshot {
  const uri = pathToFileURL(source).href;
  const file = "java/fixture/file/example";
  const type = "java/fixture/type/example.Example";
  const method = `${type}/method/run()`;
  const variable = `${method}/variable/value:int`;
  const location = evidence(source);
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    producer: {
      name: IJdtGraphSnapshot.PRODUCER,
      version: "1.50.0.fixture",
      compilerVersion: "21",
    },
    capabilities: {
      atomicGenerations: true,
      resident: true,
      sourceDigests: true,
      diskDigests: true,
      unsavedBuffers: true,
      diagnostics: true,
      facts: ["contains"],
    },
    universe: digest("universe"),
    generation: digest("generation-one"),
    complete: true,
    mode: "initial",
    sequence: 1,
    projects: [
      {
        name: "fixture",
        location: pathToFileURL(root).href,
        output: "/fixture/bin",
        compilerVersion: "21",
        options: {},
        classpath: [],
      },
    ],
    sources: [
      {
        project: "fixture",
        uri,
        checkerDigest: digest("checker"),
        checkerEncoding: IJdtGraphSnapshot.CHECKER_ENCODING,
        diskDigest: digest(fs.readFileSync(source)),
      },
    ],
    nodes: [
      rawNode(file, file, "persistent", uri, "Example.java", "", "file", "", "file", [], location),
      rawNode(type, "Lexample/Example;", "persistent", uri, "Example", "example.Example", "class", "", "type", ["public", "final"], location),
      rawNode(method, "Lexample/Example;.run()V", "structural", uri, "run", "example.Example.run", "method", "():void", "method", ["public"], location),
      rawNode(variable, "local#value", "generation", uri, "value", "", "variable", "int", "variable", [], location),
    ],
    edges: [
      { from: file, to: type, kind: "contains", evidence: location },
      { from: type, to: method, kind: "contains", evidence: location },
      { from: method, to: variable, kind: "contains", evidence: location },
    ],
    diagnostics: [
      {
        uri,
        severity: "warning",
        code: "fixture",
        message: "fixture warning",
        evidence: location,
      },
    ],
    coverage: { contains: "complete" },
    unresolved: [],
  };
}

function movedSnapshot(
  raw: IJdtGraphSnapshot,
  generation = "generation-two",
): IJdtGraphSnapshot {
  const moved = structuredClone(raw);
  moved.generation = digest(generation);
  moved.mode = "incremental";
  moved.sequence = 2;
  return moved;
}

function gradleJavaId(target: string): string {
  const symbol = javaDeclarationSymbol({
    kind: "class",
    name: "Example",
    qualifiedName: "example.Example",
  });
  return semanticGraphNodeId(
    {
      version: 2,
      language: "java",
      symbol,
      role: "class",
      native: { key: symbol, stability: "semantic" },
      scope: { target },
      stability: "persistent",
    },
    "example.Example",
  );
}

function rawNode(
  symbol: string,
  nativeKey: string,
  stability: IJdtGraphSnapshot.INode["stability"],
  uri: string,
  name: string,
  qualifiedName: string,
  kind: string,
  signature: string,
  declarationKind: string,
  modifiers: string[],
  location: IJdtGraphSnapshot.IEvidence,
): IJdtGraphSnapshot.INode {
  return {
    project: "fixture",
    symbol,
    nativeKey,
    stability,
    uri,
    name,
    qualifiedName,
    kind,
    signature,
    declarationKind,
    exported: modifiers.includes("public"),
    modifiers,
    evidence: location,
  };
}

function evidence(source: string): IJdtGraphSnapshot.IEvidence {
  return {
    uri: pathToFileURL(source).href,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 20,
  };
}

function singleSlashFileUri(file: string): string {
  return pathToFileURL(file).href.replace(/^file:\/\/\//u, "file:/");
}

function requestCount(file: string, method: string): number {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as { method?: string })
    .filter((message) => message.method === method).length;
}

async function waitForRequest(file: string, method: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (fs.existsSync(file) && requestCount(file, method) !== 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`fake JDT server did not receive ${method}`);
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function refused(name: string, closure: () => unknown, message: string): void {
  TestValidator.error(name, closure, (error) =>
    TestValidator.predicate(name, String(error).includes(message)),
  );
}

async function rejected(
  name: string,
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    TestValidator.predicate(name, String(error).includes(message));
    return;
  }
  throw new Error(`${name}: expected rejection`);
}
