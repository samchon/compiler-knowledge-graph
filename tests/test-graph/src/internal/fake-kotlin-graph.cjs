// A stand-in for `scip-java` with the kotlinc graph plugin attached.
//
// It answers the three questions the strict Kotlin route asks a launcher: what
// version it is, whether its `index` command publishes `--kotlin-graph-output`, and
// what that option writes. The artifact it writes is modelled on the producer's
// own Gradle lifecycle contract, including per-compilation targets and
// project-relative source paths.
//
// Every fault flag below stands for a producer state a real build can reach and
// a fixture cannot produce by asking politely: a launcher that predates the
// option, a generation with a hole in its coverage matrix, an edge whose target
// this compilation never saw, a build that recompiled one file.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--fake-${name}`);
const valueOf = (name) => {
  const prefix = `--fake-${name}=`;
  const found = args.find((argument) => argument.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
};
const optionAfter = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

if (args.includes("--version")) {
  process.stdout.write("scip-java 0.13.1-fake\n");
  process.exit(0);
}

const serving = args.includes("kotlin-graph-server");
if (serving) void serve();
else indexOnce();

async function serve() {
  if (args.includes("--help")) {
    if (!flag("legacy-server")) {
      process.stdout.write(
        "Serve compiler-owned Kotlin graph generations over NDJSON.\n",
      );
    }
    return;
  }
  if (flag("server-close-stdin")) {
    process.stdin.destroy();
    setInterval(() => undefined, 1_000);
    return;
  }
  const readline = require("node:readline");
  const childProcess = require("node:child_process");
  const prefix = args.slice(0, args.indexOf("kotlin-graph-server"));
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    const request = JSON.parse(line);
    const serverLog = valueOf("server-log");
    if (serverLog !== undefined) {
      fs.appendFileSync(serverLog, `${process.pid}\n`);
    }
    const once = (name) => {
      const marker = valueOf(name);
      if (marker === undefined || fs.existsSync(marker)) return false;
      fs.writeFileSync(marker, String(process.pid));
      return true;
    };
    if (flag("server-stall") || once("server-stall-once")) continue;
    if (once("server-crash-once")) process.exit(17);
    if (flag("server-stderr")) {
      process.stderr.write("resident fixture stderr\n");
    }
    if (once("server-malformed-once")) {
      process.stdout.write("not-json\n");
      continue;
    }
    if (once("server-string-once")) {
      process.stdout.write('"wrong"\n');
      continue;
    }
    if (once("server-null-once")) {
      process.stdout.write("null\n");
      continue;
    }
    if (once("server-non-object-once")) {
      process.stdout.write("[]\n");
      continue;
    }
    if (once("server-bad-identity-once")) {
      process.stdout.write(
        `${JSON.stringify({ id: "wrong", protocolVersion: 1, ok: true })}\n`,
      );
      continue;
    }
    if (once("server-bad-protocol-once")) {
      process.stdout.write(
        `${JSON.stringify({ id: request.id, protocolVersion: 2, ok: true })}\n`,
      );
      continue;
    }
    if (once("server-bad-result-once")) {
      process.stdout.write(
        `${JSON.stringify({ id: request.id, protocolVersion: 1, ok: "yes" })}\n`,
      );
      continue;
    }
    if (once("server-non-string-error-once")) {
      process.stdout.write(
        `${JSON.stringify({ id: request.id, protocolVersion: 1, ok: false, error: 1 })}\n`,
      );
      continue;
    }
    if (once("server-empty-error-once")) {
      process.stdout.write(
        `${JSON.stringify({ id: request.id, protocolVersion: 1, ok: false, error: "" })}\n`,
      );
      continue;
    }
    if (once("server-unexpected-id-once")) {
      process.stdout.write(
        `${JSON.stringify({ id: request.id + 1, protocolVersion: 1, ok: true })}\n`,
      );
      continue;
    }
    if (once("server-oversized-once")) {
      process.stdout.write(`${"x".repeat(4096)}\n`);
      continue;
    }
    if (once("server-error-once")) {
      process.stdout.write(
        `${JSON.stringify({
          id: request.id,
          protocolVersion: 1,
          ok: false,
          error: "deliberate resident failure",
        })}\n`,
      );
      continue;
    }
    const result = childProcess.spawnSync(
      process.execPath,
      [
        __filename,
        ...prefix,
        "index",
        "--output",
        path.join(path.dirname(request.output), "fake-index.scip"),
        "--kotlin-graph-output",
        request.output,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const response = `${JSON.stringify({
      id: request.id,
      protocolVersion: 1,
      ok: result.status === 0,
      ...(result.status === 0
        ? {}
        : { error: (result.stderr || `fake producer exited ${result.status}`).trim() }),
    })}\n`;
    if (flag("server-blank-prefix")) process.stdout.write("\n");
    if (flag("server-split-response")) {
      process.stdout.write(response.slice(0, 5));
      await new Promise((resolve) => setTimeout(resolve, 10));
      process.stdout.write(response.slice(5));
    } else {
      process.stdout.write(response);
    }
  }
}

function indexOnce() {
const indexing = args.includes("index");

if (indexing && args.includes("--help")) {
  process.stdout.write(
    [
      "Usage: scip-java index [OPTIONS]",
      "",
      "Options:",
      "  --output PATH        Where to generate the SCIP index.",
      ...(flag("legacy-launcher")
        ? []
        : [
            "  --kotlin-graph-output PATH  Write the committed kotlinc graph generations here.",
          ]),
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (!indexing) {
  process.stderr.write(
    `fake scip-java: unexpected command ${args.join(" ")}\n`,
  );
  process.exit(2);
}

if (flag("build-failure")) {
  process.stderr.write("[ERROR] COMPILATION ERROR :\n");
  process.exit(1);
}

const scipOutput = optionAfter("--output");
if (scipOutput !== undefined) {
  fs.mkdirSync(path.dirname(scipOutput), { recursive: true });
  fs.writeFileSync(scipOutput, "");
}

const graphOutput = optionAfter("--kotlin-graph-output");
if (graphOutput === undefined) {
  process.stderr.write("fake scip-java: no --kotlin-graph-output was requested\n");
  process.exit(2);
}

if (flag("empty-artifact")) {
  fs.writeFileSync(graphOutput, "");
  process.exit(0);
}

if (flag("not-json")) {
  fs.writeFileSync(graphOutput, "> Task :compileKotlin\nBUILD SUCCESSFUL\n");
  process.exit(0);
}

const project = process.cwd();
const marker = valueOf("marker");
// A real build recompiles what changed. The marker counts invocations so a
// second one can rewrite exactly one source shard, which is the condition the
// consumer's delta path exists for.
const invocation = (() => {
  if (marker === undefined) return 1;
  const previous = fs.existsSync(marker)
    ? Number(fs.readFileSync(marker, "utf8"))
    : 0;
  const next = previous + 1;
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, String(next));
  return next;
})();

const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const COVERAGE = {
  contains: "complete",
  exports: "partial",
  imports: "complete",
  calls: "complete",
  accesses: "complete",
  instantiates: "complete",
  type_ref: "partial",
  extends: "complete",
  implements: "complete",
  overrides: "complete",
  dispatches: "partial",
  decorates: "complete",
  renders: "unsupported",
  tests: "partial",
  references: "partial",
};

const evidence = (file, startLine, startColumn, endLine, endColumn) => ({
  file,
  startLine,
  startColumn,
  endLine,
  endColumn,
});

const sourceDigest = (source) => {
  const file = path.join(project, source);
  return fs.existsSync(file)
    ? digest(fs.readFileSync(file))
    : digest(`fake:${source}`);
};

/** One compilation unit, in the producer's own shard schema. */
const shard = (target, source, body) => ({
  schemaVersion: 1,
  language: "kotlin",
  source,
  checkerDigest: sourceDigest(source),
  diskDigest: fs.existsSync(path.join(project, source))
    ? sourceDigest(source)
    : "",
  target,
  compilerVersion: "2.3.20",
  ...body,
  nodes: body.nodes.map((node) => ({ origin: "Source", ...node })),
  diagnostics:
    body.diagnostics ??
    (source.endsWith("Caller.kt")
      ? [
          {
            severity: "warning",
            message: "fixture warning",
            evidence: evidence(source, 5, 1, 5, 8),
          },
        ]
      : []),
});

const exampleShard = (target) =>
  shard(target, "src/main/kotlin/com/Example.kt", {
    nodes: [
      {
        symbol: "semanticdb maven . . com/Example#",
        kind: "class",
        name: "Example",
        qualifiedName: "com.Example",
        file: "src/main/kotlin/com/Example.kt",
        exported: true,
        modifiers: ["public"],
        signature: "public class Example",
        evidence: evidence("src/main/kotlin/com/Example.kt", 2, 1, 2, 27),
      },
    ],
    edges: [
      {
        from: "src/main/kotlin/com/Example.kt",
        to: "semanticdb maven . . com/Example#",
        kind: "contains",
        access: null,
        provenance: null,
        targetKind: "class",
        targetName: "Example",
        targetQualifiedName: "com.Example",
        evidence: evidence("src/main/kotlin/com/Example.kt", 2, 1, 2, 27),
      },
      {
        from: "src/main/kotlin/com/Example.kt",
        to: "semanticdb maven . . com/Example#",
        kind: "exports",
        access: null,
        provenance: null,
        targetKind: "class",
        targetName: "Example",
        targetQualifiedName: "com.Example",
        evidence: evidence("src/main/kotlin/com/Example.kt", 2, 1, 2, 27),
      },
    ],
    unresolved: [],
  });

const callerShard = (target) =>
  shard(target, "src/main/kotlin/com/Caller.kt", {
    nodes: [
      {
        symbol: "semanticdb maven . . com/Caller#",
        kind: "class",
        name: "Caller",
        qualifiedName: "com.Caller",
        file: "src/main/kotlin/com/Caller.kt",
        exported: true,
        modifiers: ["public"],
        signature: "public class Caller",
        evidence: evidence("src/main/kotlin/com/Caller.kt", 2, 1, 6, 2),
      },
      {
        symbol: "semanticdb maven . . com/Caller#make().",
        kind: "method",
        // The producer displays an executable with its parameter list, which
        // is what tells two overloads apart on sight. The graph's name is the
        // simple declared name and its signature is where a list belongs.
        name: "make",
        qualifiedName: "com.Caller.make",
        file: "src/main/kotlin/com/Caller.kt",
        exported: true,
        modifiers: ["public", "static"],
        signature: "public static Example make()",
        evidence: evidence("src/main/kotlin/com/Caller.kt", 3, 5, 5, 6),
      },
      // A constructor the producer displays with its parameter list and
      // formats no signature for. The list is the only statement of its shape
      // there is, so cutting it out of the name has to put it somewhere.
      {
        symbol: "semanticdb maven . . com/Caller#`<init>`().",
        kind: "constructor",
        name: "<init>",
        qualifiedName: "com.Caller.<init>",
        file: "src/main/kotlin/com/Caller.kt",
        exported: true,
        modifiers: ["public"],
        signature: "constructor()",
        evidence: evidence("src/main/kotlin/com/Caller.kt", 2, 1, 2, 20),
      },
      // A local: no owner to qualify it, nothing exported, no modifier kotlinc
      // records in the shared vocabulary, and no signature. Every optional
      // fact absent at once, which is the shape a declaration most often has.
      {
        symbol: "semanticdb maven . . com/Caller#make().(made)",
        kind: "variable",
        name: "made",
        qualifiedName: "",
        file: "src/main/kotlin/com/Caller.kt",
        exported: false,
        modifiers: [],
        signature: "",
        evidence: evidence("src/main/kotlin/com/Caller.kt", 4, 9, 4, 13),
      },
    ],
    edges: [
      {
        from: "src/main/kotlin/com/Caller.kt",
        to: "semanticdb maven . . com/Caller#",
        kind: "contains",
        access: null,
        provenance: null,
        targetKind: "class",
        targetName: "Caller",
        targetQualifiedName: "com.Caller",
        evidence: evidence("src/main/kotlin/com/Caller.kt", 2, 1, 6, 2),
      },
      {
        from: "semanticdb maven . . com/Caller#",
        to: "semanticdb maven . . com/Caller#make().",
        kind: "contains",
        access: null,
        provenance: null,
        targetKind: "method",
        targetName: "make",
        targetQualifiedName: "com.Caller.make",
        evidence: evidence("src/main/kotlin/com/Caller.kt", 3, 5, 5, 6),
      },
      // The cross-file relationship: the method instantiates a class declared
      // in another compilation unit of the same target.
      {
        from: "semanticdb maven . . com/Caller#make().",
        to: "semanticdb maven . . com/Example#",
        kind: "instantiates",
        access: null,
        provenance: null,
        targetKind: "class",
        targetName: "Example",
        targetQualifiedName: "com.Example",
        evidence: evidence("src/main/kotlin/com/Caller.kt", 4, 16, 4, 31),
      },
      // The same relationship written twice, at two call sites. The producer
      // keys its edges by evidence as well as endpoints; the graph's triple is
      // unique, so the consumer has to fold these into one.
      {
        from: "semanticdb maven . . com/Caller#make().",
        to: "semanticdb maven . . com/Example#",
        kind: "instantiates",
        access: null,
        provenance: null,
        targetKind: "class",
        targetName: "Example",
        targetQualifiedName: "com.Example",
        evidence: evidence("src/main/kotlin/com/Caller.kt", 4, 40, 4, 55),
      },
      // An endpoint outside this compilation: the JDK's Object, which no shard
      // in the target declares.
      {
        from: "semanticdb maven . . com/Caller#make().",
        to: "semanticdb maven . . kotlin/lang/Object#toString().",
        kind: "calls",
        access: null,
        provenance: null,
        targetKind: "method",
        targetName: "toString",
        targetQualifiedName: "kotlin.lang.Object.toString",
        evidence: evidence("src/main/kotlin/com/Caller.kt", 4, 60, 4, 70),
      },
      // The same external symbol reached a second time. One endpoint outside
      // the compilation is one node however many sources name it.
      {
        from: "semanticdb maven . . com/Caller#",
        to: "semanticdb maven . . kotlin/lang/Object#toString().",
        kind: "references",
        access: "read",
        provenance: null,
        targetKind: "method",
        targetName: "toString",
        targetQualifiedName: "kotlin.lang.Object.toString",
        evidence: evidence("src/main/kotlin/com/Caller.kt", 5, 9, 5, 19),
      },
      // The same endpoint reached from two sites, one of which could name it
      // and one of which could not. The description that says something wins
      // whichever order they arrive in—which is what kotlinc does with a
      // reference it attributes at one site and not another.
      {
        from: "semanticdb maven . . com/Caller#",
        to: "semanticdb maven . . kotlin/lang/Deprecated#",
        kind: "type_ref",
        access: null,
        provenance: null,
        targetKind: "interface",
        targetName: "Deprecated",
        targetQualifiedName: "kotlin.lang.Deprecated",
        evidence: evidence("src/main/kotlin/com/Caller.kt", 2, 1, 2, 12),
      },
      {
        from: "semanticdb maven . . com/Caller#make().",
        to: "semanticdb maven . . kotlin/lang/Deprecated#",
        kind: "decorates",
        access: null,
        provenance: null,
        targetKind: null,
        targetName: null,
        targetQualifiedName: null,
        evidence: evidence("src/main/kotlin/com/Caller.kt", 3, 1, 3, 12),
      },
      // An edge whose *origin* the target does not declare. kotlinc takes the
      // enclosing symbol of a reference site, and inside an anonymous class
      // body that owner is a symbol no compilation unit here declares; the
      // producer names what an edge points at, never where it came from, so
      // this endpoint has only its own symbol to be displayed by.
      {
        from: "semanticdb maven . . com/Caller#make().$anon1#run().",
        to: "semanticdb maven . . com/Example#",
        kind: "calls",
        access: null,
        provenance: null,
        targetKind: "class",
        targetName: "Example",
        targetQualifiedName: "com.Example",
        evidence: evidence("src/main/kotlin/com/Caller.kt", 4, 20, 4, 27),
      },
    ],
    unresolved:
      invocation === 1 || !flag("incremental")
        ? [
            {
              family: "dispatches",
              reason: "dynamic",
              evidence: evidence("src/main/kotlin/com/Caller.kt", 4, 60, 4, 70),
              // One candidate the target declares and one it does not. The
              // first becomes a node identity; the second stays the producer's
              // own symbol, because inventing a declaration for it would be
              // the opposite of publishing an unresolved site.
              candidates: [
                "semanticdb maven . . com/Example#",
                "semanticdb maven . . kotlin/lang/Object#",
              ],
            },
            // A site with nothing to offer. kotlinc could not attribute the
            // expression at all, so there is no possibility to name.
            {
              family: "references",
              reason: "analysis-error",
              evidence: evidence("src/main/kotlin/com/Caller.kt", 5, 1, 5, 8),
              candidates: [],
            },
          ]
        : [],
  });

const target = (name, shards) => {
  const coverage = { ...COVERAGE };
  if (flag("hole-in-coverage")) delete coverage.tests;
  if (flag("claims-unsupported")) coverage.renders = "complete";
  return {
    name,
    generation: digest(`${name}:${invocation}:${JSON.stringify(shards)}`),
    universe: digest(
      `${name}:${valueOf("universe") ?? "default"}:${
        flag("moving-universe") ? invocation : ""
      }`,
    ),
    coverage,
    shards,
  };
};

const shards = [exampleShard(":|jvm|main")];
if (!flag("single-source")) shards.push(callerShard(":|jvm|main"));
// One build, two JDKs. A Gradle toolchain per source set can do this, and no
// single version is then the build's—which is a different fact from a build
// that never said.
if (flag("two-compilers")) shards[shards.length - 1].compilerVersion = "2.3.10";
if (flag("incremental") && invocation > 1) {
  // Exactly one source recompiled: `Caller.kt` keeps its identity while its
  // body moves, and `Example.kt` is byte-identical to the last generation.
  const caller = shards[shards.length - 1];
  caller.checkerDigest = digest(`recompiled:${invocation}`);
  caller.diskDigest = caller.checkerDigest;
}
if (flag("deleted-source") && invocation > 1) shards.pop();

const artifact = {
  schemaVersion: flag("future-schema") ? 2 : 1,
  projectRoot: flag("foreign-root")
    ? path.join(project, "elsewhere")
    : project,
  producer: {
    name: flag("foreign-producer") ? "some-other-graph" : "scip-kotlinc-k2-graph",
    version: "0.13.1-fake",
    protocolVersion: flag("future-protocol") ? 2 : 1,
    capabilities: {
      atomicGenerations: !flag("no-atomic-generations"),
      incremental: !flag("no-incremental"),
      diagnostics: !flag("no-diagnostics"),
    },
  },
  targets: flag("no-target")
    ? []
    : flag("two-targets")
      ? [
          target(":module-a|jvm|main", [exampleShard(":module-a|jvm|main")]),
          target(":module-b|jvm|main", [exampleShard(":module-b|jvm|main")]),
        ]
      : [target(":|jvm|main", shards)],
};

// An edge with nothing on one end. A symbol the target does not declare is an
// ordinary external endpoint and becomes a node; an empty string is not an
// endpoint at all, and no reader can be told which declaration it meant.
// One symbol described two ways by two sites that both claim to know. Not the
// same as one site knowing and another not: this is a contradiction, and
// picking either would publish a name the compiler never gave it.
if (flag("two-named-externals")) {
  const shard = artifact.targets[0].shards.find((entry) => entry.edges.length > 3);
  const named = shard.edges.filter(
    (edge) => edge.targetQualifiedName === "kotlin.lang.Object.toString()",
  );
  named[1].targetName = "hashCode()";
  named[1].targetQualifiedName = "kotlin.lang.Object.hashCode()";
}

if (flag("empty-endpoint")) {
  artifact.targets[0].shards[0].edges[0].to = "";
}
if (flag("unclaimed-family")) {
  artifact.targets[0].shards[0].edges[0].kind = "renders";
}
// One symbol declared by two compilation units of one target. Both sources
// exist, so this reaches the identity rule rather than tripping the disk-digest
// one on the way: kotlinc attributes one declaration per symbol, and two shards
// carrying it would put the same node in one generation twice.
if (flag("duplicate-symbol")) {
  const owner = artifact.targets[0];
  const destination = owner.shards[owner.shards.length - 1];
  const duplicate = structuredClone(exampleShard(owner.name).nodes[0]);
  duplicate.file = destination.source;
  duplicate.evidence.file = destination.source;
  destination.nodes.push(duplicate);
}
if (flag("foreign-shard-target")) {
  artifact.targets[0].shards[0].target = ":elsewhere|jvm|main";
}
if (flag("bad-evidence")) {
  artifact.targets[0].shards[0].nodes[0].evidence.startLine = 0;
}

fs.mkdirSync(path.dirname(graphOutput), { recursive: true });
fs.writeFileSync(graphOutput, `${JSON.stringify(artifact)}\n`);
process.exit(0);
}
