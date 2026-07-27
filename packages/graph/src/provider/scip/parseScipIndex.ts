import { IScipIndex } from "./IScipIndex";

/**
 * Validate one decoded SCIP index before any of it is believed.
 *
 * Every field this graph reads is checked here, and a violation rejects the
 * whole index rather than skipping the offending record. A partially accepted
 * index is the failure mode worth avoiding: the missing facts are silent, so a
 * consumer cannot distinguish "this symbol has no references" from "the record
 * carrying them was malformed and dropped", and the audit riding on the result
 * asserts the first. The one producer-compatibility exception is an enclosing
 * range on a non-definition occurrence: graph never consumes that field, and
 * stock rust-analyzer writes the referenced definition's body there. Such a
 * range is validated structurally and then omitted when it cannot enclose the
 * occurrence; definition scopes remain strict.
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
  return {
    metadata: {
      ...optionalEnumName(
        metadata.version,
        `${label}.metadata.version`,
        "version",
        PROTOCOL_VERSIONS,
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
    documents: foldDocumentsByPath(
      documents.map((document, index) =>
        documentOf(document, `${label}.documents[${index}]`),
      ),
      warnings,
    ),
    ...(externalSymbols === undefined
      ? {}
      : {
          externalSymbols: arrayOf(
            externalSymbols,
            `${label}.externalSymbols`,
          ).map((symbol, at) =>
            symbolInformationOf(symbol, `${label}.externalSymbols[${at}]`),
          ),
        }),
  };
}

function documentOf(value: unknown, label: string): IScipIndex.IDocument {
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
            occurrenceOf(occurrence, `${label}.occurrences[${at}]`),
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

function occurrenceOf(value: unknown, label: string): IScipIndex.IOccurrence {
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
  const invalidEnclosingRange =
    enclosingRange !== undefined && !rangeContains(enclosingRange, range);
  if (
    invalidEnclosingRange &&
    ((parsedSymbolRoles ?? 0) & IScipIndex.SymbolRole.Definition) !== 0
  ) {
    throw new Error(`scip: ${label}.enclosingRange does not enclose its range`);
  }
  return {
    range,
    ...optionalString(occurrence.symbol, `${label}.symbol`, "symbol"),
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
  return rangeOf(
    [
      range.line,
      fieldOf(range, "startCharacter", "start_character", label),
      fieldOf(range, "endCharacter", "end_character", label),
    ],
    label,
  );
}

function multiLineRangeOf(value: unknown, label: string): number[] {
  const range = objectOf(value, label);
  return rangeOf(
    [
      fieldOf(range, "startLine", "start_line", label),
      fieldOf(range, "startCharacter", "start_character", label),
      fieldOf(range, "endLine", "end_line", label),
      fieldOf(range, "endCharacter", "end_character", label),
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

function enumNameOf(
  value: unknown,
  label: string,
  names: Readonly<Record<number, string>>,
): string {
  if (typeof value === "string") return value;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    names[value] === undefined
  ) {
    throw new Error(`scip: ${label} must be a known enum name or number`);
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
  const byPath = new Map<string, IScipIndex.IDocument>();
  const folded = new Map<string, number>();
  for (const document of documents) {
    const existing = byPath.get(document.relativePath);
    if (existing === undefined) {
      byPath.set(document.relativePath, document);
      continue;
    }
    folded.set(
      document.relativePath,
      (folded.get(document.relativePath) ?? 1) + 1,
    );
    byPath.set(document.relativePath, mergeDocuments(existing, document, warnings));
  }
  for (const [relativePath, count] of folded) {
    warnings.push(
      `scip: ${relativePath} was indexed as ${String(count)} translation units; their occurrences are folded into one document`,
    );
  }
  // Sorted, because an indexer's document order is its own business and at
  // least one producer's varies between runs of an unchanged project.
  // rust-analyzer walks crates in parallel, and two indexes of one source have
  // published different normalized snapshot bytes purely from the order they
  // came back in — a difference the graph then reported as the project having
  // moved. Ordering here makes every downstream digest a function of the facts
  // rather than of the schedule that produced them.
  return [...byPath.values()].sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0,
  );
}

function mergeDocuments(
  left: IScipIndex.IDocument,
  right: IScipIndex.IDocument,
  warnings: string[],
): IScipIndex.IDocument {
  // Text is per-file, not per-unit: two units compile the same bytes. A
  // disagreement means they did not, which is a moved source rather than a
  // merge to attempt.
  if (
    left.text !== undefined &&
    right.text !== undefined &&
    left.text !== right.text
  ) {
    throw new Error(
      `scip: two translation units disagree about the text of ${left.relativePath}`,
    );
  }
  const occurrences = [...(left.occurrences ?? [])];
  const claimed = new Map<string, string>();
  for (const occurrence of left.occurrences ?? [])
    claimed.set(rangeKey(occurrence.range), occurrence.symbol ?? "");
  for (const occurrence of right.occurrences ?? []) {
    const key = rangeKey(occurrence.range);
    const already = claimed.get(key);
    const symbol = occurrence.symbol ?? "";
    if (already === undefined) {
      claimed.set(key, symbol);
      occurrences.push(occurrence);
      continue;
    }
    if (already === symbol) continue;
    // Same range, different symbol. Conditional compilation makes this real
    // rather than impossible, so both are kept and the ambiguity is named.
    warnings.push(
      `scip: ${left.relativePath} resolves one range to both ${already} and ${symbol} across translation units; both are published`,
    );
    occurrences.push(occurrence);
  }
  const symbols = [...(left.symbols ?? [])];
  const seenSymbols = new Set(symbols.map((entry) => entry.symbol));
  for (const symbol of right.symbols ?? []) {
    if (seenSymbols.has(symbol.symbol)) continue;
    seenSymbols.add(symbol.symbol);
    symbols.push(symbol);
  }
  return {
    ...left,
    ...(right.text !== undefined && left.text === undefined
      ? { text: right.text }
      : {}),
    // Absent stays absent: a document that carried no occurrence list is not
    // the same claim as one carrying an empty list, and the adapter downstream
    // reads that difference.
    ...(occurrences.length === 0 ? {} : { occurrences }),
    ...(symbols.length === 0 ? {} : { symbols }),
  };
}

/**
 * A range's identity, exact rather than normalized.
 *
 * Two units describing one token produce byte-identical ranges, so equality is
 * the right test; anything looser would fold a genuinely different span.
 */
function rangeKey(range: readonly number[]): string {
  return range.join(",");
}
