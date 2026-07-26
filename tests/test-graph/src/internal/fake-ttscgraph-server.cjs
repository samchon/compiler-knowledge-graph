const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const args = process.argv.slice(2);
const cwdIndex = args.indexOf("--cwd");
const project = cwdIndex === -1 ? process.cwd() : path.resolve(args[cwdIndex + 1]);
const invalidMode = args.find((arg) => arg.startsWith("--invalid"));
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
let requests = 0;

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
const manifest = (drift) =>
  [...WORKSPACE_FILES, ...BUNDLED_FILES].map((file) => {
    if (BUNDLED_FILES.includes(file)) {
      return {
        file,
        checkerDigest: digestOf(`${file}:checker${drift ?? ""}`),
        diskDigest: "",
      };
    }
    const text = readProjectFile(file);
    return {
      file,
      checkerDigest: digestOf(text ?? `absent:${file}${drift ?? ""}`),
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

const provenance = (drift) => ({
  schemaVersion: 6,
  capabilities: CAPABILITIES,
  producer: {
    tool: "ttscgraph",
    version: "0.19.2",
    typescript: "5.9.0",
  },
  universe: universe(drift),
  sources: manifest(drift),
});

const graph = (name, options = {}) => ({
  project,
  tsconfig: "tsconfig.json",
  provenance: provenance(options.drift),
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
    response = frame(request.id, { changed: true, mode: "initial", dump });
  } else if (requests === 1) {
    response = frame(request.id, {
      changed: true,
      mode: "initial",
      dump: graph("first"),
    });
  } else if (requests === 2) {
    response = frame(request.id, { changed: false, mode: "unchanged" });
  } else if (requests === 3) {
    response = frame(request.id, {
      changed: true,
      mode: "incremental",
      dump: graph("second", universeDrift ? { drift: "moved" } : {}),
    });
  } else {
    response = frame(request.id, {
      changed: false,
      mode: "error",
      error: "synthetic failure",
    });
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
