#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const producerArgument = args.find((arg) => arg.startsWith("--producer="));
if (producerArgument === undefined) {
  throw new Error("fake standard provider: --producer is required");
}
const producer = producerArgument.slice("--producer=".length);
const forwarded = args.filter((arg) => arg !== producerArgument);
const heuristic = process.env.SAMCHON_GRAPH_FIXTURE_MODE === "heuristic";

if (forwarded.includes("--version")) {
  process.stdout.write(`${producer} v1.0.0\n`);
  process.exit(0);
}
if (
  (producer === "rustc" && forwarded.includes("-vV")) ||
  (producer === "cargo" && forwarded.includes("-V"))
) {
  process.stdout.write(`${producer} v1.0.0\n`);
  process.exit(0);
}

if (producer === "scip") {
  const artifact = forwarded[forwarded.length - 1];
  if (artifact === undefined) {
    throw new Error("fake standard provider: SCIP artifact is required");
  }
  process.stdout.write(fs.readFileSync(artifact, "utf8"));
  process.exit(0);
}

const descriptions = {
  "scip-clang": [
    // Upstream v0.4.0 hard-codes CPP on every document. The product must recover
    // the C slice from the file rather than teaching this oracle a nicer value.
    { language: "C++", file: "src/main.c" },
    { language: "C++", file: "src/main.cpp" },
  ],
  "scip-java": [
    { language: "Java", file: "src/Main.java" },
    { language: "Kotlin", file: "src/Main.kt" },
  ],
  "scip-dotnet": [{ language: "C#", file: "src/Main.cs" }],
  "scip-python": [{ language: "Python", file: "src/main.py" }],
  "scip-ruby": [{ language: "Ruby", file: "src/main.rb" }],
  "scip-php": [{ language: "PHP", file: "src/main.php" }],
  // Keyed by the binary, not the provider: dart's indexer ships as `scip_dart`.
  scip_dart: [{ language: "Dart", file: "src/main.dart" }],
  "rust-analyzer": [{ language: "Rust", file: "src/lib.rs" }],
};
/**
 * The exact invocation each producer's real tool accepts.
 *
 * This used to be one lookup that took `--index-output-path=`, `--output`, or
 * `--index-file`, whichever was present — the union of every shape the
 * providers happen to emit. A provider passing the wrong flag for its real tool
 * therefore still passed, because the thing checking it was written from the
 * thing being checked. The development skill names that shape: an expectation
 * taken from what the code emits cannot fail for the defect it already
 * contains.
 *
 * Each entry is now one claim about one upstream CLI, stated in one place a
 * reader can audit against that tool's own documentation. A provider that
 * changes its arguments fails here as well as in its real lane.
 */
const contracts = {
  // `scip-clang --compdb-path=… --index-output-path=… --temporary-output-dir=…`
  "scip-clang": (args) => ({
    leading: [],
    requires: ["--compdb-path=", "--temporary-output-dir="],
    output: valueOf(args, "--index-output-path="),
  }),
  // `scip-java index --output <path>`
  "scip-java": (args) => ({
    leading: ["index"],
    requires: [],
    output: valueAfter(args, "--output"),
  }),
  // `scip-dotnet index --output <path>`
  "scip-dotnet": (args) => ({
    leading: ["index"],
    requires: [],
    output: valueAfter(args, "--output"),
  }),
  // `scip-python index . --project-name <name> --output <path>`
  "scip-python": (args) => ({
    leading: ["index", "."],
    requires: ["--project-name"],
    output: valueAfter(args, "--output"),
  }),
  // `scip-ruby . --index-file <path>`
  "scip-ruby": (args) => ({
    leading: ["."],
    requires: [],
    output: valueAfter(args, "--index-file"),
  }),
  // `scip_dart --output <path> .`
  //
  // The flag exists despite pub.dev listing none: `bin/scip_dart.dart` declares
  // `addOption('output', abbr: 'o', defaultsTo: 'index.scip')`. Taking the
  // published summary at its word would have put dart behind a shim it does not
  // need.
  scip_dart: (args) => ({
    leading: [],
    requires: ["."],
    // A positional, not a flag: nothing follows it, and the required-argument
    // check otherwise demands a value after every non-`=` entry.
    valueless: ["."],
    output: valueAfter(args, "--output"),
  }),
  // `scip-php` — no output flag at all. `bin/scip-php` declares only `--help`
  // and `--memory-limit`, takes `getcwd()` as the project root, and ends with
  // `file_put_contents('index.scip', …)`. The fixture writes exactly where the
  // real tool would, which is what makes the session's `artifactFrom` move a
  // tested path rather than an assumed one.
  "scip-php": () => ({
    leading: [],
    requires: [],
    output: path.join(process.cwd(), "index.scip"),
  }),
  // `rust-analyzer scip . --exclude-vendored-libraries --output <path>`
  "rust-analyzer": (args) => ({
    leading: ["scip", "."],
    requires: ["--exclude-vendored-libraries"],
    valueless: ["--exclude-vendored-libraries"],
    output: valueAfter(args, "--output"),
  }),
};

const scip = descriptions[producer];
if (scip !== undefined) {
  const contract = contracts[producer](forwarded);
  for (const [index, expected] of contract.leading.entries()) {
    if (forwarded[index] !== expected) {
      throw new Error(
        `fake standard provider: ${producer} expects argument ${String(index)} to be ${expected}, got ${String(forwarded[index])}`,
      );
    }
  }
  // The destination is not the only argument that has to survive. A scip-clang
  // invocation that lost its compilation database, or a rust-analyzer one that
  // stopped excluding vendored libraries, would index a different program and
  // still write an artifact where the session looks for it.
  for (const required of contract.requires ?? []) {
    // An attached flag has to carry something after the `=`, and a detached one
    // has to be followed by a value. Checking only that the spelling appears
    // would accept `--project-name` with nothing after it, which indexes a
    // different project just as surely as omitting the flag.
    const satisfied = required.endsWith("=")
      ? forwarded.some(
          (argument) =>
            argument.startsWith(required) && argument.length > required.length,
        )
      : forwarded.some(
          (argument, index) =>
            argument === required &&
            (contract.valueless?.includes(required) === true ||
              forwarded[index + 1] !== undefined),
        );
    if (!satisfied) {
      throw new Error(
        `fake standard provider: ${producer} was invoked without a usable ${required}`,
      );
    }
  }
  const output = contract.output;
  if (output === undefined) {
    throw new Error(
      `fake standard provider: ${producer} did not receive the output argument its real tool accepts`,
    );
  }
  write(output, {
    metadata: {
      projectRoot: fileUri(process.cwd()),
      toolInfo: { name: producer, version: "1.0.0" },
    },
    documents: scip.map((document, index) => {
      const text = fs.readFileSync(
        path.join(process.cwd(), document.file),
        "utf8",
      );
      const semantic = scipCorpus(index, text, {
        // These are the pinned producers that actually populate
        // occurrence.enclosing_range, which is the common adapter's only
        // grounded origin for a reference occurrence.
        groundReferences: [
          "scip-java",
          "scip-python",
          "rust-analyzer",
        ].includes(producer),
      });
      return {
        language: document.language,
        relativePath: document.file,
        text,
        symbols: semantic.symbols,
        occurrences: semantic.occurrences,
      };
    }),
  });
  process.exit(0);
}

// dart is absent: it is a SCIP producer now, driven through the `contracts`
// table above like every other one, rather than a sidecar named after a program
// that was never written.
// Lua's producer is lua-language-server driven through its own `--doc` export,
// so the fixture stands in for the server rather than for a sidecar binary. It
// holds the invocation to the exact shape the provider builds and writes the
// exporter's artifact where `--doc_out_path` says, which is what makes the
// session's contract a tested path instead of an assumed one.
if (producer === "lua-language-server") {
  const outDir = valueOf(forwarded, "--doc_out_path=");
  const doc = valueOf(forwarded, "--doc=");
  const config = valueOf(forwarded, "--configpath=");
  for (const [flag, value] of [
    ["--doc=", doc],
    ["--doc_out_path=", outDir],
    ["--configpath=", config],
  ]) {
    if (value === undefined || value === "") {
      throw new Error(
        `fake standard provider: lua-language-server was invoked without ${flag}`,
      );
    }
  }
  // The config is what points the server at our exporter. A run that never
  // wrote it would silently use the stock documentation export, which emits no
  // references at all.
  if (!fs.existsSync(config)) {
    throw new Error(
      `fake standard provider: lua-language-server config ${config} does not exist`,
    );
  }
  const script = JSON.parse(fs.readFileSync(config, "utf8"))[
    "Lua.docScriptPath"
  ];
  if (typeof script !== "string" || !script.startsWith("/")) {
    throw new Error(
      "fake standard provider: the lua config carries no rooted docScriptPath",
    );
  }
  // Derived from the shared corpus rather than hard-coded, so the fixture
  // cannot drift from the source every provider is measured against. The real
  // exporter reports a declaration's name span and, separately, the span of the
  // function it holds — the probe measured a six-character `setglobal` whose
  // `.value` was a thirty-character `function` — and the containing span is
  // what lets a reference be attributed to the declaration it sits inside.
  const file = "src/main.lua";
  const text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const lines = text.split(/\r?\n/);
  const nodes = [];
  const edges = [];
  for (const [line, body] of lines.entries()) {
    const declared = /^function\s+([A-Za-z_]\w*)/.exec(body);
    if (declared === null) continue;
    const name = declared[1];
    const at = body.indexOf(name);
    nodes.push({
      name,
      kind: "function",
      sourceType: "function",
      location: {
        file,
        startLine: line,
        startColumn: at,
        endLine: line,
        endColumn: at + name.length,
      },
      body: {
        file,
        startLine: line,
        startColumn: 0,
        endLine: line,
        endColumn: body.length,
      },
    });
  }
  // `callee()` is used inside `caller`'s body, which is the relationship the
  // shared corpus checks: the edge runs from the declaration containing the use
  // to the one it names.
  for (const [index, node] of nodes.entries()) {
    for (const [line, body] of lines.entries()) {
      if (line === node.location.startLine) continue;
      const used = body.indexOf(`${node.name}(`);
      if (used === -1) continue;
      edges.push({
        from: index + 1,
        kind: "references",
        sourceType: "getglobal",
        location: {
          file,
          startLine: line,
          startColumn: used,
          endLine: line,
          endColumn: used + node.name.length,
        },
      });
    }
  }
  write(path.join(outDir, "samchon-graph-lua.json"), {
    schemaVersion: 1,
    files: [file],
    nodes,
    edges,
    skipped: { unnamed: 0, outsideRoot: 0, refsFailed: 0 },
    warnings: [],
  });
  process.exit(0);
}

const sidecarLanguages = new Set(["go", "swift", "zig"]);
const sidecarLanguage = producer.startsWith("samchon-graph-")
  ? producer.slice("samchon-graph-".length)
  : producer;
if (sidecarLanguages.has(sidecarLanguage)) {
  const output = valueOf(forwarded, "--output=");
  if (output === undefined) {
    throw new Error(`fake standard provider: ${producer} output is required`);
  }
  const files = {
    go: "src/main.go",
    swift: "src/Main.swift",
    zig: "src/main.zig",
    php: "src/main.php",
    lua: "src/main.lua",
    dart: "src/main.dart",
  };
  const file = files[sidecarLanguage];
  const text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const digest = sha256(text);
  const semantic = sidecarCorpus(sidecarLanguage, file, text);
  write(output, {
    schemaVersion: 1,
    projectRoot: fileUri(process.cwd()),
    languages: [sidecarLanguage],
    tool: {
      name: `samchon-graph-${sidecarLanguage}`,
      version: "1.0.0",
      compilerVersion: `${sidecarLanguage}-fixture`,
      protocolVersion: 1,
    },
    universe: sha256(`${sidecarLanguage}-universe`),
    capabilities: ["universe", "sourceDigests", "diskDigests"],
    sources: [
      {
        file,
        checkerDigest: digest,
        diskDigest: digest,
      },
    ],
    nodes: semantic.nodes,
    edges: semantic.edges,
    diagnostics: [],
    warnings: [],
  });
  process.exit(0);
}

throw new Error(`fake standard provider: unknown producer ${producer}`);

/**
 * The common strict-fixture corpus.
 *
 * Its declarations and comment-only negative twin are deliberately simple
 * enough for every registered standard provider to state. Providers that
 * claim references also ground the positive occurrence. The `heuristic` form
 * is still schema-valid: it models the exact bad provider the conformance gate
 * exists to reject, one that turns a prose mention into a declaration and,
 * where supported, a reference.
 */
function scipCorpus(scope, text, { groundReferences }) {
  const packageName = `pkg${scope}`;
  const caller = `scip-fake fake example v1 \`${packageName}\`/caller().`;
  const callee = `scip-fake fake example v1 \`${packageName}\`/callee().`;
  const mentioned = `scip-fake fake example v1 \`${packageName}\`/mentionedInComment().`;
  const callerRange = wordRanges(text, "caller")[0];
  const calleeRanges = wordRanges(text, "callee");
  const calleeDefinition = calleeRanges.at(-1);
  const calleeReference = calleeRanges.at(-2);
  const mentionedRange = wordRanges(text, "mentionedInComment")[0];
  if (
    callerRange === undefined ||
    calleeDefinition === undefined ||
    calleeReference === undefined ||
    mentionedRange === undefined
  ) {
    throw new Error("fake standard provider: invalid semantic source fixture");
  }
  const callerScope = [
    ...(heuristic && comparePosition(mentionedRange, callerRange) < 0
      ? mentionedRange.slice(0, 2)
      : callerRange.slice(0, 2)),
    ...calleeReference.slice(2, 4),
  ];
  const symbols = [
    { symbol: caller, displayName: "caller", kind: "Function" },
    { symbol: callee, displayName: "callee", kind: "Function" },
  ];
  const occurrences = [
    {
      range: callerRange,
      ...(groundReferences ? { enclosingRange: callerScope } : {}),
      symbol: caller,
      symbolRoles: 1,
    },
    { range: calleeDefinition, symbol: callee, symbolRoles: 1 },
    { range: calleeReference, symbol: callee },
  ];
  if (heuristic) {
    symbols.push({
      symbol: mentioned,
      displayName: "mentionedInComment",
      kind: "Function",
    });
    occurrences.push(
      { range: mentionedRange, symbol: mentioned, symbolRoles: 1 },
      { range: mentionedRange, symbol: mentioned },
    );
  }
  return { symbols, occurrences };
}

/** Every zero-based SCIP range for one exact source token. */
function wordRanges(text, word) {
  const output = [];
  let offset = 0;
  for (;;) {
    const found = text.indexOf(word, offset);
    if (found < 0) return output;
    const prefix = text.slice(0, found);
    const line = prefix.split("\n").length - 1;
    const lineStart = prefix.lastIndexOf("\n") + 1;
    const column = found - lineStart;
    output.push([line, column, line, column + word.length]);
    offset = found + word.length;
  }
}

function comparePosition(left, right) {
  return left[0] - right[0] || left[1] - right[1];
}

function sidecarCorpus(language, file, text) {
  const id = (name) => `${file}#${name}:function`;
  const callerRange = wordRanges(text, "caller")[0];
  const calleeRanges = wordRanges(text, "callee");
  const calleeDefinition = calleeRanges.at(-1);
  const calleeReference = calleeRanges.at(-2);
  if (
    callerRange === undefined ||
    calleeDefinition === undefined ||
    calleeReference === undefined
  ) {
    throw new Error("fake standard provider: invalid sidecar source fixture");
  }
  const nodes = [
    {
      id: id("caller"),
      kind: "function",
      language,
      name: "caller",
      file,
      external: false,
      evidence: evidenceOf(file, callerRange),
    },
    {
      id: id("callee"),
      kind: "function",
      language,
      name: "callee",
      file,
      external: false,
      evidence: evidenceOf(file, calleeDefinition),
    },
  ];
  const edges = [
    {
      kind: "references",
      from: id("caller"),
      to: id("callee"),
      evidence: evidenceOf(file, calleeReference),
    },
  ];
  if (heuristic) {
    nodes.push({
      id: id("mentionedInComment"),
      kind: "function",
      language,
      name: "mentionedInComment",
      file,
      external: false,
    });
    edges.push({
      kind: "references",
      from: id("caller"),
      to: id("mentionedInComment"),
    });
  }
  return { nodes, edges };
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

function valueOf(values, prefix) {
  return values.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function valueAfter(values, flag) {
  const index = values.indexOf(flag);
  return index === -1 ? undefined : values[index + 1];
}

function fileUri(file) {
  return `file://${file.startsWith("/") ? "" : "/"}${file.replace(/\\/g, "/")}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
