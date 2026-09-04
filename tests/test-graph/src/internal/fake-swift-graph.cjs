// Deterministic stand-in for the SwiftPM/IndexStoreDB sidecar.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const args = process.argv.slice(2);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

if (args.includes("--version")) {
  process.stdout.write("samchon-swift-graph 0.1.0-fake\n");
  process.exit(0);
}
if (args.includes("supports")) {
  process.exit(args.includes("--fake-unsupported") ? 1 : 0);
}
if (args.includes("snapshot")) {
  const index = args.indexOf("--output");
  const output = index === -1 ? undefined : args[index + 1];
  if (output === undefined) {
    process.stderr.write("fake Swift graph: snapshot requires --output\n");
    process.exit(2);
  }
  writeArtifact(output);
  process.exit(0);
}
if (!args.includes("graph-server")) {
  process.stderr.write("fake Swift graph: expected graph-server\n");
  process.exit(2);
}
if (args.includes("--help")) {
  if (!args.includes("--fake-legacy-server")) {
    process.stdout.write(
      "Serve explicit-output-unit SwiftPM IndexStoreDB generations over NDJSON.\n",
    );
  }
  process.exit(0);
}

void serve();

async function serve() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    const request = JSON.parse(line);
    try {
      writeArtifact(request.output);
      process.stdout.write(
        `${JSON.stringify({ id: request.id, protocolVersion: 1, ok: true })}\n`,
      );
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          id: request.id,
          protocolVersion: 1,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    }
  }
}

function writeArtifact(output) {
  const root = process.cwd();
  const source = "Sources/Demo/Api.swift";
  const bytes = fs.readFileSync(path.join(root, source));
  const stale = path.join(
    root,
    ".build/x86_64-unknown-linux-gnu/debug/Stale.build/Old.swift.o",
  );
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, "stale unit that must remain outside the generation");
  const triples = ["arm64-apple-macosx13.0", "x86_64-unknown-linux-gnu"];
  const targets = triples.map((triple) => {
    const unit = `.build/${triple}/debug/Demo.build/Api.swift.o`;
    const unitFile = path.join(root, unit);
    fs.mkdirSync(path.dirname(unitFile), { recursive: true });
    fs.writeFileSync(unitFile, sha256(bytes));
    return target(root, source, bytes, unit, triple);
  });
  const artifact = {
    schemaVersion: 1,
    projectRoot: root,
    producer: {
      name: "samchon-swift-graph",
      version: "0.1.0-fake",
      protocolVersion: 1,
      capabilities: {
        atomicGenerations: true,
        incremental: true,
        diagnostics: true,
        explicitOutputUnits: true,
        indexStoreDB: true,
        sourceEnrichment: true,
        swiftpm: true,
        sourceKitResident: false,
      },
    },
    targets,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(artifact)}\n`);
}

function target(root, source, bytes, unit, triple) {
  const name = `Demo@${triple}/debug`;
  const service = "s:4Demo7ServiceP";
  const base = "s:4Demo4BaseC";
  const baseRun = "s:4Demo4BaseC3runyyF";
  const api = "s:4Demo3ApiC";
  const extension = "s:e:4Demo3ApiC";
  const constructor = "s:4Demo3ApiC4seedACSi_tcfc";
  const property = "s:4Demo3ApiC5valueSivp";
  const getter = "s:4Demo3ApiC5valueSivg";
  const setter = "s:4Demo3ApiC5valueSivs";
  const run = "s:4Demo3ApiC3runyyF";
  const fetch = "s:4Demo3ApiC5fetchySSqd__Ya_lF";
  const local = "s:L_4Demo3ApiC3runyyF5localL_Sivp";
  const macro = "s:4Demo12FixtureMacrofMp";
  const macroHost = "s:4Demo9MacroHostV";
  const test = "s:4Demo7testApiyyYaF";
  const coverage = {};
  for (const family of [
    "contains", "exports", "imports", "calls", "accesses", "instantiates",
    "type_ref", "extends", "implements", "overrides", "dispatches", "decorates",
    "renders", "tests", "references",
  ]) coverage[family] = family === "renders" ? "unsupported" : "partial";
  const coordinate = (value) => sha256(`${name}:${value}`);
  return {
    name,
    generation: coordinate(`generation:${sha256(bytes)}`),
    universe: coordinate("universe"),
    moduleName: "Demo",
    targetTriple: triple,
    sdk: triple.startsWith("arm64") ? "/SDK/MacOSX.sdk" : "",
    configuration: "debug",
    swiftLanguageVersion: "Swift 6.0",
    compilerFlagsDigest: coordinate("flags"),
    moduleDependenciesDigest: coordinate("modules"),
    packageResolutionDigest: coordinate("resolution"),
    pluginsDigest: coordinate("plugins"),
    generatedSourcesDigest: coordinate("generated"),
    indexStoreDBCommit: "f4d7f08f6a078050d86aed10a06bf1fc871a8ded",
    outputUnits: [{ path: unit, digest: sha256(fs.readFileSync(path.join(root, unit))) }],
    coverage,
    shards: [{
      schemaVersion: 1,
      language: "swift",
      source,
      checkerDigest: sha256(bytes),
      diskDigest: sha256(bytes),
      target: name,
      compilerVersion: "Swift 6.0",
      moduleName: "Demo",
      targetTriple: triple,
      sourceEnrichmentPasses: 1,
      nodes: [
        node(service, "interface", "Service", "Demo.Service", source, 3, "public protocol Service"),
        node(base, "class", "Base", "Demo.Base", source, 7, "open class Base"),
        node(baseRun, "method", "run", "Demo.Base.run", source, 10, "open func run()"),
        node(api, "class", "Api", "Demo.Api", source, 12, "public final class Api: Base, Service"),
        node(extension, "type", "Api extension", "Demo.Api.extension", source, 25, "extension Api", [], false),
        node(constructor, "constructor", "init(seed:)", "Demo.Api.init(seed:)", source, 26, "public convenience init(seed: Int)"),
        node(property, "property", "value", "Demo.Api.value", source, 14, "public override var value: Int"),
        node(getter, "method", "get value", "Demo.Api.value.get", source, 15, "get", [], false),
        node(setter, "method", "set value", "Demo.Api.value.set", source, 16, "set", [], false),
        node(run, "method", "run", "Demo.Api.run", source, 18, "public override final func run()"),
        node(fetch, "method", "fetch", "Demo.Api.fetch", source, 23, "public func fetch<T>(_ value: T) async -> String", ["public", "async"]),
        node(local, "variable", "local", "Demo.Api.run.local", source, 19, "var local", [], false, "IndexStoreDB:index-include-locals"),
        node(macro, "type", "FixtureMacro", "Demo.FixtureMacro", source, 32, "public macro FixtureMacro()"),
        node(macroHost, "type", "MacroHost", "Demo.MacroHost", source, 34, "public struct MacroHost"),
        node(test, "function", "testApi", "Demo.testApi", source, 36, "public func testApi() async", ["public", "async"]),
      ],
      edges: [
        edge(source, service, "contains", source, 3, "interface", "Service", "Demo.Service"),
        edge(source, api, "exports", source, 12, "class", "Api", "Demo.Api"),
        edge(source, "swift-module:Foundation", "imports", source, 1, "module", "Foundation", "Foundation"),
        edge(api, "swift-attribute:MainActor", "decorates", source, 2, "type", "MainActor", "MainActor"),
        edge(api, base, "extends", source, 12, "class", "Base", "Demo.Base"),
        edge(api, service, "implements", source, 12, "interface", "Service", "Demo.Service"),
        edge(extension, api, "type_ref", source, 25, "class", "Api", "Demo.Api"),
        edge(extension, constructor, "contains", source, 26, "constructor", "init(seed:)", "Demo.Api.init(seed:)"),
        edge(property, getter, "contains", source, 15, "method", "get value", "Demo.Api.value.get"),
        edge(property, setter, "contains", source, 16, "method", "set value", "Demo.Api.value.set"),
        edge(run, baseRun, "overrides", source, 18, "method", "run", "Demo.Base.run"),
        edge(test, constructor, "calls", source, 37, "constructor", "init(seed:)", "Demo.Api.init(seed:)"),
        edge(test, constructor, "instantiates", source, 37, "constructor", "init(seed:)", "Demo.Api.init(seed:)"),
        edge(test, property, "accesses", source, 38, "property", "value", "Demo.Api.value", "write"),
        edge(test, property, "accesses", source, 39, "property", "value", "Demo.Api.value", "read"),
        edge(test, run, "calls", source, 40, "method", "run", "Demo.Api.run"),
        edge(test, run, "dispatches", source, 40, "method", "run", "Demo.Api.run"),
        edge(test, run, "tests", source, 40, "method", "run", "Demo.Api.run"),
        edge(fetch, service, "references", source, 23, "interface", "Service", "Demo.Service"),
        edge(run, local, "references", source, 20, "variable", "local", "Demo.Api.run.local"),
      ],
      unresolved: [
        {
          family: "dispatches",
          reason: "dynamic",
          evidence: evidence(source, 40, 3, 40, 14),
          candidates: [baseRun, run],
        },
        {
          family: "references",
          reason: "conditional-build",
          evidence: evidence(source, 30, 1, 30, 17),
          candidates: [],
        },
        {
          family: "references",
          reason: "macro-or-generated",
          evidence: evidence(source, 32, 32, 32, 46),
          candidates: [macroHost],
        },
      ],
      diagnostics: [{
        severity: "warning",
        message: "fixture warning",
        evidence: evidence(source, 43, 4, 43, 11),
      }],
    }],
  };
}

function node(
  symbol,
  kind,
  name,
  qualifiedName,
  file,
  line,
  signature,
  modifiers = ["public"],
  exported = true,
  origin = "IndexStoreDB+source-enrichment",
) {
  return {
    symbol,
    kind,
    name,
    qualifiedName,
    file,
    exported,
    modifiers,
    signature,
    origin,
    evidence: evidence(file, line, 1, line, name.length + 1),
  };
}

function edge(
  from,
  to,
  kind,
  file,
  line,
  targetKind,
  targetName,
  targetQualifiedName,
  access = null,
) {
  return {
    from,
    to,
    kind,
    access,
    provenance: kind === "imports" || kind === "decorates"
      ? "source-enrichment"
      : "IndexStoreDB",
    targetKind,
    targetName,
    targetQualifiedName,
    evidence: evidence(file, line, 1, line, targetName.length + 1),
  };
}

function evidence(file, startLine, startColumn, endLine, endColumn) {
  return { file, startLine, startColumn, endLine, endColumn };
}
