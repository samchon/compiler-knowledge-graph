/**
 * The SCIP index as `scip print --json` writes it.
 *
 * SCIP is a whole-workspace semantic artifact that a language's own indexer
 * produces once, so consuming it is strictly better than re-asking a language
 * server the same questions file by file. What it is *not* is a graph: the
 * common schema records where a symbol is defined, referenced, read, and
 * written, and which symbols it implements or is typed by — and stops. It has
 * no universal way to say that a reference is an invocation rather than a
 * function value, that a type reference is a construction, or what a decorator
 * means, because those distinctions are not the same fact in every language.
 *
 * So this contract is deliberately narrow. Everything it can prove is mapped;
 * everything else is left to a typed, per-language enrichment, and nothing is
 * inferred from source punctuation. A `(` after a name is not evidence of a
 * call — it is evidence of a `(`.
 *
 * The parser normalizes both protobuf JSON (lowerCamelCase with named enums)
 * and the Go-struct JSON emitted by `scip print --json` (snake_case with
 * numeric enums) into this one lowerCamelCase representation. Known enums use
 * their names. An unknown protocol-version number is retained as its decimal
 * string because protobuf preserves unknown enum numbers for forward
 * compatibility and graph does not interpret that metadata field.
 */
export interface IScipIndex {
  metadata: IScipIndex.IMetadata;
  documents: IScipIndex.IDocument[];

  /**
   * Symbols defined outside the indexed workspace but referenced by it.
   *
   * They become dependency-boundary leaves. The graph names them and does not
   * walk into them, exactly as it treats any other external symbol.
   */
  externalSymbols?: IScipIndex.ISymbolInformation[];
}

export namespace IScipIndex {
  export interface IMetadata {
    version?: string;
    toolInfo?: IToolInfo;

    /**
     * The workspace root the document paths are relative to, as a `file://`
     * URI.
     *
     * Validated against the project the session was opened for. An index whose
     * root is a different directory describes a different program, and merging
     * it would attribute another checkout's facts to this one.
     */
    projectRoot: string;

    textDocumentEncoding?: string;
  }

  export interface IToolInfo {
    name: string;
    version?: string;
    arguments?: string[];
  }

  export interface IDocument {
    /** The indexer's own language name, such as `Go` or `TypeScript`. */
    language?: string;

    /** Workspace-relative path, always forward-slashed. */
    relativePath: string;

    occurrences?: IOccurrence[];
    symbols?: ISymbolInformation[];
    diagnostics?: IDiagnostic[];
    text?: string;
    positionEncoding?: string;
  }

  /**
   * One symbol appearance in a document.
   *
   * `range` is `[startLine, startCharacter, endLine, endCharacter]`, or the
   * three-element `[startLine, startCharacter, endCharacter]` when the
   * occurrence does not span lines. Both are zero-based; the graph's spans are
   * one-based, and the conversion happens once, here.
   */
  export interface IOccurrence {
    range: number[];

    /** Absent for diagnostics or syntax highlighting with no symbol. */
    symbol?: string;

    /** A bitmask of {@link SymbolRole} values, absent when it is zero. */
    symbolRoles?: number;

    syntaxKind?: string;
    enclosingRange?: number[];
    diagnostics?: IDiagnostic[];
  }

  export interface ISymbolInformation {
    symbol: string;
    displayName?: string;
    documentation?: string[];
    kind?: string;
    relationships?: IRelationship[];
    enclosingSymbol?: string;
  }

  /**
   * A typed relationship between two symbols.
   *
   * More than one flag can be set on one relationship, and each is a separate
   * claim; a reader that treats the record as a tagged union silently drops
   * whichever claim it checked second.
   */
  export interface IRelationship {
    symbol: string;
    isReference?: boolean;
    isImplementation?: boolean;
    isTypeDefinition?: boolean;
    isDefinition?: boolean;
  }

  export interface IDiagnostic {
    severity?: string;
    code?: string;
    message: string;
    source?: string;
    tags?: string[];
  }

  /**
   * The bitmask values SCIP defines for {@link IOccurrence.symbolRoles}.
   *
   * `ForwardDefinition` marks a declaration that is not the implementation.
   * The adapter retains that occurrence as the node's declaration evidence and
   * a later `Definition` occurrence as its implementation span; it never mints
   * a second node for the same symbol.
   */
  export enum SymbolRole {
    Definition = 0x1,
    Import = 0x2,
    WriteAccess = 0x4,
    ReadAccess = 0x8,
    Generated = 0x10,
    Test = 0x20,
    ForwardDefinition = 0x40,
  }
}
