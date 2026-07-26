import { TestValidator } from "@nestia/e2e";
import {
  adaptScipIndex,
  parseScipIndex,
  scipSymbol,
} from "@samchon/graph";

/**
 * SCIP ingestion publishes what the index proves and refuses to guess the
 * rest.
 *
 * A SCIP index says where a symbol is defined and referenced, and can carry
 * role and relationship bits whose meaning still depends on the producing
 * indexer. It has no universal way to say that a reference is an invocation,
 * that a type reference is a construction, or what an annotation means —
 * those are different facts in different languages. The temptation is to
 * recover them by looking at source or treating all producers alike, and the
 * whole value of a strict lane is that it does neither.
 */
export const test_scip_ingestion_maps_only_what_it_proves = async () => {
  assertSymbolParsing();
  assertIndexValidation();
  assertMapping();
  assertForwardDefinitionOrdering();
};

function assertSymbolParsing(): void {
  const method = scipSymbol("scip-go gomod example v1 `pkg`/Server#Serve().");
  TestValidator.equals(
    "a method symbol names itself and its owners",
    [method?.displayName, method?.owners, method?.descriptor, method?.stability],
    ["Serve", ["pkg", "Server"], "method", "persistent"],
  );

  TestValidator.equals(
    "a term descriptor is read",
    scipSymbol("scip-go gomod example v1 `pkg`/value.")?.descriptor,
    "term",
  );
  TestValidator.equals(
    "a type descriptor is read",
    scipSymbol("scip-go gomod example v1 `pkg`/Server#")?.descriptor,
    "type",
  );
  TestValidator.equals(
    "a namespace descriptor is read",
    scipSymbol("scip-go gomod example v1 `pkg`/")?.descriptor,
    "namespace",
  );
  TestValidator.equals(
    "a macro descriptor is read",
    scipSymbol("scip-rust cargo example v1 `krate`/expand!")?.descriptor,
    "macro",
  );
  TestValidator.equals(
    "a meta descriptor is read",
    scipSymbol("scip-java maven example v1 `pkg`/Meta:")?.descriptor,
    "meta",
  );
  TestValidator.equals(
    "a type parameter is read",
    scipSymbol("scip-java maven example v1 `pkg`/Box#[T]")?.descriptor,
    "type-parameter",
  );
  TestValidator.equals(
    "a value parameter is read",
    scipSymbol("scip-java maven example v1 `pkg`/run().(arg)")?.descriptor,
    "parameter",
  );

  // A backticked name may contain the very characters that end a descriptor;
  // cutting at the first `#` would split the name in half.
  TestValidator.equals(
    "a backticked name keeps its punctuation",
    scipSymbol("scip-scala maven example v1 `odd#name`#")?.displayName,
    "odd#name",
  );
  TestValidator.equals(
    "a doubled backtick is one literal backtick",
    scipSymbol("scip-scala maven example v1 `tick``tock`#")?.displayName,
    "tick`tock",
  );

  // `local N` is an index-local counter: the same declaration is `local 3`
  // today and `local 7` after an edit above it, so it is never persistent.
  TestValidator.equals(
    "a local symbol is scoped to its generation",
    [scipSymbol("local 4")?.stability, scipSymbol("local 4")?.displayName],
    ["generation", "4"],
  );

  for (const malformed of [
    "",
    "local ",
    "local  4",
    "local bad id",
    "local `bad`",
    " scip-go gomod example v1 `pkg`/Server#",
    "local-scip gomod example v1 `pkg`/Server#",
    "scip-go gomod example",
    "scip-go gomod example v1 ",
    "scip-go gomod example v1 `pkg`/unterminated",
    "scip-go gomod example v1 `unclosed",
    "scip-go gomod example v1 `pkg`/run(unclosed.",
    "scip-go gomod example v1 `pkg`/run(bad disambiguator).",
    "scip-go gomod example v1 `pkg`/naïve#",
    // A suffix that closes a descriptor it never opened denotes nothing.
    "scip-go gomod example v1 `pkg`/bad)",
    "scip-go gomod example v1 `pkg`/bad]",
    // A bracketed descriptor with nothing inside it names nothing.
    "scip-java maven example v1 `pkg`/Box#[]",
    "scip-java maven example v1 `pkg`/run().()",
    "scip-java maven example v1 `pkg`/Box#[`T`x",
    "scip-java maven example v1 `pkg`/run().(`arg`x",
    "scip-go gomod example v1 ``#",
    // A descriptor that is only a suffix has no name to read.
    "scip-go gomod example v1 #",
  ]) {
    TestValidator.equals(
      `an unreadable symbol is not guessed: "${malformed}"`,
      scipSymbol(malformed),
      undefined,
    );
  }

  TestValidator.equals(
    "escaped spaces in package coordinates do not consume the descriptor tail",
    scipSymbol("scip-go gomod example  package v1 `pkg`/Server#")?.displayName,
    "Server",
  );
  TestValidator.equals(
    "a valid method disambiguator is accepted",
    scipSymbol("scip-go gomod example v1 `pkg`/run(+1).")?.displayName,
    "run",
  );

  // The index's own kind wins; the descriptor is the fallback; neither
  // mapping means no node, because a guessed kind is read as fact downstream.
  TestValidator.equals(
    "the index's kind wins over the descriptor",
    scipSymbol.nodeKind("Interface", "type"),
    "interface",
  );
  TestValidator.equals(
    "the descriptor is the fallback",
    scipSymbol.nodeKind(undefined, "method"),
    "method",
  );
  TestValidator.equals(
    "an unmapped kind falls back to the descriptor",
    scipSymbol.nodeKind("SelfParameterButNotReally", "type"),
    "type",
  );
  TestValidator.equals(
    "a namespace descriptor maps",
    scipSymbol.nodeKind(undefined, "namespace"),
    "namespace",
  );
  TestValidator.equals(
    "a term descriptor maps",
    scipSymbol.nodeKind(undefined, "term"),
    "variable",
  );
  TestValidator.equals(
    "a macro descriptor maps",
    scipSymbol.nodeKind(undefined, "macro"),
    "function",
  );
  for (const undecided of ["type-parameter", "parameter", "meta"] as const) {
    TestValidator.equals(
      `a ${undecided} descriptor declares nothing this graph models`,
      scipSymbol.nodeKind(undefined, undecided),
      undefined,
    );
  }
  TestValidator.equals(
    "no kind and no descriptor is no node",
    scipSymbol.nodeKind(undefined, undefined),
    undefined,
  );
}

function assertIndexValidation(): void {
  const valid = parseScipIndex(rawIndex());
  TestValidator.equals(
    "a valid index parses",
    valid.documents.map((document) => document.relativePath),
    ["main.go"],
  );
  const goStructJson = parseScipIndex({
    metadata: {
      version: 0,
      tool_info: {
        name: "rust-analyzer-scip",
        version: "0.1",
        arguments: ["index"],
      },
      project_root: "file:///r",
      text_document_encoding: 1,
    },
    documents: [
      {
        language: "Rust",
        relative_path: "src/main.rs",
        position_encoding: 2,
        symbols: [
          {
            symbol: "scip-rust cargo example v1 `crate`/run().",
            display_name: "run",
            kind: 17,
            enclosing_symbol: "scip-rust cargo example v1 `crate`/Owner#",
            relationships: [
              {
                symbol: "scip-rust cargo example v1 `crate`/Owner#",
                is_reference: true,
                is_type_definition: true,
              },
            ],
          },
        ],
        occurrences: [
          {
            TypedRange: {
              SingleLineRange: {
                line: 4,
                start_character: 2,
                end_character: 5,
              },
            },
            TypedEnclosingRange: {
              MultiLineEnclosingRange: {
                start_line: 3,
                start_character: 0,
                end_line: 5,
                end_character: 1,
              },
            },
            symbol: "scip-rust cargo example v1 `crate`/run().",
            symbol_roles: 1,
            syntax_kind: 16,
            diagnostics: [
              { severity: 2, code: "lint", message: "finding", tags: [2] },
            ],
          },
        ],
      },
    ],
    external_symbols: [
      {
        symbol: "scip-rust cargo dep v1 `dep`/External#",
        display_name: "External",
        kind: 7,
      },
    ],
  });
  TestValidator.equals(
    "`scip print --json` Go-struct fields and enums are normalized",
    [
      goStructJson.metadata,
      goStructJson.documents[0]?.relativePath,
      goStructJson.documents[0]?.positionEncoding,
      goStructJson.documents[0]?.symbols?.[0],
      goStructJson.documents[0]?.occurrences?.[0],
      goStructJson.externalSymbols?.[0],
    ],
    [
      {
        version: "UnspecifiedProtocolVersion",
        toolInfo: {
          name: "rust-analyzer-scip",
          version: "0.1",
          arguments: ["index"],
        },
        projectRoot: "file:///r",
        textDocumentEncoding: "UTF8",
      },
      "src/main.rs",
      "UTF16CodeUnitOffsetFromLineStart",
      {
        symbol: "scip-rust cargo example v1 `crate`/run().",
        displayName: "run",
        kind: "Function",
        relationships: [
          {
            symbol: "scip-rust cargo example v1 `crate`/Owner#",
            isReference: true,
            isTypeDefinition: true,
          },
        ],
        enclosingSymbol: "scip-rust cargo example v1 `crate`/Owner#",
      },
      {
        range: [4, 2, 5],
        symbol: "scip-rust cargo example v1 `crate`/run().",
        symbolRoles: 1,
        syntaxKind: "IdentifierFunctionDefinition",
        enclosingRange: [3, 0, 5, 1],
        diagnostics: [
          {
            message: "finding",
            severity: "Warning",
            code: "lint",
            tags: ["Deprecated"],
          },
        ],
      },
      {
        symbol: "scip-rust cargo dep v1 `dep`/External#",
        displayName: "External",
        kind: "Class",
      },
    ],
  );

  // Every rejection below is a shape that, if accepted, would attribute facts
  // to source that never produced them.
  const rejections: Array<[string, unknown]> = [
    ["a non-object index", []],
    ["a missing metadata block", { documents: [] }],
    ["a missing project root", { metadata: {}, documents: [] }],
    ["non-array documents", { metadata: { projectRoot: "file:///r" }, documents: {} }],
    ["an empty document path", withDocument({ relativePath: "" })],
    [
      "an absolute POSIX document path",
      withDocument({ relativePath: "/etc/passwd" }),
    ],
    [
      "an absolute Windows document path",
      withDocument({ relativePath: "C:/x.go" }),
    ],
    [
      "a drive-relative Windows document path",
      withDocument({ relativePath: "C:x.go" }),
    ],
    [
      "a parent-escaping document path",
      withDocument({ relativePath: "../out.go" }),
    ],
    ["a dot-segment document path", withDocument({ relativePath: "./a.go" })],
    ["a repeated-separator document path", withDocument({ relativePath: "dir//a.go" })],
    [
      "two documents describing one file",
      {
        metadata: { projectRoot: "file:///r" },
        documents: [{ relativePath: "a.go" }, { relativePath: "a.go" }],
      },
    ],
    [
      "two spellings of one document path",
      {
        metadata: { projectRoot: "file:///r" },
        documents: [
          { relativePath: "dir/a.go" },
          { relativePath: "dir\\a.go" },
        ],
      },
    ],
    ["a non-string occurrence symbol", withOccurrence({ range: [0, 0, 1], symbol: 1 })],
    ["an occurrence without any range", withOccurrence({ symbol: "s" })],
    ["a two-element range", withOccurrence({ range: [0, 1], symbol: "s" })],
    ["a five-element range", withOccurrence({ range: [0, 1, 2, 3, 4], symbol: "s" })],
    ["a negative range value", withOccurrence({ range: [0, -1, 2], symbol: "s" })],
    ["a fractional range value", withOccurrence({ range: [0, 1.5, 2], symbol: "s" })],
    [
      "a range coordinate outside SCIP's int32 field",
      withOccurrence({ range: [0, 0, 0x80000000], symbol: "s" }),
    ],
    ["a range that ends before it starts", withOccurrence({ range: [3, 0, 1, 0], symbol: "s" })],
    [
      "a single-line range that ends before it starts",
      withOccurrence({ range: [0, 5, 2], symbol: "s" }),
    ],
    [
      "both members of the typed-range choice",
      withOccurrence({
        symbol: "s",
        singleLineRange: { line: 0, startCharacter: 0, endCharacter: 1 },
        multiLineRange: {
          startLine: 0,
          startCharacter: 0,
          endLine: 1,
          endCharacter: 0,
        },
      }),
    ],
    [
      "a typed range contradicting its legacy twin",
      withOccurrence({
        range: [0, 0, 1],
        symbol: "s",
        singleLineRange: { line: 1, startCharacter: 0, endCharacter: 1 },
      }),
    ],
    [
      "a typed range with a missing coordinate",
      withOccurrence({
        symbol: "s",
        singleLineRange: { line: 0, startCharacter: 0 },
      }),
    ],
    [
      "an empty Go-struct typed-range wrapper",
      withOccurrence({ symbol: "s", TypedRange: {} }),
    ],
    [
      "both protobuf and Go-struct typed-range encodings",
      withOccurrence({
        symbol: "s",
        singleLineRange: { line: 0, startCharacter: 0, endCharacter: 1 },
        TypedRange: {
          SingleLineRange: {
            line: 0,
            start_character: 0,
            end_character: 1,
          },
        },
      }),
    ],
    [
      "a non-integer role mask",
      withOccurrence({ range: [0, 0, 1], symbol: "s", symbolRoles: "1" }),
    ],
    [
      "a negative role mask",
      withOccurrence({ range: [0, 0, 1], symbol: "s", symbolRoles: -1 }),
    ],
    [
      "a role mask outside SCIP's int32 field",
      withOccurrence({
        range: [0, 0, 1],
        symbol: "s",
        symbolRoles: 0x80000000,
      }),
    ],
    ["an empty symbol identity", withSymbol({ symbol: "" })],
    ["a non-string display name", withSymbol({ symbol: "s", displayName: 1 })],
    [
      "a non-boolean relationship flag",
      withSymbol({ symbol: "s", relationships: [{ symbol: "t", isImplementation: "yes" }] }),
    ],
    [
      "a relationship without a symbol",
      withSymbol({ symbol: "s", relationships: [{}] }),
    ],
    [
      "a diagnostic without a message",
      {
        metadata: { projectRoot: "file:///r" },
        documents: [{ relativePath: "a.go", diagnostics: [{ severity: "Error" }] }],
      },
    ],
    [
      "a tool info block without a name",
      { metadata: { projectRoot: "file:///r", toolInfo: {} }, documents: [] },
    ],
    [
      "a null optional record",
      { metadata: { projectRoot: "file:///r", toolInfo: null }, documents: [] },
    ],
    [
      "both protobuf and Go spellings of one field",
      {
        metadata: { projectRoot: "file:///r", project_root: "file:///r" },
        documents: [],
      },
    ],
    [
      "an unknown numeric symbol kind",
      withSymbol({ symbol: "s", kind: 83 }),
    ],
    [
      "non-array external symbols",
      { metadata: { projectRoot: "file:///r" }, documents: [], externalSymbols: {} },
    ],
  ];
  for (const [label, malformed] of rejections) {
    TestValidator.error(`a malformed index is refused: ${label}`, () =>
      parseScipIndex(malformed),
    );
  }

  // A single-line three-element range is the shorthand, not a defect.
  TestValidator.equals(
    "the single-line range shorthand is accepted",
    parseScipIndex(withOccurrence({ range: [4, 2, 9], symbol: "s" })).documents[0]!
      .occurrences![0]!.range,
    [4, 2, 9],
  );
  const symbolLess = parseScipIndex(
    withOccurrence({
      range: [3, 4, 8],
      symbol: "",
      diagnostics: [{ message: "syntax-only finding" }],
    }),
  ).documents[0]!.occurrences![0]!;
  TestValidator.equals(
    "a diagnostic or highlighting occurrence may carry no symbol",
    [symbolLess.symbol, symbolLess.diagnostics?.[0]?.message],
    ["", "syntax-only finding"],
  );
  // scip-python lists document-scoped locals among its external symbols. A
  // `local N` counter resets per document, so outside its own document the
  // string names nothing and there is no document to scope an external leaf to.
  // Materializing one produced an identity with an empty generation key, which
  // the semantic-identity contract refuses — taking the whole provider down and
  // falling the language back to the generic lane.
  const unscopedLocal = adaptScipIndex({
    index: parseScipIndex({
      metadata: { projectRoot: "file:///r" },
      documents: [
        {
          relativePath: "a.py",
          symbols: [
            {
              symbol: "scip-python python click v1 `a`/caller().",
              displayName: "caller",
              kind: "Function",
            },
          ],
          occurrences: [
            {
              range: [0, 0, 6],
              symbol: "scip-python python click v1 `a`/caller().",
              symbolRoles: 0x1,
            },
            { range: [1, 2, 7], symbol: "local 4" },
          ],
        },
      ],
      externalSymbols: [{ symbol: "local 4", displayName: "leaked" }],
    }),
    root: "/r",
    provider: "scip-python",
    languages: ["python"],
    languageOf: () => "python",
  });
  TestValidator.equals(
    "a document-scoped local is never externalized into an invented declaration",
    [
      unscopedLocal.nodes.map((node) => node.name),
      unscopedLocal.edges.filter((edge) => edge.kind !== "contains").length,
      unscopedLocal.warnings.filter((warning) =>
        warning.includes("document-scoped local"),
      ).length,
    ],
    [["caller"], 0, 1],
  );

  // The twin that separates counting listed symbols from counting lost
  // references. This `local 4` *is* declared by its document, so it resolves
  // normally and nothing is omitted; a counter that fired on the external
  // listing would report a declaration that exists as having none.
  const declaredLocal = adaptScipIndex({
    index: parseScipIndex({
      metadata: { projectRoot: "file:///r" },
      documents: [
        {
          relativePath: "a.py",
          symbols: [
            {
              symbol: "scip-python python click v1 `a`/caller().",
              displayName: "caller",
              kind: "Function",
            },
            { symbol: "local 4", displayName: "held", kind: "Variable" },
          ],
          occurrences: [
            {
              range: [0, 0, 6],
              symbol: "scip-python python click v1 `a`/caller().",
              symbolRoles: 0x1,
            },
            { range: [1, 2, 6], symbol: "local 4", symbolRoles: 0x1 },
            { range: [2, 2, 6], symbol: "local 4" },
          ],
        },
      ],
      externalSymbols: [{ symbol: "local 4", displayName: "leaked" }],
    }),
    root: "/r",
    provider: "scip-python",
    languages: ["python"],
    languageOf: () => "python",
  });
  TestValidator.equals(
    "a local its own document declares is not reported as undeclared",
    declaredLocal.warnings.filter((warning) =>
      warning.includes("document-scoped local"),
    ),
    [],
  );

  const symbolLessAdapted = adaptScipIndex({
    index: parseScipIndex(
      withDocument({
        relativePath: "a.go",
        occurrences: [
          { range: [0, 0, 1], symbolRoles: 0x40 },
          { range: [1, 0, 1], symbolRoles: 0x1 },
          {
            range: [2, 3, 7],
            diagnostics: [{ message: "syntax-only finding" }],
          },
        ],
      }),
    ),
    root: "/r",
    provider: "scip-go",
    languages: ["go"],
    languageOf: () => "go",
  });
  TestValidator.equals(
    "symbol-less occurrences retain diagnostics without inventing graph facts",
    [
      symbolLessAdapted.nodes,
      symbolLessAdapted.edges,
      symbolLessAdapted.diagnostics.map((diagnostic) => [
        diagnostic.message,
        diagnostic.line,
        diagnostic.column,
      ]),
    ],
    [[], [], [["syntax-only finding", 3, 4]]],
  );
  const typedSingleLine = parseScipIndex(
    withOccurrence({
      symbol: "s",
      singleLineRange: { line: 4, startCharacter: 2, endCharacter: 9 },
      singleLineEnclosingRange: {
        line: 4,
        startCharacter: 0,
        endCharacter: 10,
      },
    }),
  ).documents[0]!.occurrences![0]!;
  TestValidator.equals(
    "typed single-line ranges are normalized without deprecated twins",
    [typedSingleLine.range, typedSingleLine.enclosingRange],
    [
      [4, 2, 9],
      [4, 0, 10],
    ],
  );
  const typedMultiLine = parseScipIndex(
    withOccurrence({
      range: [2, 3, 4, 5],
      symbol: "s",
      multiLineRange: {
        startLine: 2,
        startCharacter: 3,
        endLine: 4,
        endCharacter: 5,
      },
      multiLineEnclosingRange: {
        startLine: 1,
        startCharacter: 0,
        endLine: 5,
        endCharacter: 9,
      },
    }),
  ).documents[0]!.occurrences![0]!;
  TestValidator.equals(
    "an equivalent typed range takes precedence over its legacy twin",
    typedMultiLine.range,
    [2, 3, 4, 5],
  );
  TestValidator.equals(
    "a typed enclosing range is normalized",
    typedMultiLine.enclosingRange,
    [1, 0, 5, 9],
  );
  const rustAnalyzerReference = parseScipIndex(
    withOccurrence({
      range: [8, 4, 10],
      symbol: "rust-analyzer cargo example 1.0.0 `main`/run().",
      enclosingRange: [1, 0, 5, 1],
    }),
  ).documents[0]!.occurrences![0]!;
  TestValidator.equals(
    "a non-definition occurrence does not inherit its target definition body as a scope",
    [rustAnalyzerReference.range, rustAnalyzerReference.enclosingRange],
    [[8, 4, 10], undefined],
  );
  TestValidator.error(
    "a definition whose enclosing range does not enclose it is refused",
    () =>
      parseScipIndex(
        withOccurrence({
          range: [8, 4, 10],
          symbol: "s",
          symbolRoles: 1,
          enclosingRange: [1, 0, 5, 1],
        }),
      ),
  );
  // Optional records the graph does not read are still validated, because a
  // malformed one is evidence the index was not produced the way it claims.
  const documented = parseScipIndex(
    withSymbol({
      symbol: "scip-go gomod example v1 `pkg`/run().",
      documentation: ["one", "two"],
      relationships: [{ symbol: "scip-go gomod example v1 `pkg`/Other#" }],
      enclosingSymbol: "scip-go gomod example v1 `pkg`/Owner#",
    }),
  ).documents[0]!.symbols![0]!;
  TestValidator.equals(
    "documentation lines are carried",
    documented.documentation,
    ["one", "two"],
  );
  TestValidator.equals(
    "a relationship with no flags set carries none",
    documented.relationships,
    [{ symbol: "scip-go gomod example v1 `pkg`/Other#" }],
  );
  TestValidator.error("a non-string documentation line is refused", () =>
    parseScipIndex(withSymbol({ symbol: "s", documentation: [1] })),
  );
  TestValidator.error("non-array documentation is refused", () =>
    parseScipIndex(withSymbol({ symbol: "s", documentation: "one" })),
  );
  TestValidator.error("non-array relationships are refused", () =>
    parseScipIndex(withSymbol({ symbol: "s", relationships: {} })),
  );
  TestValidator.error("a non-string enclosing symbol is refused", () =>
    parseScipIndex(withSymbol({ symbol: "s", enclosingSymbol: 1 })),
  );
  TestValidator.error("an unknown numeric position encoding is refused", () =>
    parseScipIndex(withDocument({ relativePath: "a.go", positionEncoding: 99 })),
  );
  TestValidator.error("a non-enum position encoding is refused", () =>
    parseScipIndex(
      withDocument({ relativePath: "a.go", positionEncoding: null }),
    ),
  );
  TestValidator.error("a fractional enum number is refused", () =>
    parseScipIndex(
      withDocument({ relativePath: "a.go", positionEncoding: 1.5 }),
    ),
  );
  TestValidator.equals(
    "a Windows-spelled workspace-relative document is canonicalized",
    parseScipIndex(withDocument({ relativePath: "dir\\a.go" })).documents[0]
      ?.relativePath,
    "dir/a.go",
  );
  TestValidator.error("an unknown numeric syntax kind is refused", () =>
    parseScipIndex(
      withOccurrence({ range: [0, 0, 1], symbol: "s", syntaxKind: 99 }),
    ),
  );
  TestValidator.error("a malformed enclosing range is refused", () =>
    parseScipIndex(
      withOccurrence({ range: [0, 0, 1], symbol: "s", enclosingRange: [0, 0] }),
    ),
  );

  const optionalRecords = parseScipIndex({
    metadata: {
      projectRoot: "file:///r",
      toolInfo: {
        name: "scip-go",
        version: "1",
        arguments: ["--index", "./..."],
      },
    },
    documents: [
      {
        relativePath: "a.go",
        diagnostics: [
          { message: "deprecated", tags: ["Deprecated", "Unnecessary"] },
        ],
      },
    ],
  });
  TestValidator.equals(
    "optional tool arguments and diagnostic tags are validated and kept",
    [
      optionalRecords.metadata.toolInfo?.arguments,
      optionalRecords.documents[0]?.diagnostics?.[0]?.tags,
    ],
    [
      ["--index", "./..."],
      ["Deprecated", "Unnecessary"],
    ],
  );
  TestValidator.error("non-array tool arguments are refused", () =>
    parseScipIndex({
      metadata: {
        projectRoot: "file:///r",
        toolInfo: { name: "scip-go", arguments: "--index" },
      },
      documents: [],
    }),
  );
  TestValidator.error("a non-string tool argument is refused", () =>
    parseScipIndex({
      metadata: {
        projectRoot: "file:///r",
        toolInfo: { name: "scip-go", arguments: [1] },
      },
      documents: [],
    }),
  );
  TestValidator.error("non-array diagnostic tags are refused", () =>
    parseScipIndex(
      withDocument({
        relativePath: "a.go",
        diagnostics: [{ message: "finding", tags: "Deprecated" }],
      }),
    ),
  );
  TestValidator.error("an unknown numeric diagnostic tag is refused", () =>
    parseScipIndex(
      withDocument({
        relativePath: "a.go",
        diagnostics: [{ message: "finding", tags: [99] }],
      }),
    ),
  );

  TestValidator.equals(
    "an optional tool info block is kept",
    parseScipIndex({
      metadata: { projectRoot: "file:///r", toolInfo: { name: "scip-go", version: "1" } },
      documents: [],
    }).metadata.toolInfo,
    { name: "scip-go", version: "1" },
  );
}

function assertMapping(): void {
  const adapted = adaptScipIndex({
    index: parseScipIndex(rawIndex()),
    root: "/r",
    provider: "scip-go",
    languages: ["go"],
    languageOf: () => "go",
  });

  TestValidator.equals(
    "declarations become nodes",
    adapted.nodes.map((node) => node.name).sort(),
    ["Serve", "Server", "helper"],
  );
  TestValidator.equals(
    "the document is in the manifest",
    adapted.files,
    ["main.go"],
  );

  const id = (name: string): string =>
    adapted.nodes.find((node) => node.name === name)!.id;

  TestValidator.predicate(
    "a reference inside a definition is attributed to it",
    adapted.edges.some(
      (edge) =>
        edge.kind === "references" &&
        edge.from === id("Serve") &&
        edge.to === id("helper"),
    ),
  );
  TestValidator.predicate(
    "a common adapter retains a read-labelled occurrence only as a reference",
    adapted.edges.some(
      (edge) =>
        edge.kind === "references" &&
        edge.from === id("Serve") &&
        edge.to === id("Server"),
    ),
  );

  TestValidator.predicate(
    "an unproven read-role promotion is reported",
    adapted.warnings.some((warning) => warning.includes("read role")),
  );
  TestValidator.predicate(
    "an enclosing symbol becomes containment",
    adapted.edges.some(
      (edge) =>
        edge.kind === "contains" &&
        edge.from === id("Server") &&
        edge.to === id("Serve"),
    ),
  );
  TestValidator.predicate(
    "spans are one-based",
    adapted.nodes.every(
      (node) => node.evidence === undefined || node.evidence.startLine >= 1,
    ),
  );

  // The refusal that matters: nothing in a SCIP index says this reference was
  // an invocation, so no `calls` edge is invented for it.
  TestValidator.predicate(
    "no edge family outside SCIP's proof is published",
    adapted.edges.every((edge) => adaptScipIndex.EDGE_KINDS.includes(edge.kind)),
  );
  TestValidator.predicate(
    "calls are never inferred",
    !adapted.edges.some((edge) => edge.kind === "calls"),
  );

  const descriptorOnly = adaptScipIndex({
    index: parseScipIndex({
      metadata: { projectRoot: "file:///r" },
      documents: [
        {
          relativePath: "kind.go",
          symbols: [
            {
              symbol: "scip-go gomod example v1 `main`/Unknown#",
              displayName: "Unknown",
            },
          ],
        },
      ],
    }),
    root: "/r",
    provider: "scip-go",
    languages: ["go"],
    languageOf: () => "go",
  });
  TestValidator.predicate(
    "a descriptor-only type stays generic and reports the derivation",
    descriptorOnly.nodes[0]?.kind === "type" &&
      descriptorOnly.warnings.some((warning) =>
        warning.includes("derived from generic SCIP descriptor"),
      ),
  );

  // A range is an offset in code units, and which code unit is the document's
  // to declare. Graph columns are UTF-16, so a UTF-8 indexer disagrees on every
  // line holding a non-ASCII character — silently, and only there.
  const utf8 = adaptScipIndex({
    index: parseScipIndex(rawIndex({ positionEncoding: "UTF8CodeUnitOffsetFromLineStart" })),
    root: "/r",
    provider: "scip-go",
    languages: ["go"],
    languageOf: () => "go",
  });
  TestValidator.predicate(
    "a non-UTF-16 position encoding is reported rather than absorbed",
    utf8.warnings.some((warning) => warning.includes("UTF-16 code units")),
  );
  TestValidator.equals(
    "…and its facts are still published, because spans are evidence not identity",
    utf8.nodes.length,
    adapted.nodes.length,
  );
  // "Did not say" is not "said something wrong": an older indexer that omits
  // the field must not put a warning on every well-behaved ASCII project.
  TestValidator.equals(
    "an absent position encoding is not a warning",
    adapted.warnings.filter((warning) => warning.includes("UTF-16")),
    [],
  );
  TestValidator.equals(
    "an explicitly UTF-16 encoding is not a warning",
    adaptScipIndex({
      index: parseScipIndex(
        rawIndex({ positionEncoding: "UTF16CodeUnitOffsetFromLineStart" }),
      ),
      root: "/r",
      provider: "scip-go",
      languages: ["go"],
      languageOf: () => "go",
    }).warnings.filter((warning) => warning.includes("UTF-16")),
    [],
  );
  TestValidator.predicate(
    "an explicitly unspecified encoding reports its ambiguity",
    adaptScipIndex({
      index: parseScipIndex(
        rawIndex({ positionEncoding: "UnspecifiedPositionEncoding" }),
      ),
      root: "/r",
      provider: "scip-go",
      languages: ["go"],
      languageOf: () => "go",
    }).warnings.some((warning) => warning.includes("UTF-16")),
  );
  const metadataUtf8 = adaptScipIndex({
    index: parseScipIndex(
      rawIndex({}, { textDocumentEncoding: "UTF8" }),
    ),
    root: "/r",
    provider: "scip-go",
    languages: ["go"],
    languageOf: () => "go",
  });
  TestValidator.equals(
    "the source-text encoding is not mistaken for a position encoding",
    metadataUtf8.warnings.filter((warning) =>
      warning.includes("UTF-16 code units"),
    ),
    [],
  );

  assertLongLineScopeSelection();
  assertRelationshipsAndExternals();

  // A document in a language this session does not own is reported, not
  // silently absorbed.
  const foreign = adaptScipIndex({
    index: parseScipIndex(rawIndex({ language: "rust" })),
    root: "/r",
    provider: "scip-go",
    languages: ["go"],
    languageOf: () => "rust",
  });
  TestValidator.equals("a foreign document contributes nothing", foreign.nodes, []);
  TestValidator.predicate(
    "a foreign document is reported",
    foreign.warnings.some((warning) => warning.includes("does not own")),
  );
}

/** Nested ranges are ordered by positions, not an invented line width. */
function assertLongLineScopeSelection(): void {
  const base = "scip-go gomod example v1 `main`";
  const outer = `${base}/outer().`;
  const inner = `${base}/inner().`;
  const target = `${base}/target().`;
  const adapted = adaptScipIndex({
    index: parseScipIndex({
      metadata: { projectRoot: "file:///r" },
      documents: [
        {
          relativePath: "long.go",
          symbols: [
            { symbol: outer, displayName: "outer", kind: "Function" },
            { symbol: inner, displayName: "inner", kind: "Function" },
            { symbol: target, displayName: "target", kind: "Function" },
          ],
          occurrences: [
            {
              range: [0, 0, 1],
              symbol: outer,
              symbolRoles: 1,
              enclosingRange: [0, 0, 2, 0],
            },
            {
              range: [0, 2, 3],
              symbol: inner,
              symbolRoles: 1,
              enclosingRange: [0, 0, 1, 2_000_000],
            },
            { range: [1, 10, 16], symbol: target },
            { range: [3, 0, 6], symbol: target, symbolRoles: 1 },
          ],
        },
      ],
    }),
    root: "/r",
    provider: "scip-go",
    languages: ["go"],
    languageOf: () => "go",
  });
  const id = (name: string): string | undefined =>
    adapted.nodes.find((node) => node.name === name)?.id;
  TestValidator.predicate(
    "a range beyond one million columns still selects the innermost owner",
    adapted.edges.some(
      (edge) =>
        edge.kind === "references" &&
        edge.from === id("inner") &&
        edge.to === id("target"),
    ) &&
      !adapted.edges.some(
        (edge) =>
          edge.kind === "references" &&
          edge.from === id("outer") &&
          edge.to === id("target"),
      ),
  );
}

/** Forward declarations win the declaration slot regardless of file order. */
function assertForwardDefinitionOrdering(): void {
  const symbol = "scip-clang . example . `api`/run().";
  const adapted = adaptScipIndex({
    index: parseScipIndex({
      metadata: { projectRoot: "file:///r" },
      documents: [
        {
          // The implementation deliberately precedes its header in the index.
          relativePath: "src/api.c",
          symbols: [{ symbol, displayName: "run", kind: "Function" }],
          occurrences: [
            { range: [10, 2, 5], symbol, symbolRoles: 0x1 },
            // A malformed duplicate must not replace the first implementation.
            { range: [20, 2, 5], symbol, symbolRoles: 0x1 },
          ],
        },
        {
          relativePath: "include/api.h",
          occurrences: [
            { range: [1, 0, 3], symbol, symbolRoles: 0x40 },
            // Multiple prototypes keep the first declaration span.
            { range: [2, 0, 3], symbol, symbolRoles: 0x40 },
          ],
        },
      ],
    }),
    root: "/r",
    provider: "scip-clang",
    languages: ["c"],
    languageOf: () => "c",
  });
  const node = adapted.nodes[0];
  TestValidator.equals(
    "a later header still supplies evidence and the source supplies implementation",
    [
      node?.evidence?.file,
      node?.evidence?.startLine,
      node?.implementation?.file,
      node?.implementation?.startLine,
    ],
    ["include/api.h", 2, "src/api.c", 11],
  );

  const ordinary = adaptScipIndex({
    index: parseScipIndex({
      metadata: { projectRoot: "file:///r" },
      documents: [
        {
          relativePath: "ordinary.c",
          symbols: [{ symbol, displayName: "run", kind: "Function" }],
          occurrences: [
            { range: [3, 0, 3], symbol, symbolRoles: 0x1 },
            { range: [4, 0, 3], symbol, symbolRoles: 0x1 },
          ],
        },
      ],
    }),
    root: "/r",
    provider: "scip-clang",
    languages: ["c"],
    languageOf: () => "c",
  }).nodes[0];
  TestValidator.equals(
    "duplicate ordinary definitions do not invent a declaration/implementation pair",
    [ordinary?.evidence?.startLine, ordinary?.implementation],
    [4, undefined],
  );
}

/**
 * Typed relationships, dependency leaves, diagnostics, and the shapes the
 * adapter drops rather than approximates.
 */
function assertRelationshipsAndExternals(): void {
  const base = "scip-go gomod example v1 `main`";
  const iface = `${base}/Reader#`;
  const impl = `${base}/File#`;
  const typed = `${base}/Handle#`;
  const fallback = `${base}/Fallback#`;
  const external = "scip-go gomod dep v1 `dep`/Client#";
  const externalFallback =
    "scip-go gomod dep v1 `dep`/FallbackDependency#";
  const ownerless = "scip-go gomod dep v1 `dep`/Ownerless#";
  const future = "scip-go gomod dep v1 `dep`/Future#";
  const unnamed = "scip-go gomod dep v1 `dep`/";

  const adapted = adaptScipIndex({
    index: parseScipIndex({
      metadata: { projectRoot: "file:///r" },
      documents: [
        {
          relativePath: "main.go",
          symbols: [
            { symbol: iface, displayName: "Reader", kind: "Interface" },
            {
              symbol: impl,
              displayName: "File",
              kind: "Struct",
              // Both flags on one relationship are two separate claims; a
              // reader that treats the record as a tagged union drops the
              // second.
              relationships: [
                {
                  symbol: iface,
                  isImplementation: true,
                  isTypeDefinition: true,
                },
                // A relationship naming a symbol nothing declares has no
                // endpoint to land on, but its unsupported claims must still
                // be reported independently of endpoint resolution.
                {
                  symbol: "scip-go gomod example v1 `main`/Absent#",
                  isReference: true,
                  isImplementation: true,
                  isDefinition: true,
                },
                // A self-relationship is not an edge.
                { symbol: impl, isImplementation: true },
              ],
            },
            {
              symbol: typed,
              displayName: "Handle",
              kind: "TypeAlias",
              // An enclosing symbol nothing declares cannot own anything.
              enclosingSymbol: "scip-go gomod example v1 `main`/Missing#",
            },
            {
              symbol: fallback,
              kind: "Class",
              enclosingSymbol: "!!unreadable!!",
              relationships: [
                { symbol: "!!unreadable!!", isTypeDefinition: true },
              ],
            },
            // A kind this graph does not model publishes no node, and neither
            // does the type-parameter descriptor it falls back to.
            { symbol: `${base}/T#[X]`, displayName: "X", kind: "SomethingNewer" },
            // A symbol string the parser cannot read is reported, not guessed.
            { symbol: "!!unreadable!!", displayName: "junk", kind: "Function" },
            // A declaration with no name to show.
            { symbol: `${base}/anon.`, displayName: "", kind: "Variable" },
          ],
          occurrences: [
            {
              range: [0, 5, 11],
              symbol: iface,
              symbolRoles: 1,
              // A second scope, so attribution has to rank them: the innermost
              // enclosing definition owns a reference, and with one scope the
              // ranking never runs.
              enclosingRange: [0, 0, 30, 0],
            },
            {
              range: [1, 0, 4],
              symbol: impl,
              symbolRoles: 0x40 | 0x10 | 0x20,
            },
            {
              range: [2, 5, 9],
              symbol: impl,
              symbolRoles: 1,
              enclosingRange: [2, 0, 9, 1],
            },
            {
              range: [2, 4, 10],
              symbol: typed,
              symbolRoles: 1,
              // Starts on the same line its owner does, so containment has to
              // compare columns rather than stopping at the line number.
              enclosingRange: [2, 2, 2, 40],
            },
            // A dependency leaf, created at the moment a document names it and
            // taking that document's language. It sits on the line two scopes
            // open on, past the column where the narrower one ends — so
            // attribution has to compare columns rather than stopping once the
            // line numbers match, and lands on the enclosing method.
            { range: [2, 50, 56], symbol: external },
            // The same relationship again: one edge, not two.
            { range: [6, 50, 56], symbol: external },
            // An import role, carried together with a read. The mask holds
            // both bits, and calling this an access would lose the one fact
            // nothing else records: the module boundary was crossed here.
            { range: [3, 50, 56], symbol: typed, symbolRoles: 2 | 8 },
            // A future role may change how this occurrence is classified. It
            // is reported and dropped rather than guessed to be a reference.
            { range: [4, 20, 26], symbol: future, symbolRoles: 0x80 },
            // A reference with no enclosing definition has nothing to
            // attribute it to.
            { range: [20, 0, 4], symbol: iface },
            // A write access is an access, not a bare reference.
            { range: [5, 2, 8], symbol: iface, symbolRoles: 4 },
            // An occurrence naming a symbol nothing declares is dropped.
            { range: [6, 0, 4], symbol: `${base}/Nowhere#` },
            // …and one this parser cannot read.
            { range: [7, 0, 4], symbol: "!!unreadable!!" },
            // A *definition* occurrence whose symbol is unreadable: there is no
            // declaration to attach the span to, and inventing one would put a
            // node in the graph named after a string nobody could parse.
            { range: [8, 0, 4], symbol: "!!unreadable!!", symbolRoles: 1 },
            // A multi-line definition that takes its display name from the
            // parsed symbol rather than SymbolInformation.
            { range: [9, 0, 10, 4], symbol: fallback, symbolRoles: 1 },
            // A dependency with no explicit display name takes the semantic
            // name from its symbol string when first referenced.
            { range: [9, 6, 12], symbol: externalFallback },
            // A referenced external with neither an explicit nor parsed name
            // remains absent rather than publishing an empty graph handle.
            { range: [10, 6, 12], symbol: unnamed },
            // An occurrence-level diagnostic has a range, and it is used.
            // Pinning it to 1:1 would send a reader to the top of the file for
            // a problem twelve lines down.
            {
              range: [11, 6, 10],
              symbol: iface,
              diagnostics: [{ severity: "Warning", message: "shadowed here" }],
            },
            // Outside every declared enclosing range, so it has a target but
            // no owner from which a graph edge could start.
            { range: [31, 0, 4], symbol: ownerless },
          ],
          diagnostics: [
            // Document-level: no range of its own, so the file's first
            // position is the honest answer — the file is what it is about.
            { severity: "Error", code: "E1", message: "broken" },
            { severity: "Warning", message: "suspicious" },
            { severity: "Information", message: "noted" },
            { severity: "Hint", message: "consider" },
            // An unspecified severity is kept without one rather than
            // defaulted to error.
            { message: "unattributed", source: "vet" },
          ],
        },
        // A file the indexer read and found nothing in — an empty source, or
        // one holding only comments. It belongs in the manifest, because the
        // index did read it, and it declares nothing.
        { relativePath: "empty.go" },
      ],
      externalSymbols: [
        // Already declared internally and therefore not a dependency leaf.
        { symbol: iface, displayName: "Reader", kind: "Interface" },
        // An external identity that cannot be parsed is ignored.
        { symbol: "!!unreadable!!", displayName: "junk" },
        { symbol: external, displayName: "Client", kind: "Class" },
        { symbol: externalFallback, kind: "Class" },
        { symbol: ownerless, displayName: "Ownerless", kind: "Class" },
        { symbol: future, displayName: "Future", kind: "Class" },
        // A dependency leaf nothing ever references is never materialized.
        { symbol: "scip-go gomod dep v1 `dep`/Unused#", displayName: "Unused" },
        // …and one with no name to show cannot be.
        { symbol: unnamed, displayName: "" },
      ],
    }),
    root: "/r",
    provider: "scip-go",
    languages: ["go"],
    languageOf: () => "go",
  });

  const named = (name: string): string | undefined =>
    adapted.nodes.find((node) => node.name === name)?.id;

  TestValidator.equals(
    "only declarations this graph models become nodes",
    adapted.nodes.map((node) => node.name).sort(),
    [
      "Client",
      "Fallback",
      "FallbackDependency",
      "File",
      "Handle",
      "Ownerless",
      "Reader",
    ],
  );
  TestValidator.predicate(
    "a dependency leaf is external and fileless",
    adapted.nodes.some(
      (node) => node.name === "Client" && node.external && node.file === "",
    ),
  );
  TestValidator.predicate(
    "an unreferenced dependency leaf is never materialized",
    !adapted.nodes.some(
      (node) => node.name === "Unused" || node.name === "Future",
    ),
  );
  TestValidator.predicate(
    "an unreadable symbol is reported",
    adapted.warnings.some((warning) => warning.includes("cannot name")),
  );
  // A file the index read and found nothing in is still a file it read.
  TestValidator.predicate(
    "a declaration-free document stays in the manifest",
    adapted.files.includes("empty.go"),
  );

  const edge = (kind: string, from: string, to: string): boolean =>
    adapted.edges.some(
      (candidate) =>
        candidate.kind === kind &&
        candidate.from === named(from) &&
        candidate.to === named(to),
    );
  TestValidator.predicate(
    "an implementation relationship is not promoted without language proof",
    !edge("implements", "File", "Reader") &&
      adapted.warnings.some((warning) =>
        warning.includes("implementation relationship"),
      ),
  );
  const fileNode = adapted.nodes.find((node) => node.name === "File");
  TestValidator.equals(
    "a forward declaration and definition share one node with two spans",
    [
      fileNode?.evidence?.startLine,
      fileNode?.implementation?.startLine,
    ],
    [2, 3],
  );
  TestValidator.predicate(
    "generated and test roles are reported until language enrichment maps them",
    adapted.warnings.some((warning) => warning.includes("generated role")) &&
      adapted.warnings.some((warning) => warning.includes("test role")),
  );
  TestValidator.predicate(
    "relationship aliases and unknown occurrence roles are reported, not guessed",
    adapted.warnings.some((warning) =>
      warning.includes("reference relationship"),
    ) &&
      adapted.warnings.some((warning) =>
        warning.includes("definition relationship"),
      ) &&
      adapted.warnings.some((warning) =>
        warning.includes("unknown role bits 0x80"),
      ),
  );
  TestValidator.predicate(
    "…and a type-definition flag on the same record is its own claim",
    edge("type_ref", "File", "Reader"),
  );
  TestValidator.predicate(
    "a write-labelled occurrence remains a common reference",
    edge("references", "File", "Reader"),
  );
  TestValidator.predicate(
    "a reference to a dependency leaf lands on it",
    edge("references", "File", "Client"),
  );
  TestValidator.predicate(
    "an import-labelled occurrence remains a common reference",
    edge("references", "File", "Handle"),
  );
  TestValidator.predicate(
    "unproven import and access promotions are both omitted and reported",
    !edge("imports", "File", "Handle") &&
      !edge("accesses", "File", "Handle") &&
      adapted.warnings.some((warning) => warning.includes("import role")) &&
      adapted.warnings.some((warning) => warning.includes("read role")),
  );
  TestValidator.predicate(
    "a relationship to an undeclared symbol emits nothing",
    !adapted.edges.some((candidate) => candidate.to === undefined) &&
      !adapted.edges.some((candidate) => candidate.from === named("Fallback")),
  );
  TestValidator.predicate(
    "an external target outside every scope is materialized without an edge",
    named("Ownerless") !== undefined &&
      !adapted.edges.some((candidate) => candidate.to === named("Ownerless")),
  );
  TestValidator.predicate(
    "an unowned enclosing symbol emits no containment",
    !adapted.edges.some((candidate) => candidate.kind === "contains"),
  );

  TestValidator.equals(
    "every diagnostic severity the index states is carried",
    adapted.diagnostics.map((diagnostic) => diagnostic.severity),
    ["error", "warning", "info", "hint", undefined, "warning"],
  );
  TestValidator.equals(
    "a diagnostic without a code falls back to its source",
    adapted.diagnostics[4]?.code,
    "vet",
  );
  // A document-level finding is about the file; an occurrence-level one is
  // about a place in it, and reporting the second at 1:1 would look like an
  // answer while sending the reader to the wrong line.
  TestValidator.equals(
    "a document-level diagnostic is reported at the file's first position",
    [adapted.diagnostics[0]?.line, adapted.diagnostics[0]?.column],
    [1, 1],
  );
  TestValidator.equals(
    "an occurrence-level diagnostic keeps the position it was given",
    [adapted.diagnostics[5]?.line, adapted.diagnostics[5]?.column],
    [12, 7],
  );

  // One name referenced twice in a scope is two occurrences of one
  // relationship; a strict slice may not carry it twice.
  TestValidator.equals(
    "repeated occurrences of one relationship publish one edge",
    adapted.edges.filter(
      (candidate) =>
        candidate.kind === "references" &&
        candidate.from === named("File") &&
        candidate.to === named("Client"),
    ).length,
    1,
  );

  // A `local N` counter is scoped to its document. Two files each holding a
  // `local 4` describe two unrelated declarations, and filing both under one
  // key made the second overwrite the first — after which every reference in
  // the earlier file resolved to a declaration in the later one.
  const locals = adaptScipIndex({
    index: parseScipIndex({
      metadata: { projectRoot: "file:///r" },
      documents: [
        {
          relativePath: "a.go",
          symbols: [{ symbol: "local 4", displayName: "alpha", kind: "Variable" }],
          occurrences: [
            {
              range: [0, 0, 5],
              symbol: "local 4",
              symbolRoles: 1,
              enclosingRange: [0, 0, 9, 0],
            },
          ],
        },
        {
          relativePath: "b.go",
          symbols: [{ symbol: "local 4", displayName: "beta", kind: "Variable" }],
          occurrences: [
            {
              range: [0, 0, 4],
              symbol: "local 4",
              symbolRoles: 1,
              enclosingRange: [0, 0, 9, 0],
            },
          ],
        },
      ],
    }),
    root: "/r",
    provider: "scip-go",
    languages: ["go"],
    languageOf: () => "go",
  });
  TestValidator.equals(
    "one local counter per document is two declarations",
    locals.nodes.map((entry) => `${entry.name}@${entry.file}`).sort(),
    ["alpha@a.go", "beta@b.go"],
  );
  TestValidator.equals(
    "…and neither is reported as a redefinition of the other",
    locals.warnings,
    [],
  );

  // One symbol cannot be defined in two documents; keeping the first is
  // reported rather than silently overwriting.
  const duplicated = adaptScipIndex({
    index: parseScipIndex({
      metadata: { projectRoot: "file:///r" },
      documents: ["a.go", "b.go"].map((relativePath) => ({
        relativePath,
        symbols: [{ symbol: iface, displayName: "Reader", kind: "Interface" }],
      })),
    }),
    root: "/r",
    provider: "scip-go",
    languages: ["go"],
    languageOf: () => "go",
  });
  TestValidator.equals(
    "a symbol defined twice keeps one node",
    duplicated.nodes.length,
    1,
  );
  TestValidator.predicate(
    "…and says which definition it kept",
    duplicated.warnings.some((warning) => warning.includes("keeping the first")),
  );
}

function rawIndex(
  document: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
): unknown {
  const server = "scip-go gomod example v1 `main`/Server#";
  const serve = "scip-go gomod example v1 `main`/Server#Serve().";
  const helper = "scip-go gomod example v1 `main`/helper().";
  return {
    metadata: {
      projectRoot: "file:///r",
      toolInfo: { name: "scip-go", version: "0.1.0" },
      ...metadata,
    },
    documents: [
      {
        language: "Go",
        relativePath: "main.go",
        ...document,
        symbols: [
          { symbol: server, displayName: "Server", kind: "Struct" },
          {
            symbol: serve,
            displayName: "Serve",
            kind: "Method",
            enclosingSymbol: server,
          },
          { symbol: helper, displayName: "helper", kind: "Function" },
        ],
        occurrences: [
          { range: [0, 5, 11], symbol: server, symbolRoles: 1 },
          {
            range: [2, 10, 15],
            symbol: serve,
            symbolRoles: 1,
            enclosingRange: [2, 0, 8, 1],
          },
          { range: [4, 2, 8], symbol: helper },
          { range: [5, 2, 8], symbol: server, symbolRoles: 8 },
          { range: [9, 0, 6], symbol: helper, symbolRoles: 1 },
        ],
      },
    ],
  };
}

function withDocument(document: Record<string, unknown>): unknown {
  return { metadata: { projectRoot: "file:///r" }, documents: [document] };
}

function withOccurrence(occurrence: Record<string, unknown>): unknown {
  return withDocument({ relativePath: "a.go", occurrences: [occurrence] });
}

function withSymbol(symbol: Record<string, unknown>): unknown {
  return withDocument({ relativePath: "a.go", symbols: [symbol] });
}
