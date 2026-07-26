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
    { language: "C", file: "src/main.c" },
    { language: "C++", file: "src/main.cpp" },
  ],
  "scip-java": [
    { language: "Java", file: "src/Main.java" },
    { language: "Kotlin", file: "src/Main.kt" },
    { language: "Scala", file: "src/Main.scala" },
  ],
  "scip-dotnet": [{ language: "C#", file: "src/Main.cs" }],
  "scip-python": [{ language: "Python", file: "src/main.py" }],
  "scip-ruby": [{ language: "Ruby", file: "src/main.rb" }],
  "rust-analyzer": [{ language: "Rust", file: "src/lib.rs" }],
};
const scip = descriptions[producer];
if (scip !== undefined) {
  const output =
    valueOf(forwarded, "--index-output-path=") ??
    valueAfter(forwarded, "--output") ??
    valueAfter(forwarded, "--index-file");
  if (output === undefined) {
    throw new Error(`fake standard provider: ${producer} output is required`);
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
      const semantic = scipCorpus(index, text);
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

const sidecarLanguages = new Set(["go", "swift", "zig", "php", "lua", "dart"]);
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
 * Its positive reference and comment-only negative twin are deliberately
 * simple enough for every registered standard provider to state.  The
 * `heuristic` form is still schema-valid: it models the exact bad provider the
 * conformance gate exists to reject, one that turns a prose mention into a
 * declaration and reference.
 */
function scipCorpus(scope, text) {
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
      enclosingRange: callerScope,
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
