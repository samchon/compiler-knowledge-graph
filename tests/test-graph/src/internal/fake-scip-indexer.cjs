#!/usr/bin/env node
"use strict";

/**
 * A SCIP indexer that does exactly what it is told, so a session's lifecycle
 * can be proved without installing one.
 *
 * A real indexer's contract with the session is narrow: read the project, write
 * one artifact where it was told to, and exit. Everything the session must
 * handle around that — an artifact that never appears, a non-zero exit, a
 * process that ignores its first signal — is a mode here rather than a mock,
 * because a stubbed session would prove the test's own arrangement rather than
 * the shutdown and validation paths that exist for these cases.
 */
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const options = new Map(
  args
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const at = arg.indexOf("=");
      return at === -1
        ? [arg.slice(2), ""]
        : [arg.slice(2, at), arg.slice(at + 1)];
    }),
);

const output = options.get("output");
const mode = options.get("mode") ?? "index";
const state = options.get("state");

// A generation counter on disk, so one fixture can answer the first call
// differently from the second without the test having to swap binaries.
const generation = (() => {
  if (state === undefined) return 0;
  const previous = fs.existsSync(state)
    ? Number(fs.readFileSync(state, "utf8").trim())
    : 0;
  fs.writeFileSync(state, String(previous + 1));
  return previous;
})();

if (mode === "fail") {
  process.stderr.write("fake-scip: refusing to index\n");
  process.exit(3);
}

if (mode === "silent-fail") {
  process.exit(3);
}

if (mode === "short-stdout-fail") {
  // The ordinary case: a tool that fails with one line and prints it on stdout.
  // Nothing to truncate, so nothing should be marked as truncated.
  process.stdout.write("cannot open project\n");
  process.exit(3);
}

if (mode === "stdout-fail") {
  // A build wrapper's shape: a long log on stdout, the failure at the end of
  // it, and nothing on stderr at all. `scip-java` runs the project's real
  // Gradle build and reports exactly this way.
  process.stdout.write(`OPENING LINE\n${"noise\n".repeat(600)}`);
  process.stdout.write("FAILURE: compilation failed\n");
  process.exit(3);
}

if (mode === "silent") {
  // Exits cleanly having written nothing. The session must notice the missing
  // artifact rather than decoding whatever was there before.
  process.exit(0);
}

if (mode === "hang") {
  // Ignores the first termination signal, so close() has to escalate.
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const index = indexOf(generation);
  fs.writeFileSync(
    output,
    JSON.stringify(options.has("go-json") ? goStructJsonOf(index) : index),
  );
  const mutate = options.get("mutate");
  if (mutate !== undefined) {
    fs.appendFileSync(path.join(options.get("root") ?? "/", mutate), "// moved\n");
  }
  process.exit(0);
}

function indexOf(generation) {
  const root = options.get("root") ?? "/";
  const name = generation === 0 ? "first" : "second";
  const symbol = `scip-fake fake example v1 \`pkg\`/${name}().`;
  const relativePath = options.get("document") ?? "main.go";
  const protocolVersion =
    generation > 0 && options.has("next-protocol-version-name")
      ? options.get("next-protocol-version-name")
      : options.has("protocol-version-name")
        ? options.get("protocol-version-name")
        : options.has("protocol-version")
          ? Number(options.get("protocol-version"))
          : undefined;
  // Most indexers omit `text`. The ones that carry it are the only ones whose
  // facts can be tied to the bytes they were computed from, so both shapes are
  // producible here.
  const withText = options.has("with-text");
  // Both shapes are real: the SCIP CLI writes a `file://` URI, while some
  // indexers put a plain absolute path there. And `toolInfo` is optional, so a
  // snapshot has to name the provider itself when the index does not.
  const plainRoot = options.has("plain-root");
  const bare = options.has("no-tool-info");
  return {
    metadata: {
      projectRoot: options.has("empty-root")
        ? ""
        : plainRoot
          ? root
          : `file://${root.startsWith("/") ? "" : "/"}${root.replace(/\\/g, "/")}`,
      ...(protocolVersion === undefined ? {} : { version: protocolVersion }),
      ...(bare ? {} : { toolInfo: { name: "fake-scip", version: "1.2.3" } }),
    },
    documents: [
      {
        language: "Go",
        relativePath,
        ...(withText
          ? { text: fs.readFileSync(path.join(root, relativePath), "utf8") }
          : {}),
        symbols: [{ symbol, displayName: name, kind: "Function" }],
        occurrences: [{ range: [0, 5, 10], symbol, symbolRoles: 1 }],
      },
      ...(options.has("partial-text")
        ? [
            {
              language: "Go",
              relativePath: "other.go",
              symbols: [
                {
                  symbol: "scip-fake fake example v1 `pkg`/other().",
                  displayName: "other",
                  kind: "Function",
                },
              ],
              occurrences: [
                {
                  range: [0, 5, 10],
                  symbol: "scip-fake fake example v1 `pkg`/other().",
                  symbolRoles: 1,
                },
              ],
            },
          ]
        : []),
    ],
  };
}

/** The exact field and enum representation used by `scip print --json`. */
function goStructJsonOf(index) {
  return {
    metadata: {
      project_root: index.metadata.projectRoot,
      ...(index.metadata.toolInfo === undefined
        ? {}
        : { tool_info: index.metadata.toolInfo }),
    },
    documents: index.documents.map((document) => ({
      language: document.language,
      relative_path: document.relativePath,
      ...(document.text === undefined ? {} : { text: document.text }),
      symbols: document.symbols.map((symbol) => ({
        symbol: symbol.symbol,
        display_name: symbol.displayName,
        kind: symbol.kind === "Function" ? 17 : 0,
      })),
      occurrences: document.occurrences.map((occurrence) => ({
        range: occurrence.range,
        symbol: occurrence.symbol,
        symbol_roles: occurrence.symbolRoles,
        TypedRange: null,
        TypedEnclosingRange: null,
      })),
    })),
  };
}
