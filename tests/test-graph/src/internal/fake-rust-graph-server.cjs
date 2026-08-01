#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const args = process.argv.slice(2);
const valueOf = (prefix) => args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
const commit = valueOf("--commit=") ?? "95f4050923a1d80a29147f4b66614c843c26b183";
const requestLog = valueOf("--request-log=");
const retrySentMarker = valueOf("--retry-sent-marker=");
const initializeMarker = valueOf("--initialize-marker=");
const initializeDelay = Number(valueOf("--initialize-delay=") ?? 0);
const marker = valueOf("--marker=");
let retry = Number(valueOf("--retry=") ?? 0);
let contentModified = Number(valueOf("--content-modified=") ?? 0);
const rejectCheckpoint = args.includes("--reject-checkpoint");
const hang = args.includes("--hang");
const internalError = args.includes("--internal-error");
const malformed = args.includes("--malformed");
const configurationWithoutItems = args.includes("--configuration-without-items");
const expectInitializationOptions = args.includes("--expect-initialization-options");
const initializeError = args.includes("--initialize-error");
const failVersion = args.includes("--fail-version");
const conformance = args.includes("--conformance");
const conformanceHeuristic = args.includes("--conformance-heuristic");

if (args.includes("--version")) {
  if (failVersion) process.exit(7);
  process.stdout.write(`rust-analyzer 1.95.0 (${commit.slice(0, 9)} 2026-08-01)\n`);
  process.exit(0);
}

const EDGE_KINDS = [
  "contains",
  "exports",
  "imports",
  "calls",
  "accesses",
  "instantiates",
  "type_ref",
  "extends",
  "implements",
  "overrides",
  "dispatches",
  "decorates",
  "renders",
  "tests",
  "references",
];
const universe = sha256("fixture-rust-universe");
const evidence = conformance
  ? {
      file: "src/lib.rs",
      startLine: 2,
      startColumn: 8,
      endLine: 2,
      endColumn: 14,
    }
  : {
      file: "src/lib.rs",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 20,
    };
const calleeEvidence = {
  file: "src/lib.rs",
  startLine: 3,
  startColumn: 8,
  endLine: 3,
  endColumn: 14,
};
const callEvidence = {
  file: "src/lib.rs",
  startLine: 2,
  startColumn: 19,
  endLine: 2,
  endColumn: 25,
};
const nodes = conformance
  ? [
      {
        id: "rust-hir-v1|fixture-caller",
        kind: "function",
        name: "caller",
        qualifiedName: "fixture::caller",
        file: "src/lib.rs",
        external: false,
        exported: true,
        signature: "fn()",
        evidence,
      },
      {
        id: "rust-hir-v1|fixture-callee",
        kind: "function",
        name: "callee",
        qualifiedName: "fixture::callee",
        file: "src/lib.rs",
        external: false,
        exported: true,
        signature: "fn()",
        evidence: calleeEvidence,
      },
      ...(conformanceHeuristic
        ? [
            {
              id: "rust-hir-v1|fixture-comment",
              kind: "function",
              name: "mentionedInComment",
              qualifiedName: "fixture::mentionedInComment",
              file: "src/lib.rs",
              external: false,
              exported: false,
              signature: "fn()",
              evidence: {
                file: "src/lib.rs",
                startLine: 1,
                startColumn: 4,
                endLine: 1,
                endColumn: 22,
              },
            },
          ]
        : []),
    ]
  : [
      {
        id: "rust-hir-v1|fixture-answer",
        kind: "function",
        name: "answer",
        qualifiedName: "fixture::answer",
        file: "src/lib.rs",
        external: false,
        exported: true,
        signature: "fn() -> u8",
        evidence,
      },
      {
        id: "rust-hir-v1|fixture-dependency",
        kind: "function",
        name: "dependency",
        qualifiedName: null,
        file: "bundled:///rust/dependencies",
        external: true,
        exported: false,
        signature: null,
        evidence: null,
      },
    ];
const edges = conformance
  ? [
      {
        from: "rust-hir-v1|fixture-caller",
        to: "rust-hir-v1|fixture-callee",
        kind: "calls",
        evidence: callEvidence,
      },
      ...(conformanceHeuristic
        ? [
            {
              from: "rust-hir-v1|fixture-caller",
              to: "rust-hir-v1|fixture-comment",
              kind: "calls",
              evidence: {
                file: "src/lib.rs",
                startLine: 1,
                startColumn: 4,
                endLine: 1,
                endColumn: 22,
              },
            },
          ]
        : []),
    ]
  : [
      {
        from: "rust-hir-v1|fixture-answer",
        to: "rust-hir-v1|fixture-dependency",
        kind: "calls",
        evidence,
      },
    ];
const shard = {
  key: "app\u0000src/lib.rs",
  source: "src/lib.rs",
  checkerDigest: sha256(conformanceHeuristic ? "fixture-heuristic" : "fixture-source"),
  interfaceFingerprint: sha256(
    conformanceHeuristic ? "fixture-heuristic-interface" : "fixture-interface",
  ),
  digest: "",
  nodes,
  edges,
  diagnostics: [
    {
      file: "src/lib.rs",
      line: 1,
      column: null,
      code: "fixture",
      message: "fixture diagnostic",
      severity: "warning",
    },
  ],
  coverage: EDGE_KINDS.map((family) => ({
    family,
    state: family === "renders" ? "unsupported" : "partial",
  })),
  unresolved: EDGE_KINDS.filter((family) => family !== "renders").map((family) => ({
    family,
    evidence,
    reason: "provider-gap",
    candidates: [],
  })),
};
shard.digest = sha256({
  key: shard.key,
  source: shard.source,
  checkerDigest: shard.checkerDigest,
  interfaceFingerprint: shard.interfaceFingerprint,
  nodes: shard.nodes,
  edges: shard.edges,
  diagnostics: shard.diagnostics,
  coverage: shard.coverage,
  unresolved: shard.unresolved,
});
const manifest = [{ key: shard.key, digest: shard.digest }];
const generation = sha256({ universe, manifest });
let sequence = 0;
let buffer = Buffer.alloc(0);
let initializeRequest;
let serverRequestPhase = 0;

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

process.stdin.on("end", finish);

function handle(message) {
  if (message.method === "initialize") {
    if (
      expectInitializationOptions &&
      JSON.stringify(message.params?.initializationOptions) !== '{"fixture":true}'
    ) {
      process.exitCode = 33;
    }
    initializeRequest = message.id;
    if (initializeMarker !== undefined) fs.writeFileSync(initializeMarker, "started");
    if (initializeDelay > 0) {
      setTimeout(requestConfiguration, initializeDelay);
      return;
    }
    requestConfiguration();
    return;
  }
  if (message.id === 9001 && serverRequestPhase === 0) {
    const expected = configurationWithoutItems ? "[]" : "[null,null]";
    if (JSON.stringify(message.result) !== expected) process.exitCode = 31;
    serverRequestPhase = 1;
    send({ jsonrpc: "2.0", id: 9002, method: "fixture/unknown", params: {} });
    return;
  }
  if (message.id === 9002 && serverRequestPhase === 1) {
    if (message.result !== null) process.exitCode = 32;
    serverRequestPhase = 2;
    if (initializeError) {
      sendError(initializeRequest, -32603, "fixture initialize failure");
    } else {
      send({ jsonrpc: "2.0", id: initializeRequest, result: { capabilities: {} } });
    }
    return;
  }
  if (message.method === "samchon/graphSnapshot") {
    if (requestLog !== undefined) fs.appendFileSync(requestLog, `${JSON.stringify(message.params)}\n`);
    if (hang) return;
    if (internalError) {
      sendError(message.id, -32603, "fixture internal failure");
      return;
    }
    if (message.params?.checkpoint !== undefined && rejectCheckpoint) {
      sendError(message.id, -32802, "persisted checkpoint rejected");
      return;
    }
    if (retry > 0) {
      retry -= 1;
      sendError(message.id, -32802, "fixture index is not ready");
      if (retrySentMarker !== undefined) fs.writeFileSync(retrySentMarker, "sent");
      return;
    }
    if (contentModified > 0) {
      contentModified -= 1;
      sendError(message.id, -32801, "fixture content changed");
      return;
    }
    sequence += 1;
    const base = message.params?.checkpoint?.generation ?? message.params?.knownGeneration;
    const result = snapshot(base === generation ? generation : null);
    if (malformed) result.producer.commit = "wrong";
    send({ jsonrpc: "2.0", id: message.id, result });
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "exit") finish();
}

function requestConfiguration() {
    send({
      jsonrpc: "2.0",
      id: 9001,
      method: "workspace/configuration",
      params: configurationWithoutItems
        ? {}
        : { items: [{ section: "rust-analyzer" }, { section: "rust-analyzer.cargo" }] },
    });
}

function snapshot(baseGeneration) {
  return {
    protocolVersion: 1,
    schemaVersion: 1,
    producer: { name: "samchon-rust-analyzer", version: "1.95.0", commit },
    universe: {
      digest: universe,
      target: "app",
      workspaceRoots: ["."],
      toolchains: ["stable"],
      configurations: ["rustc-version=rustc 1.95.0 (fixture)\nhost: fixture"],
    },
    sequence,
    generation,
    baseGeneration,
    upserts: baseGeneration === null ? [shard] : [],
    deletes: [],
    manifest,
    phases: {
      semanticMillis: baseGeneration === null ? 1 : 0,
      shardMillis: baseGeneration === null ? 1 : 0,
      encodeMillis: 1,
      totalMillis: baseGeneration === null ? 3 : 1,
      cacheHit: baseGeneration !== null,
    },
  };
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message, data: { fixture: true } } });
}

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function sha256(value) {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort(compare)
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finish() {
  if (marker !== undefined) fs.writeFileSync(marker, "closed");
  process.exit(process.exitCode ?? 0);
}
