const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const args = process.argv.slice(2);
const cwdIndex = args.indexOf("--cwd");
const requestedProject =
  cwdIndex === -1 ? process.cwd() : path.resolve(args[cwdIndex + 1]);
const project = args.includes("--canonical-project")
  ? fs.realpathSync.native(requestedProject)
  : requestedProject;
const nativeInvalidMode = args.find((arg) =>
  arg.startsWith("--native-invalid"),
);
const invalidMode = args.find(
  (arg) => arg.startsWith("--invalid") && !arg.startsWith("--native-invalid"),
);
const markerArg = args.find((arg) => arg.startsWith("--marker="));
const marker = markerArg?.slice("--marker=".length);
const stdinClosedMarkerArg = args.find((arg) =>
  arg.startsWith("--stdin-closed-marker="),
);
const stdinClosedMarker = stdinClosedMarkerArg?.slice(
  "--stdin-closed-marker=".length,
);
const requestLogArg = args.find((arg) => arg.startsWith("--request-log="));
const requestLog = requestLogArg?.slice("--request-log=".length);
const nativeLogArg = args.find((arg) => arg.startsWith("--native-log="));
const nativeLog = nativeLogArg?.slice("--native-log=".length);
// Stands in for a producer that speaks a protocol this client refuses, so the
// pin can be proved without shipping a second fake.
const protocolArg = args.find((arg) => arg.startsWith("--protocol="));
const protocolVersion =
  protocolArg === undefined ? 1 : Number(protocolArg.slice("--protocol=".length));
// Drops one capability, so the client's degrade-and-say-so paths are reachable.
const dropArg = args.find((arg) => arg.startsWith("--drop-capability="));
const dropped = dropArg?.slice("--drop-capability=".length);
// Moves the build universe under an `incremental` label — a producer claiming it
// reused a program whose own inputs say it could not have.
const universeDrift = args.includes("--universe-drift");
const universeReload = args.includes("--universe-reload");
// Transport- and process-level fault injection. These stand in for the wire
// conditions a well-formed producer never emits but a real one can: a process
// that dies mid-serve, a stream chunked or blank-padded by the OS, a line that
// is not JSON, a frame routed to nobody, and a first answer that claims a
// snapshot still holds when there is none yet to reuse.
const stderrExit = args.includes("--stderr-exit");
const exitSilently = args.includes("--exit-silently");
const ignoreFirstArg = args.find((arg) =>
  arg.startsWith("--ignore-first-process="),
);
const ignoreFirstMarker = ignoreFirstArg?.slice(
  "--ignore-first-process=".length,
);
const ignoreThisProcess =
  ignoreFirstMarker !== undefined && !fs.existsSync(ignoreFirstMarker);
if (ignoreThisProcess) {
  fs.mkdirSync(path.dirname(ignoreFirstMarker), { recursive: true });
  fs.writeFileSync(ignoreFirstMarker, String(process.pid));
}
const ignoreStdin = args.includes("--ignore-stdin") || ignoreThisProcess;
const hangRequests = args.includes("--hang-requests") || ignoreThisProcess;
const blankLine = args.includes("--blank-line");
const splitFrame = args.includes("--split-frame");
const nonJson = args.includes("--nonjson");
const nonJsonLong = args.includes("--nonjson-long");
const unknownId = args.includes("--unknown-id");
const firstUnchanged = args.includes("--first-unchanged");
const closeStdinAfterFirst = args.includes("--close-stdin-after-first");
const lateAfterNonJson = args.includes("--late-after-nonjson");
const reverseCapabilities = args.includes("--reverse-capabilities");
const duplicateCapability = args.includes("--duplicate-capability");
const oversizedResponse = args.find((arg) =>
  arg.startsWith("--oversized-response="),
);
const envelopeCapabilityMismatch = args.includes(
  "--envelope-capability-mismatch",
);
// The registered-provider conformance fixture asks the actual client to carry
// the same positive relationship and comment-only negative twin as every other
// strict provider.  These flags change only the fake's graph facts; they leave
// the protocol, source-manifest, and lifecycle fixtures below untouched.
const conformance = args.includes("--conformance");
const conformanceHeuristic = args.includes("--conformance-heuristic");
const phaseTrace = args.includes("--phase-trace");
let requests = 0;
let nativeState;
let nativeBase;

const CAPABILITIES = [
  "universe",
  "sourceDigests",
  "diskDigests",
  "diagnostics",
].filter((capability) => capability !== dropped);
if (reverseCapabilities) CAPABILITIES.reverse();
if (duplicateCapability) CAPABILITIES.push(CAPABILITIES[0]);

// Every workspace and bundled file the fake program loaded. The manifest must
// cover every file the nodes below name, because that is what the client checks.
const WORKSPACE_FILES = ["src/index.ts", "src/core/order.ts", "src/empty.ts"];
const BUNDLED_FILES = ["bundled:///libs/lib.es2015.collection.d.ts"];

const digestOf = (text) =>
  crypto.createHash("sha256").update(text).digest("hex");

const goJSON = (value) =>
  JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => {
    if (character === "<") return "\\u003c";
    if (character === ">") return "\\u003e";
    if (character === "&") return "\\u0026";
    return character === "\u2028" ? "\\u2028" : "\\u2029";
  });

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const readProjectFile = (rel) => {
  try {
    return fs.readFileSync(path.join(project, rel), "utf8");
  } catch {
    return undefined;
  }
};

/**
 * The source manifest.
 *
 * `checkerDigest` is what the producer's checker parsed, and the fake reports it
 * whether or not the file is on disk right now — that is the property under
 * test. A real `ttscgraph` answers from the Program it holds; neither it nor
 * this fake needs the client to go looking on disk, and a file the client cannot
 * read still has a perfectly well-defined digest here.
 */
const manifest = (semantic) =>
  [...WORKSPACE_FILES, ...BUNDLED_FILES].map((file) => {
    if (BUNDLED_FILES.includes(file)) {
      return {
        file,
        checkerDigest: digestOf(`${file}:checker`),
        diskDigest: "",
      };
    }
    const text = readProjectFile(file);
    return {
      file,
      checkerDigest: digestOf(
        `${text ?? `absent:${file}`}${
          file === "src/core/order.ts" && semantic !== "first"
            ? `:program:${semantic}`
            : ""
        }`,
      ),
      diskDigest:
        dropped === "diskDigests" || text === undefined ? "" : digestOf(text),
    };
  });

const universe = (drift) => ({
  configs: [
    {
      file: "tsconfig.json",
      digest: digestOf(`${readProjectFile("tsconfig.json") ?? ""}${drift ?? ""}`),
    },
  ],
  roots: WORKSPACE_FILES.map((file) => ({ config: "tsconfig.json", file })),
});

const provenance = (semantic, drift) => ({
  schemaVersion: 6,
  capabilities: CAPABILITIES,
  producer: {
    tool: "ttscgraph",
    version: "0.19.2",
    typescript: "5.9.0",
  },
  universe: universe(drift),
  sources: manifest(semantic),
});

const graph = (name, options = {}) => ({
  project,
  tsconfig: "tsconfig.json",
  provenance: provenance(name, options.drift),
  diagnostics:
    dropped === "diagnostics"
      ? []
      : [
          {
            file: "src/core/order.ts",
            line: 1,
            column: 1,
            code: 2322,
            category: "error",
            message: `synthetic finding for ${name}`,
          },
        ],
  nodes: conformance
    ? conformanceNodes()
    : [
    {
      id: "src/index.ts#src/index.ts:module",
      kind: "module",
      name: "src/index.ts",
      file: "src/index.ts",
      external: false,
    },
    {
      id: `src/core/order.ts#${name}:function`,
      kind: "function",
      name,
      file: "src/core/order.ts",
      external: false,
      exported: true,
      closure: true,
      ignored: true,
      modifiers: ["export", "async"],
      decorators: [{ name: "Route", arguments: [{ literal: 1 }] }],
      evidence: { startLine: 1, startCol: 1, endLine: 1, endCol: 10 },
    },
    {
      id: "src/core/order.ts#src/core/order.ts:module",
      kind: "module",
      name: "src/core/order.ts",
      file: "src/core/order.ts",
      external: false,
    },
    {
      id: "src/empty.ts#src/empty.ts:module",
      kind: "module",
      name: "src/empty.ts",
      file: "src/empty.ts",
      external: false,
    },
    {
      id: "bundled:///libs/lib.es2015.collection.d.ts#Map:interface",
      kind: "interface",
      name: "Map",
      file: "bundled:///libs/lib.es2015.collection.d.ts",
      external: true,
      evidence: { startLine: 19, startCol: 1, endLine: 19, endCol: 14 },
    },
  ],
  edges: conformance
    ? conformanceEdges()
    : [
    {
      from: "src/index.ts#src/index.ts:module",
      to: `src/core/order.ts#${name}:function`,
      kind: "exports",
      evidence: { startLine: 1, startCol: 1, endLine: 1, endCol: 10 },
    },
  ],
});

/** Convert the fake compiler document into the same native shards as ttscgraph. */
function nativeSnapshot(dump) {
  nativeBase = nativeState;
  const shards = new Map();
  const nodeFiles = new Map(dump.nodes.map((node) => [node.id, node.file]));
  const sourceOccurrences = new Map();
  const universeFingerprint = nativeUniverseFingerprint({
    universe: dump.provenance.universe,
  });
  const coordinates = (...values) =>
    JSON.stringify([
      1,
      dump.provenance.producer.tool,
      dump.provenance.producer.version,
      dump.provenance.producer.typescript,
      dump.tsconfig,
      universeFingerprint,
      ...values,
    ]);
  for (const source of dump.provenance.sources) {
    const occurrence = sourceOccurrences.get(source.file) ?? 0;
    sourceOccurrences.set(source.file, occurrence + 1);
    const prefix = source.file.startsWith("bundled:///") ? "2" : "1";
    const key = `${prefix}:source:${coordinates(
      source.file,
      source.checkerDigest,
      source.diskDigest,
      digestOf(`resolution:${source.file}`),
      ...(occurrence === 0 ? [] : [occurrence]),
    )}`;
    shards.set(key, {
      key,
      source,
      nodes: dump.nodes.filter(
        (node) => !node.external && node.file === source.file,
      ),
      edges: dump.edges.filter(
        (edge) => nodeFiles.get(edge.from) === source.file,
      ),
      diagnostics: dump.diagnostics.filter(
        (diagnostic) => diagnostic.file === source.file,
      ),
    });
  }
  for (const config of dump.provenance.universe.configs) {
    const key = `3:config:${coordinates(config.file, config.digest)}`;
    shards.set(key, {
      key,
      config,
      nodes: [],
      edges: [],
      diagnostics: dump.diagnostics.filter(
        (diagnostic) => diagnostic.file === config.file,
      ),
    });
  }
  const externalKey = `0:external:${coordinates("external")}`;
  shards.set(externalKey, {
    key: externalKey,
    nodes: dump.nodes.filter((node) => node.external),
    edges: [],
    diagnostics: [],
  });
  const metadataKey = `0:metadata:${coordinates("metadata")}`;
  const inputFiles = new Set([
    ...dump.provenance.sources.map((source) => source.file),
    ...dump.provenance.universe.configs.map((config) => config.file),
  ]);
  shards.set(metadataKey, {
    key: metadataKey,
    nodes: [],
    edges: [],
    diagnostics: dump.diagnostics.filter(
      (diagnostic) =>
        diagnostic.file === "" || !inputFiles.has(diagnostic.file),
    ),
  });
  const committed = new Map(
    [...shards].map(([key, shard]) => [
      key,
      { digest: digestOf(goJSON(shard)), shard },
    ]),
  );
  const manifest = [...committed]
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([key, value]) => ({ key, digest: value.digest }));
  const sequence = (nativeState?.sequence ?? 0) + 1;
  const transaction = {
    protocolVersion: 1,
    schemaVersion: dump.provenance.schemaVersion,
    project: dump.project,
    tsconfig: dump.tsconfig,
    producer: dump.provenance.producer,
    capabilities: dump.provenance.capabilities,
    universe: dump.provenance.universe,
    sequence,
    generation: digestOf(
      goJSON({
        tsconfig: dump.tsconfig,
        producer: dump.provenance.producer,
        capabilities: dump.provenance.capabilities,
        universe: dump.provenance.universe,
        manifest,
      }),
    ),
    ...(nativeState === undefined
      ? {}
      : {
          baseSequence: nativeState.sequence,
          baseGeneration: nativeState.generation,
        }),
    upserts: [...committed]
      .filter(
        ([key, value]) => nativeState?.shards.get(key)?.digest !== value.digest,
      )
      .map(([, value]) => ({ digest: value.digest, shard: value.shard })),
    deletes:
      nativeState === undefined
        ? []
        : [...nativeState.shards.keys()].filter((key) => !committed.has(key)),
    manifest,
  };
  nativeState = {
    sequence,
    generation: transaction.generation,
    shards: committed,
  };
  return transaction;
}

function resignNativeGeneration(snapshot) {
  snapshot.generation = digestOf(
    goJSON({
      tsconfig: snapshot.tsconfig,
      producer: snapshot.producer,
      capabilities: snapshot.capabilities,
      universe: snapshot.universe,
      manifest: snapshot.manifest,
    }),
  );
}

function resignCompleteNativeSnapshot(snapshot) {
  snapshot.upserts.forEach((upsert) => {
    upsert.digest = digestOf(goJSON(upsert.shard));
  });
  snapshot.manifest = snapshot.upserts
    .map((upsert) => ({
      key: upsert.shard.key,
      digest: upsert.digest,
    }))
    .sort((left, right) => compareUtf8(left.key, right.key));
  resignNativeGeneration(snapshot);
}

function nativeUniverseFingerprint(snapshot) {
  const hash = crypto.createHash("sha256");
  const push = (text) => hash.update(`${String(text.length)}:${text}`);
  push("configs");
  for (const config of snapshot.universe.configs) {
    push(config.file);
    push(config.digest);
  }
  push("roots");
  for (const root of snapshot.universe.roots) {
    push(root.config);
    push(root.file);
  }
  return hash.digest("hex");
}

function corruptNativeSnapshot(snapshot, mode) {
  const source = (file) =>
    snapshot.upserts.find((upsert) => upsert.shard.source?.file === file);
  const config = () =>
    snapshot.upserts.find((upsert) => upsert.shard.config !== undefined);
  const external = () =>
    snapshot.upserts.find((upsert) => upsert.shard.key.startsWith("0:external:"));
  const metadata = () =>
    snapshot.upserts.find((upsert) => upsert.shard.key.startsWith("0:metadata:"));

  if (mode === "--native-invalid-digest" || mode === "--native-invalid-digest-third") {
    snapshot.upserts[0].digest = "0".repeat(64);
  } else if (mode === "--native-invalid-manifest") {
    snapshot.manifest.push({ ...snapshot.manifest[0] });
  } else if (mode === "--native-invalid-base" || mode === "--native-invalid-base-third") {
    snapshot.baseSequence = 1;
    snapshot.baseGeneration = "0".repeat(64);
  } else if (mode === "--native-invalid-protocol") {
    snapshot.protocolVersion = 2;
  } else if (mode === "--native-invalid-schema") {
    snapshot.schemaVersion = 4;
  } else if (mode === "--native-invalid-sequence-zero") {
    snapshot.sequence = 0;
  } else if (mode === "--native-invalid-sequence-fraction") {
    snapshot.sequence = 1.5;
  } else if (mode === "--native-invalid-generation-format") {
    snapshot.generation = "invalid";
  } else if (mode === "--native-invalid-generation") {
    snapshot.generation = "0".repeat(64);
  } else if (mode === "--native-invalid-initial-sequence") {
    snapshot.sequence = 2;
  } else if (mode === "--native-invalid-base-sequence-only") {
    snapshot.baseSequence = 1;
  } else if (mode === "--native-invalid-base-generation-only") {
    snapshot.baseGeneration = "0".repeat(64);
  } else if (mode === "--native-invalid-base-sequence-type") {
    snapshot.baseSequence = "one";
    snapshot.baseGeneration = "0".repeat(64);
  } else if (mode === "--native-invalid-project-third") {
    snapshot.project = path.join(snapshot.project, "other");
  } else if (mode === "--native-invalid-tsconfig-third") {
    snapshot.tsconfig = "other-tsconfig.json";
  } else if (mode === "--native-invalid-delete-unknown-third") {
    snapshot.deletes.push("missing-shard");
  } else if (mode === "--native-invalid-delete-duplicate-third") {
    snapshot.deletes.push(snapshot.manifest[0].key, snapshot.manifest[0].key);
  } else if (mode === "--native-invalid-upsert-duplicate-third") {
    snapshot.upserts.push(structuredClone(snapshot.upserts[0]));
  } else if (mode === "--native-invalid-retained-edge-target-third") {
    snapshot.upserts = snapshot.upserts.filter(
      (upsert) =>
        upsert.shard.source?.file !== "src/core/order.ts" &&
        upsert.shard.source?.file !== "src/index.ts",
    );
    snapshot.manifest = [...nativeBase.shards]
      .filter(
        ([, value]) => value.shard.source?.file !== "src/core/order.ts",
      )
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([key, value]) => ({ key, digest: value.digest }));
    snapshot.deletes = [...nativeBase.shards]
      .filter(
        ([, value]) => value.shard.source?.file === "src/core/order.ts",
      )
      .map(([key]) => key);
    resignNativeGeneration(snapshot);
  } else if (mode === "--native-invalid-key-empty") {
    snapshot.upserts[0].shard.key = "";
    resignCompleteNativeSnapshot(snapshot);
  } else if (mode === "--native-invalid-key-nul") {
    snapshot.upserts[0].shard.key = "bad\0key";
    resignCompleteNativeSnapshot(snapshot);
  } else if (
    mode === "--native-invalid-reserved-coverage" ||
    mode === "--native-invalid-reserved-coverage-alternate"
  ) {
    snapshot.upserts[0].shard.key =
      mode === "--native-invalid-reserved-coverage"
        ? `0:coverage:${JSON.stringify([
            1,
            "ttscgraph",
            snapshot.producer.version,
            snapshot.producer.typescript,
            "typescript",
            snapshot.tsconfig,
            nativeUniverseFingerprint(snapshot),
          ])}`
        : "0:coverage:foreign-native-shard";
    resignCompleteNativeSnapshot(snapshot);
  } else if (mode === "--native-invalid-two-input-kinds") {
    source("src/empty.ts").shard.config = structuredClone(
      snapshot.universe.configs[0],
    );
    resignCompleteNativeSnapshot(snapshot);
  } else if (mode === "--native-invalid-duplicate-source") {
    const duplicate = source("src/empty.ts");
    duplicate.shard.source.file = "src/index.ts";
    duplicate.shard.nodes.forEach((node) => {
      node.file = "src/index.ts";
    });
    resignCompleteNativeSnapshot(snapshot);
  } else if (mode === "--native-invalid-duplicate-config") {
    const duplicate = structuredClone(config());
    duplicate.shard.key += ":duplicate";
    snapshot.upserts.push(duplicate);
    resignCompleteNativeSnapshot(snapshot);
  } else if (mode === "--native-invalid-config-facts") {
    config().shard.nodes.push(structuredClone(external().shard.nodes[0]));
    resignCompleteNativeSnapshot(snapshot);
  } else if (mode === "--native-invalid-nonsource-edges") {
    metadata().shard.edges.push(structuredClone(source("src/index.ts").shard.edges[0]));
    resignCompleteNativeSnapshot(snapshot);
  } else if (mode === "--native-invalid-source-external-node") {
    source("src/core/order.ts").shard.nodes[0].external = true;
    resignCompleteNativeSnapshot(snapshot);
  } else if (mode === "--native-invalid-source-foreign-node") {
    source("src/core/order.ts").shard.nodes[0].file = "src/index.ts";
    resignCompleteNativeSnapshot(snapshot);
  } else if (mode === "--native-invalid-external-local-node") {
    external().shard.nodes[0].external = false;
    resignCompleteNativeSnapshot(snapshot);
  } else if (mode === "--native-invalid-duplicate-node") {
    metadata().shard.nodes.push(structuredClone(external().shard.nodes[0]));
    resignCompleteNativeSnapshot(snapshot);
  } else if (mode === "--native-invalid-local-duplicate-node") {
    external().shard.nodes.push(structuredClone(external().shard.nodes[0]));
    resignCompleteNativeSnapshot(snapshot);
  } else if (mode === "--native-invalid-source-diagnostic") {
    source("src/core/order.ts").shard.diagnostics[0].file = "src/index.ts";
    resignCompleteNativeSnapshot(snapshot);
  } else if (mode === "--native-invalid-config-diagnostic") {
    config().shard.diagnostics.push({ file: "src/index.ts" });
    resignCompleteNativeSnapshot(snapshot);
  } else if (mode === "--native-invalid-metadata-diagnostic") {
    metadata().shard.diagnostics.push({ file: "src/index.ts" });
    resignCompleteNativeSnapshot(snapshot);
  } else if (mode === "--native-invalid-edge-owner") {
    source("src/index.ts").shard.edges[0].from =
      source("src/core/order.ts").shard.nodes[0].id;
    resignCompleteNativeSnapshot(snapshot);
  } else if (mode === "--native-invalid-config-coverage") {
    snapshot.upserts = snapshot.upserts.filter(
      (upsert) => upsert.shard.config === undefined,
    );
    resignCompleteNativeSnapshot(snapshot);
  } else if (mode === "--native-invalid-config-digest") {
    config().shard.config = {
      ...config().shard.config,
      digest: "0".repeat(64),
    };
    resignCompleteNativeSnapshot(snapshot);
  } else if (mode === "--native-invalid-manifest-sort") {
    snapshot.manifest.reverse();
    resignNativeGeneration(snapshot);
  } else if (mode === "--native-invalid-manifest-entry") {
    snapshot.manifest[0].digest = "0".repeat(64);
    resignNativeGeneration(snapshot);
  } else if (mode === "--native-invalid-manifest-digest-format") {
    snapshot.manifest[0].digest = "invalid";
  } else if (mode === "--native-invalid-producer-array") {
    snapshot.producer = [];
  } else if (mode === "--native-invalid-capabilities-array") {
    snapshot.capabilities = {};
  } else if (mode === "--native-invalid-project-string") {
    snapshot.project = 1;
  } else if (mode === "--native-invalid-nodes-array") {
    snapshot.upserts[0].shard.nodes = {};
  } else if (mode === "--native-invalid-node-boolean") {
    source("src/core/order.ts").shard.nodes[0].external = "false";
    resignCompleteNativeSnapshot(snapshot);
  } else {
    throw new Error(`unknown native invalid mode: ${mode}`);
  }
}

function conformanceNodes() {
  const ranges = conformanceRanges();
  const nodes = [
    {
      id: "src/core/order.ts#caller:function",
      kind: "function",
      name: "caller",
      file: "src/core/order.ts",
      external: false,
      evidence: evidenceOf("src/core/order.ts", ranges.caller),
    },
    {
      id: "src/core/order.ts#callee:function",
      kind: "function",
      name: "callee",
      file: "src/core/order.ts",
      external: false,
      evidence: evidenceOf("src/core/order.ts", ranges.calleeDefinition),
    },
  ];
  if (conformanceHeuristic) {
    nodes.push({
      id: "src/core/order.ts#mentionedInComment:function",
      kind: "function",
      name: "mentionedInComment",
      file: "src/core/order.ts",
      external: false,
    });
  }
  return nodes;
}

function conformanceEdges() {
  const ranges = conformanceRanges();
  const edges = [
    {
      from: "src/core/order.ts#caller:function",
      to: "src/core/order.ts#callee:function",
      kind: "calls",
      evidence: evidenceOf("src/core/order.ts", ranges.calleeReference),
    },
  ];
  if (conformanceHeuristic) {
    edges.push({
      from: "src/core/order.ts#caller:function",
      to: "src/core/order.ts#mentionedInComment:function",
      kind: "calls",
    });
  }
  return edges;
}

function conformanceRanges() {
  const text = fs.readFileSync(
    path.join(project, "src", "core", "order.ts"),
    "utf8",
  );
  const caller = wordRanges(text, "caller")[0];
  const callee = wordRanges(text, "callee");
  if (
    caller === undefined ||
    callee.at(-1) === undefined ||
    callee.at(-2) === undefined
  ) {
    throw new Error("fake ttscgraph: invalid conformance source fixture");
  }
  return {
    caller,
    calleeDefinition: callee.at(-1),
    calleeReference: callee.at(-2),
  };
}

function wordRanges(text, word) {
  const output = [];
  let offset = 0;
  for (;;) {
    const found = text.indexOf(word, offset);
    if (found < 0) return output;
    const prefix = text.slice(0, found);
    const line = prefix.split("\n").length - 1;
    const column = found - (prefix.lastIndexOf("\n") + 1);
    output.push([line, column, line, column + word.length]);
    offset = found + word.length;
  }
}

function evidenceOf(file, range) {
  return {
    file,
    startLine: range[0] + 1,
    startCol: range[1] + 1,
    endLine: range[2] + 1,
    endCol: range[3] + 1,
  };
}

/** Every response owes the client these, whatever became of the request. */
const frame = (id, rest) => ({
  id,
  protocolVersion,
  capabilities: envelopeCapabilityMismatch
    ? CAPABILITIES.filter((capability) => capability !== "diagnostics")
    : CAPABILITIES,
  ...rest,
});

// A producer that crashes before it can answer. With something on stderr the
// client must surface it verbatim; with nothing, the bare exit still rejects.
// Both happen at startup, before a single request is read, so the client meets
// a process that is already gone.
if (stderrExit) {
  process.stderr.write("ttscgraph diagnostic: fatal\n", () => process.exit(1));
  return;
}
if (exitSilently) {
  process.exit(1);
}

// Writes one response, subject to the transport-fault flags: a non-JSON line,
// a blank line before the frame, a frame split across two stdout chunks, or a
// frame routed to an id nobody is waiting on. Each is a stream condition the
// envelope parser never sees, because the client's own NDJSON reassembly is
// what has to survive it.
const emit = (response) => {
  if (oversizedResponse !== undefined) {
    const terminated = oversizedResponse === "--oversized-response=terminated";
    process.stdout.write(`${"X".repeat(4096)}${terminated ? "\n" : ""}`);
    return;
  }
  if (nonJsonLong) {
    // Longer than the client will carry, so the tail has to be cut. A real
    // producer reaches this length easily: one stack trace does it.
    process.stdout.write(`NOT-A-FRAME ${"stack frame ".repeat(80)}\n`);
    return;
  }
  if (nonJson) {
    process.stdout.write("this is not a ttscgraph frame\n", () => {
      if (lateAfterNonJson) process.stdout.write("late retired output\n");
    });
    return;
  }
  const routed = unknownId ? { ...response, id: response.id + 1000 } : response;
  const payload = `${blankLine ? "\n" : ""}${JSON.stringify(routed)}\n`;
  if (!splitFrame) {
    process.stdout.write(payload);
    return;
  }
  // Two chunks, the first deliberately short of the newline, so the client's
  // reassembly buffer — not readline on this side — is what joins them.
  const cut = Math.max(1, Math.floor(payload.length / 2));
  process.stdout.write(payload.slice(0, cut));
  setTimeout(() => process.stdout.write(payload.slice(cut)), 10);
};

const input = readline.createInterface({ input: process.stdin });
if (ignoreStdin) {
  // Stay alive after stdin closes so close() must fall through to the kill.
  // The marker below still records that stdin closed; what the client proves is
  // that it ended the exact owned process, not that the process cooperated.
  setInterval(() => {}, 1_000);
}
input.on("line", (line) => {
  const request = JSON.parse(line);
  requests += 1;
  if (requestLog !== undefined) fs.writeFileSync(requestLog, `${requests}\n`);
  if (hangRequests) return;
  if (request.graphSnapshotVersion !== 1) {
    emit(
      frame(request.id, {
        changed: false,
        mode: "error",
        error: "graph snapshot protocol v1 was not requested",
      }),
    );
    return;
  }
  let response;
  if (firstUnchanged) {
    // A first answer that reuses a snapshot that does not exist yet.
    response = frame(request.id, { changed: false, mode: "unchanged" });
  } else if (invalidMode !== undefined) {
    const dump = graph("broken");
    if (invalidMode === "--invalid") {
      dump.edges[0].to = "src/core/order.ts#missing:function";
    } else if (invalidMode === "--invalid-span") {
      dump.nodes[1].evidence = {
        startLine: 3,
        startCol: 8,
        endLine: 3,
        endCol: 2,
      };
    } else if (invalidMode === "--invalid-path") {
      dump.nodes[1].evidence.file = "../escape.ts";
    } else if (invalidMode === "--invalid-node-evidence") {
      dump.nodes[1].evidence.file = "src/index.ts";
    } else if (invalidMode === "--invalid-edge-evidence") {
      dump.edges[0].evidence.file = "src/core/order.ts";
    } else if (invalidMode === "--invalid-bundled-workspace") {
      dump.nodes.at(-1).external = false;
    } else if (invalidMode === "--invalid-manifest") {
      // A file the facts name but the manifest never loaded: two programs'
      // output in one envelope.
      dump.provenance.sources = dump.provenance.sources.filter(
        (entry) => entry.file !== "src/core/order.ts",
      );
    } else if (invalidMode === "--invalid-manifest-digest") {
      dump.provenance.sources[0].checkerDigest = "not-a-sha256";
    } else if (invalidMode === "--invalid-manifest-duplicate") {
      dump.provenance.sources.push({ ...dump.provenance.sources[0] });
    } else if (invalidMode === "--invalid-diagnostic-file") {
      dump.diagnostics[0].file = "src/never-loaded.ts";
    } else if (invalidMode === "--invalid-diagnostic-category") {
      dump.diagnostics[0].category = "advice";
    } else if (invalidMode === "--invalid-universe-configs") {
      dump.provenance.universe.configs = [];
    } else if (invalidMode === "--invalid-universe-digest") {
      dump.provenance.universe.configs[0].digest = "0123";
    } else if (invalidMode === "--invalid-disk-digest") {
      dump.provenance.sources[0].diskDigest = "not-a-sha256";
    } else {
      throw new Error(`unknown invalid mode: ${invalidMode}`);
    }
    response = frame(request.id, {
      changed: true,
      mode: "initial",
      snapshot: nativeSnapshot(dump),
    });
  } else if (requests === 1) {
    response = frame(request.id, {
      changed: true,
      mode: "initial",
      snapshot: nativeSnapshot(graph("first")),
    });
  } else if (requests === 2) {
    response = frame(request.id, { changed: false, mode: "unchanged" });
  } else if (requests === 3) {
    response = frame(request.id, {
      changed: true,
      mode: "incremental",
      snapshot: nativeSnapshot(
        graph(
          "second",
          universeDrift || universeReload ? { drift: "moved" } : {},
        ),
      ),
    });
    if (universeReload) response.mode = "reload";
  } else {
    response = frame(request.id, {
      changed: false,
      mode: "error",
      error: "synthetic failure",
    });
  }
  if (
    nativeInvalidMode !== undefined &&
    response.snapshot !== undefined &&
    (nativeInvalidMode.endsWith("-third") ? requests === 3 : requests === 1)
  ) {
    if (nativeInvalidMode === "--native-invalid-snapshot-string") {
      response.snapshot = "invalid";
    } else if (nativeInvalidMode === "--native-invalid-snapshot-null") {
      response.snapshot = null;
    } else corruptNativeSnapshot(response.snapshot, nativeInvalidMode);
  }
  if (nativeLog !== undefined && response.snapshot !== undefined) {
    fs.appendFileSync(nativeLog, `${JSON.stringify(response.snapshot)}\n`);
  }
  if (phaseTrace) {
    process.stderr.write(
      "@samchon/graph: ttscgraph-phase C:\\private\\spoof.ts\n",
    );
    process.stderr.write(
      `@samchon/graph: ttscgraph-phase owner=producer request=${String(request.id)}` +
        ` mode=${response.mode} phase=shard-export durationMs=1.000\n`,
    );
  }
  emit(response);
  if (closeStdinAfterFirst && requests === 1) {
    input.close();
    process.stdin.destroy();
    fs.closeSync(0);
    // This marker is a transport fence, not a readline lifecycle hint: publish
    // it only after descriptor 0 is actually closed so the client's next write
    // cannot race the fake's teardown.
    if (stdinClosedMarker !== undefined) {
      fs.writeFileSync(stdinClosedMarker, "closed\n");
    }
    setInterval(() => undefined, 1_000);
  }
});
input.on("close", () => {
  if (marker !== undefined) fs.writeFileSync(marker, "closed\n");
  // The count is the evidence that one refresh costs one request. The client
  // used to spend a second round-trip per changed snapshot asking whether the
  // first one still held, so four refreshes would have produced six requests.
  if (requestLog !== undefined) fs.writeFileSync(requestLog, `${requests}\n`);
});
