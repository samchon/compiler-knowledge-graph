const fs = require("node:fs");
const { spawn } = require("node:child_process");

let buffer = Buffer.alloc(0);
const failLanguages = new Set();
const languageByUri = new Map();
const options = {
  allSymbolKinds: false,
  badHeader: false,
  badJson: false,
  emptySymbols: false,
  closeInputAfterInitialize: false,
  exitOnInitialize: false,
  exitOnShutdown: false,
  messageLessError: false,
  minimalDiagnostics: false,
  nullReferences: false,
  referenceError: false,
  nullSymbols: false,
  classify: false,
  cSymbols: false,
  csharpSymbols: false,
  csharpOwnerFallback: false,
  dualOwner: false,
  pythonLocals: false,
  phpSymbols: false,
  rubySymbols: false,
  trivia: false,
  inheritance: false,
  goReceivers: false,
  javaAnonymous: false,
  javaFlat: false,
  omitChildren: false,
  progress: false,
  hangProgressLifecycle: false,
  hangRefreshReadiness: false,
  ignoreTermination: false,
  progressLifecycle: false,
  referenceProgressLifecycle: false,
  rustImpls: false,
  specialReferences: false,
  stderr: false,
  shutdownError: false,
  symbolInformation: false,
  unknownResponse: false,
  unknownParent: false,
  changeSymbolsOnRefresh: false,
  overflowSymbols: false,
  declarationSlices: false,
  typeQueries: false,
};
const symbolCallCountByUri = new Map();
let diagnosticSeverities = [2];
let hangMethod;
let hangRefreshMethod;
let oversizedFrame = 0;
let oversizedHeader = "";
if (process.env.SAMCHON_GRAPH_FAKE_LSP_ARGS_FILE) {
  fs.writeFileSync(
    process.env.SAMCHON_GRAPH_FAKE_LSP_ARGS_FILE,
    JSON.stringify(process.argv.slice(2)),
  );
}
if (process.env.SAMCHON_GRAPH_FAKE_LSP_CWD_FILE) {
  fs.writeFileSync(process.env.SAMCHON_GRAPH_FAKE_LSP_CWD_FILE, process.cwd());
}
if (process.env.SAMCHON_GRAPH_FAKE_LSP_PID_FILE) {
  fs.writeFileSync(
    process.env.SAMCHON_GRAPH_FAKE_LSP_PID_FILE,
    `${process.pid}\n`,
  );
}
// Delay only the FIRST textDocument/references response by this many ms, then
// answer the rest immediately — models a server that builds its reference index
// lazily on the first call and serves the rest from cache.
let slowFirstReferencesMs = 0;
let referenceCallCount = 0;
let progressLifecycleStarted = false;
let progressLifecycleReady = false;
let refreshStarted = false;
let refreshProgressStarted = false;
let lateProgressLifecycleMs = 0;
let referenceProgressLifecycleStarted = false;
let referenceProgressLifecycleReady = false;
let documentVersionLog;
let stubbornDescendantPidFile;
const documentVersionEvents = [];
// Answer the first N references (enough to let the warmup succeed) and then go
// silent — models a warm server that still times out on a few later targets.
let hangReferencesAfter = Infinity;

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--fail-language=")) {
    failLanguages.add(arg.slice("--fail-language=".length));
  } else if (arg === "--all-symbol-kinds") {
    options.allSymbolKinds = true;
  } else if (arg === "--bad-header") {
    options.badHeader = true;
  } else if (arg === "--bad-json") {
    options.badJson = true;
  } else if (arg === "--empty-symbols") {
    options.emptySymbols = true;
  } else if (arg === "--close-input-after-initialize") {
    options.closeInputAfterInitialize = true;
  } else if (arg === "--exit-on-initialize") {
    options.exitOnInitialize = true;
  } else if (arg === "--exit-on-shutdown") {
    options.exitOnShutdown = true;
  } else if (arg === "--message-less-error") {
    options.messageLessError = true;
  } else if (arg === "--minimal-diagnostics") {
    options.minimalDiagnostics = true;
  } else if (arg === "--null-references") {
    options.nullReferences = true;
  } else if (arg === "--reference-error") {
    options.referenceError = true;
  } else if (arg === "--null-symbols") {
    options.nullSymbols = true;
  } else if (arg === "--classify") {
    options.classify = true;
  } else if (arg === "--c-symbols") {
    options.cSymbols = true;
  } else if (arg === "--csharp-symbols") {
    options.csharpSymbols = true;
  } else if (arg === "--csharp-owner-fallback") {
    options.csharpOwnerFallback = true;
  } else if (arg === "--dual-owner") {
    options.dualOwner = true;
  } else if (arg === "--python-locals") {
    options.pythonLocals = true;
  } else if (arg === "--php-symbols") {
    options.phpSymbols = true;
  } else if (arg === "--ruby-symbols") {
    options.rubySymbols = true;
  } else if (arg === "--trivia") {
    options.trivia = true;
  } else if (arg === "--inheritance") {
    options.inheritance = true;
  } else if (arg === "--go-receivers") {
    options.goReceivers = true;
  } else if (arg === "--java-anonymous") {
    options.javaAnonymous = true;
  } else if (arg === "--java-flat") {
    options.javaFlat = true;
  } else if (arg === "--omit-children") {
    options.omitChildren = true;
  } else if (arg === "--progress") {
    options.progress = true;
  } else if (arg === "--hang-progress-lifecycle") {
    options.hangProgressLifecycle = true;
  } else if (arg === "--hang-refresh-readiness") {
    options.hangRefreshReadiness = true;
  } else if (arg === "--ignore-termination") {
    options.ignoreTermination = true;
  } else if (arg === "--progress-lifecycle") {
    options.progressLifecycle = true;
  } else if (arg.startsWith("--late-progress-lifecycle=")) {
    lateProgressLifecycleMs = Number(
      arg.slice("--late-progress-lifecycle=".length),
    );
  } else if (arg === "--reference-progress-lifecycle") {
    options.referenceProgressLifecycle = true;
  } else if (arg === "--rust-impls") {
    options.rustImpls = true;
  } else if (arg === "--special-references") {
    options.specialReferences = true;
  } else if (arg === "--stderr") {
    options.stderr = true;
  } else if (arg === "--shutdown-error") {
    options.shutdownError = true;
  } else if (arg === "--symbol-information") {
    options.symbolInformation = true;
  } else if (arg === "--unknown-response") {
    options.unknownResponse = true;
  } else if (arg === "--unknown-parent") {
    options.unknownParent = true;
  } else if (arg === "--change-symbols-on-refresh") {
    options.changeSymbolsOnRefresh = true;
  } else if (arg === "--overflow-symbols") {
    options.overflowSymbols = true;
  } else if (arg === "--declaration-slices") {
    options.declarationSlices = true;
  } else if (arg === "--type-queries") {
    options.typeQueries = true;
  } else if (arg.startsWith("--hang-method=")) {
    hangMethod = arg.slice("--hang-method=".length);
  } else if (arg.startsWith("--hang-refresh-method=")) {
    hangRefreshMethod = arg.slice("--hang-refresh-method=".length);
  } else if (arg.startsWith("--slow-first-references=")) {
    slowFirstReferencesMs = Number(arg.slice("--slow-first-references=".length));
  } else if (arg.startsWith("--hang-references-after=")) {
    hangReferencesAfter = Number(arg.slice("--hang-references-after=".length));
  } else if (arg.startsWith("--oversized-frame=")) {
    oversizedFrame = Number(arg.slice("--oversized-frame=".length));
  } else if (arg === "--oversized-header=unterminated") {
    oversizedHeader = "unterminated";
  } else if (arg === "--oversized-header=terminated") {
    oversizedHeader = "terminated";
  } else if (arg.startsWith("--document-version-log=")) {
    documentVersionLog = arg.slice("--document-version-log=".length);
  } else if (arg.startsWith("--stubborn-descendant=")) {
    stubbornDescendantPidFile = arg.slice("--stubborn-descendant=".length);
  } else if (arg.startsWith("--diagnostic-severities=")) {
    diagnosticSeverities = arg
      .slice("--diagnostic-severities=".length)
      .split(",")
      .map((value) => Number(value));
  }
}
if (stubbornDescendantPidFile !== undefined) {
  const descendant = spawn(
    process.execPath,
    [
      "-e",
      process.platform === "win32"
        ? "setInterval(() => undefined, 1_000);"
        : 'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1_000);',
    ],
    {
      // A POSIX detached child deliberately leaves its parent's process group,
      // which would stop testing group ownership. Windows detachment creates a
      // new process group but still inherits the private Job Object.
      detached: process.platform === "win32",
      stdio: "ignore",
    },
  );
  fs.writeFileSync(stubbornDescendantPidFile, `${descendant.pid}\n`);
  descendant.unref();
}
if (options.ignoreTermination && process.platform !== "win32") {
  // A signal-resistant server holds its own work: it does not exit when the
  // client closes stdin, and it ignores SIGTERM, so the client must escalate to
  // SIGKILL. `terminateOwnedProcess` destroys the client's stdin write end
  // before it signals; without a ref'd handle the child's stdin EOF would drain
  // the event loop and exit this process before the SIGTERM handler runs,
  // leaving the SIGTERM-before-SIGKILL evidence unwritten on POSIX hosts. The
  // keep-alive timer holds the loop open so SIGTERM is observed deterministically
  // and only SIGKILL ends the process; a swallowed stdin error keeps a closed
  // pipe from surfacing as an uncaught exit.
  const keepAlive = setInterval(() => undefined, 1_000);
  keepAlive.ref?.();
  process.stdin.on("error", () => undefined);
  process.on("SIGTERM", () => {
    if (process.env.SAMCHON_GRAPH_FAKE_LSP_SIGTERM_FILE) {
      fs.writeFileSync(
        process.env.SAMCHON_GRAPH_FAKE_LSP_SIGTERM_FILE,
        "received",
      );
    }
  });
}
writeDocumentVersionLog();

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (match === null) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;
    const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.slice(bodyEnd);
    handle(JSON.parse(body));
  }
});

function handle(message) {
  if (
    message.method === hangMethod ||
    (refreshStarted && message.method === hangRefreshMethod)
  ) {
    if (process.env.SAMCHON_GRAPH_FAKE_LSP_HANG_FILE) {
      fs.writeFileSync(
        process.env.SAMCHON_GRAPH_FAKE_LSP_HANG_FILE,
        message.method,
      );
    }
    return;
  }
  if (message.method === "initialize") {
    if (options.exitOnInitialize) process.exit(7);
    if (oversizedHeader !== "") {
      process.stdout.write(
        `${"X".repeat(70 * 1024)}${
          oversizedHeader === "terminated" ? "\r\n\r\n" : ""
        }`,
      );
      setInterval(() => undefined, 1_000);
      return;
    }
    if (oversizedFrame > 0) {
      process.stdout.write(`Content-Length: ${oversizedFrame}\r\n\r\n`);
      setInterval(() => undefined, 1_000);
      return;
    }
    if (options.stderr) process.stderr.write("fake-lsp progress\n");
    if (options.badHeader) process.stdout.write("Missing-Length\r\n\r\n");
    if (options.badJson) {
      const bad = "{ not json";
      process.stdout.write(`Content-Length: ${Buffer.byteLength(bad)}\r\n\r\n${bad}`);
    }
    if (options.unknownResponse) respond(999999, { ignored: true });
    respond(message.id, {
      capabilities: {
        textDocumentSync: 1,
        documentSymbolProvider: true,
        referencesProvider: true,
      },
      serverInfo: { name: "fake-lsp", version: "0.0.0" },
    });
    if (options.closeInputAfterInitialize) {
      process.stdin.removeAllListeners("data");
      process.stdin.on("error", () => undefined);
      process.stdin.destroy();
      fs.closeSync(0);
      if (process.env.SAMCHON_GRAPH_FAKE_LSP_INPUT_CLOSED_FILE) {
        fs.writeFileSync(
          process.env.SAMCHON_GRAPH_FAKE_LSP_INPUT_CLOSED_FILE,
          "closed",
        );
      }
      setInterval(() => undefined, 1_000);
    }
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "textDocument/didOpen") {
    recordDocumentVersion(message.method, message.params.textDocument);
    languageByUri.set(
      message.params.textDocument.uri,
      message.params.textDocument.languageId,
    );
    if (options.progress) {
      // Mirror a real server: ask the client to create a progress token (a
      // server-initiated request that must be answered), then report indexing.
      request("window/workDoneProgress/create", { token: "fake-index" });
      notify("$/progress", {
        token: "fake-index",
        value: { kind: "report", message: "indexing" },
      });
    }
    if (options.progressLifecycle && !progressLifecycleStarted) {
      // A real work-done phase may stay active without emitting reports for
      // longer than the client's quiet threshold. rust-analyzer does this
      // while Cargo resolves metadata and scans source roots. References are
      // deliberately unavailable until the matching `end`, so a client that
      // treats the silent gap as readiness loses every semantic edge.
      progressLifecycleStarted = true;
      notify("$/progress", { value: { kind: "report" } });
      request("window/workDoneProgress/create", { token: 42 });
      notify("$/progress", {
        token: 42,
        value: { kind: "begin", title: "indexing" },
      });
      setTimeout(() => {
        progressLifecycleReady = true;
        notify("$/progress", {
          token: 42,
          value: { kind: "end" },
        });
      }, 500);
    }
    if (options.hangProgressLifecycle && !progressLifecycleStarted) {
      progressLifecycleStarted = true;
      request("window/workDoneProgress/create", { token: "stalled-index" });
      notify("$/progress", {
        token: "stalled-index",
        value: { kind: "begin", title: "indexing forever" },
      });
      if (process.env.SAMCHON_GRAPH_FAKE_LSP_PROGRESS_FILE) {
        fs.writeFileSync(
          process.env.SAMCHON_GRAPH_FAKE_LSP_PROGRESS_FILE,
          "started",
        );
      }
    }
    if (lateProgressLifecycleMs > 0 && !progressLifecycleStarted) {
      // csharp-ls may acknowledge didOpen, then begin solution loading well
      // after the historical fixed 300ms grace. References stay incomplete
      // until the delayed lifecycle explicitly ends.
      progressLifecycleStarted = true;
      setTimeout(() => {
        request("window/workDoneProgress/create", { token: "late-index" });
        notify("$/progress", {
          token: "late-index",
          value: { kind: "begin", title: "late indexing" },
        });
        setTimeout(() => {
          progressLifecycleReady = true;
          notify("$/progress", {
            token: "late-index",
            value: { kind: "end" },
          });
        }, 200);
      }, lateProgressLifecycleMs);
    }
    notify("textDocument/publishDiagnostics", {
      uri: message.params.textDocument.uri,
      diagnostics: diagnosticSeverities.map((severity, index) => ({
          range: {
            start: { line: 4 + index, character: 0 },
            end: { line: 4 + index, character: 10 },
          },
          ...(options.minimalDiagnostics ? {} : {
            severity,
            source: "fake-lsp",
            code: `FAKE00${index + 1}`,
          }),
          message: "fake warning",
        })),
    });
    return;
  }
  if (message.method === "textDocument/didChange") {
    recordDocumentVersion(message.method, message.params.textDocument);
    refreshStarted = true;
    if (options.hangRefreshReadiness && !refreshProgressStarted) {
      refreshProgressStarted = true;
      request("window/workDoneProgress/create", { token: "refresh-index" });
      notify("$/progress", {
        token: "refresh-index",
        value: { kind: "begin", title: "refresh indexing forever" },
      });
      if (process.env.SAMCHON_GRAPH_FAKE_LSP_HANG_FILE) {
        fs.writeFileSync(
          process.env.SAMCHON_GRAPH_FAKE_LSP_HANG_FILE,
          "indexing readiness",
        );
      }
    }
    return;
  }
  if (message.method === "textDocument/didClose") {
    recordDocumentVersion(message.method, message.params.textDocument);
    languageByUri.delete(message.params.textDocument.uri);
    return;
  }
  if (message.method === "textDocument/documentSymbol") {
    const uri = message.params.textDocument.uri;
    const languageId = languageByUri.get(uri);
    if (failLanguages.has(languageId)) {
      return respondError(message.id, `forced ${languageId} failure`);
    }
    if (options.messageLessError) return respondBareError(message.id);
    if (options.emptySymbols) return respond(message.id, []);
    if (options.overflowSymbols) {
      // Flat SymbolInformation whose members start on a line PAST the end of the
      // source file. The declaration line then resolves to "" through the
      // out-of-range fallback, so the C# field/property recovery parses nothing
      // and the member stays a plain property, and the Java modifier scan reads
      // an empty line. Each file gets the shape appropriate to its language.
      const languageId = languageByUri.get(uri);
      const information = (name, kind, line, character, containerName) => ({
        name,
        kind,
        containerName,
        location: {
          uri,
          range: {
            start: { line, character },
            end: { line, character: character + name.length },
          },
        },
      });
      if (languageId === "csharp") {
        // `loose` starts past the source, so its declaration line is "" and the
        // field/property recovery finds nothing (the member stays a property by
        // default). `Score` points at a real property declaration, so the same
        // recovery reaches the second `property` arm of the field/property test.
        return respond(message.id, [
          information("Bag", 5, 0, 17, ""),
          information("loose", 13, 500, 8, "Bag"),
          information("Score", 13, 4, 19, "Bag"),
        ]);
      }
      return respond(message.id, [
        information("Api", 5, 0, 13, ""),
        information("gone()", 6, 500, 4, "Api"),
      ]);
    }
    if (options.declarationSlices) {
      // Hierarchical DocumentSymbols that drive the per-language modifier reader
      // through its three edge branches. `spanned` places the modifiers on the
      // line ABOVE the identifier (its range spans two lines, so the reader
      // slices both). `inverted` selects before its range starts (a server that
      // inverts the two — the reader bails with no modifiers). `gone` starts
      // past the end of the source (every read falls back to the empty string).
      const languageId = languageByUri.get(uri);
      const doc = (name, kind, rsL, rsC, reL, reC, ssL, ssC, seL, seC, children) => ({
        name,
        detail: "",
        kind,
        range: { start: { line: rsL, character: rsC }, end: { line: reL, character: reC } },
        selectionRange: {
          start: { line: ssL, character: ssC },
          end: { line: seL, character: seC },
        },
        children: children ?? [],
      });
      if (languageId === "c") {
        return respond(message.id, [
          doc("spanned", 12, 0, 0, 1, 31, 1, 4, 1, 11),
          doc("inverted", 12, 1, 0, 1, 10, 0, 0, 0, 6),
          doc("gone", 12, 500, 0, 500, 10, 500, 0, 500, 6),
        ]);
      }
      if (languageId === "csharp") {
        return respond(message.id, [
          doc("Holder", 5, 0, 0, 3, 1, 0, 6, 0, 12, [
            doc("Spanned", 6, 1, 0, 2, 27, 2, 16, 2, 23),
            doc("inverted", 6, 2, 0, 2, 10, 1, 0, 1, 6),
            doc("gone", 6, 500, 0, 500, 10, 500, 0, 500, 6),
          ]),
        ]);
      }
      if (languageId === "php") {
        return respond(message.id, [
          doc("Holder", 5, 1, 0, 4, 1, 1, 6, 1, 12, [
            doc("spanned", 6, 2, 0, 3, 24, 3, 13, 3, 20),
            doc("inverted", 6, 3, 0, 3, 10, 2, 0, 2, 6),
            doc("gone", 6, 500, 0, 500, 10, 500, 0, 500, 6),
          ]),
        ]);
      }
      return respond(message.id, [
        doc("Holder", 5, 0, 0, 3, 1, 0, 6, 0, 12, [
          doc("spanned", 6, 1, 0, 2, 28, 2, 16, 2, 23),
          doc("inverted", 6, 2, 0, 2, 10, 1, 0, 1, 6),
          doc("gone", 6, 500, 0, 500, 10, 500, 0, 500, 6),
        ]),
      ]);
    }
    if (options.typeQueries) {
      // A single `Target` type per file; the reference handler points the query
      // sites at the `typeof` contexts the reference classifier must read.
      const languageId = languageByUri.get(uri);
      const doc = (name, kind, rsL, rsC, reL, reC, ssL, ssC, seL, seC) => ({
        name,
        detail: "",
        kind,
        range: { start: { line: rsL, character: rsC }, end: { line: reL, character: reC } },
        selectionRange: {
          start: { line: ssL, character: ssC },
          end: { line: seL, character: seC },
        },
        children: [],
      });
      if (languageId === "typescript") {
        return respond(message.id, [doc("Target", 5, 0, 0, 0, 21, 0, 13, 0, 19)]);
      }
      return respond(message.id, [doc("Target", 5, 1, 0, 1, 20, 1, 5, 1, 11)]);
    }
    if (options.phpSymbols) {
      const leaf = (name, kind, line, character, endLine = line, children = []) => ({
        name,
        detail: "",
        kind,
        range: {
          start: { line, character: 0 },
          end: { line: endLine, character: 80 },
        },
        selectionRange: {
          start: { line, character },
          end: { line, character: character + name.length },
        },
        children,
      });
      const file = decodeURIComponent(uri).replaceAll("\\", "/").split("/").at(-1);
      let documentSymbols;
      let information;
      if (file === "Namespaces.php") {
        documentSymbols = [
          leaf("Alpha\\One", 3, 1, 10),
          leaf("First", 5, 1, 27),
          leaf("AfterTraps", 5, 11, 6),
          leaf("Beta", 3, 12, 10),
          leaf("second", 12, 12, 25),
          leaf("Gamma\\Deep", 3, 13, 10),
          leaf("Last", 5, 13, 28),
        ];
        information = [
          ["Alpha\\One", 3, 1, 10, ""],
          ["First", 5, 1, 27, ""],
          ["AfterTraps", 5, 11, 6, ""],
          ["Beta", 3, 12, 10, ""],
          ["second", 12, 12, 25, ""],
          ["Gamma\\Deep", 3, 13, 10, ""],
          ["Last", 5, 13, 28, "Gamma\\Deep"],
        ];
      } else if (file === "Bracketed.php") {
        documentSymbols = [
          leaf("Red\\Blue", 3, 1, 10),
          leaf("Box", 5, 1, 27, 1, [leaf("open", 6, 1, 42)]),
          leaf("global_helper", 12, 2, 21),
          leaf("Green", 3, 3, 10),
          leaf("Contract", 11, 3, 28, 3, [leaf("run", 6, 3, 48)]),
        ];
        information = [
          ["Red\\Blue", 3, 1, 10, ""],
          ["Box", 5, 1, 27, ""],
          ["open", 6, 1, 42, "Box"],
          ["global_helper", 12, 2, 21, ""],
          ["Green", 3, 3, 10, ""],
          ["Contract", 11, 3, 28, "Green"],
          ["run", 6, 3, 48, "Green\\Contract"],
        ];
      } else {
        documentSymbols = [
          // Intelephense reports the namespace and its declarations as
          // top-level siblings; only type members retain hierarchy.
          leaf("Demo", 3, 1, 10),
          leaf("Pipeline", 5, 3, 15, 11, [
            leaf("secret", 7, 5, 20),
            leaf("shared", 7, 6, 25),
            leaf("__construct", 9, 7, 13),
            leaf("handle", 6, 8, 20),
            leaf("extensionPoint", 6, 9, 23),
            leaf("hidden", 6, 10, 21),
          ]),
          leaf("Handler", 11, 13, 10, 16, [leaf("process", 6, 15, 13)]),
          leaf("bootstrap", 12, 18, 9),
        ];
        information = [
          ["Demo", 3, 1, 10, ""],
          ["Pipeline", 5, 3, 15, ""],
          ["secret", 7, 5, 20, "Pipeline"],
          ["shared", 7, 6, 25, "Demo\\Pipeline"],
          ["__construct", 9, 7, 13, "Pipeline"],
          ["handle", 6, 8, 20, "Demo.Pipeline"],
          ["extensionPoint", 6, 9, 23, "Pipeline"],
          ["hidden", 6, 10, 21, "Demo\\Pipeline"],
          ["Handler", 11, 13, 10, "Demo"],
          ["process", 6, 15, 13, "Demo.Handler"],
          ["bootstrap", 12, 18, 9, ""],
        ];
      }
      if (options.symbolInformation) {
        return respond(
          message.id,
          information.map(([name, kind, line, character, containerName]) => ({
            name,
            kind,
            containerName,
            location: {
              uri,
              range: {
                start: { line, character },
                end: { line, character: character + name.length },
              },
            },
          })),
        );
      }
      return respond(message.id, documentSymbols);
    }
    if (options.rubySymbols) {
      if (options.symbolInformation) {
        // A Ruby server (e.g. Solargraph) can answer with the legacy flat
        // SymbolInformation shape: no nesting, no modifier fields, ownership
        // only as `containerName`. Visibility is recovered from the source the
        // same way, keyed by each declaration's own line — the exact lines the
        // hierarchical reply below reports for the same `router.rb`.
        const information = (name, kind, line, character, containerName) => ({
          name,
          kind,
          containerName,
          location: {
            uri,
            range: {
              start: { line, character },
              end: { line, character: character + name.length },
            },
          },
        });
        return respond(message.id, [
          information("Demo", 2, 0, 7, ""),
          information("Router", 5, 1, 8, "Demo"),
          information("call", 6, 2, 8, "Demo.Router"),
          information("dispatch!", 6, 8, 8, "Demo.Router"),
          information("route!", 6, 14, 8, "Demo.Router"),
          information("process_route", 6, 20, 8, "Demo.Router"),
          information("compile?", 6, 28, 13, "Demo.Router"),
          information("hidden_builder=", 6, 35, 10, "Demo.Router"),
          information("build!", 6, 41, 10, "Demo.Router"),
          information("put", 6, 44, 8, "Demo.Router"),
        ]);
      }
      const leaf = (name, line, character, endLine = line) => ({
        name,
        detail: "",
        kind: 6,
        range: {
          start: { line, character: 0 },
          end: { line: endLine, character: 80 },
        },
        selectionRange: {
          start: { line, character },
          end: { line, character: character + name.length },
        },
        children: [],
      });
      return respond(message.id, [
        {
          name: "Demo",
          detail: "",
          kind: 2,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 46, character: 3 },
          },
          selectionRange: {
            start: { line: 0, character: 7 },
            end: { line: 0, character: 11 },
          },
          children: [
            {
              name: "Router",
              detail: "",
              kind: 5,
              range: {
                start: { line: 1, character: 0 },
                end: { line: 45, character: 5 },
              },
              selectionRange: {
                start: { line: 1, character: 8 },
                end: { line: 1, character: 14 },
              },
              children: [
                leaf("call", 2, 8, 4),
                leaf("dispatch!", 8, 8, 10),
                leaf("route!", 14, 8, 16),
                leaf("process_route", 20, 8, 24),
                leaf("compile?", 28, 13, 30),
                leaf("hidden_builder=", 35, 10, 37),
                leaf("build!", 41, 10),
                leaf("put", 44, 8),
              ],
            },
          ],
        },
      ]);
    }
    if (options.cSymbols) {
      // clangd reports a `static` C function as an ordinary top-level symbol,
      // exactly like one with external linkage: the storage class lives only in
      // the source prefix between the symbol's range start and its declared
      // name. These entries carry that prefix in both reply shapes.
      //
      //   0: #include <stdio.h>
      //   1: static int helper(void) {
      //   2:   return 1;
      //   3: }
      //   4: int public_api(void) {
      //   5:   return helper();
      //   6: }
      //   7: static const int LIMIT = 8;
      //   8: int shared_counter = 0;
      //   9: static void
      //  10: wrapped_helper(void) {
      //  11: }
      const entries = [
        { name: "helper", kind: 12, line: 1, character: 11, endLine: 3 },
        { name: "public_api", kind: 12, line: 4, character: 4, endLine: 6 },
        { name: "LIMIT", kind: 14, line: 7, character: 17, endLine: 7 },
        { name: "shared_counter", kind: 13, line: 8, character: 4, endLine: 8 },
        // The one entry whose declaration head opens on an earlier line than
        // the name it declares.
        {
          name: "wrapped_helper",
          kind: 12,
          line: 10,
          character: 0,
          endLine: 11,
          headLine: 9,
        },
      ];
      if (options.symbolInformation) {
        return respond(
          message.id,
          entries.map((entry) => ({
            name: entry.name,
            kind: entry.kind,
            containerName: "",
            location: {
              uri,
              range: {
                // The flat shape carries no separate declaration range, so the
                // storage class is recovered from the declaration line itself.
                start: { line: entry.line, character: entry.character },
                end: {
                  line: entry.line,
                  character: entry.character + entry.name.length,
                },
              },
            },
          })),
        );
      }
      return respond(
        message.id,
        entries.map((entry) => ({
          name: entry.name,
          detail: "",
          kind: entry.kind,
          range: {
            // The declaration range opens at the head, which may be a line
            // above the declared name.
            start: { line: entry.headLine ?? entry.line, character: 0 },
            end: { line: entry.endLine, character: 80 },
          },
          selectionRange: {
            start: { line: entry.line, character: entry.character },
            end: {
              line: entry.line,
              character: entry.character + entry.name.length,
            },
          },
          children: [],
        })),
      );
    }
    if (options.csharpSymbols) {
      if (options.symbolInformation) {
        const information = (name, kind, line, character, containerName) => ({
          name,
          kind,
          containerName,
          location: {
            uri,
            range: {
              start: { line, character },
              end: { line, character: character + name.length },
            },
          },
        });
        if (options.csharpOwnerFallback) {
          // Exercise the flat-owner-kind recovery paths that the ordinary
          // csharp-ls data never reaches: every symbol there carries a full,
          // exactly registered `containerName`. Here `Widget` reports *no*
          // container (its `Field1` member must be reattached by unique
          // simple-name fallback), and two `Sink` classes share a simple name
          // across namespaces (so a member that names only `Sink` is ambiguous
          // and stays unresolved).
          return respond(message.id, [
            information("Widget", 5, 2, 17, undefined),
            information("Sink", 5, 7, 30, "Alpha"),
            information("Sink", 5, 8, 29, "Beta"),
            information("Field1", 13, 4, 19, "Root.Widget"),
            information("Orphan", 13, 9, 15, "Ghost.Unknown"),
            information("Ambiguous", 14, 10, 15, "Gamma.Sink"),
          ]);
        }
        return respond(message.id, [
          information("Core", 3, 0, 15, ""),
          information("ISink", 11, 2, 17, "Demo.Core"),
          information("Emit(Event evt)", 6, 4, 9, "Demo.Core.ISink"),
          information("Event", 5, 7, 20, "Demo.Core"),
          information("InternalSink", 5, 9, 15, "Demo.Core"),
          information("InternalSink()", 9, 11, 11, "Demo.Core.InternalSink"),
          information("Emit(Event evt)", 6, 13, 16, "Demo.Core.InternalSink"),
          information("Helper()", 6, 21, 17, "Demo.Core.InternalSink"),
          information("ProtectedHelper()", 6, 22, 19, "Demo.Core.InternalSink"),
          information("DefaultPrivate()", 6, 23, 9, "Demo.Core.InternalSink"),
          information("Logger", 5, 26, 20, "Demo.Core"),
          // Flat csharp-ls results can collapse both fields and properties to
          // SymbolKind.Variable. Source + owner kind restore the sharper kind.
          information("_sink", 13, 28, 27, "Demo.Core.Logger"),
          information("Logger(ISink sink)", 9, 29, 11, "Demo.Core.Logger"),
          information("Write(Event evt)", 6, 30, 16, "Demo.Core.Logger"),
          information("AssemblyHelper()", 6, 31, 18, "Demo.Core.Logger"),
          information("Enabled", 13, 32, 16, "Demo.Core.Logger"),
          information("Route", 5, 42, 14, "Demo.Core"),
          information("Routed", 23, 43, 21, "Demo.Core"),
        ]);
      }
      const leaf = (name, kind, line, character, endLine = line) => ({
        name,
        detail: "",
        kind,
        range: {
          start: { line, character: 0 },
          end: { line: endLine, character: 80 },
        },
        selectionRange: {
          start: { line, character },
          end: { line, character: character + name.length },
        },
        children: [],
      });
      return respond(message.id, [
        {
          // csharp-ls reports only the leaf for a dotted file-scoped namespace;
          // the declaration line is the source of the missing prefix.
          name: "Core",
          detail: "",
          kind: 3,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 43, character: 40 },
          },
          selectionRange: {
            start: { line: 0, character: 15 },
            end: { line: 0, character: 19 },
          },
          children: [
            {
              ...leaf("ISink", 11, 2, 17, 5),
              children: [leaf("Emit(Event evt)", 6, 4, 9)],
            },
            leaf("Event", 5, 7, 20),
            {
              ...leaf("InternalSink", 5, 9, 15, 24),
              children: [
                leaf("InternalSink()", 9, 11, 11),
                leaf("Emit(Event evt)", 6, 13, 16, 19),
                leaf("Helper()", 6, 21, 17),
                leaf("ProtectedHelper()", 6, 22, 19),
                leaf("DefaultPrivate()", 6, 23, 9),
              ],
            },
            {
              ...leaf("Logger", 5, 26, 20, 40),
              children: [
                leaf("_sink", 8, 28, 27),
                leaf("Logger(ISink sink)", 9, 29, 11),
                leaf("Write(Event evt)", 6, 30, 16),
                leaf("AssemblyHelper()", 6, 31, 18),
                leaf("Enabled", 7, 32, 16, 39),
              ],
            },
            leaf("Route", 5, 42, 14),
            leaf("Routed", 23, 43, 21),
          ],
        },
      ]);
    }
    if (options.inheritance) {
      const cls = (name, kind, line) => ({
        name,
        detail: "",
        kind,
        range: { start: { line, character: 0 }, end: { line, character: 60 } },
        selectionRange: { start: { line, character: 13 }, end: { line, character: 13 + name.length } },
        children: [],
      });
      return respond(message.id, [
        cls("Deco", 12, 0),
        cls("Parent", 5, 1),
        cls("Iface", 11, 2),
        cls("Child", 5, 5),
        cls("Solo", 5, 6),
        cls("Dup", 5, 7),
      ]);
    }
    if (options.javaFlat) {
      // The legacy flat shape a Java server may still answer with: no nesting,
      // no modifier fields, and a decorated callable name. Ownership arrives as
      // `containerName` and visibility only as the source prefix.
      //
      //   0: package sample;
      //   1: public class Api {
      //   2:   @Marker('(') @SuppressWarnings("public \" static") private void hidden() {}
      //   3:   public void shown() { new Adapter() {}; }
      //   4:   void packageOnly() {}
      //   5: }
      //   6: class Internal {}
      const information = (name, kind, line, character, containerName) => ({
        name,
        kind,
        containerName,
        location: {
          uri,
          range: {
            start: { line, character },
            end: { line, character: character + name.length },
          },
        },
      });
      return respond(message.id, [
        information("Api", 5, 1, 13, ""),
        information("hidden()", 6, 2, 66, "Api"),
        information("shown()", 6, 3, 14, "Api"),
        information("new Adapter() {...}", 5, 3, 24, "Api.shown()"),
        information("packageOnly()", 6, 4, 7, "Api"),
        information("Internal", 5, 6, 6, ""),
      ]);
    }
    if (options.javaAnonymous) {
      const symbol = (name, kind, line, start, endLine = line, children = []) => ({
        name,
        detail: "",
        kind,
        range: {
          start: { line, character: 0 },
          end: { line: endLine, character: 80 },
        },
        selectionRange: {
          start: { line, character: start },
          end: {
            line,
            character: start + name.replace(/\(.*/, "").length,
          },
        },
        children,
      });
      const anonymous = (line, writeLine) =>
        symbol("new Adapter() {...}", 5, line, 8, line + 2, [
          symbol("write()", 6, writeLine, 28),
        ]);
      return respond(message.id, [
        symbol("PublicApi", 5, 2, 13, 35, [
          symbol("PublicApi()", 9, 3, 9),
          symbol("first()", 6, 5, 14, 9, [anonymous(6, 7)]),
          symbol("second()", 6, 11, 14, 15, [anonymous(12, 13)]),
          symbol("convert(T)", 6, 17, 48, 22),
          symbol("names()", 6, 24, 18),
          symbol("hidden()", 6, 25, 15),
          symbol("packageOnly()", 6, 26, 7),
          symbol("extensionPoint()", 6, 27, 24),
          symbol("Nested", 5, 34, 22),
        ]),
        symbol("PackageType", 5, 37, 6),
        symbol("Adapter", 5, 39, 15, 41, [
          symbol("write()", 6, 40, 16),
        ]),
        symbol("Helper", 5, 43, 6, 45, [
          symbol("helper()", 6, 44, 14),
        ]),
      ]);
    }
    if (options.goReceivers) {
      if (options.symbolInformation) {
        const symbol = (name, kind, line) => ({
          name,
          kind,
          containerName: "",
          location: {
            uri,
            range: {
              start: { line, character: 0 },
              end: { line, character: name.length },
            },
          },
        });
        return respond(message.id, [
          symbol("Engine", 5, 2),
          symbol("(*Engine).ServeHTTP", 6, 4),
          symbol("(*Engine).handleHTTPRequest", 6, 5),
          symbol("(*GenericEngine[T]).ServeHTTP", 6, 6),
          symbol("helper", 12, 7),
        ]);
      }
      const symbol = (name, kind, line) => ({
        name,
        detail: "",
        kind,
        range: {
          start: { line, character: 0 },
          end: { line, character: 60 },
        },
        selectionRange: {
          start: { line, character: 0 },
          end: { line, character: name.length },
        },
        children: [],
      });
      return respond(message.id, [
        symbol("Engine", 5, 2),
        symbol("(*Engine).ServeHTTP", 6, 4),
        symbol("(*Engine).handleHTTPRequest", 6, 5),
        symbol("(*GenericEngine[T]).ServeHTTP", 6, 6),
        symbol("helper", 12, 7),
      ]);
    }
    if (options.classify) {
      const leaf = (name, kind, line) => ({
        name,
        detail: "",
        kind,
        range: { start: { line, character: 0 }, end: { line, character: 5 } },
        selectionRange: { start: { line, character: 0 }, end: { line, character: 1 } },
        children: [],
      });
      return respond(message.id, [
        {
          name: "Owner",
          detail: "",
          kind: 5,
          range: { start: { line: 0, character: 0 }, end: { line: 999, character: 1 } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
          children: [
            leaf("method", 6, 3),
            leaf("iface", 11, 4),
            leaf("value", 13, 5),
            leaf("ctor", 9, 6),
            leaf("fn", 12, 7),
            leaf("nested", 5, 8),
            leaf("alias", 23, 9),
            leaf("mode", 10, 10),
            leaf("prop", 7, 11),
            leaf("count", 8, 12),
          ],
        },
      ]);
    }
    if (options.dualOwner) {
      return respond(message.id, [
        {
          name: "Owner",
          detail: "",
          kind: 5,
          range: { start: { line: 0, character: 0 }, end: { line: 12, character: 1 } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
          children: [
            {
              name: "helper",
              detail: "",
              kind: 13,
              range: { start: { line: 1, character: 2 }, end: { line: 3, character: 4 } },
              selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
              children: [],
            },
            {
              name: "method",
              detail: "",
              kind: 6,
              range: { start: { line: 4, character: 2 }, end: { line: 7, character: 3 } },
              selectionRange: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } },
              children: [],
            },
            {
              name: "assigned",
              detail: "",
              kind: 6,
              range: { start: { line: 8, character: 2 }, end: { line: 11, character: 3 } },
              selectionRange: { start: { line: 8, character: 2 }, end: { line: 8, character: 10 } },
              children: [
                {
                  name: "result",
                  detail: "",
                  kind: 13,
                  range: { start: { line: 9, character: 10 }, end: { line: 9, character: 27 } },
                  selectionRange: { start: { line: 9, character: 10 }, end: { line: 9, character: 16 } },
                  children: [],
                },
              ],
            },
          ],
        },
        {
          name: "target",
          detail: "",
          kind: 12,
          range: { start: { line: 13, character: 0 }, end: { line: 13, character: 20 } },
          selectionRange: { start: { line: 13, character: 9 }, end: { line: 13, character: 15 } },
          children: [],
        },
      ]);
    }
    if (options.pythonLocals) {
      const leaf = (name, kind, line, start, end) => ({
        name,
        detail: "",
        kind,
        range: {
          start: { line, character: start },
          end: { line, character: end },
        },
        selectionRange: {
          start: { line, character: start },
          end: { line, character: start + name.length },
        },
        children: [],
      });
      return respond(message.id, [
        {
          name: "App",
          detail: "",
          kind: 5,
          range: { start: { line: 0, character: 0 }, end: { line: 5, character: 32 } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
          children: [
            leaf("class_value", 13, 1, 4, 24),
            {
              name: "dispatch",
              detail: "",
              kind: 6,
              range: { start: { line: 2, character: 4 }, end: { line: 5, character: 32 } },
              selectionRange: { start: { line: 2, character: 8 }, end: { line: 2, character: 16 } },
              children: [
                leaf("self", 13, 2, 17, 21),
                leaf("ctx", 13, 2, 23, 26),
                leaf("response", 13, 3, 8, 27),
                leaf("handler", 13, 4, 8, 34),
              ],
            },
          ],
        },
        leaf("module_value", 13, 7, 0, 21),
        leaf("target", 12, 8, 4, 10),
      ]);
    }
    if (options.rustImpls) {
      const leaf = (name, kind, line, start, end = start + name.length) => ({
        name,
        detail: "",
        kind,
        range: {
          start: { line, character: 0 },
          end: { line, character: 80 },
        },
        selectionRange: {
          start: { line, character: start },
          end: { line, character: end },
        },
        children: [],
      });
      const impl = (name, startLine, endLine, children) => ({
        name: `impl ${name}`,
        detail: "",
        kind: 19,
        range: {
          start: { line: startLine, character: 0 },
          end: { line: endLine, character: 1 },
        },
        selectionRange: {
          start: { line: startLine, character: 0 },
          end: { line: startLine, character: 4 + name.length },
        },
        children,
      });
      return respond(message.id, [
        leaf("Runtime", 23, 0, 11),
        leaf("Handle", 23, 1, 11),
        impl("Runtime", 3, 5, [leaf("spawn", 6, 4, 11)]),
        impl("Runtime", 6, 8, [leaf("block_on", 6, 7, 15)]),
        impl("Handle", 9, 11, [leaf("spawn", 6, 10, 11)]),
        leaf("public_api", 12, 12, 7),
        leaf("crate_only", 12, 13, 14),
        leaf("private_helper", 12, 14, 3),
        leaf("Generic", 23, 15, 11),
        {
          ...impl("Generic<T>", 16, 18, [leaf("get", 6, 17, 7)]),
          name: "impl<T> Generic<T>",
        },
        {
          ...impl("Handle", 19, 21, [leaf("schedule", 6, 20, 7)]),
          name: "impl Schedule for Handle",
        },
        {
          ...impl("External", 22, 24, [leaf("collision", 6, 23, 7)]),
          name: "impl Schedule for External",
        },
        {
          ...impl("()", 25, 27, [leaf("collision", 6, 26, 7)]),
          name: "impl Schedule for ()",
        },
        leaf("super_only", 12, 28, 14),
        leaf("scoped_only", 12, 29, 26),
        leaf("GLOBAL", 14, 30, 11),
        leaf("LOCAL", 14, 31, 18),
        leaf("Packet", 23, 32, 10),
        leaf("UnsafeTarget", 23, 33, 11),
        {
          ...impl("UnsafeTarget", 34, 36, [
            leaf("unsafe_schedule", 6, 35, 7),
          ]),
          name: "impl Schedule for UnsafeTarget",
        },
        impl("Late", 37, 39, [leaf("before_declaration", 6, 38, 7)]),
        leaf("Late", 23, 40, 11),
        leaf("public_module", 2, 41, 8),
        leaf("GLOBAL_MUT", 14, 42, 15),
        leaf("ffi_entry", 12, 43, 18),
        {
          ...impl("Arc<WrappedLate>", 44, 48, [
            {
              ...leaf("wrapped_before_declaration", 6, 45, 7),
              range: {
                start: { line: 45, character: 0 },
                end: { line: 47, character: 80 },
              },
              children: [leaf("local", 13, 46, 12)],
            },
          ]),
          name: "impl Schedule for Arc<WrappedLate>",
        },
        leaf("WrappedLate", 23, 49, 11),
        {
          ...impl("broken", 27, 27, []),
          name: "impl<broken",
        },
      ]);
    }
    if (options.trivia) {
      const leaf = (name, kind, line, endLine, startChar) => ({
        name,
        detail: "",
        kind,
        range: { start: { line, character: 2 }, end: { line: endLine ?? line, character: 40 } },
        selectionRange: { start: { line, character: startChar }, end: { line, character: startChar + name.length } },
        children: [],
      });
      return respond(message.id, [
        {
          name: "Owner",
          detail: "",
          kind: 5,
          range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
          children: [
            leaf("makeNew", 7, 1, 1, 2),
            leaf("useType", 7, 2, 2, 2),
            leaf("viaBlock", 7, 3, 3, 2),
            leaf("viaLine", 7, 4, 6, 2),
            leaf("jsx", 7, 7, 7, 2),
            leaf("opt", 7, 8, 8, 2),
            leaf("runtimeType", 7, 9, 9, 2),
          ],
        },
        { name: "Store", detail: "", kind: 5, range: { start: { line: 11, character: 0 }, end: { line: 11, character: 14 } }, selectionRange: { start: { line: 11, character: 6 }, end: { line: 11, character: 11 } }, children: [] },
        { name: "blockFn", detail: "", kind: 12, range: { start: { line: 12, character: 0 }, end: { line: 12, character: 32 } }, selectionRange: { start: { line: 12, character: 9 }, end: { line: 12, character: 16 } }, children: [] },
        { name: "lineFn", detail: "", kind: 12, range: { start: { line: 13, character: 0 }, end: { line: 13, character: 31 } }, selectionRange: { start: { line: 13, character: 9 }, end: { line: 13, character: 15 } }, children: [] },
        { name: "Panel", detail: "", kind: 12, range: { start: { line: 14, character: 13 }, end: { line: 14, character: 30 } }, selectionRange: { start: { line: 14, character: 13 }, end: { line: 14, character: 18 } }, children: [] },
        { name: "optFn", detail: "", kind: 12, range: { start: { line: 15, character: 0 }, end: { line: 15, character: 30 } }, selectionRange: { start: { line: 15, character: 9 }, end: { line: 15, character: 14 } }, children: [] },
        { name: "passedFn", detail: "", kind: 12, range: { start: { line: 16, character: 0 }, end: { line: 16, character: 33 } }, selectionRange: { start: { line: 16, character: 9 }, end: { line: 16, character: 17 } }, children: [] },
        { name: "register", detail: "", kind: 12, range: { start: { line: 17, character: 0 }, end: { line: 17, character: 44 } }, selectionRange: { start: { line: 17, character: 9 }, end: { line: 17, character: 17 } }, children: [] },
      ]);
    }
    if (options.nullSymbols) return respond(message.id, null);
    if (options.unknownParent) {
      return respond(message.id, [
        {
          name: "UnknownContainer",
          detail: "unknown container",
          kind: 999,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 4, character: 1 },
          },
          selectionRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 16 },
          },
          children: [
            {
              name: "KnownChild",
              detail: "function KnownChild(): void",
              kind: 12,
              range: {
                start: { line: 1, character: 2 },
                end: { line: 3, character: 3 },
              },
              selectionRange: {
                start: { line: 1, character: 11 },
                end: { line: 1, character: 21 },
              },
            },
          ],
        },
      ]);
    }
    if (options.changeSymbolsOnRefresh) {
      // Models a server whose second `documentSymbol` answer reflects an edit
      // made between builds: the resident source's refresh must call this
      // again (not reuse the first build's symbols) after a file changes.
      const count = (symbolCallCountByUri.get(uri) ?? 0) + 1;
      symbolCallCountByUri.set(uri, count);
      const name = count === 1 ? "FirstHelper" : "SecondHelper";
      return respond(message.id, [
        {
          name,
          detail: `function ${name}(): void`,
          kind: 12,
          range: { start: { line: 6, character: 0 }, end: { line: 8, character: 1 } },
          selectionRange: {
            start: { line: 6, character: 16 },
            end: { line: 6, character: 16 + name.length },
          },
          children: [],
        },
      ]);
    }
    if (options.allSymbolKinds) {
      const kinds = [2, 3, 7, 8, 9, 10, 11, 13, 14, 23, 999];
      return respond(message.id, kinds.map((kind, index) => ({
        name: `Kind${kind}`,
        kind,
        containerName: index % 2 === 0 ? "AllKinds" : "",
        location: {
          uri,
          range: {
            start: { line: index, character: 0 },
            end: { line: index, character: 8 },
          },
        },
      })));
    }
    if (options.symbolInformation) {
      return respond(message.id, [
        {
          name: "LspInformation",
          kind: 12,
          containerName: "InformationContainer",
          location: {
            uri,
            range: {
              start: { line: 6, character: 16 },
              end: { line: 8, character: 1 },
            },
          },
        },
      ]);
    }
    const helper = {
      name: "helper",
      detail: "function helper(): void",
      kind: 12,
      range: {
        start: { line: 6, character: 0 },
        end: { line: 8, character: 1 },
      },
      selectionRange: {
        start: { line: 6, character: 16 },
        end: { line: 6, character: 22 },
      },
      ...(options.omitChildren ? {} : { children: [] }),
    };
    return respond(message.id, [
      {
        name: "LspService",
        detail: "class LspService",
        kind: 5,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 5, character: 1 },
        },
        selectionRange: {
          start: { line: 0, character: 13 },
          end: { line: 0, character: 23 },
        },
        children: [
          {
            name: "run",
            detail: "run(): void",
            kind: 6,
            range: {
              start: { line: 1, character: 2 },
              end: { line: 3, character: 3 },
            },
            selectionRange: {
              start: { line: 1, character: 2 },
              end: { line: 1, character: 5 },
            },
            children: [],
          },
        ],
      },
      helper,
    ]);
  }
  if (message.method === "textDocument/references") {
    if (
      options.referenceProgressLifecycle &&
      !referenceProgressLifecycleStarted
    ) {
      // The warm reference itself starts a lazy cross-file index and returns a
      // valid but incomplete answer. The client must await the lifecycle and
      // requery instead of preserving this first empty response.
      referenceProgressLifecycleStarted = true;
      request("window/workDoneProgress/create", { token: "reference-index" });
      notify("$/progress", {
        token: "reference-index",
        value: { kind: "begin", title: "reference indexing" },
      });
      setTimeout(() => {
        referenceProgressLifecycleReady = true;
        notify("$/progress", {
          token: "reference-index",
          value: { kind: "end" },
        });
      }, 200);
      return respond(message.id, []);
    }
    if (
      ((options.progressLifecycle || lateProgressLifecycleMs > 0) &&
        !progressLifecycleReady) ||
      (options.referenceProgressLifecycle &&
        !referenceProgressLifecycleReady)
    ) {
      return respond(message.id, []);
    }
    if (options.referenceError) return respondError(message.id, "content modified");
    if (options.nullReferences) return respond(message.id, null);
    referenceCallCount += 1;
    if (referenceCallCount > hangReferencesAfter) return;
    if (slowFirstReferencesMs > 0 && referenceCallCount === 1) {
      // The first call is delayed past a short per-request timeout but within a
      // patient warmup budget; the harness must wait it out, then the batch is
      // instant. Re-dispatch after the delay with the delay disabled.
      const delay = slowFirstReferencesMs;
      slowFirstReferencesMs = 0;
      setTimeout(() => handle(message), delay);
      return;
    }
    if (options.typeQueries) {
      const uri = message.params.textDocument.uri;
      const languageId = languageByUri.get(uri);
      const at = (line, startChar, endChar) => ({
        uri,
        range: {
          start: { line, character: startChar },
          end: { line, character: endChar },
        },
      });
      if (languageId === "typescript") {
        // `type Alias = typeof Target` and `null as typeof Target`: a type-alias
        // right-hand side and an `as` type assertion, both type queries.
        return respond(message.id, [at(1, 20, 26), at(2, 25, 31)]);
      }
      // A non-TypeScript `typeof Target`: always a type reference.
      return respond(message.id, [at(2, 15, 21)]);
    }
    if (options.classify) {
      const uri = message.params.textDocument.uri;
      const at = (line, startChar = 0, endChar = 4) => ({
        uri,
        range: {
          start: { line, character: startChar },
          end: { line, character: endChar },
        },
      });
      // line 1: invocation (`(` after col 4), line 2: bare access, line 3: a
      // dotted member access spanning `aabb.member` (so a callable target
      // reached this way classifies as an access, not a generic reference),
      // line 13: a JSX opening tag (`<aabb`), line 14: a JSX closing tag
      // (`</aabb`), line 15: a generic type argument (`Array<aabb>` — must NOT
      // classify as JSX), line 16: an invocation through a generic argument
      // list (`aabb<T>()`), line 17: an unclosed generic argument list
      // (`aabb<Unclosed;` — the skip gives up and returns the text
      // unchanged), line 500: beyond the file so the classifier sees no
      // source text.
      // A repeated `(from, to, kind)` triple keeps the FIRST source-order
      // evidence, so a target that is invoked twice can only ever show its first
      // call site. Two targets are therefore split out of the shared list:
      //
      // - `count` (line 12) is referenced ONLY by the generic-argument
      //   invocation, so nothing collides with it and its classification is
      //   observable at its own line.
      // - `fn` (line 7) is referenced by BOTH invocations, so the surviving
      //   evidence pins the first-wins contract.
      const base = [
        at(1),
        at(2),
        at(2, 0, 11),
        at(13, 1, 5),
        at(14, 2, 6),
        at(15, 6, 10),
        at(17, 0, 4),
        at(500),
      ];
      const target = message.params.position.line;
      if (target === 12) return respond(message.id, [at(16, 0, 4)]);
      if (target === 7) return respond(message.id, [...base, at(16, 0, 4)]);
      return respond(message.id, base);
    }
    if (options.dualOwner) {
      const uri = message.params.textDocument.uri;
      // `target()` is called once inside `helper` (a property/arrow-field
      // member, line 2) and once inside `method`, where it is split across
      // two lines (`target` on line 5, `();` on line 6) — the `(` check must
      // read line 6's text, not line 5's.
      return respond(message.id, [
        { uri, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } } },
        { uri, range: { start: { line: 5, character: 4 }, end: { line: 6, character: 6 } } },
        { uri, range: { start: { line: 9, character: 19 }, end: { line: 9, character: 25 } } },
      ]);
    }
    if (options.pythonLocals) {
      const uri = message.params.textDocument.uri;
      return respond(message.id, [
        { uri, range: { start: { line: 1, character: 18 }, end: { line: 1, character: 24 } } },
        { uri, range: { start: { line: 3, character: 19 }, end: { line: 3, character: 25 } } },
        { uri, range: { start: { line: 4, character: 26 }, end: { line: 4, character: 32 } } },
        { uri, range: { start: { line: 7, character: 15 }, end: { line: 7, character: 21 } } },
      ]);
    }
    if (options.javaAnonymous) {
      const line = message.params.position.line;
      // JDT.LS answers a reference query on EACH anonymous class with all
      // constructions of the nominal Adapter supertype. The indexer must not
      // query those synthetic identities (lines 6 and 12), or this identical
      // response becomes an anonymous-target cross-product. Querying the real
      // Adapter declaration (line 39) remains valid and preserves both sites.
      if (line !== 6 && line !== 12 && line !== 39)
        return respond(message.id, []);
      const uri = message.params.textDocument.uri;
      return respond(message.id, [
        {
          uri,
          range: {
            start: { line: 6, character: 8 },
            end: { line: 6, character: 15 },
          },
        },
        {
          uri,
          range: {
            start: { line: 12, character: 8 },
            end: { line: 12, character: 15 },
          },
        },
      ]);
    }
    if (options.trivia) {
      const uri = message.params.textDocument.uri;
      const at = (line) => ({ uri, range: { start: { line, character: 2 }, end: { line, character: 40 } } });
      // Each reference range starts on the token's leading trivia; the indexer
      // must advance to the real token. Store is used on lines 1 (`new Store`)
      // and 2 (`typeof Store`); blockFn on line 3 with a block comment before
      // it; lineFn on line 6 with the range starting on line 5's `//` comment.
      switch (message.params.position.line - 1) {
        case 10: // Store — ranges start on the space before the name so the
          // `new` / `typeof` keyword lands at the end of `before` after the
          // trivia advance, exercising the keyword-prefix classification.
          return respond(message.id, [
            { uri, range: { start: { line: 1, character: 15 }, end: { line: 1, character: 21 } } },
            { uri, range: { start: { line: 2, character: 17 }, end: { line: 2, character: 23 } } },
            { uri, range: { start: { line: 9, character: 23 }, end: { line: 9, character: 28 } } },
          ]);
        case 11: // blockFn — range starts inside `/* pre */`
          return respond(message.id, [{ uri, range: { start: { line: 3, character: 13 }, end: { line: 3, character: 30 } } }]);
        case 12: // lineFn — range starts on the `// pick` line, wraps to line 6
          return respond(message.id, [{ uri, range: { start: { line: 5, character: 4 }, end: { line: 6, character: 10 } } }]);
        case 13: // Panel — a namespaced JSX tag `<NS.Panel />` (render + access)
          return respond(message.id, [{ uri, range: { start: { line: 7, character: 9 }, end: { line: 7, character: 17 } } }]);
        case 14: // optFn — an optional call `optFn?.()`
          return respond(message.id, [{ uri, range: { start: { line: 8, character: 8 }, end: { line: 8, character: 13 } } }]);
        case 15: // passedFn — handed to `register(...)` as a value, at module scope
          return respond(message.id, [{ uri, range: { start: { line: 18, character: 9 }, end: { line: 18, character: 17 } } }]);
        case 16: // register — called at the top level of the module
          return respond(message.id, [{ uri, range: { start: { line: 18, character: 0 }, end: { line: 18, character: 8 } } }]);
        default:
          return respond(message.id, []);
      }
    }
    const line = message.params.position.line;
    if (line === 6) {
      if (options.specialReferences) {
        return respond(message.id, [
          {
            uri: "file:///outside.ts",
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
          },
          {
            uri: message.params.textDocument.uri,
            range: {
              start: { line: 6, character: 16 },
              end: { line: 6, character: 22 },
            },
          },
          {
            uri: message.params.textDocument.uri,
            range: {
              start: { line: 99, character: 0 },
              end: { line: 99, character: 1 },
            },
          },
          {
            uri: message.params.textDocument.uri.replace(/\/[^/]*$/, "/unopened.ts"),
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
          },
        ]);
      }
      return respond(message.id, [
        {
          uri: message.params.textDocument.uri,
          range: {
            start: { line: 2, character: 4 },
            end: { line: 2, character: 10 },
          },
        },
      ]);
    }
    return respond(message.id, []);
  }
  if (message.method === "shutdown") {
    // Several real servers treat `shutdown` as the end and simply exit instead
    // of answering it, so the client's own `exit` notification arrives at a
    // process that is already gone.
    if (options.exitOnShutdown) process.exit(0);
    if (options.shutdownError) return respondError(message.id, "shutdown failed");
    return respond(message.id, null);
  }
  if (message.method === "exit") {
    if (!options.ignoreTermination) process.exit(0);
    return;
  }
  if (message.id !== undefined) respond(message.id, null);
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function respondError(id, message) {
  write({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

function respondBareError(id) {
  write({ jsonrpc: "2.0", id, error: { code: -32000 } });
}

function notify(method, params) {
  write({ jsonrpc: "2.0", method, params });
}

let serverRequestId = 100000;
function request(method, params) {
  write({ jsonrpc: "2.0", id: serverRequestId++, method, params });
}

function recordDocumentVersion(method, textDocument) {
  if (documentVersionLog === undefined) return;
  documentVersionEvents.push({
    method,
    uri: textDocument.uri,
    ...(textDocument.version === undefined
      ? {}
      : { version: textDocument.version }),
  });
  writeDocumentVersionLog();
}

function writeDocumentVersionLog() {
  if (documentVersionLog === undefined) return;
  fs.writeFileSync(documentVersionLog, JSON.stringify(documentVersionEvents));
}

function write(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

process.on("uncaughtException", (error) => {
  fs.writeSync(2, `${error.stack || error.message}\n`);
  process.exit(1);
});
