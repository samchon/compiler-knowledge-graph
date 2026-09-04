#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { GraphSnapshotProtocol } = require(path.resolve(
  __dirname,
  "../../../../packages/graph/lib/provider/GraphSnapshotProtocol.js",
));

const args = process.argv.slice(2);
const valueOf = (prefix) =>
  args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
const marker = valueOf("--marker=");
const requestLog = valueOf("--request-log=");
const expectInitializationOptions = args.includes("--expect-initialization-options");
const conformance = args.includes("--conformance");
const change = args.includes("--change");
const malformed = valueOf("--malformed=");
const internalError = args.includes("--internal-error");
const hang = args.includes("--hang");
const hangInitialize = args.includes("--hang-initialize");
const initializeError = args.includes("--initialize-error");
const transition = valueOf("--transition=");
let contentModified = Number(valueOf("--content-modified=") ?? 0);
let sequence = 1;
let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString("ascii");
    const length = Number(/Content-Length:\s*(\d+)/iu.exec(header)?.[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (!Number.isSafeInteger(length) || buffer.length < bodyEnd) return;
    const message = JSON.parse(buffer.slice(bodyStart, bodyEnd).toString("utf8"));
    buffer = buffer.slice(bodyEnd);
    handle(message);
  }
});

function handle(message) {
  if (requestLog !== undefined) {
    fs.appendFileSync(requestLog, `${JSON.stringify(message)}\n`);
  }
  if (message.method === "initialize") {
    if (hangInitialize) return;
    if (initializeError) {
      sendError(message.id, -32603, "fixture initialize failure");
      return;
    }
    if (
      expectInitializationOptions &&
      JSON.stringify(message.params?.initializationOptions) !== '{"fixture":true}'
    ) {
      process.exitCode = 31;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
    return;
  }
  if (message.method === "workspace/executeCommand") {
    if (hang) return;
    if (internalError) {
      sendError(message.id, -32603, "fixture internal failure");
      return;
    }
    if (contentModified > 0) {
      contentModified -= 1;
      sendError(message.id, -32801, "fixture solution moved");
      return;
    }
    const known = message.params?.arguments?.[0]?.knownGeneration ?? null;
    const result = snapshot(known);
    corrupt(result);
    send({ jsonrpc: "2.0", id: message.id, result });
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "exit") finish();
}

function snapshot(known) {
  const initial = transaction("initial", 1, null, "fixture");
  const initialGeneration = initial.generation;
  const edited = change
    ? transaction("incremental", 2, initial, "edited")
    : undefined;
  const transitioned =
    transition === "reload"
      ? transaction("reload", 2, null, "reloaded", "reloaded-universe")
      : transition === "rebuild"
        ? transaction("rebuild", 2, null, "rebuilt")
        : transition === "reload-nonfull"
          ? transaction(
              "reload",
              2,
              initial,
              "invalid-reload",
              "reloaded-universe",
            )
          : transition === "stale-base"
            ? staleBase(initial)
        : undefined;
  if (known === transitioned?.generation) {
    return {
      protocolVersion: 1,
      mode: "unchanged",
      sequence: 2,
      generation: transitioned.generation,
      universe: transitioned.universe,
      frames: [],
    };
  }
  if (known === edited?.generation) {
    return {
      protocolVersion: 1,
      mode: "unchanged",
      sequence: 2,
      generation: edited.generation,
      universe: edited.universe,
      frames: [],
    };
  }
  if (known === initialGeneration && transitioned !== undefined) {
    sequence = 2;
    return transitioned;
  }
  if (known === initialGeneration && !change) {
    return {
      protocolVersion: 1,
      mode: "unchanged",
      sequence: 1,
      generation: initialGeneration,
      universe: initial.universe,
      frames: [],
    };
  }
  if (known === initialGeneration && change) {
    sequence = 2;
    return edited;
  }
  return initial;
}

function transaction(
  mode,
  nextSequence,
  prior,
  name,
  universeName = "fixture-universe",
) {
  const graphFile = conformance ? "src/Main.cs" : "Program.cs";
  const sourceFile = path.join(process.cwd(), ...graphFile.split("/"));
  const bytes = fs.readFileSync(sourceFile);
  const target = `roslyn:${sha256("fixture-target")}`;
  const universe = sha256(universeName);
  const evidence = {
    file: graphFile,
    startLine: 1,
    startCol: 1,
    endLine: 1,
    endCol: 6,
  };
  const nodes = conformance
    ? ["caller", "callee"]
        .map((symbol) => ({
          id: `@v2/csharp/${sha256(`fixture-${symbol}`)}#${symbol}:function`,
          kind: "function",
          language: "csharp",
          name: symbol,
          file: graphFile,
          external: false,
          evidence: wordSpans(bytes.toString("utf8"), graphFile, symbol).at(-1),
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    : [{
        id: `@v2/csharp/${sha256(`fixture-${name}`)}#${name}:class`,
        kind: "class",
        language: "csharp",
        name,
        file: graphFile,
        external: false,
        evidence,
      }];
  const caller = nodes.find((node) => node.name === "caller");
  const callee = nodes.find((node) => node.name === "callee");
  const edges = conformance
    ? [{
        from: caller.id,
        to: callee.id,
        kind: "references",
        evidence: wordSpans(bytes.toString("utf8"), graphFile, "callee").at(-2),
      }]
    : [];
  const families = [
    "contains", "exports", "imports", "calls", "accesses",
    "instantiates", "type_ref", "extends", "implements", "overrides",
    "dispatches", "decorates", "renders", "tests", "references",
  ];
  const coverage = families.map((family) => ({
    provider: "roslyn-workspace",
    language: "csharp",
    target,
    family,
    state: family === "renders" ? "unsupported" : "partial",
  }));
  const unresolved = families
    .filter((family) => family !== "renders")
    .map((family) => ({
      provider: "roslyn-workspace",
      language: "csharp",
      target,
      universe,
      family,
      evidence,
      reason: "provider-gap",
      candidates: [],
    }));
  const source = {
    file: sourceFile,
    checkerDigest: sha256(bytes),
    diskDigest: sha256(bytes),
  };
  const shard = {
    key: "csharp-fixture|Program.cs",
    target,
    languages: ["csharp"],
    nodes,
    edges,
    diagnostics: [],
    coverage,
    unresolved,
    sources: [source],
  };
  const shardDigest = GraphSnapshotProtocol.shardDigest(shard);
  const manifest = [{ key: shard.key, digest: shardDigest }];
  const generation = sha256(`${universe}:${name}`);
  const hello = {
    type: "hello",
    protocolVersion: 1,
    schemaVersion: 1,
    producerSchemaVersion: 1,
    provider: "roslyn-workspace",
    producer: "samchon-roslyn",
    producerVersion: "1.0.0-fixture",
    compilerVersion: "5.9.0-fixture",
    languages: ["csharp"],
    authority: "compiler",
    supportedFacts: families.filter((family) => family !== "renders"),
    capabilities: [
      "coverage", "diagnostics", "diskDigests", "incremental",
      "sourceDigests", "universe", "unresolved", "immutableSolution",
      "sourceGeneratedDocuments",
    ],
  };
  const begin = {
    type: "begin",
    sequence: nextSequence,
    generation,
    universe,
    manifest: GraphSnapshotProtocol.manifestDigest([source]),
    targets: [target],
    ...(prior === null
      ? {}
      : { baseSequence: prior.sequence, baseGeneration: prior.generation }),
  };
  const provenance = {
    provider: hello.provider,
    authority: hello.authority,
    facts: hello.supportedFacts,
    schemaVersion: hello.producerSchemaVersion,
    tool: hello.producer,
    toolVersion: hello.producerVersion,
    compilerVersion: hello.compilerVersion,
    protocolVersion: hello.protocolVersion,
    universe,
    capabilities: hello.capabilities,
  };
  const factDigest = GraphSnapshotProtocol.factDigest({
    languages: hello.languages,
    nodes: shard.nodes,
    edges: shard.edges,
    diagnostics: shard.diagnostics,
    coverage: shard.coverage,
    unresolved: shard.unresolved,
    provenance,
  });
  return {
    protocolVersion: 1,
    mode,
    sequence: nextSequence,
    generation,
    universe,
    frames: [
      hello,
      begin,
      { type: "upsertShard", digest: shardDigest, shard },
      { type: "commit", sequence: nextSequence, generation, shards: manifest, factDigest },
    ],
  };
}

function corrupt(result) {
  if (malformed === undefined) return;
  if (malformed === "envelope") result.protocolVersion = 2;
  if (malformed === "mode") result.mode = "incremental";
  if (malformed === "initial-base") {
    const begin = result.frames.find((frame) => frame.type === "begin");
    begin.baseSequence = 7;
    begin.baseGeneration = sha256("unexpected-base");
  }
  if (malformed === "sequence") result.sequence += 1;
  if (malformed === "generation") result.generation = sha256("wrong-generation");
  if (malformed === "universe") result.universe = sha256("wrong-universe");
  if (malformed === "unchanged-frames") {
    result.mode = "unchanged";
  }
}

function staleBase(initial) {
  const result = transaction("incremental", 2, initial, "stale-base");
  const begin = result.frames.find((frame) => frame.type === "begin");
  begin.baseSequence = 7;
  begin.baseGeneration = sha256("stale-base");
  return result;
}

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function wordSpans(text, file, word) {
  const output = [];
  for (let offset = 0; ; ) {
    const found = text.indexOf(word, offset);
    if (found < 0) return output;
    const prefix = text.slice(0, found);
    const line = prefix.split("\n").length;
    const column = found - prefix.lastIndexOf("\n");
    output.push({
      file,
      startLine: line,
      startCol: column,
      endLine: line,
      endCol: column + word.length,
    });
    offset = found + word.length;
  }
}

function finish() {
  if (marker !== undefined) fs.writeFileSync(marker, "closed");
  process.exit(process.exitCode ?? 0);
}
