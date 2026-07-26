import path from "node:path";

import {
  ISamchonGraphDiagnostic,
  ISamchonGraphEdge,
  ISamchonGraphEvidence,
  ISamchonGraphNode,
} from "../../structures";
import { GraphEdgeKind, GraphLanguage } from "../../typings";
import { IGraphSemanticIdentity, semanticGraphNodeId } from "../semanticIdentity";
import { IScipIndex } from "./IScipIndex";
import { scipSymbol } from "./scipSymbol";

/**
 * The edge families a bare SCIP index can prove.
 *
 * Short on purpose. SCIP records where a symbol is defined, referenced, read,
 * and written, and which symbols it implements or is typed by. It does not
 * universally distinguish an invocation from a function value, a construction
 * from a type reference, or say what an annotation means — those are different
 * facts in different languages, and the schema has no common field for them.
 *
 * So `calls`, `instantiates`, `overrides`, `decorates`, and `tests` are absent
 * here and stay absent unless a language enrichment proves them. The
 * alternative — reading the source at the occurrence and looking for a `(` —
 * is not a weaker version of proving a call; it is a different thing wearing
 * its name, and it is wrong on every function value, every macro, and every
 * language whose call syntax is not juxtaposition with parentheses.
 *
 * Roles and implementation relationships are intentionally not promoted here.
 * They are fields in the interchange, but their producer semantics are not
 * uniform: stock Go labels every reference as a read (including writes, calls,
 * and imports), PHP labels every reference with role zero, and some producers
 * emit transitive implementation closure where others emit direct parents.
 * A language provider must opt into those mappings after proving its own
 * producer contract; the common adapter can prove only the reference itself.
 */
const SCIP_EDGE_KINDS: readonly GraphEdgeKind[] = [
  "contains",
  "references",
  "type_ref",
];

interface IScipAdaptation {
  nodes: ISamchonGraphNode[];
  edges: ISamchonGraphEdge[];
  diagnostics: ISamchonGraphDiagnostic[];
  warnings: string[];

  /** Every document path the index attributed facts to, project-relative. */
  files: string[];
}

interface IAdaptScipIndexProps {
  index: IScipIndex;
  root: string;

  /** Registry name, used only in warnings so a reader knows who to blame. */
  provider: string;

  /** The languages this session owns; a document outside them is a defect. */
  languages: readonly GraphLanguage[];

  /** Which file a document path belongs to, in the product's own vocabulary. */
  languageOf: (file: string) => GraphLanguage;
}

/**
 * Map one validated SCIP index onto a strict graph slice.
 *
 * Everything published here is something the index stated. A symbol whose kind
 * this graph does not model, a symbol string this parser cannot read, and an
 * occurrence whose enclosing definition is unknown are each dropped with a
 * warning rather than approximated, because a graph that is quietly wrong is
 * worse to reason about than one that is visibly incomplete.
 */
export function adaptScipIndex(
  props: adaptScipIndex.IProps,
): adaptScipIndex.IResult {
  const owned = new Set(props.languages);
  const nodes = new Map<string, ISamchonGraphNode>();
  const edges: ISamchonGraphEdge[] = [];
  const diagnostics: ISamchonGraphDiagnostic[] = [];
  const warnings: string[] = [];
  const unsupportedRoles = new Set<string>();
  const ownedDocuments = new Set<
    (typeof props.index.documents)[number]
  >();
  const files: string[] = [];
  let derivedKinds = 0;

  // Every definition in the index, so a reference in one document can resolve
  // to a declaration in another. Built before any edge is emitted: an endpoint
  // that does not exist yet is indistinguishable from one that never will.
  const definitions = new Map<string, IDefinition>();
  for (const document of props.index.documents) {
    const file = normalizeFile(document.relativePath);
    const language =
      languageFromScip(document.language) ?? props.languageOf(file);
    if (!owned.has(language)) {
      warnings.push(
        `${props.provider}: ignoring ${file}, whose ${language} facts this provider does not own`,
      );
      continue;
    }
    // A SCIP range is an offset in code units, and which code unit is the
    // document's to declare. The graph's columns follow the LSP convention of
    // UTF-16 code units, so an indexer that counts UTF-8 bytes disagrees with
    // it on every line holding a non-ASCII character — silently, and only
    // there. Spans are display evidence rather than identity, so this reports
    // rather than rejects; what it must not do is say nothing, because the
    // resulting column is wrong in exactly the cases nobody tests.
    const encoding = document.positionEncoding;
    if (encoding !== undefined && encoding !== UTF16_POSITION_ENCODING) {
      warnings.push(
        `${props.provider}: ${file} reports ${encoding} positions, but graph columns are UTF-16 code units; columns on lines with non-ASCII characters may be off`,
      );
    }
    ownedDocuments.add(document);
    files.push(file);
    for (const symbol of document.symbols ?? []) {
      const parsed = scipSymbol(symbol.symbol);
      if (parsed === undefined) {
        warnings.push(
          `${props.provider}: ${file} declares a symbol this index cannot name: ${symbol.symbol}`,
        );
        continue;
      }
      const statedKind = scipSymbol.nodeKind(symbol.kind, undefined);
      const kind = statedKind ?? scipSymbol.nodeKind(undefined, parsed.descriptor);
      if (kind === undefined) continue;
      if (statedKind === undefined) derivedKinds += 1;
      const displayName = symbol.displayName ?? parsed.displayName;
      if (displayName === "") continue;
      const id = semanticGraphNodeId(
        identityOf(parsed, language, kind, file),
        displayName,
      );
      const symbolKey = definitionKey(parsed, file);
      const definition = definitions.get(symbolKey);
      if (definition !== undefined) {
        warnings.push(
          `${props.provider}: ${parsed.key} is defined in both ${definition.file} and ${file}; keeping the first`,
        );
        continue;
      }
      // A semantic id is hash-derived, so retain a final collision defense.
      // Current v2 identities include the parsed symbol key and a local's
      // document generation; ordinary distinct definitions therefore cannot
      // reach it. If that invariant or the digest ever fails, publishing both
      // would duplicate an id and make `mergeGraphSlices` reject the whole
      // slice.
      const colliding = nodes.get(id);
      /* c8 ignore start -- an earlier definition with the same parsed key is
       * rejected above. Every remaining SCIP identity includes that key and,
       * for locals, its document generation, so reaching this guard requires a
       * SHA-256 collision rather than a constructible index fixture. */
      if (colliding !== undefined) {
        warnings.push(
          `${props.provider}: ${parsed.key} in ${file} derives the same identity as ${colliding.file}'s; keeping the first, because a graph cannot hold one id twice`,
        );
        continue;
      }
      /* c8 ignore stop */
      const node: ISamchonGraphNode = {
        id,
        kind,
        language,
        name: displayName,
        file,
        external: false,
      };
      nodes.set(id, node);
      definitions.set(symbolKey, {
        id,
        file,
        node,
        enclosingSymbol: symbol.enclosingSymbol,
        relationships: symbol.relationships ?? [],
      });
    }
  }

  // External symbols are dependency-boundary leaves: named endpoints the
  // workspace references but does not declare. They exist so a reference edge
  // has somewhere to land instead of dangling.
  //
  // Held back rather than materialized here, because a node needs a language
  // and this list does not carry one. Taking the session's first language
  // would be an answer for a single-language indexer and a coin toss for a
  // provider that owns C and C++ together — every external symbol in the
  // program attributed to whichever language the registry happened to list
  // first. The language a reference *appears in* is a fact the index does
  // state, so each external leaf is created when its first occurrence names
  // it, and inherits that document's language.
  //
  // A document-scoped symbol is never a candidate. `local 4` is a counter the
  // indexer resets per document, so outside the document that defines it the
  // string names nothing: two files each holding a `local 4` are unrelated
  // declarations, and there is no document to scope an external leaf to. A
  // producer that lists one here has told this graph less than it needs, and
  // materializing the leaf anyway would invent an endpoint the index never
  // proved — so the reference is dropped and the omission is reported.
  const pendingExternals = new Map<string, IScipIndex.ISymbolInformation>();
  for (const symbol of props.index.externalSymbols ?? []) {
    const parsed = scipSymbol(symbol.symbol);
    if (parsed === undefined || definitions.has(parsed.key)) continue;
    if (parsed.stability === "generation") continue;
    pendingExternals.set(parsed.key, symbol);
  }
  // Counted where a reference is actually lost, not where a symbol is listed:
  // a local that its own document declares resolves normally, and saying it had
  // no defining document would be false. The message says only what this walk
  // observed — the index did not resolve it — because a local can also go
  // unresolved through a dropped declaration above, and naming a cause this
  // counter cannot distinguish would be the same kind of falsehood.
  let unscopedLocalReferences = 0;

  const externalize = (
    key: string,
    language: GraphLanguage,
  ): IDefinition | undefined => {
    const symbol = pendingExternals.get(key);
    if (symbol === undefined) return undefined;
    const parsed = scipSymbol(key)!;
    const displayName = symbol.displayName ?? parsed.displayName;
    if (displayName === "") return undefined;
    const id = semanticGraphNodeId(
      identityOf(parsed, language, "external_symbol", ""),
      displayName,
    );
    pendingExternals.delete(key);
    const node: ISamchonGraphNode = {
      id,
      kind: "external_symbol",
      language,
      name: displayName,
      file: "",
      external: true,
    };
    nodes.set(id, node);
    const definition: IDefinition = { id, file: "", node, relationships: [] };
    definitions.set(key, definition);
    return definition;
  };

  // Forward declarations and implementations can live in different
  // documents, and document order has no semantic meaning. Collect every
  // forward-declaration span before visiting any ordinary definition so a
  // source file listed before its header cannot steal the declaration slot.
  const forwardDefinitions = new Set<string>();
  for (const document of props.index.documents) {
    const file = normalizeFile(document.relativePath);
    if (!ownedDocuments.has(document)) continue;
    for (const occurrence of document.occurrences ?? []) {
      if (!hasRole(occurrence, IScipIndex.SymbolRole.ForwardDefinition)) {
        continue;
      }
      const parsed = scipSymbol(occurrence.symbol ?? "");
      const definition =
        parsed === undefined ? undefined : resolve(definitions, parsed, file);
      if (definition === undefined) continue;
      forwardDefinitions.add(definition.id);
      definition.node.evidence ??= spanOf(file, occurrence.range);
    }
  }

  for (const document of props.index.documents) {
    const file = normalizeFile(document.relativePath);
    if (!ownedDocuments.has(document)) continue;
    const language =
      languageFromScip(document.language) ?? props.languageOf(file);
    const occurrences = document.occurrences ?? [];

    // A definition occurrence carries the span the declaration occupies, and
    // its `enclosingRange` bounds the whole declaration body. Both are
    // attached before references are attributed, because attribution asks
    // which enclosing range contains an occurrence.
    const scopes: IScope[] = [];
    for (const occurrence of occurrences) {
      if (!hasRole(occurrence, IScipIndex.SymbolRole.Definition)) continue;
      const parsed = scipSymbol(occurrence.symbol ?? "");
      const definition =
        parsed === undefined ? undefined : resolve(definitions, parsed, file);
      if (definition === undefined) continue;
      const evidence = spanOf(file, occurrence.range);
      if (forwardDefinitions.has(definition.id)) {
        definition.node.implementation ??= evidence;
      } else {
        definition.node.evidence ??= evidence;
      }
      if (occurrence.enclosingRange !== undefined) {
        scopes.push({
          id: definition.id,
          range: occurrence.enclosingRange,
        });
      }
    }
    // Innermost first: later starts win, and for equal starts earlier ends win.
    // Comparing line/column positions directly avoids inventing a maximum line
    // width; the old `lineDelta * 1_000_000 + columnDelta` reversed valid
    // nesting on source lines longer than that arbitrary boundary.
    scopes.sort((left, right) => {
      const start = compare(
        position(right.range, "start"),
        position(left.range, "start"),
      );
      return start !== 0
        ? start
        : compare(position(left.range, "end"), position(right.range, "end"));
    });

    for (const occurrence of occurrences) {
      const unknownRoles = recordUnknownRoles(unsupportedRoles, occurrence);
      recordUnsupportedRole(
        unsupportedRoles,
        occurrence,
        IScipIndex.SymbolRole.Generated,
        "generated",
      );
      recordUnsupportedRole(
        unsupportedRoles,
        occurrence,
        IScipIndex.SymbolRole.Test,
        "test",
      );
      if (
        unknownRoles ||
        hasRole(occurrence, IScipIndex.SymbolRole.Definition) ||
        hasRole(occurrence, IScipIndex.SymbolRole.ForwardDefinition)
      ) {
        continue;
      }
      const parsed = scipSymbol(occurrence.symbol ?? "");
      if (parsed === undefined) continue;
      const target =
        resolve(definitions, parsed, file) ??
        externalize(parsed.key, language);
      if (target === undefined) {
        if (parsed.stability === "generation") unscopedLocalReferences += 1;
        continue;
      }
      const owner = scopes.find((scope) => contains(scope.range, occurrence.range));
      if (owner === undefined) continue;
      if (owner.id === target.id) continue;
      recordUnsupportedRole(
        unsupportedRoles,
        occurrence,
        IScipIndex.SymbolRole.Import,
        "import",
      );
      recordUnsupportedRole(
        unsupportedRoles,
        occurrence,
        IScipIndex.SymbolRole.ReadAccess,
        "read",
      );
      recordUnsupportedRole(
        unsupportedRoles,
        occurrence,
        IScipIndex.SymbolRole.WriteAccess,
        "write",
      );
      edges.push({
        kind: "references",
        from: owner.id,
        to: target.id,
        evidence: spanOf(file, occurrence.range),
      });
    }

    // A document-level diagnostic has no range of its own, so it is reported
    // at the file's first position — the file *is* what it is about. An
    // occurrence-level one does have a range, and it is used: pinning every
    // finding to 1:1 would send a reader to the top of the file for a problem
    // twenty lines down, which is worse than saying nothing, because it looks
    // like an answer.
    for (const diagnostic of document.diagnostics ?? []) {
      diagnostics.push(diagnosticOf(diagnostic, file, undefined));
    }
    for (const occurrence of occurrences) {
      for (const diagnostic of occurrence.diagnostics ?? []) {
        diagnostics.push(diagnosticOf(diagnostic, file, occurrence.range));
      }
    }
  }

  // Containment and typed relationships come last, once every endpoint exists.
  for (const definition of definitions.values()) {
    if (definition.enclosingSymbol !== undefined) {
      const parsed = scipSymbol(definition.enclosingSymbol);
      const owner =
        parsed === undefined
          ? undefined
          : resolve(definitions, parsed, definition.file);
      if (owner !== undefined && owner.id !== definition.id) {
        edges.push({ kind: "contains", from: owner.id, to: definition.id });
      }
    }
    for (const relationship of definition.relationships) {
      // Support is a property of the relationship field, not of whether this
      // particular target can be resolved. Record unsupported claims before
      // endpoint lookup so an absent dependency cannot make them disappear.
      if (relationship.isReference === true) {
        unsupportedRoles.add("reference relationship");
      }
      if (relationship.isImplementation === true) {
        unsupportedRoles.add("implementation relationship");
      }
      if (relationship.isDefinition === true) {
        unsupportedRoles.add("definition relationship");
      }
      const parsed = scipSymbol(relationship.symbol);
      const target =
        parsed === undefined
          ? undefined
          : resolve(definitions, parsed, definition.file);
      if (target === undefined || target.id === definition.id) continue;
      // Each flag is its own claim; a relationship can be both an
      // implementation and a type definition, and checking them as if they
      // were alternatives drops whichever was tested second.
      if (relationship.isTypeDefinition === true) {
        edges.push({ kind: "type_ref", from: definition.id, to: target.id });
      }
    }
  }

  for (const role of unsupportedRoles) {
    warnings.push(
      `${props.provider}: SCIP ${role} data is not promoted to a stronger graph fact until this language provider proves a typed mapping for its pinned indexer`,
    );
  }
  if (derivedKinds > 0) {
    warnings.push(
      `${props.provider}: ${String(derivedKinds)} node kind(s) were derived from generic SCIP descriptor suffixes because the producer supplied no mapped SymbolInformation.kind; language enrichment is required for a more specific kind`,
    );
  }
  if (unscopedLocalReferences > 0) {
    warnings.push(
      `${props.provider}: ${String(unscopedLocalReferences)} reference(s) named a document-scoped local this index does not resolve, so they are omitted rather than attached to an invented declaration`,
    );
  }

  return {
    nodes: [...nodes.values()],
    // Deduplicated on the way out. A name referenced twice in one scope is two
    // occurrences of one relationship, and a symbol listing the same
    // relationship under two flags is one claim per flag — both legitimate in
    // an index, both duplicates in a graph, and `mergeGraphSlices` rejects a
    // strict slice that carries one. The first occurrence keeps its evidence,
    // because the earliest is the one a reader is sent to.
    edges: dedupe(edges),
    diagnostics,
    warnings,
    files,
  };
}

function languageFromScip(
  language: string | undefined,
): GraphLanguage | undefined {
  if (language === undefined) return undefined;
  const normalized = language.toLowerCase().replaceAll(/[^a-z+#]/g, "");
  const mapped: Record<string, GraphLanguage> = {
    c: "c",
    "c++": "cpp",
    cpp: "cpp",
    csharp: "csharp",
    "c#": "csharp",
    dart: "dart",
    go: "go",
    java: "java",
    kotlin: "kotlin",
    lua: "lua",
    php: "php",
    python: "python",
    ruby: "ruby",
    rust: "rust",
    scala: "scala",
    swift: "swift",
    typescript: "typescript",
    zig: "zig",
  };
  return mapped[normalized];
}

/** One edge per kind and endpoint pair, keeping the first evidence seen. */
function dedupe(edges: readonly ISamchonGraphEdge[]): ISamchonGraphEdge[] {
  const seen = new Map<string, ISamchonGraphEdge>();
  for (const edge of edges) {
    const key = `${edge.kind}\0${edge.from}\0${edge.to}`;
    if (!seen.has(key)) seen.set(key, edge);
  }
  return [...seen.values()];
}

/* c8 ignore start -- merging a namespace onto a function compiles to an
 * `X || (X = {})` initialiser, emitted at the closing brace, whose falsy arm
 * cannot run: the function declaration above it is always evaluated first.
 * The constant inside runs unconditionally, so nothing testable is hidden. */
export namespace adaptScipIndex {
  /** What a bare SCIP index proves, and nothing more. */
  export const EDGE_KINDS = SCIP_EDGE_KINDS;

  /** Everything the adapter needs that only the session knows. */
  export type IProps = IAdaptScipIndexProps;

  /** One strict slice mapped from one index. */
  export type IResult = IScipAdaptation;
}
/* c8 ignore stop */

/**
 * The one position encoding whose offsets are already graph columns.
 *
 * An absent field is left alone because older JSON encodings omit the proto
 * default. An explicit `UnspecifiedPositionEncoding` is reported: SCIP marks
 * it ambiguous for consumers, so treating it as UTF-16 would overstate the
 * precision of every non-ASCII span.
 */
const UTF16_POSITION_ENCODING = "UTF16CodeUnitOffsetFromLineStart";

interface IDefinition {
  id: string;
  file: string;
  node: ISamchonGraphNode;
  enclosingSymbol?: string;
  relationships: readonly IScipIndex.IRelationship[];
}

interface IScope {
  id: string;
  range: number[];
}

/**
 * The identity a SCIP symbol contributes to its node id.
 *
 * A global symbol is persistent: the indexer derived it from the declaration's
 * package, path, and descriptors, so it survives edits elsewhere in the file. A
 * `local N` symbol is not, and is scoped to its document and generation, so an
 * unrelated edit above it renames nothing.
 */
function identityOf(
  symbol: scipSymbol.IParsed,
  language: GraphLanguage,
  role: ISamchonGraphNode["kind"],
  file: string,
): IGraphSemanticIdentity {
  return {
    version: 2,
    language,
    symbol: symbol.key,
    role,
    native: { key: symbol.key, stability: "semantic" },
    stability: symbol.stability,
    ...(symbol.stability === "generation"
      ? { scope: { document: file }, generation: file }
      : {}),
  };
}

/**
 * The key one definition is filed under.
 *
 * A global symbol is the same declaration wherever it is named, so its own
 * string is enough. A `local N` symbol is not: the counter is scoped to its
 * document, and two files each holding a `local 4` describe two unrelated
 * declarations. Filing both under `local 4` made whichever came second
 * overwrite the first, and every reference in the earlier file then resolved to
 * a declaration in the later one.
 */
function definitionKey(symbol: scipSymbol.IParsed, file: string): string {
  return symbol.stability === "generation"
    ? `${file}\0${symbol.key}`
    : symbol.key;
}

/**
 * Find a definition from a document that is naming it.
 *
 * A local symbol can only mean the one in this document; a global one is
 * looked up as itself. Trying the scoped key first is what keeps a local
 * reference from reaching another file's identically numbered local.
 */
function resolve(
  definitions: ReadonlyMap<string, IDefinition>,
  symbol: scipSymbol.IParsed,
  file: string,
): IDefinition | undefined {
  return definitions.get(definitionKey(symbol, file));
}

function diagnosticOf(
  diagnostic: IScipIndex.IDiagnostic,
  file: string,
  range: number[] | undefined,
): ISamchonGraphDiagnostic {
  const span = range === undefined ? undefined : spanOf(file, range);
  return {
    file,
    line: span?.startLine ?? 1,
    column: span?.startCol ?? 1,
    code: diagnostic.code ?? diagnostic.source ?? "unknown",
    message: diagnostic.message,
    ...severityOf(diagnostic.severity),
  };
}

function spanOf(file: string, range: number[]): ISamchonGraphEvidence {
  const [startLine, startCharacter] = range as [number, number, ...number[]];
  const endLine = range.length === 3 ? startLine : range[2]!;
  const endCharacter = range.length === 3 ? range[2]! : range[3]!;
  return {
    file,
    startLine: startLine + 1,
    startCol: startCharacter + 1,
    endLine: endLine + 1,
    endCol: endCharacter + 1,
  };
}

function hasRole(
  occurrence: IScipIndex.IOccurrence,
  role: IScipIndex.SymbolRole,
): boolean {
  return ((occurrence.symbolRoles ?? 0) & role) !== 0;
}

function contains(outer: number[], inner: number[]): boolean {
  const outerStart = position(outer, "start");
  const outerEnd = position(outer, "end");
  const innerStart = position(inner, "start");
  const innerEnd = position(inner, "end");
  return (
    compare(outerStart, innerStart) <= 0 && compare(outerEnd, innerEnd) >= 0
  );
}

function position(range: number[], edge: "start" | "end"): [number, number] {
  if (edge === "start") return [range[0]!, range[1]!];
  return range.length === 3
    ? [range[0]!, range[2]!]
    : [range[2]!, range[3]!];
}

function recordUnsupportedRole(
  roles: Set<string>,
  occurrence: IScipIndex.IOccurrence,
  role: IScipIndex.SymbolRole,
  label: string,
): void {
  if (hasRole(occurrence, role)) roles.add(`${label} role`);
}

/** Report future role bits and prevent treating them as ordinary references. */
function recordUnknownRoles(
  roles: Set<string>,
  occurrence: IScipIndex.IOccurrence,
): boolean {
  const unknown = (occurrence.symbolRoles ?? 0) & ~KNOWN_SYMBOL_ROLES;
  if (unknown === 0) return false;
  roles.add(`unknown role bits 0x${unknown.toString(16)}`);
  return true;
}

const KNOWN_SYMBOL_ROLES =
  IScipIndex.SymbolRole.Definition |
  IScipIndex.SymbolRole.Import |
  IScipIndex.SymbolRole.WriteAccess |
  IScipIndex.SymbolRole.ReadAccess |
  IScipIndex.SymbolRole.Generated |
  IScipIndex.SymbolRole.Test |
  IScipIndex.SymbolRole.ForwardDefinition;

function compare(left: [number, number], right: [number, number]): number {
  if (left[0] !== right[0]) return left[0] - right[0];
  return left[1] - right[1];
}

function severityOf(
  severity: string | undefined,
): { severity?: ISamchonGraphDiagnostic["severity"] } {
  switch (severity) {
    case "Error":
      return { severity: "error" };
    case "Warning":
      return { severity: "warning" };
    case "Information":
      return { severity: "info" };
    case "Hint":
      return { severity: "hint" };
    // `Unspecified`, an absent field, and a severity name this client has not
    // heard of are all the same fact: the indexer did not say. The diagnostic
    // is kept without one rather than defaulted to `error`, which would invent
    // a severity the producer never claimed.
    case undefined:
    default:
      return {};
  }
}

/** Graph file identities are forward-slashed and project-relative. */
function normalizeFile(relativePath: string): string {
  return relativePath.split(path.win32.sep).join("/");
}
