import { IScipIndex } from "./IScipIndex";

/**
 * Validate one decoded SCIP index before any of it is believed.
 *
 * Every field this graph reads is checked here, and a violation rejects the
 * whole index rather than skipping the offending record. A partially accepted
 * index is the failure mode worth avoiding: the missing facts are silent, so a
 * consumer cannot distinguish "this symbol has no references" from "the record
 * carrying them was malformed and dropped", and the audit riding on the result
 * asserts the first. The one producer-compatibility exception is an optional
 * enclosing range. Stock rust-analyzer has written the referenced definition's
 * body on a reference, and scip-java has written a definition scope that misses
 * its own name. Such a range is validated structurally and then omitted with a
 * warning when it cannot enclose the occurrence. The occurrence itself remains
 * valid, while the adapter gets no scope from which it could invent containment.
 */
export function parseScipIndex(
  value: unknown,
  label = "scip",
  warnings: string[] = [],
): IScipIndex {
  const index = objectOf(value, label);
  const metadata = objectOf(index.metadata, `${label}.metadata`);
  const documents = arrayOf(index.documents, `${label}.documents`);
  const toolInfo = fieldOf(
    metadata,
    "toolInfo",
    "tool_info",
    `${label}.metadata`,
  );
  const projectRoot = fieldOf(
    metadata,
    "projectRoot",
    "project_root",
    `${label}.metadata`,
  );
  const textDocumentEncoding = fieldOf(
    metadata,
    "textDocumentEncoding",
    "text_document_encoding",
    `${label}.metadata`,
  );
  const externalSymbols = fieldOf(
    index,
    "externalSymbols",
    "external_symbols",
    label,
  );
  const parsedExternalSymbols =
    externalSymbols === undefined
      ? undefined
      : arrayOf(
          externalSymbols,
          `${label}.externalSymbols`,
        ).map((symbol, at) =>
          symbolInformationOf(symbol, `${label}.externalSymbols[${at}]`),
        );
  const rangeWarnings: string[] = [];
  const parsedDocuments = documents.map((document, index) =>
    documentOf(document, `${label}.documents[${index}]`, rangeWarnings),
  );
  const foldedDocuments = foldDocumentsByPath(parsedDocuments, warnings);
  warnings.push(...[...new Set(rangeWarnings)].sort(compareText));
  return {
    metadata: {
      ...optionalProtocolVersion(
        metadata.version,
        `${label}.metadata.version`,
      ),
      ...(toolInfo === undefined
        ? {}
        : { toolInfo: toolInfoOf(toolInfo, `${label}.metadata.toolInfo`) }),
      projectRoot: stringOf(
        projectRoot,
        `${label}.metadata.projectRoot`,
      ),
      ...optionalEnumName(
        textDocumentEncoding,
        `${label}.metadata.textDocumentEncoding`,
        "textDocumentEncoding",
        TEXT_ENCODINGS,
      ),
    },
    documents: foldedDocuments,
    ...(parsedExternalSymbols === undefined
      ? {}
      : {
          // The protocol calls this a repeated field and does not promise
          // uniqueness. Normalize it before the adapter's symbol map can make
          // producer order choose the last duplicate.
          externalSymbols: mergeSymbols(
            "the external symbol table",
            parsedExternalSymbols,
          ),
        }),
  };
}

function documentOf(
  value: unknown,
  label: string,
  warnings: string[],
): IScipIndex.IDocument {
  const document = objectOf(value, label);
  const rawPath = stringOf(
    fieldOf(document, "relativePath", "relative_path", label),
    `${label}.relativePath`,
  );
  const positionEncoding = fieldOf(
    document,
    "positionEncoding",
    "position_encoding",
    label,
  );
  if (rawPath === "") {
    throw new Error(`scip: ${label}.relativePath is empty`);
  }
  // A document path is workspace-relative by definition. An absolute or
  // parent-escaping path would attribute facts to a file outside the program
  // this index claims to describe.
  if (/^[a-zA-Z]:|^[\\/]/.test(rawPath)) {
    throw new Error(
      `scip: ${label}.relativePath must be workspace-relative: ${rawPath}`,
    );
  }
  if (rawPath.split(/[\\/]/).includes("..")) {
    throw new Error(
      `scip: ${label}.relativePath escapes the workspace: ${rawPath}`,
    );
  }
  const relativePath = rawPath.split("\\").join("/");
  if (
    relativePath
      .split("/")
      .some((segment) => segment === "" || segment === ".")
  ) {
    throw new Error(
      `scip: ${label}.relativePath must be normalized: ${rawPath}`,
    );
  }
  return {
    ...optionalString(document.language, `${label}.language`, "language"),
    relativePath,
    ...(document.occurrences === undefined
      ? {}
      : {
          occurrences: arrayOf(
            document.occurrences,
            `${label}.occurrences`,
          ).map((occurrence, at) =>
            occurrenceOf(
              occurrence,
              `${label}.occurrences[${at}]`,
              relativePath,
              warnings,
            ),
          ),
        }),
    ...(document.symbols === undefined
      ? {}
      : {
          symbols: arrayOf(document.symbols, `${label}.symbols`).map(
            (symbol, at) =>
              symbolInformationOf(symbol, `${label}.symbols[${at}]`),
          ),
        }),
    // The one field that lets a snapshot say which bytes its facts came from.
    // Most indexers omit it; when present it is the only honest source of a
    // checker digest, because everything else this client can read is a later
    // instant.
    ...optionalString(document.text, `${label}.text`, "text"),
    ...optionalEnumName(
      positionEncoding,
      `${label}.positionEncoding`,
      "positionEncoding",
      POSITION_ENCODINGS,
    ),
    ...(document.diagnostics === undefined
      ? {}
      : {
          diagnostics: arrayOf(
            document.diagnostics,
            `${label}.diagnostics`,
          ).map((diagnostic, at) =>
            diagnosticOf(diagnostic, `${label}.diagnostics[${at}]`),
          ),
        }),
  };
}

function occurrenceOf(
  value: unknown,
  label: string,
  relativePath: string,
  warnings: string[],
): IScipIndex.IOccurrence {
  const occurrence = objectOf(value, label);
  const range = occurrenceRangeOf(occurrence, label, false)!;
  const enclosingRange = occurrenceRangeOf(occurrence, label, true);
  const symbolRoles = fieldOf(
    occurrence,
    "symbolRoles",
    "symbol_roles",
    label,
  );
  const syntaxKind = fieldOf(
    occurrence,
    "syntaxKind",
    "syntax_kind",
    label,
  );
  const parsedSymbolRoles =
    symbolRoles === undefined
      ? undefined
      : roleMaskOf(symbolRoles, `${label}.symbolRoles`);
  const parsedSymbol = optionalString(
    occurrence.symbol,
    `${label}.symbol`,
    "symbol",
  );
  const invalidEnclosingRange =
    enclosingRange !== undefined && !rangeContains(enclosingRange, range);
  if (invalidEnclosingRange) {
    warnings.push(
      `scip: ${relativePath} occurrence ${
        parsedSymbol.symbol === undefined
          ? "without a symbol"
          : JSON.stringify(parsedSymbol.symbol)
      } at ${JSON.stringify(range)} carries an enclosing range that does not enclose it; the optional scope was omitted`,
    );
  }
  return {
    range,
    ...parsedSymbol,
    ...(parsedSymbolRoles === undefined
      ? {}
      : { symbolRoles: parsedSymbolRoles }),
    ...optionalEnumName(
      syntaxKind,
      `${label}.syntaxKind`,
      "syntaxKind",
      SYNTAX_KINDS,
    ),
    ...(enclosingRange === undefined || invalidEnclosingRange
      ? {}
      : { enclosingRange }),
    // Kept, because this is where a diagnostic gets a position. Dropping it
    // left the adapter with nothing but document-level findings, every one of
    // which it then had to report at the top of the file.
    ...(occurrence.diagnostics === undefined
      ? {}
      : {
          diagnostics: arrayOf(
            occurrence.diagnostics,
            `${label}.diagnostics`,
          ).map((diagnostic, at) =>
            diagnosticOf(diagnostic, `${label}.diagnostics[${at}]`),
          ),
        }),
  };
}

/** Prefer SCIP's typed range while validating any legacy twin it accompanies. */
function occurrenceRangeOf(
  occurrence: Record<string, unknown>,
  label: string,
  enclosing: boolean,
): number[] | undefined {
  const legacyKey = enclosing ? "enclosingRange" : "range";
  const legacySnakeKey = enclosing ? "enclosing_range" : "range";
  const singleKey = enclosing
    ? "singleLineEnclosingRange"
    : "singleLineRange";
  const singleSnakeKey = enclosing
    ? "single_line_enclosing_range"
    : "single_line_range";
  const multiKey = enclosing
    ? "multiLineEnclosingRange"
    : "multiLineRange";
  const multiSnakeKey = enclosing
    ? "multi_line_enclosing_range"
    : "multi_line_range";
  const directSingle = fieldOf(
    occurrence,
    singleKey,
    singleSnakeKey,
    label,
  );
  const directMulti = fieldOf(occurrence, multiKey, multiSnakeKey, label);
  const wrapperKey = enclosing ? "TypedEnclosingRange" : "TypedRange";
  const wrapperValue = occurrence[wrapperKey];
  const wrapper =
    wrapperValue === undefined || wrapperValue === null
      ? undefined
      : objectOf(wrapperValue, `${label}.${wrapperKey}`);
  const wrapperSingleKey = enclosing
    ? "SingleLineEnclosingRange"
    : "SingleLineRange";
  const wrapperMultiKey = enclosing
    ? "MultiLineEnclosingRange"
    : "MultiLineRange";
  const wrapperSingle = wrapper?.[wrapperSingleKey];
  const wrapperMulti = wrapper?.[wrapperMultiKey];
  if (
    wrapper !== undefined &&
    wrapperSingle === undefined &&
    wrapperMulti === undefined
  ) {
    throw new Error(
      `scip: ${label}.${wrapperKey} has no typed-range member`,
    );
  }
  const hasDirect = directSingle !== undefined || directMulti !== undefined;
  const hasWrapped = wrapperSingle !== undefined || wrapperMulti !== undefined;
  if (hasDirect && hasWrapped) {
    throw new Error(
      `scip: ${label} sets both protobuf JSON and Go-struct JSON typed ranges`,
    );
  }
  const single = directSingle ?? wrapperSingle;
  const multi = directMulti ?? wrapperMulti;
  if (single !== undefined && multi !== undefined) {
    throw new Error(
      `scip: ${label} sets both ${singleKey} and ${multiKey} in one typed-range choice`,
    );
  }
  const typed =
    single !== undefined
      ? singleLineRangeOf(single, `${label}.${singleKey}`)
      : multi !== undefined
        ? multiLineRangeOf(multi, `${label}.${multiKey}`)
        : undefined;
  const legacyValue = fieldOf(
    occurrence,
    legacyKey,
    legacySnakeKey,
    label,
  );
  const legacy =
    legacyValue === undefined
      ? undefined
      : rangeOf(legacyValue, `${label}.${legacyKey}`);
  if (typed !== undefined && legacy !== undefined && !sameRange(typed, legacy)) {
    throw new Error(
      `scip: ${label}.${legacyKey} contradicts its typed range`,
    );
  }
  if (typed !== undefined) return typed;
  if (legacy !== undefined || enclosing) return legacy;
  throw new Error(`scip: ${label} has no source range`);
}

function singleLineRangeOf(value: unknown, label: string): number[] {
  const range = objectOf(value, label);
  // Both protobuf JSON and the decoder's Go `encoding/json` output omit
  // zero-valued proto3 scalars. Absence is therefore the encoded value zero,
  // not a missing coordinate.
  return rangeOf(
    [
      proto3ScalarFieldOf(range, "line", "line", label),
      proto3ScalarFieldOf(
        range,
        "startCharacter",
        "start_character",
        label,
      ),
      proto3ScalarFieldOf(range, "endCharacter", "end_character", label),
    ],
    label,
  );
}

function multiLineRangeOf(value: unknown, label: string): number[] {
  const range = objectOf(value, label);
  return rangeOf(
    [
      proto3ScalarFieldOf(range, "startLine", "start_line", label),
      proto3ScalarFieldOf(
        range,
        "startCharacter",
        "start_character",
        label,
      ),
      proto3ScalarFieldOf(range, "endLine", "end_line", label),
      proto3ScalarFieldOf(range, "endCharacter", "end_character", label),
    ],
    label,
  );
}

function sameRange(left: readonly number[], right: readonly number[]): boolean {
  const expanded = (range: readonly number[]): readonly number[] =>
    range.length === 3
      ? [range[0]!, range[1]!, range[0]!, range[2]!]
      : range;
  const a = expanded(left);
  const b = expanded(right);
  return a.every((entry, index) => entry === b[index]);
}

function rangeContains(
  outer: readonly number[],
  inner: readonly number[],
): boolean {
  const start = (range: readonly number[]): readonly [number, number] => [
    range[0]!,
    range[1]!,
  ];
  const end = (range: readonly number[]): readonly [number, number] =>
    range.length === 3
      ? [range[0]!, range[2]!]
      : [range[2]!, range[3]!];
  return (
    comparePosition(start(outer), start(inner)) <= 0 &&
    comparePosition(end(outer), end(inner)) >= 0
  );
}

function comparePosition(
  left: readonly [number, number],
  right: readonly [number, number],
): number {
  return left[0] !== right[0] ? left[0] - right[0] : left[1] - right[1];
}

function symbolInformationOf(
  value: unknown,
  label: string,
): IScipIndex.ISymbolInformation {
  const symbol = objectOf(value, label);
  const displayName = fieldOf(
    symbol,
    "displayName",
    "display_name",
    label,
  );
  const enclosingSymbol = fieldOf(
    symbol,
    "enclosingSymbol",
    "enclosing_symbol",
    label,
  );
  return {
    symbol: nonEmptyString(symbol.symbol, `${label}.symbol`),
    ...optionalString(displayName, `${label}.displayName`, "displayName"),
    ...optionalEnumName(
      symbol.kind,
      `${label}.kind`,
      "kind",
      SYMBOL_KINDS,
    ),
    ...(symbol.documentation === undefined
      ? {}
      : {
          documentation: arrayOf(
            symbol.documentation,
            `${label}.documentation`,
          ).map((line, at) => stringOf(line, `${label}.documentation[${at}]`)),
        }),
    ...(symbol.relationships === undefined
      ? {}
      : {
          relationships: arrayOf(
            symbol.relationships,
            `${label}.relationships`,
          ).map((relationship, at) =>
            relationshipOf(relationship, `${label}.relationships[${at}]`),
          ),
        }),
    ...optionalString(
      enclosingSymbol,
      `${label}.enclosingSymbol`,
      "enclosingSymbol",
    ),
  };
}

function relationshipOf(
  value: unknown,
  label: string,
): IScipIndex.IRelationship {
  const relationship = objectOf(value, label);
  const isReference = fieldOf(
    relationship,
    "isReference",
    "is_reference",
    label,
  );
  const isImplementation = fieldOf(
    relationship,
    "isImplementation",
    "is_implementation",
    label,
  );
  const isTypeDefinition = fieldOf(
    relationship,
    "isTypeDefinition",
    "is_type_definition",
    label,
  );
  const isDefinition = fieldOf(
    relationship,
    "isDefinition",
    "is_definition",
    label,
  );
  return {
    symbol: nonEmptyString(relationship.symbol, `${label}.symbol`),
    ...flag(isReference, `${label}.isReference`, "isReference"),
    ...flag(
      isImplementation,
      `${label}.isImplementation`,
      "isImplementation",
    ),
    ...flag(
      isTypeDefinition,
      `${label}.isTypeDefinition`,
      "isTypeDefinition",
    ),
    ...flag(isDefinition, `${label}.isDefinition`, "isDefinition"),
  };
}

function diagnosticOf(value: unknown, label: string): IScipIndex.IDiagnostic {
  const diagnostic = objectOf(value, label);
  return {
    message: stringOf(diagnostic.message, `${label}.message`),
    ...optionalEnumName(
      diagnostic.severity,
      `${label}.severity`,
      "severity",
      SEVERITIES,
    ),
    ...optionalString(diagnostic.code, `${label}.code`, "code"),
    ...optionalString(diagnostic.source, `${label}.source`, "source"),
    ...(diagnostic.tags === undefined
      ? {}
      : {
          tags: arrayOf(diagnostic.tags, `${label}.tags`).map((tag, at) =>
            enumNameOf(
              tag,
              `${label}.tags[${String(at)}]`,
              DIAGNOSTIC_TAGS,
            ),
          ),
        }),
  };
}

function toolInfoOf(value: unknown, label: string): IScipIndex.IToolInfo {
  const info = objectOf(value, label);
  return {
    name: stringOf(info.name, `${label}.name`),
    ...optionalString(info.version, `${label}.version`, "version"),
    ...(info.arguments === undefined
      ? {}
      : {
          arguments: arrayOf(info.arguments, `${label}.arguments`).map(
            (argument, at) =>
              stringOf(argument, `${label}.arguments[${String(at)}]`),
          ),
        }),
  };
}

/**
 * A zero-based SCIP range, as three or four non-negative integers.
 *
 * The three-element form is the single-line shorthand
 * `[line, startCharacter, endCharacter]`; the four-element form spans lines. A
 * range whose end precedes its start is rejected rather than normalized: it
 * names no text, and silently swapping the ends would invent a span the
 * indexer never reported.
 */
function rangeOf(value: unknown, label: string): number[] {
  const range = arrayOf(value, label);
  if (range.length !== 3 && range.length !== 4) {
    throw new Error(
      `scip: ${label} must have three or four elements, not ${String(range.length)}`,
    );
  }
  const numbers = range.map((entry, index) => {
    if (
      typeof entry !== "number" ||
      !Number.isSafeInteger(entry) ||
      entry < 0 ||
      entry > 0x7fffffff
    ) {
      throw new Error(
        `scip: ${label}[${String(index)}] must be a non-negative int32`,
      );
    }
    return entry;
  });
  const [startLine, startCharacter] = numbers as [number, number, ...number[]];
  const endLine = numbers.length === 3 ? startLine : numbers[2]!;
  const endCharacter = numbers.length === 3 ? numbers[2]! : numbers[3]!;
  if (
    endLine < startLine ||
    (endLine === startLine && endCharacter < startCharacter)
  ) {
    throw new Error(`scip: ${label} ends before it starts`);
  }
  return numbers;
}

function roleMaskOf(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0x7fffffff
  ) {
    throw new Error(`scip: ${label} must be a non-negative int32 bitmask`);
  }
  return value;
}

function flag<K extends string>(
  value: unknown,
  label: string,
  key: K,
): Partial<Record<K, boolean>> {
  if (value === undefined) return {};
  if (typeof value !== "boolean") {
    throw new Error(`scip: ${label} must be a boolean`);
  }
  return { [key]: value } as Record<K, boolean>;
}

function optionalString<K extends string>(
  value: unknown,
  label: string,
  key: K,
): Partial<Record<K, string>> {
  if (value === undefined) return {};
  return { [key]: stringOf(value, label) } as Record<K, string>;
}

function optionalEnumName<K extends string>(
  value: unknown,
  label: string,
  key: K,
  names: Readonly<Record<number, string>>,
): Partial<Record<K, string>> {
  if (value === undefined) return {};
  return { [key]: enumNameOf(value, label, names) } as Record<K, string>;
}

/**
 * Preserve a protocol version that this decoder does not know yet.
 *
 * Protobuf keeps unknown enum numbers for forward compatibility. Most SCIP
 * enums affect graph meaning and therefore remain closed below, but protocol
 * version is metadata that graph does not interpret. Refusing a non-negative
 * int32 here would reject an otherwise usable index merely because its
 * producer is ahead of the decoder (and scip-php 0.1.0 already writes `1`
 * despite bundling a schema that only names `0`). Negative values cannot be
 * represented by graph's public protocol provenance contract. ProtoJSON enum
 * strings remain enum identifiers: accepting a decimal string here would lose
 * whether the producer wrote a name or a number before provenance sees it.
 */
function optionalProtocolVersion(
  value: unknown,
  label: string,
): Partial<Record<"version", string>> {
  if (value === undefined) return {};
  if (typeof value === "string") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      throw new Error(
        `scip: ${label} must be a protobuf enum name or non-negative int32 number`,
      );
    }
    return { version: value };
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0x7fffffff
  ) {
    throw new Error(
      `scip: ${label} must be a protobuf enum name or non-negative int32 number`,
    );
  }
  return { version: PROTOCOL_VERSIONS[value] ?? String(value) };
}

function enumNameOf(
  value: unknown,
  label: string,
  names: Readonly<Record<number, string>>,
): string {
  if (typeof value === "string") {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return value;
    throw new Error(
      `scip: ${label} must be a protobuf enum name or known number`,
    );
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    names[value] === undefined
  ) {
    throw new Error(
      `scip: ${label} must be a protobuf enum name or known number`,
    );
  }
  return names[value];
}

/**
 * Read one protobuf JSON field from either spelling, without accepting an
 * ambiguous record that supplies both and relies on consumer precedence.
 */
function fieldOf(
  object: Record<string, unknown>,
  camel: string,
  snake: string,
  label: string,
): unknown {
  if (camel === snake) return object[camel];
  const camelValue = object[camel];
  const snakeValue = object[snake];
  if (camelValue !== undefined && snakeValue !== undefined) {
    throw new Error(
      `scip: ${label} sets both ${camel} and ${snake}`,
    );
  }
  return camelValue !== undefined ? camelValue : snakeValue;
}

/** Apply proto3's scalar default only when JSON omitted the field. */
function proto3ScalarFieldOf(
  object: Record<string, unknown>,
  camel: string,
  snake: string,
  label: string,
): unknown {
  const value = fieldOf(object, camel, snake, label);
  return value === undefined ? 0 : value;
}

function nonEmptyString(value: unknown, label: string): string {
  const text = stringOf(value, label);
  if (text === "") throw new Error(`scip: ${label} is empty`);
  return text;
}

function stringOf(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`scip: ${label} must be a string`);
  }
  return value;
}

function arrayOf(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`scip: ${label} must be an array`);
  }
  return value;
}

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`scip: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

const PROTOCOL_VERSIONS: Readonly<Record<number, string>> = {
  0: "UnspecifiedProtocolVersion",
};

const TEXT_ENCODINGS: Readonly<Record<number, string>> = {
  0: "UnspecifiedTextEncoding",
  1: "UTF8",
  2: "UTF16",
};

const POSITION_ENCODINGS: Readonly<Record<number, string>> = {
  0: "UnspecifiedPositionEncoding",
  1: "UTF8CodeUnitOffsetFromLineStart",
  2: "UTF16CodeUnitOffsetFromLineStart",
  3: "UTF32CodeUnitOffsetFromLineStart",
};

const SYNTAX_KINDS: Readonly<Record<number, string>> = {
  0: "UnspecifiedSyntaxKind",
  1: "Comment",
  2: "PunctuationDelimiter",
  3: "PunctuationBracket",
  4: "Keyword",
  5: "IdentifierOperator",
  6: "Identifier",
  7: "IdentifierBuiltin",
  8: "IdentifierNull",
  9: "IdentifierConstant",
  10: "IdentifierMutableGlobal",
  11: "IdentifierParameter",
  12: "IdentifierLocal",
  13: "IdentifierShadowed",
  14: "IdentifierNamespace",
  15: "IdentifierFunction",
  16: "IdentifierFunctionDefinition",
  17: "IdentifierMacro",
  18: "IdentifierMacroDefinition",
  19: "IdentifierType",
  20: "IdentifierBuiltinType",
  21: "IdentifierAttribute",
  22: "RegexEscape",
  23: "RegexRepeated",
  24: "RegexWildcard",
  25: "RegexDelimiter",
  26: "RegexJoin",
  27: "StringLiteral",
  28: "StringLiteralEscape",
  29: "StringLiteralSpecial",
  30: "StringLiteralKey",
  31: "CharacterLiteral",
  32: "NumericLiteral",
  33: "BooleanLiteral",
  34: "Tag",
  35: "TagAttribute",
  36: "TagDelimiter",
};

const SEVERITIES: Readonly<Record<number, string>> = {
  0: "UnspecifiedSeverity",
  1: "Error",
  2: "Warning",
  3: "Information",
  4: "Hint",
};

const DIAGNOSTIC_TAGS: Readonly<Record<number, string>> = {
  0: "UnspecifiedDiagnosticTag",
  1: "Unnecessary",
  2: "Deprecated",
};

const SYMBOL_KINDS: Readonly<Record<number, string>> = {
  0: "UnspecifiedKind",
  1: "Array",
  2: "Assertion",
  3: "AssociatedType",
  4: "Attribute",
  5: "Axiom",
  6: "Boolean",
  7: "Class",
  8: "Constant",
  9: "Constructor",
  10: "DataFamily",
  11: "Enum",
  12: "EnumMember",
  13: "Event",
  14: "Fact",
  15: "Field",
  16: "File",
  17: "Function",
  18: "Getter",
  19: "Grammar",
  20: "Instance",
  21: "Interface",
  22: "Key",
  23: "Lang",
  24: "Lemma",
  25: "Macro",
  26: "Method",
  27: "MethodReceiver",
  28: "Message",
  29: "Module",
  30: "Namespace",
  31: "Null",
  32: "Number",
  33: "Object",
  34: "Operator",
  35: "Package",
  36: "PackageObject",
  37: "Parameter",
  38: "ParameterLabel",
  39: "Pattern",
  40: "Predicate",
  41: "Property",
  42: "Protocol",
  43: "Quasiquoter",
  44: "SelfParameter",
  45: "Setter",
  46: "Signature",
  47: "Subscript",
  48: "String",
  49: "Struct",
  50: "Tactic",
  51: "Theorem",
  52: "ThisParameter",
  53: "Trait",
  54: "Type",
  55: "TypeAlias",
  56: "TypeClass",
  57: "TypeFamily",
  58: "TypeParameter",
  59: "Union",
  60: "Value",
  61: "Variable",
  62: "Contract",
  63: "Error",
  64: "Library",
  65: "Modifier",
  66: "AbstractMethod",
  67: "MethodSpecification",
  68: "ProtocolMethod",
  69: "PureVirtualMethod",
  70: "TraitMethod",
  71: "TypeClassMethod",
  72: "Accessor",
  73: "Delegate",
  74: "MethodAlias",
  75: "SingletonClass",
  76: "SingletonMethod",
  77: "StaticDataMember",
  78: "StaticEvent",
  79: "StaticField",
  80: "StaticMethod",
  81: "StaticProperty",
  82: "StaticVariable",
  84: "Extension",
  85: "Mixin",
  86: "Concept",
};

/**
 * One document per path, folding the several a multi-TU language emits.
 *
 * The SCIP schema calls `relative_path` a "Unique path to the text document",
 * and for a language whose file belongs to exactly one compilation that holds.
 * C and C++ are not such languages: a source compiled into several translation
 * units is indexed once per unit, and scip-clang emits a document for each.
 * A vendored helper compiled into two binaries is the ordinary case. Neither
 * the schema nor scip-clang says how a consumer should read that, so this
 * decides.
 *
 * Refusing was the previous answer, on the ground that two records cannot both
 * be one file's complete occurrence list and that merging would double every
 * shared reference. The second half is what exact deduplication answers: two
 * translation units reporting the same symbol at the same range with the same
 * roles have stated one fact twice, not two facts. The union of what they say
 * is the file's occurrence list; the alternative was that no C project with a
 * shared source could be indexed at all, which is nearly all of them.
 *
 * Where they genuinely disagree — one range, two different symbols, which
 * conditional compilation can produce — the union keeps both and says so.
 * Publishing both is truthful, since the file really does mean two things in
 * two units, but a reader must not discover that by accident.
 */
function foldDocumentsByPath(
  documents: readonly IScipIndex.IDocument[],
  warnings: string[],
): IScipIndex.IDocument[] {
  const byPath = new Map<string, IScipIndex.IDocument[]>();
  const foldWarnings: string[] = [];
  for (const document of documents) {
    const units = byPath.get(document.relativePath) ?? [];
    units.push(document);
    byPath.set(document.relativePath, units);
  }
  const merged = [...byPath].map(([relativePath, units]) => {
    const document =
      units.length === 1 ? units[0]! : mergeDocuments(units);
    if (units.length === 1) return document;
    foldWarnings.push(
      `scip: ${relativePath} was indexed as ${String(units.length)} translation units; their occurrences are folded into one document`,
    );
    foldWarnings.push(...translationUnitAmbiguityWarnings(document));
    return document;
  });
  warnings.push(...[...new Set(foldWarnings)].sort(compareText));
  // Sorted, because an indexer's document order is its own business and at
  // least one producer's varies between runs of an unchanged project.
  // rust-analyzer walks crates in parallel, and two indexes of one source have
  // published different normalized snapshot bytes purely from the order they
  // came back in — a difference the graph then reported as the project having
  // moved. Ordering here makes every downstream digest a function of the facts
  // rather than of the schedule that produced them.
  return merged.sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        /* c8 ignore next -- `byPath` has one value per unique path. */
        : 0,
  );
}

function mergeDocuments(
  documents: readonly IScipIndex.IDocument[],
): IScipIndex.IDocument {
  const first = documents[0]!;
  // Text is per-file, not per-unit: two units compile the same bytes. A
  // disagreement means they did not, which is a moved source rather than a
  // merge to attempt.
  let text: string | undefined;
  let language: string | undefined;
  let positionEncoding: string | undefined;
  for (const document of documents) {
    if (
      text !== undefined &&
      document.text !== undefined &&
      text !== document.text
    ) {
      throw new Error(
        `scip: two translation units disagree about the text of ${first.relativePath}`,
      );
    }
    text ??= document.text;
    language = compatibleDocumentScalar(
      first.relativePath,
      "language",
      language,
      document.language,
    );
    positionEncoding = compatibleDocumentScalar(
      first.relativePath,
      "position encoding",
      positionEncoding,
      document.positionEncoding,
    );
  }
  const occurrences = mergeOccurrences(
    ...documents.map((document) => document.occurrences ?? []),
  );
  const symbols = mergeSymbols(
    first.relativePath,
    ...documents.map((document) => document.symbols ?? []),
  );
  const diagnostics = mergeExact(
    ...documents.map((document) => document.diagnostics ?? []),
  );
  return {
    ...(language === undefined ? {} : { language }),
    relativePath: first.relativePath,
    ...(documents.every((document) => document.occurrences === undefined)
      ? {}
      : { occurrences }),
    ...(documents.every((document) => document.symbols === undefined)
      ? {}
      : { symbols }),
    ...(text === undefined ? {} : { text }),
    ...(positionEncoding === undefined ? {} : { positionEncoding }),
    // Preserve presence as well as contents. An omitted repeated field and an
    // explicitly empty one encode the same proto value, but retaining the wire
    // distinction here costs nothing and prevents the fold from erasing data.
    ...(documents.every((document) => document.diagnostics === undefined)
      ? {}
      : { diagnostics }),
  };
}

/**
 * Merge occurrence facts without treating their coordinates as their meaning.
 *
 * The old fold keyed only by range and symbol. A token that is a definition in
 * one conditional compilation and a reference in another therefore lost one
 * reading, as did a scope or diagnostic carried by only one unit. Exact
 * semantic twins fold; different roles, syntax, or scopes survive. Diagnostics
 * are unioned on an otherwise identical occurrence so the common graph fact is
 * not doubled merely because one unit attached another finding.
 */
function mergeOccurrences(
  ...groups: readonly (readonly IScipIndex.IOccurrence[])[]
): IScipIndex.IOccurrence[] {
  const byCore = new Map<string, IScipIndex.IOccurrence[]>();
  for (const group of groups) {
    for (const occurrence of group) {
      const core = occurrenceCoreKey(occurrence);
      const readings = byCore.get(core) ?? [];
      readings.push(occurrence);
      byCore.set(core, readings);
    }
  }
  return [...byCore.values()].map((readings) => {
    const existing = readings[0]!;
    const symbolRoles = readings.find(
      (occurrence) => occurrence.symbolRoles !== undefined,
    )?.symbolRoles;
    const diagnostics = mergeExact(
      ...readings.map((occurrence) => occurrence.diagnostics ?? []),
    );
    return {
      range: existing.range,
      ...(existing.symbol === undefined ? {} : { symbol: existing.symbol }),
      ...(symbolRoles === undefined ? {} : { symbolRoles }),
      ...(existing.syntaxKind === undefined
        ? {}
        : { syntaxKind: existing.syntaxKind }),
      ...(existing.enclosingRange === undefined
        ? {}
        : { enclosingRange: existing.enclosingRange }),
      ...(readings.every((occurrence) => occurrence.diagnostics === undefined)
        ? {}
        : { diagnostics }),
    };
  }).sort(compareOccurrence);
}

/**
 * Name translation-unit ambiguity from the completed union, not from an
 * intermediate pairwise fold. Three or more units can arrive in any order;
 * deriving these warnings once makes their text a function of the final facts
 * rather than of which partial union happened first.
 */
function translationUnitAmbiguityWarnings(
  document: IScipIndex.IDocument,
): string[] {
  const warnings: string[] = [];
  const claims = new Map<
    string,
    { range: string; symbol: string; cores: Set<string> }
  >();
  const symbolsByRange = new Map<string, Set<string>>();
  for (const occurrence of document.occurrences ?? []) {
    const range = rangeKey(occurrence.range);
    const symbol = occurrence.symbol ?? "";
    const core = occurrenceCoreKey(occurrence);
    const claimKey = JSON.stringify([range, symbol]);
    const claim = claims.get(claimKey) ?? {
      range,
      symbol,
      cores: new Set<string>(),
    };
    claim.cores.add(core);
    claims.set(claimKey, claim);
    const rangeSymbols = symbolsByRange.get(range) ?? new Set<string>();
    rangeSymbols.add(symbol);
    symbolsByRange.set(range, rangeSymbols);
  }
  for (const symbols of symbolsByRange.values()) {
    if (symbols.size <= 1) continue;
    warnings.push(
      `scip: ${document.relativePath} resolves one range to ${[...symbols]
        .sort(compareText)
        .map((symbol) => JSON.stringify(symbol))
        .join(", ")} across translation units; every reading is published`,
    );
  }
  for (const claim of claims.values()) {
    if (claim.cores.size <= 1) continue;
    warnings.push(
      `scip: ${document.relativePath} reports ${JSON.stringify(claim.symbol)} at range ${claim.range} with different roles, syntax, or scopes across translation units; every reading is published`,
    );
  }
  return warnings.sort(compareText);
}

function occurrenceCoreKey(occurrence: IScipIndex.IOccurrence): string {
  return JSON.stringify([
    occurrence.range,
    occurrence.symbol ?? null,
    occurrence.symbolRoles ?? 0,
    occurrence.syntaxKind ?? null,
    occurrence.enclosingRange ?? null,
  ]);
}

/**
 * Merge one symbol's additive evidence while refusing irreconcilable scalars.
 *
 * Relationships are a fact union. Documentation contributes producer-local
 * order constraints to one Markdown sequence, while a display name, kind, or
 * enclosing symbol has one public slot. The documentation constraints merge
 * deterministically unless they form a cycle; scalar disagreements and cyclic
 * orders are refused rather than silently dropping or reordering evidence.
 */
function mergeSymbols(
  file: string,
  ...groups: readonly (readonly IScipIndex.ISymbolInformation[])[]
): IScipIndex.ISymbolInformation[] {
  const bySymbol = new Map<string, IScipIndex.ISymbolInformation[]>();
  for (const group of groups) {
    for (const symbol of group) {
      const records = bySymbol.get(symbol.symbol) ?? [];
      records.push(symbol);
      bySymbol.set(symbol.symbol, records);
    }
  }
  return [...bySymbol.values()].map((records) => {
    const first = records[0]!;
    let displayName: string | undefined;
    let kind: string | undefined;
    let enclosingSymbol: string | undefined;
    for (const record of records) {
      displayName = compatibleSymbolScalar(
        file,
        first.symbol,
        "displayName",
        displayName,
        record.displayName,
      );
      kind = compatibleSymbolScalar(
        file,
        first.symbol,
        "kind",
        kind,
        record.kind,
      );
      enclosingSymbol = compatibleSymbolScalar(
        file,
        first.symbol,
        "enclosingSymbol",
        enclosingSymbol,
        record.enclosingSymbol,
      );
    }
    const documentation = compatibleSymbolDocumentation(
      file,
      first.symbol,
      records.map((record) => record.documentation),
    );
    const relationships = mergeExact(
      ...records.map((record) => record.relationships ?? []),
    );
    return {
      symbol: first.symbol,
      ...(displayName === undefined ? {} : { displayName }),
      ...(kind === undefined ? {} : { kind }),
      ...(documentation === undefined ? {} : { documentation }),
      ...(records.every((record) => record.relationships === undefined)
        ? {}
        : { relationships }),
      ...(enclosingSymbol === undefined ? {} : { enclosingSymbol }),
    };
  }).sort((leftSymbol, rightSymbol) =>
    compareText(leftSymbol.symbol, rightSymbol.symbol),
  );
}

function compatibleSymbolDocumentation(
  file: string,
  symbol: string,
  sequences: readonly (readonly string[] | undefined)[],
): string[] | undefined {
  if (sequences.every((sequence) => sequence === undefined)) return undefined;

  interface IToken {
    key: string;
    line: string;
    sortKey: string;
  }
  const nodes = new Map<string, IToken>();
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, number>();
  for (const sequence of sequences) {
    if (sequence === undefined) continue;
    const ordinals = new Map<string, number>();
    let previous: string | undefined;
    for (const line of sequence) {
      const ordinal = ordinals.get(line) ?? 0;
      ordinals.set(line, ordinal + 1);
      const key = JSON.stringify([line, ordinal]);
      if (!nodes.has(key)) {
        nodes.set(key, {
          key,
          line,
          sortKey: JSON.stringify([
            line,
            String(ordinal).padStart(16, "0"),
          ]),
        });
        outgoing.set(key, new Set());
        incoming.set(key, 0);
      }
      if (previous !== undefined) {
        const targets = outgoing.get(previous)!;
        if (!targets.has(key)) {
          targets.add(key);
          incoming.set(key, incoming.get(key)! + 1);
        }
      }
      previous = key;
    }
  }

  const compareToken = (left: IToken, right: IToken): number =>
    compareText(left.sortKey, right.sortKey);
  const available = [...nodes.values()]
    .filter((token) => incoming.get(token.key) === 0)
    .sort(compareToken);
  const documentation: string[] = [];
  while (available.length !== 0) {
    const token = available.shift()!;
    documentation.push(token.line);
    for (const target of [...outgoing.get(token.key)!].sort((left, right) =>
      compareToken(nodes.get(left)!, nodes.get(right)!),
    )) {
      const remaining = incoming.get(target)! - 1;
      incoming.set(target, remaining);
      if (remaining === 0) {
        available.push(nodes.get(target)!);
        available.sort(compareToken);
      }
    }
  }
  if (documentation.length !== nodes.size) {
    throw new Error(
      `scip: translation units disagree about documentation order for ${JSON.stringify(symbol)} in ${file}`,
    );
  }
  return documentation;
}

function compatibleDocumentScalar(
  file: string,
  field: string,
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  if (left !== undefined && right !== undefined && left !== right) {
    throw new Error(
      `scip: two translation units disagree about the ${field} of ${file}`,
    );
  }
  return left ?? right;
}

function compatibleSymbolScalar(
  file: string,
  symbol: string,
  field: "displayName" | "kind" | "enclosingSymbol",
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  if (left !== undefined && right !== undefined && left !== right) {
    throw new Error(
      `scip: two translation units disagree about ${field} for ${symbol} in ${file}`,
    );
  }
  return left ?? right;
}

/** Exact, stable union for already-validated records. */
function mergeExact<T>(...groups: readonly (readonly T[])[]): T[] {
  const merged = new Map<string, T>();
  for (const group of groups) {
    for (const value of group) {
      const key = JSON.stringify(value);
      if (!merged.has(key)) merged.set(key, value);
    }
  }
  return [...merged].sort(([leftKey], [rightKey]) =>
    compareText(leftKey, rightKey),
  ).map(([, value]) => value);
}

/** A range's exact identity, without normalization. */
function rangeKey(range: readonly number[]): string {
  return range.join(",");
}

function compareOccurrence(
  left: IScipIndex.IOccurrence,
  right: IScipIndex.IOccurrence,
): number {
  const length = Math.min(left.range.length, right.range.length);
  for (let index = 0; index < length; index++) {
    const difference = left.range[index]! - right.range[index]!;
    if (difference !== 0) return difference;
  }
  if (left.range.length !== right.range.length)
    return left.range.length - right.range.length;
  return compareText(occurrenceCoreKey(left), occurrenceCoreKey(right));
}

function compareText(left: string, right: string): number {
  /* c8 ignore next 2 -- callers compare distinct set or map identities. */
  return left < right ? -1 : left > right ? 1 : 0;
}
