#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const args = process.argv.slice(2);
const valueOf = (prefix) =>
  args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
const requestLog = valueOf("--request-log=");
const marker = valueOf("--marker=");
const delayCommand = Number(valueOf("--delay-command=") ?? 0);
const delayInitialize = Number(valueOf("--delay-initialize=") ?? 0);
const failInitialize = args.includes("--fail-initialize");
const reuseAfterChange = args.includes("--reuse-after-change");
const source = path.join(process.cwd(), "src", "Example.java");
let buffer = Buffer.alloc(0);
let lastGeneration;
let sequence = 0;

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const header = buffer.subarray(0, end).toString("ascii");
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
    if (!Number.isSafeInteger(length) || buffer.length < end + 4 + length) return;
    const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
    buffer = buffer.subarray(end + 4 + length);
    handle(JSON.parse(body));
  }
});

function handle(message) {
  if (requestLog) fs.appendFileSync(requestLog, `${JSON.stringify(message)}\n`);
  if (message.method === "initialize") {
    if (failInitialize) {
      return error(message.id, -32000, "fixture initialize failure");
    }
    const result = { capabilities: { executeCommandProvider: { commands: ["java.graph.snapshot"] } } };
    return delayInitialize > 0
      ? setTimeout(() => respond(message.id, result), delayInitialize)
      : respond(message.id, result);
  }
  if (message.method === "workspace/executeCommand") {
    if (message.params?.command !== "java.graph.snapshot") {
      return error(message.id, -32601, "unsupported command");
    }
    const result = snapshot();
    return delayCommand > 0
      ? setTimeout(() => respond(message.id, result), delayCommand)
      : respond(message.id, result);
  }
  if (message.method === "shutdown") return respond(message.id, null);
  if (message.method === "exit") {
    if (marker) fs.writeFileSync(marker, "closed");
    process.exit(0);
  }
}

function snapshot() {
  const exists = fs.existsSync(source);
  const text = exists ? fs.readFileSync(source) : Buffer.alloc(0);
  const observed = sha256(Buffer.concat([Buffer.from("generation:"), text]));
  const generation = reuseAfterChange && lastGeneration !== undefined ? lastGeneration : observed;
  const mode = lastGeneration === undefined ? "initial" : lastGeneration === generation ? "unchanged" : "incremental";
  if (lastGeneration !== generation) sequence += 1;
  lastGeneration = generation;
  const uri = pathToFileURL(source).href;
  const evidence = { uri, startLine: 1, startColumn: 1, endLine: 1, endColumn: 20 };
  const file = "java/fixture/file/example";
  const type = "java/fixture/type/example.Example";
  const method = `${type}/method/run()`;
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    producer: { name: "eclipse-jdtls-graph-snapshot", version: "1.50.0.fixture", compilerVersion: "21" },
    capabilities: {
      atomicGenerations: true,
      resident: true,
      sourceDigests: true,
      diskDigests: true,
      unsavedBuffers: true,
      diagnostics: true,
      facts: ["contains"],
    },
    universe: sha256("fixture-universe"),
    generation,
    complete: true,
    mode,
    sequence,
    projects: [{ name: "fixture", location: pathToFileURL(process.cwd()).href, output: "/fixture/bin", compilerVersion: "21", options: {}, classpath: [] }],
    sources: exists ? [{ project: "fixture", uri, checkerDigest: sha256(Buffer.concat([Buffer.from("checker:"), text])), checkerEncoding: "jdt-utf16-code-units-v1", diskDigest: sha256(text) }] : [],
    nodes: exists ? [
      node(file, file, "persistent", uri, "Example.java", uri, "file", "", "file", [], evidence),
      node(type, "Lexample/Example;", "persistent", uri, "Example", "example.Example", "class", "", "type", ["public", "final"], evidence),
      node(method, "Lexample/Example;.run()V", "structural", uri, "run", "example.Example.run", "method", "():void", "method", ["public"], evidence),
    ] : [],
    edges: exists ? [
      { from: file, to: type, kind: "contains", evidence },
      { from: type, to: method, kind: "contains", evidence },
    ] : [],
    diagnostics: exists ? [{ uri, severity: "information", code: "fixture", message: "fixture note", evidence }] : [],
    coverage: { contains: "complete" },
    unresolved: [],
  };
}

function node(symbol, nativeKey, stability, uri, name, qualifiedName, kind, signature, declarationKind, modifiers, evidence) {
  return { project: "fixture", symbol, nativeKey, stability, uri, name, qualifiedName, kind, signature, declarationKind, exported: modifiers.includes("public"), modifiers, evidence };
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function error(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function write(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
