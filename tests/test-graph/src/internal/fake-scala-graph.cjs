// Deterministic stand-in for the resident BSP/Scala compiler producer.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const args = process.argv.slice(2);
const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const md5 = (value) => crypto.createHash("md5").update(value).digest("hex");

if (args.includes("--version")) {
  process.stdout.write("samchon-scala-graph 0.1.0-fake\n");
  process.exit(0);
}

if (args.includes("supports")) {
  process.exit(args.includes("--fake-unsupported") ? 1 : 0);
}

if (args.includes("snapshot")) {
  const index = args.indexOf("--output");
  const output = index === -1 ? undefined : args[index + 1];
  if (output === undefined) {
    process.stderr.write("fake Scala graph: snapshot requires --output\n");
    process.exit(2);
  }
  writeArtifact(output);
  process.exit(0);
}

if (!args.includes("graph-server")) {
  process.stderr.write("fake Scala graph: expected graph-server\n");
  process.exit(2);
}
if (args.includes("--help")) {
  if (!args.includes("--fake-legacy-server")) {
    process.stdout.write(
      "Serve BSP-driven Scala compiler graph generations over NDJSON.\n",
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
  const targets = [
    target(root, "2.13.18", "2.13", "scala2", "src/scala-2/demo/Api.scala"),
    target(root, "3.9.0", "3", "scala3", "src/scala-3/demo/Api.scala"),
  ];
  const artifact = {
    schemaVersion: 1,
    projectRoot: root,
    producer: {
      name: "samchon-scala-graph",
      version: "0.1.0-fake",
      protocolVersion: 1,
      capabilities: {
        atomicGenerations: true,
        incremental: true,
        diagnostics: true,
        bsp: true,
        semanticdb: true,
        typedPlugins: true,
        zinc: true,
      },
    },
    targets,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(artifact)}\n`);
}

function target(root, scalaVersion, scalaBinaryVersion, plugin, source) {
  const bspUri = `file:///samchon-graph/${plugin}`;
  const bytes = fs.readFileSync(path.join(root, source));
  const coordinate = (name) => sha256(`${bspUri}:${name}`);
  const owner = `scala ${bspUri} demo Api#`;
  const method = `scala ${bspUri} demo Api#run().`;
  const nodes = [
    {
      symbol: owner,
      kind: "class",
      name: "Api",
      qualifiedName: "demo.Api",
      file: source,
      exported: true,
      modifiers: ["public"],
      signature: "class Api[A](value: A)",
      origin: "Source",
      evidence: evidence(source, 3, 1, 3, 28),
    },
    {
      symbol: method,
      kind: "method",
      name: "run",
      qualifiedName: "demo.Api.run",
      file: source,
      exported: true,
      modifiers: ["public"],
      signature: "def run(): A",
      origin: "Source",
      evidence: evidence(source, 4, 3, 4, 23),
    },
  ];
  const edges = [
    edge(source, owner, "contains", source, 3, 1, 3, 28, "class", "Api", "demo.Api"),
    edge(source, owner, "exports", source, 3, 1, 3, 28, "class", "Api", "demo.Api"),
    edge(owner, method, "contains", source, 4, 3, 4, 23, "method", "run", "demo.Api.run"),
    edge(
      method,
      "scala-library scala Predef.println().",
      "calls",
      source,
      4,
      16,
      4,
      23,
      "method",
      "println",
      "scala.Predef.println",
    ),
  ];
  const coverage = {};
  for (const family of [
    "contains", "exports", "imports", "calls", "accesses", "instantiates",
    "type_ref", "extends", "implements", "overrides", "dispatches", "decorates",
    "renders", "tests", "references",
  ]) coverage[family] = ["renders", "tests"].includes(family)
    ? "unsupported"
    : "partial";
  coverage.contains = "complete";
  coverage.calls = "partial";
  return {
    name: bspUri,
    generation: sha256(JSON.stringify({ bspUri, bytes: bytes.toString("hex") })),
    universe: coordinate(`universe:${scalaVersion}`),
    bspUri,
    scalaVersion,
    scalaBinaryVersion,
    platform: "jvm",
    sourceEncoding: "UTF-8",
    scalacOptionsDigest: coordinate("scalacOptions"),
    classpathDigest: coordinate("classpath"),
    sourceRootsDigest: coordinate("sourceRoots"),
    semanticdbOptionsDigest: coordinate("semanticdbOptions"),
    compilerPluginsDigest: coordinate("compilerPlugins"),
    zincAnalysisDigest: coordinate("zincAnalysis"),
    generatedSourcesDigest: coordinate("generatedSources"),
    coverage,
    shards: [
      {
        schemaVersion: 1,
        language: "scala",
        source,
        checkerDigest: sha256(bytes),
        diskDigest: sha256(bytes),
        target: bspUri,
        compilerVersion: scalaVersion,
        compilerPlugin: plugin,
        compilerPluginVersion: "0.1.0-fake",
        semanticdbSchema: 4,
        semanticdbUri: source,
        semanticdbMd5: md5(bytes),
        semanticdbBuildTarget: bspUri,
        nodes,
        edges,
        unresolved: [
          {
            family: "dispatches",
            reason: "dynamic",
            evidence: evidence(source, 4, 16, 4, 23),
            candidates: ["scala-library scala Predef.println()."],
          },
        ],
        diagnostics: [
          {
            severity: "warning",
            message: `${plugin} fixture warning`,
            evidence: evidence(source, 2, 1, 2, 12),
          },
        ],
      },
    ],
  };
}

function evidence(file, startLine, startColumn, endLine, endColumn) {
  return { file, startLine, startColumn, endLine, endColumn };
}

function edge(
  from,
  to,
  kind,
  file,
  startLine,
  startColumn,
  endLine,
  endColumn,
  targetKind,
  targetName,
  targetQualifiedName,
) {
  return {
    from,
    to,
    kind,
    access: null,
    provenance: kind === "calls" ? "typed-plugin" : "semanticdb",
    targetKind,
    targetName,
    targetQualifiedName,
    evidence: evidence(file, startLine, startColumn, endLine, endColumn),
  };
}
