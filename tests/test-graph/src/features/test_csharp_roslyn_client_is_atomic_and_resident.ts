import { TestValidator } from "@nestia/e2e";
import {
  CSHARP_ROSLYN_PRODUCER,
  CSHARP_ROSLYN_PROVIDER,
  CsharpGraphClient,
  csharpGraphProvider,
} from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths.js";

/** The Roslyn adapter keeps compiler generations atomic across every client boundary. */
export const test_csharp_roslyn_client_is_atomic_and_resident = async () => {
  const root = GraphPaths.createTempDirectory("samchon-graph-csharp-client-");
  fs.writeFileSync(path.join(root, "Program.cs"), "namespace Fixture; public class Program {}\n");
  fs.writeFileSync(
    path.join(root, "Fixture.csproj"),
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n',
  );

  await assertResidentLifecycle(root);
  await assertIncrementalLifecycle(root);
  await assertFullTransactionModes(root);
  await assertRetryAndCancellation(root);
  await assertAtomicRefusals(root);
  await assertProviderContract(root);
};

async function assertResidentLifecycle(root: string): Promise<void> {
  const marker = path.join(root, "closed.txt");
  const requestLog = path.join(root, "resident.ndjson");
  const client = directClient(root, [
    `--marker=${marker}`,
    `--request-log=${requestLog}`,
    "--expect-initialization-options",
  ], () => undefined, { fixture: true });
  const initial = await withRoslynTrace(() => client.refresh());
  const unchanged = await client.refresh();
  const requests = readRequests(requestLog);
  TestValidator.equals(
    "a resident Roslyn client commits once and reuses the exact immutable snapshot",
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
      requests.filter((message) => message.method === "initialize").length,
      requests
        .filter((message) => message.method === "workspace/executeCommand")
        .map((message) => message.params?.arguments?.[0]?.knownGeneration === null),
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
      CSHARP_ROSLYN_PROVIDER,
      CSHARP_ROSLYN_PRODUCER,
      1,
      [true, false],
    ],
  );
  await Promise.all([client.close(), client.close()]);
  TestValidator.equals(
    "the resident Roslyn process closes through the LSP handshake",
    fs.readFileSync(marker, "utf8"),
    "closed",
  );
  await rejected("a closed Roslyn session refuses refresh", client.refresh(), "session is closed");
}

async function assertIncrementalLifecycle(root: string): Promise<void> {
  const client = directClient(root, ["--change"]);
  const initial = await client.refresh();
  const edited = await client.refresh();
  const unchanged = await client.refresh();
  TestValidator.equals(
    "same-universe Roslyn changes replace one shard and then become a no-op",
    [
      edited.changed,
      edited.mode,
      edited.generation,
      edited.snapshot.nodes.map((node) => node.name),
      edited.snapshot.protocol?.baseGeneration,
      edited.snapshot.protocol?.sequence,
      unchanged.changed,
      unchanged.snapshot === edited.snapshot,
    ],
    [
      true,
      "incremental",
      2,
      ["edited"],
      initial.snapshot.protocol?.generation,
      2,
      false,
      true,
    ],
  );
  await client.close();

  let reject = true;
  const replayed = directClient(root, [], () => {
    if (reject) {
      reject = false;
      throw "fixture validation rejection";
    }
  });
  await rejected(
    "consumer validation rejects a complete generation before publication",
    replayed.refresh(),
    "fixture validation rejection",
  );
  TestValidator.predicate(
    "a rejected Roslyn generation leaves no partial current state",
    replayed.current === undefined && replayed.generation === 0,
  );
  const recovered = await replayed.refresh();
  TestValidator.predicate(
    "the producer replays a full frame transaction after consumer rejection",
    recovered.mode === "initial" && recovered.generation === 1,
  );
  await replayed.close();
}

async function assertFullTransactionModes(root: string): Promise<void> {
  for (const mode of ["reload", "rebuild"] as const) {
    const client = directClient(root, [`--transition=${mode}`]);
    const initial = await client.refresh();
    const transitioned = await client.refresh();
    const unchanged = await client.refresh();
    TestValidator.predicate(
      `${mode} is accepted only as a full transaction with the expected universe relation`,
      initial.mode === "initial" &&
        transitioned.mode === mode &&
        transitioned.snapshot.protocol?.baseGeneration === undefined &&
        unchanged.mode === "unchanged" &&
        unchanged.snapshot === transitioned.snapshot,
    );
    await client.close();
  }
  for (const transition of ["reload-nonfull", "stale-base"] as const) {
    const client = directClient(root, [`--transition=${transition}`]);
    await client.refresh();
    await rejected(
      `${transition} is not a valid transaction mode`,
      client.refresh(),
      "response mode disagrees",
    );
    await client.close();
  }
}

async function assertRetryAndCancellation(root: string): Promise<void> {
  const retried = directClient(root, ["--content-modified=1"]);
  TestValidator.equals(
    "content movement is retried inside the Roslyn client",
    (await retried.refresh()).mode,
    "initial",
  );
  await retried.close();

  const bounded = directClient(root, ["--content-modified=20"], () => undefined, undefined, {
    readyTimeoutMs: 1,
  });
  await rejected(
    "a caller may bound how long a moving Solution is retried",
    bounded.refresh(),
    "did not settle within 1 ms",
  );
  await bounded.close();

  const signaled = directClient(root);
  const liveSignal = new AbortController();
  TestValidator.equals(
    "a live caller signal races initialization without changing its result",
    (await signaled.refresh({ signal: liveSignal.signal })).mode,
    "initial",
  );
  await signaled.close();

  const failedInitialization = directClient(root, ["--initialize-error"]);
  await rejected(
    "a signal-wrapped initialization surfaces the producer rejection",
    failedInitialization.refresh({ signal: new AbortController().signal }),
    "fixture initialize failure",
  );
  await failedInitialization.close();

  const initializeLog = path.join(root, "cancel-initialize.ndjson");
  const hangingInitialization = directClient(root, [
    "--hang-initialize",
    `--request-log=${initializeLog}`,
  ]);
  const initializeController = new AbortController();
  const initializing = hangingInitialization.refresh({
    signal: initializeController.signal,
  });
  await waitForRequest(initializeLog, "initialize");
  initializeController.abort(new Error("initialize stop"));
  await rejected(
    "caller cancellation wins a pending Roslyn initialization race",
    initializing,
    "initialize stop",
  );
  await hangingInitialization.close();

  const retryLog = path.join(root, "cancel-retry.ndjson");
  const moving = directClient(root, [
    "--content-modified=20",
    `--request-log=${retryLog}`,
  ]);
  const retryController = new AbortController();
  const retrying = moving.refresh({ signal: retryController.signal });
  await waitForRequest(retryLog, "workspace/executeCommand");
  await new Promise((resolve) => setTimeout(resolve, 5));
  retryController.abort(new Error("retry stop"));
  await rejected(
    "caller cancellation interrupts the content-movement retry delay",
    retrying,
    "retry stop",
  );
  await moving.close();

  const requestLog = path.join(root, "cancel.ndjson");
  const hanging = directClient(root, ["--hang", `--request-log=${requestLog}`]);
  const active = hanging.refresh();
  const activeResult = active.catch((error: unknown) => error);
  await waitForRequest(requestLog, "workspace/executeCommand");
  const queuedController = new AbortController();
  const queued = hanging.refresh({ signal: queuedController.signal });
  queuedController.abort(new Error("queued stop"));
  await rejected("a queued Roslyn refresh observes caller cancellation", queued, "queued stop");
  await hanging.close();
  TestValidator.predicate(
    "closing the session cancels its active Roslyn request",
    String(await activeResult).includes("LSP request aborted"),
  );

  const aborted = new AbortController();
  aborted.abort(new Error("already stopped"));
  const fresh = directClient(root);
  await rejected(
    "an already-cancelled caller never enters the resident queue",
    fresh.refresh({ signal: aborted.signal }),
    "already stopped",
  );
  await fresh.close();
}

async function assertAtomicRefusals(root: string): Promise<void> {
  const cases = [
    ["envelope", "malformed producer envelope"],
    ["mode", "response mode disagrees"],
    ["initial-base", "response mode disagrees"],
    ["sequence", "envelope disagrees"],
    ["generation", "envelope disagrees"],
    ["universe", "envelope disagrees"],
    ["unchanged-frames", "unchanged envelope"],
  ] as const;
  for (const [fault, message] of cases) {
    const client = directClient(root, [`--malformed=${fault}`]);
    await rejected(`${fault} is refused`, client.refresh(), message);
    TestValidator.predicate(
      `${fault} leaves the Roslyn store unpublished`,
      client.current === undefined && client.generation === 0,
    );
    await client.close();
  }

  const internal = directClient(root, ["--internal-error"]);
  await rejected(
    "producer failures are surfaced without fallback inside an owned session",
    internal.refresh(),
    "fixture internal failure",
  );
  TestValidator.predicate(
    "an internal producer failure publishes nothing",
    internal.current === undefined,
  );
  await internal.close();
}

async function assertProviderContract(root: string): Promise<void> {
  const empty = GraphPaths.createTempDirectory("samchon-graph-no-csharp-");
  const nested = GraphPaths.createTempDirectory("samchon-graph-nested-csharp-");
  const nestedDeep = GraphPaths.createTempDirectory(
    "samchon-graph-nested-deep-csharp-",
  );
  const nestedEmpty = GraphPaths.createTempDirectory(
    "samchon-graph-nested-empty-csharp-",
  );
  fs.mkdirSync(path.join(nested, "src"));
  fs.mkdirSync(path.join(nested, "src", "empty"));
  fs.mkdirSync(path.join(nested, "src", "bin"));
  fs.writeFileSync(path.join(nested, "src", "notes.txt"), "not a project\n");
  fs.writeFileSync(
    path.join(nested, "src", "bin", "Ignored.csproj"),
    "<Project />\n",
  );
  fs.writeFileSync(path.join(nested, "src", "Nested.csproj"), "<Project />\n");
  fs.mkdirSync(path.join(nestedDeep, "src", "deeper"), { recursive: true });
  fs.writeFileSync(
    path.join(nestedDeep, "src", "deeper", "Nested.csproj"),
    "<Project />\n",
  );
  fs.mkdirSync(path.join(nestedEmpty, "src", "deeper"), { recursive: true });
  fs.writeFileSync(
    path.join(nestedEmpty, "src", "deeper", "notes.txt"),
    "not a project\n",
  );
  const unconfigured = csharpGraphProvider.configuration?.(root, {});
  const configured = csharpGraphProvider.configuration?.(root, {
    SAMCHON_GRAPH_ROSLYN_WORKSPACE: process.execPath,
    SAMCHON_GRAPH_DOTNET_TOOLCHAIN: process.execPath,
  });
  const installed = csharpGraphProvider.resolve(root, {
    SAMCHON_GRAPH_ROSLYN_WORKSPACE: process.execPath,
  });
  const source = csharpGraphProvider.resolve(root, {
    SAMCHON_GRAPH_DOTNET_TOOLCHAIN: process.execPath,
  });
  const unavailable = csharpGraphProvider.resolve(root, {
    PATH: "",
    SystemRoot: process.env.SystemRoot,
  });
  TestValidator.predicate(
    "the C# owner resolves only gated solutions and records both tool choices",
    csharpGraphProvider.resolve(empty, {
      SAMCHON_GRAPH_ROSLYN_WORKSPACE: process.execPath,
    }) === undefined &&
      csharpGraphProvider.resolve(nested, {
        SAMCHON_GRAPH_ROSLYN_WORKSPACE: process.execPath,
      })?.command === process.execPath &&
      csharpGraphProvider.resolve(nestedEmpty, {
        SAMCHON_GRAPH_ROSLYN_WORKSPACE: process.execPath,
      }) === undefined &&
      csharpGraphProvider.resolve(nestedDeep, {
        SAMCHON_GRAPH_ROSLYN_WORKSPACE: process.execPath,
      })?.command === process.execPath &&
      installed?.command === process.execPath &&
      source?.command === process.execPath &&
      unavailable === undefined &&
      source.args.includes("run") &&
      source.args.includes("--dotnet-host") &&
      source.args.includes(process.execPath) &&
      source.args.some((argument) => argument.endsWith("Samchon.Graph.CSharp.csproj")) &&
      unconfigured?.includes("SAMCHON_GRAPH_ROSLYN_WORKSPACE=unconfigured") === true &&
      configured?.includes(`SAMCHON_GRAPH_DOTNET_TOOLCHAIN=${process.execPath}`) === true,
  );
  TestValidator.predicate(
    "the C# owner is compiler-authoritative and keeps scip-dotnet only as fallback",
    csharpGraphProvider.authority === "compiler" &&
      csharpGraphProvider.fallbacks?.map((provider) => provider.name).join() === "scip-dotnet" &&
      csharpGraphProvider.refuse({ cwd: root }) === undefined &&
      csharpGraphProvider
        .refuse({ cwd: root, server: "csharp-ls", maxFiles: 1, lspReferenceLimit: 1 })
        ?.includes("server, maxFiles, lspReferenceLimit") === true,
  );

  const session = csharpGraphProvider.open({
    root,
    command: { command: process.execPath, args: [GraphPaths.fakeCsharpGraphServer] },
    languages: ["csharp"],
    options: { cwd: root },
  });
  try {
    TestValidator.equals(
      "the registered route validates its exact compiler contract",
      (await session.refresh()).snapshot.provenance.provider,
      CSHARP_ROSLYN_PROVIDER,
    );
  } finally {
    await session.close();
  }
}

function directClient(
  root: string,
  flags: string[] = [],
  validate: ConstructorParameters<typeof CsharpGraphClient>[0]["validate"] = () =>
    undefined,
  initializationOptions?: unknown,
  timing: Pick<
    ConstructorParameters<typeof CsharpGraphClient>[0],
    "readyTimeoutMs" | "requestTimeoutMs"
  > = {},
): CsharpGraphClient {
  return new CsharpGraphClient({
    root,
    command: process.execPath,
    args: [GraphPaths.fakeCsharpGraphServer, ...flags],
    initializationOptions,
    validate,
    ...timing,
  });
}

function readRequests(file: string): Array<{
  method?: string;
  params?: { arguments?: Array<{ knownGeneration?: string | null }> };
}> {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
}

async function waitForRequest(file: string, method: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (
      fs.existsSync(file) &&
      readRequests(file).some((message) => message.method === method)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`fake C# server did not receive ${method}`);
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

async function withRoslynTrace<T>(task: () => Promise<T>): Promise<T> {
  const prior = process.env["SAMCHON_GRAPH_ROSLYN_TRACE"];
  process.env["SAMCHON_GRAPH_ROSLYN_TRACE"] = "1";
  try {
    return await task();
  } finally {
    if (prior === undefined) delete process.env["SAMCHON_GRAPH_ROSLYN_TRACE"];
    else process.env["SAMCHON_GRAPH_ROSLYN_TRACE"] = prior;
  }
}
