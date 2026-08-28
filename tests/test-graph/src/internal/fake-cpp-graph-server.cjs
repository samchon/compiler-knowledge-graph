#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const args = process.argv.slice(2);
const valueOf = (prefix) =>
  args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
const commit =
  valueOf("--commit=") ?? "1111111111111111111111111111111111111111";
const requestLog = valueOf("--request-log=");
const watchLog = valueOf("--watch-log=");
let retry = Number(valueOf("--retry=") ?? 0);
let contentModified = Number(valueOf("--content-modified=") ?? 0);
const moveInputOnContentModified = args.includes(
  "--move-input-on-content-modified",
);
const hang = args.includes("--hang");
const internalError = args.includes("--internal-error");
const malformed = args.includes("--malformed");
const initializeError = args.includes("--initialize-error");
const hangInitialize = args.includes("--hang-initialize");
const requestConfiguration = args.includes("--request-configuration");
const requestEmptyConfiguration = args.includes("--request-empty-configuration");
const requestUnknown = args.includes("--request-unknown");
const pageCorruption = valueOf("--page-corruption=");
// Where to publish bodies instead of carrying them, mirroring the producer:
// one file per body, named by the body's own content digest.
const bodyRoot = valueOf("--body-root=");
// How a producer can break the published-body contract: name nothing, name a
// file that is not there, or publish something that is not a body.
const bodyFault = valueOf("--body-fault=");
const edgeCases = args.includes("--edge-cases");
const invalidSourceUri = args.includes("--invalid-source-uri");
const unsupportedSourceUri = args.includes("--unsupported-source-uri");
const checkerOverlay = args.includes("--checker-overlay");
const emptyDiskDigest = args.includes("--empty-disk-digest");
const EDGE_KINDS = [
  "contains", "exports", "imports", "calls", "accesses",
  "instantiates", "type_ref", "extends", "implements", "overrides",
  "dispatches", "decorates", "renders", "tests", "references",
];
const COVERAGE = {
  contains: "complete",
  exports: "partial",
  imports: "complete",
  calls: "partial",
  accesses: "complete",
  instantiates: "partial",
  type_ref: "complete",
  extends: "complete",
  implements: "partial",
  overrides: "complete",
  dispatches: "partial",
  decorates: "unsupported",
  renders: "unsupported",
  tests: "unsupported",
  references: "complete",
};
let sequence = 0;
let published;
let activePlan;

if (args.includes("--version")) {
  process.stdout.write(`clangd version 22.1.8 (${commit})\n`);
  process.exit(0);
}
if (args.includes("--snapshot")) {
  process.stdout.write(JSON.stringify(snapshot(null, undefined, 32)));
  process.exit(0);
}

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString("ascii");
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (!Number.isSafeInteger(length) || buffer.length < bodyEnd) return;
    const message = JSON.parse(buffer.slice(bodyStart, bodyEnd).toString("utf8"));
    buffer = buffer.slice(bodyEnd);
    handle(message);
  }
});

function handle(message) {
  if (message.method === "initialize") {
    if (hangInitialize) return;
    if (initializeError) {
      sendError(message.id, -32603, "fixture initialize failure");
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
    if (requestConfiguration) {
      send({
        jsonrpc: "2.0",
        id: "fixture-configuration",
        method: "workspace/configuration",
        params: { items: [{ section: "clangd" }, { section: "clangd.graph" }] },
      });
    }
    if (requestEmptyConfiguration) {
      send({
        jsonrpc: "2.0",
        id: "fixture-empty-configuration",
        method: "workspace/configuration",
        params: {},
      });
    }
    if (requestUnknown) {
      send({
        jsonrpc: "2.0",
        id: "fixture-unknown",
        method: "workspace/unknown",
        params: {},
      });
    }
    return;
  }
  if (message.method === "workspace/didChangeWatchedFiles") {
    if (watchLog !== undefined) {
      fs.appendFileSync(watchLog, `${JSON.stringify(message.params)}\n`);
    }
    return;
  }
  if (message.method === "samchon/graphSnapshot") {
    if (requestLog !== undefined) {
      fs.appendFileSync(requestLog, `${JSON.stringify(message.params)}\n`);
    }
    if (hang) return;
    if (internalError) {
      sendError(message.id, -32603, "fixture internal failure");
      return;
    }
    if (retry > 0) {
      retry -= 1;
      sendError(message.id, -32802, "fixture graph is not ready");
      return;
    }
    if (contentModified > 0) {
      contentModified -= 1;
      if (moveInputOnContentModified) {
        fs.writeFileSync(
          path.join(process.cwd(), "main.cpp"),
          "void moved_during_snapshot() {}\n",
        );
      }
      sendError(message.id, -32801, "fixture graph moved");
      return;
    }
    let result = snapshot(
      message.params?.knownGeneration ?? null,
      message.params?.cursor,
      message.params?.maxShards ?? 32,
    );
    if (malformed) result.producer.commit = "wrong";
    result = corruptPage(result, message.params?.cursor !== undefined);
    send({ jsonrpc: "2.0", id: message.id, result });
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "exit") process.exit(0);
}

function corruptPage(result, continuation) {
  if (pageCorruption === "generation") return null;
  if (pageCorruption === "envelope") result.page.offset = -1;
  if (pageCorruption === "telemetry") result.phases.validationMillis = -1;
  if (pageCorruption === "cache") result.phases.cacheHit = "invalid";
  // Every field still a valid non-negative integer, and only the sum wrong --
  // the shape a per-page check catches and a check over the assembled total
  // can have cancelled out.
  if (pageCorruption === "arithmetic") result.phases.totalMillis += 1;
  if (pageCorruption === "early" && !continuation) result.page.nextCursor = null;
  if (pageCorruption === "cursor" && !continuation) {
    result.page.total = result.page.count;
  }
  if (pageCorruption === "metadata" && continuation) {
    result.manifest = [{ key: "repeated", digest: "0".repeat(64) }];
  }
  if (pageCorruption === "cross-generation" && continuation) {
    result.sequence += 1;
  }
  return result;
}

function snapshot(knownGeneration, cursor, maxShards) {
  if (cursor !== undefined) {
    if (activePlan === undefined || !cursor.startsWith(`${activePlan.token}:`)) {
      throw new Error("fixture stale graph cursor");
    }
    return pageOf(activePlan, Number(cursor.slice(cursor.lastIndexOf(":") + 1)), maxShards);
  }
  const prior = published;
  const shards = compilationCommands().map(graphShard).sort(compareKey);
  const manifest = shards.map((shard) => ({
    digest: shard.digest,
    key: shard.key,
  }));
  const targets = [...new Set(shards.map((shard) => shard.graph.targetTriple))]
    .sort();
  const configurations = [
    ...new Set(shards.map((shard) => shard.configuration)),
  ].sort();
  const producer = {
    name: "samchon-clangd",
    version: "clang version 22.1.8",
    commit,
  };
  const fingerprint = producerFingerprint(producer);
  const workspaceRoots = [canonicalRoot(process.cwd())];
  const toolchains = [
    ...new Set(shards.map((shard) => shard.graph.toolchainFingerprint)),
  ].sort();
  let universeMaterial = coordinate("producer", fingerprint);
  for (const target of targets) universeMaterial += coordinate("target", target);
  for (const root of workspaceRoots) universeMaterial += coordinate("root", root);
  for (const toolchain of toolchains)
    universeMaterial += coordinate("toolchain", toolchain);
  for (const configuration of configurations)
    universeMaterial += coordinate("configuration", configuration);
  const universe = digest(universeMaterial);
  const generationMaterial = manifest
    .map((entry) => `${Buffer.byteLength(entry.key)}:${entry.key}${entry.digest}`)
    .join("");
  const generation = digest(universe + generationMaterial);
  const noChange = knownGeneration === generation;
  const delta = !noChange && prior?.generation === knownGeneration;
  const previous = new Map(
    (prior?.manifest ?? []).map((entry) => [entry.key, entry.digest]),
  );
  const current = new Map(manifest.map((entry) => [entry.key, entry.digest]));
  const upserts = noChange
    ? []
    : delta
      ? shards.filter((shard) => previous.get(shard.key) !== shard.digest)
      : shards;
  const deletes = delta
    ? [...previous.keys()].filter((key) => !current.has(key)).sort()
    : [];
  sequence += 1;
  activePlan = {
    token: digest(`${generation}:${sequence}:${knownGeneration ?? "full"}`),
    protocolVersion: 1,
    schemaVersion: 1,
    producer,
    universe: {
      digest: universe,
      targets,
      workspaceRoots,
      toolchains,
      configurations,
    },
    sequence,
    generation,
    baseGeneration: noChange || delta ? knownGeneration : null,
    upserts,
    deletes,
    manifest,
    cacheHit: noChange,
  };
  published = { generation, manifest };
  return pageOf(activePlan, 0, maxShards);
}

function pageOf(plan, offset, maxShards) {
  const pageSize = Math.max(1, Math.min(128, Number(maxShards) || 32));
  const end = Math.min(plan.upserts.length, offset + pageSize);
  const semanticMillis = offset === 0 && !plan.cacheHit ? 1 : 0;
  const shardMillis = offset === 0 && !plan.cacheHit ? 1 : 0;
  const validationMillis = 1;
  const encodeMillis = 1;
  return {
    protocolVersion: plan.protocolVersion,
    schemaVersion: plan.schemaVersion,
    producer: plan.producer,
    universe: plan.universe,
    sequence: plan.sequence,
    generation: plan.generation,
    baseGeneration: plan.baseGeneration,
    // A page names a published body rather than carrying it, which is the
    // whole point of publishing: the largest object this protocol moves
    // never enters the request path.
    upserts: plan.upserts.slice(offset, end).map((shard) => {
      if (shard.graphPaths === undefined) return shard;
      const { graph, graphPaths, unnamedBody, ...named } = shard;
      // `unnamedBody` publishes nothing and names nothing, which is a
      // producer breaking the contract rather than a mode of it.
      return unnamedBody ? named : { ...named, graphPaths };
    }),
    deletes: offset === 0 ? plan.deletes : [],
    manifest: offset === 0 && !plan.cacheHit ? plan.manifest : [],
    page: {
      offset,
      count: end - offset,
      total: plan.upserts.length,
      nextCursor:
        end < plan.upserts.length ? `${plan.token}:${end}` : null,
    },
    phases: {
      validationMillis,
      semanticMillis,
      shardMillis,
      encodeMillis,
      totalMillis:
        validationMillis + semanticMillis + shardMillis + encodeMillis,
      cacheHit: plan.cacheHit,
    },
  };
}

function compilationCommands() {
  for (const candidate of [
    path.join(process.cwd(), "compile_commands.json"),
    path.join(process.cwd(), "build", "compile_commands.json"),
  ]) {
    try {
      const rows = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (Array.isArray(rows)) {
        return rows.filter(
          (row) => typeof row?.file === "string" && row.file !== "",
        );
      }
    } catch {}
  }
  return [];
}

function graphShard(command) {
  const directory = path.resolve(command.directory || process.cwd());
  const mainFile = path.resolve(directory, command.file);
  const mainFileUri = pathToFileURL(mainFile).href;
  const commandLine = Array.isArray(command.arguments)
    ? command.arguments
    : String(command.command || "clang++ -c fixture.cpp").split(/\s+/u);
  const commandDigest = digest(
    `${directory.length}:${directory}${mainFile.length}:${mainFile}${commandLine
      .map((argument) => `${argument.length}:${argument}`)
      .join("")}`,
  );
  const language = commandLine.some((argument) => argument === "c") ||
    path.extname(mainFile).toLowerCase() === ".c"
    ? "c"
    : "cpp";
  const targetTriple = "x86_64-pc-windows-msvc";
  const diskText = fs.readFileSync(mainFile);
  const sourceText = checkerOverlay
    ? Buffer.concat([Buffer.from("// checker overlay\n"), diskText])
    : diskText;
  const sourceDigest = digest(sourceText);
  const diskDigest = emptyDiskDigest ? "" : digest(diskText);
  const text = sourceText.toString("utf8");
  const callerRange = wordRanges(text, mainFileUri, "caller")[0] ??
    range(mainFileUri, 0, 0, 0, 0);
  const calleeRanges = wordRanges(text, mainFileUri, "callee");
  const calleeReference = calleeRanges.at(-2) ?? callerRange;
  const calleeDefinition = calleeRanges.at(-1) ?? callerRange;
  const sourceRange = callerRange;
  const callerName = sourceText.includes("edited") ? "editedCaller" : "caller";
  const caller = symbol("c:@F@caller#", callerName, 13, callerRange, true);
  const callee = symbol("c:@F@callee#", "callee", 13, calleeDefinition, true);
  const base = symbol("c:@S@Base", "Base", 7, sourceRange, true);
  const derived = symbol("c:@S@Derived", "Derived", 7, sourceRange, true);
  const constructor = symbol("c:@S@Derived@F@Derived#", "Derived", 23, sourceRange, true);
  const field = symbol("c:@S@Derived@FI@value", "value", 15, sourceRange, false);
  const symbols = [caller, callee, base, derived, constructor, field];
  const sources = [{
    uri: mainFileUri,
    digest: sourceDigest,
    diskDigest,
    flags: 1,
  }];
  const header = path.join(directory, "include", "fixture.h");
  let includes = [];
  try {
    const headerUri = pathToFileURL(header).href;
    const headerDigest = digest(fs.readFileSync(header));
    sources.push({
      uri: headerUri,
      digest: headerDigest,
      diskDigest: headerDigest,
      flags: 0,
    });
    includes = [{
      source: mainFileUri,
      target: headerUri,
      spelling: "fixture.h",
      angled: false,
      moduleImported: false,
      evidence: sourceRange,
    }];
  } catch {}
  const graph = {
    producerFingerprint: producerFingerprint({
      version: "clang version 22.1.8",
      commit,
    }),
    mainFileUri,
    mainFile,
    directory,
    commandLine,
    output: typeof command.output === "string" ? command.output : "",
    commandDigest,
    toolchainFingerprint: digest("fixture-toolchain"),
    targetTriple,
    language,
    hadErrors: false,
    sources,
    symbols,
    occurrences: [
      occurrence(callee.id, caller.id, (1 << 2) | (1 << 5), 13, calleeReference),
      occurrence(constructor.id, caller.id, (1 << 2) | (1 << 5), 23, sourceRange),
      occurrence(base.id, derived.id, 1 << 2, 7, sourceRange),
      occurrence(field.id, caller.id, (1 << 2) | (1 << 3), 15, sourceRange),
      occurrence(callee.id, caller.id, (1 << 2) | (1 << 5) | (1 << 6), 13, sourceRange),
    ],
    relations: [
      relation(base.id, derived.id, 1 << 11, sourceRange),
      relation(derived.id, base.id, 1 << 12, sourceRange),
      relation(callee.id, caller.id, 1 << 14, sourceRange),
      relation(field.id, derived.id, 1 << 10, sourceRange),
      relation(field.id, caller.id, 1 << 16, sourceRange),
      relation(derived.id, base.id, 1 << 19, sourceRange),
    ],
    macros: [
      {
        usr: "c:@macro@FIXTURE",
        id: "c:@macro@FIXTURE|ordinal=0",
        name: "FIXTURE",
        roles: 1 << 1,
        definition: sourceRange,
        spelling: sourceRange,
        expansion: sourceRange,
      },
      {
        usr: "c:@macro@FIXTURE",
        id: "c:@macro@FIXTURE|ordinal=0",
        name: "FIXTURE",
        roles: 1 << 2,
        definition: sourceRange,
        spelling: sourceRange,
        expansion: sourceRange,
      },
    ],
    includes,
    missingIncludes: [],
    modules: [{ name: "fixture.module", roles: 1 << 2, evidence: sourceRange }],
    diagnostics: [{
      message: "fixture warning",
      code: "clang:1",
      severity: "warning",
      range: sourceRange,
    }],
  };
  if (edgeCases) applyEdgeCases(graph, sourceRange, caller, callee, base, derived, constructor);
  if (invalidSourceUri) {
    graph.sources.push({
      uri: "file:%",
      digest: digest("invalid-uri"),
      diskDigest: "",
      flags: 0,
    });
  }
  if (unsupportedSourceUri) {
    graph.sources.push({
      uri: "repo:///fixture/unknown.hpp",
      digest: digest("unsupported-source-uri"),
      diskDigest: "",
      flags: 0,
    });
  }
  const key = `${mainFileUri}#${commandDigest}`;
  const interfaceFingerprint = digest(
    symbols
      .filter((entry) => entry.exported)
      .map((entry) => `${lengthPrefixed(entry.id)}${lengthPrefixed(entry.signature)}`)
      .join(""),
  );
  const shard = {
    key,
    source: mainFile,
    configuration: commandDigest,
    checkerDigest: sourceDigest,
    interfaceFingerprint,
    digest: "",
    graph,
    coverage: EDGE_KINDS.map((family) => ({
      family,
      state: COVERAGE[family],
    })),
  };
  // The producer's own three-step composition. Its body term names what a
  // published body is published under rather than serializing its contents,
  // because deriving the old whole-body digest cost a second pass over every
  // occurrence and exhausted a 16 GiB host on real C++.
  const bodyDigest = digest(
    lengthPrefixed(graph.producerFingerprint) +
      lengthPrefixed(graph.mainFileUri) +
      lengthPrefixed(graph.commandDigest) +
      lengthPrefixed(graph.toolchainFingerprint) +
      lengthPrefixed(graph.targetTriple) +
      lengthPrefixed(graph.language) +
      (graph.hadErrors ? "!" : ".") +
      graph.sources
        .map((entry) => `${lengthPrefixed(entry.uri)}${lengthPrefixed(entry.digest)}`)
        .join("") +
      [
        graph.symbols.length,
        graph.occurrences.length,
        graph.relations.length,
        graph.macros.length,
        graph.includes.length,
        graph.missingIncludes.length,
        graph.modules.length,
        graph.diagnostics.length,
      ]
        .map((count) => `${count},`)
        .join(""),
  );
  const diskMaterial = graph.sources
    .map((entry) => `${lengthPrefixed(entry.uri)}${lengthPrefixed(entry.diskDigest)}`)
    .join("");
  shard.digest = digest(
    [key, sourceDigest, interfaceFingerprint, bodyDigest, diskMaterial].join(
      "\n",
    ),
  );
  // The body's own digest. A published page names the body by this instead
  // of carrying it, so the field is the claim such a producer is checked
  // against. This fixture always carries the body inline.
  shard.bodyDigest = bodyDigest;
  // Published while the body is in hand, split by file and each piece named
  // by its own digest, exactly as the producer does. The body stays on the
  // shard until a page is built, because the envelope is still assembled
  // from it.
  if (bodyRoot !== undefined) {
    fs.mkdirSync(bodyRoot, { recursive: true });
    // Split by file, as the producer does: the facts spelled in the main
    // file, then those spelled in each header it included. A header piece
    // is named by every unit that includes it and read once, which is the
    // whole reason bodies are split before they are published.
    const byFile = new Map();
    const pieceOf = (uri) => {
      let piece = byFile.get(uri);
      if (piece === undefined) {
        // Only the main file's piece carries the unit's identity. A header's
        // piece must not: two units that include the same header would
        // otherwise write two files differing solely in whose unit read it,
        // and the deduplication this split exists for would never happen.
        const identity = uri === graph.mainFileUri
          ? graph
          : { producerFingerprint: "", mainFileUri: "", mainFile: "",
              directory: "", commandLine: [], output: "", commandDigest: "",
              toolchainFingerprint: "", targetTriple: "", language: "",
              hadErrors: false };
        piece = { ...identity, symbols: [], occurrences: [], relations: [],
          macros: [], includes: [], missingIncludes: [], modules: [],
          diagnostics: [], sources: [] };
        byFile.set(uri, piece);
      }
      return piece;
    };
    // Every source gets a piece, as the producer does: a header this unit
    // read is a file this unit saw, whether or not it declared anything.
    for (const source of graph.sources) pieceOf(source.uri);
    pieceOf(graph.mainFileUri).sources = graph.sources;
    for (const symbol of graph.symbols)
      pieceOf(symbol.declaration.file).symbols.push(symbol);
    for (const occurrence of graph.occurrences)
      pieceOf(occurrence.spelling.file).occurrences.push(occurrence);
    for (const relation of graph.relations)
      pieceOf(graph.mainFileUri).relations.push(relation);
    for (const macro of graph.macros)
      pieceOf(graph.mainFileUri).macros.push(macro);
    for (const include of graph.includes)
      pieceOf(include.source).includes.push(include);
    for (const missing of graph.missingIncludes)
      pieceOf(graph.mainFileUri).missingIncludes.push(missing);
    for (const module of graph.modules)
      pieceOf(graph.mainFileUri).modules.push(module);
    for (const diagnostic of graph.diagnostics)
      pieceOf(graph.mainFileUri).diagnostics.push(diagnostic);
    const write = (piece) => {
      const text = JSON.stringify(piece);
      const file = path.join(bodyRoot, digest(text) + ".graph.json");
      if (!fs.existsSync(file)) fs.writeFileSync(file, text);
      return file;
    };
    shard.graphPaths = [
      write(pieceOf(graph.mainFileUri)),
      ...[...byFile.entries()]
        .filter(([uri]) => uri !== graph.mainFileUri)
        .map(([, piece]) => write(piece)),
    ];
    if (bodyFault === "absent")
      shard.graphPaths = [shard.graphPaths[0] + ".missing"];
    if (bodyFault === "unnamed") shard.unnamedBody = true;
    if (bodyFault === "malformed")
      fs.writeFileSync(shard.graphPaths[0], "{ not json");
  }
  return shard;
}

function applyEdgeCases(graph, location, caller, callee, base, derived, constructor) {
  const empty = range("", 0, 0, 0, 0);
  caller.qualifiedName = "fixture::caller";
  callee.qualifiedName = "";
  base.ownerUsr = caller.id;
  derived.definition = empty;
  constructor.kind = 999;
  constructor.declaration = empty;
  constructor.definition = empty;
  constructor.attributes = [];
  graph.sources.push(
    {
      uri: "bundled:///fixture/system.h",
      digest: digest("bundled"),
      diskDigest: "",
      flags: 0,
    },
    {
      uri: "relative.cpp",
      digest: digest("relative"),
      diskDigest: "",
      flags: 0,
    },
    {
      uri: path.join(graph.directory, "absolute.cpp"),
      digest: digest("absolute"),
      diskDigest: digest("absolute"),
      flags: 0,
    },
  );
  graph.occurrences[0].containerId = "";
  graph.occurrences[0].expansion = empty;
  graph.occurrences.push(occurrence(callee.id, "", 1 << 2, 13, empty));
  graph.relations.push(
    relation(base.id, derived.id, 1 << 15, location),
    relation(caller.id, caller.id, 1 << 12, location),
    relation(caller.id, callee.id, 1 << 12, empty),
    relation("c:@F@external#", caller.id, 1 << 12, location),
  );
  graph.macros[0].definition = empty;
  graph.macros[0].spelling = empty;
  graph.macros[0].expansion = empty;
  graph.macros[1].spelling = empty;
  graph.macros[1].expansion = empty;
  graph.modules[0].evidence = empty;
  graph.diagnostics[0].range = empty;
}

function symbol(id, name, kind, location, exported) {
  return {
    usr: id,
    id,
    name,
    qualifiedName: name,
    ownerUsr: "",
    signature: kind === 13 ? "void ()" : "",
    kind,
    subKind: 0,
    properties: 0,
    local: false,
    internal: !exported,
    anonymous: false,
    exported,
    declaration: location,
    definition: location,
    attributes: [{ name: "nodiscard", range: location }],
  };
}

function occurrence(id, containerId, roles, targetKind, location) {
  return {
    usr: id,
    id,
    containerId,
    roles,
    targetKind,
    spelling: location,
    expansion: location,
  };
}

function relation(subjectId, objectId, roles, evidence) {
  return { subjectId, objectId, roles, evidence };
}

function range(file, startLine, startColumn, endLine, endColumn) {
  return { file, startLine, startColumn, endLine, endColumn };
}

function wordRanges(text, file, word) {
  const output = [];
  let offset = 0;
  for (;;) {
    const found = text.indexOf(word, offset);
    if (found < 0) return output;
    const prefix = text.slice(0, found);
    const line = prefix.split("\n").length - 1;
    const lastNewline = prefix.lastIndexOf("\n");
    const column = found - lastNewline - 1;
    output.push(range(file, line, column, line, column + word.length));
    offset = found + word.length;
  }
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** One length-prefixed value, byte-counted exactly as the producer writes it. */
function lengthPrefixed(value) {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function coordinate(label, value) {
  return `${label}:${Buffer.byteLength(value)}:${value}`;
}

function producerFingerprint(producer) {
  return digest(
    `samchon-graph-schema:1\nversion:${producer.version}\nrepository:${producer.commit}`,
  );
}

function canonicalRoot(root) {
  const slash = path.resolve(root).replace(/\\/gu, "/");
  return process.platform === "win32" ? slash.toLowerCase() : slash;
}

function compareKey(left, right) {
  const source = Buffer.compare(
    Buffer.from(left.source, "utf8"),
    Buffer.from(right.source, "utf8"),
  );
  if (source !== 0) return source;
  return Buffer.compare(
    Buffer.from(left.configuration, "utf8"),
    Buffer.from(right.configuration, "utf8"),
  );
}

function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}
