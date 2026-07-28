import {
  ISamchonGraphEdge,
  ISamchonGraphNode,
} from "../../structures";
import { GraphNodeKind } from "../../typings";

/**
 * Turn the Lua exporter's raw report into graph nodes and edges.
 *
 * Kept apart from the session that runs the exporter, because this is where the
 * subtle mistakes live — an off-by-one in a coordinate, an edge pointed at the
 * wrong declaration, a kind claimed that the index does not prove — and none of
 * them need a language server to find. The session's job is spawning and
 * digesting; this one is a pure function over what came back.
 *
 * `lua-language-server` reports zero-based rows and columns through
 * `guide.rowColOf`, while `ISamchonGraphEvidence` is one-based on both axes.
 * The conversion happens once, here, rather than at each use.
 */
export function adaptLuaExport(
  report: adaptLuaExport.IReport,
  provider: string,
): adaptLuaExport.IResult {
  const nodes: ISamchonGraphNode[] = [];
  const edges: ISamchonGraphEdge[] = [];
  const warnings: string[] = [...report.warnings];

  // Identity has to be stable across runs and unique within a file. The
  // exporter can emit two declarations with one name in one file — a local
  // shadowing an earlier local is ordinary Lua — so the declaration's own line
  // and column disambiguate. Both belong in the id because Lua also permits
  // several declarations on one line; evidence alone cannot keep either case
  // from collapsing.
  const seen = new Set<string>();
  for (const entry of report.nodes) {
    const kind = NODE_KINDS[entry.kind];
    if (kind === undefined) {
      warnings.push(
        `${provider}: the exporter emitted an unmapped declaration kind ${entry.kind}`,
      );
      continue;
    }
    const id = identityOf(entry, kind);
    if (seen.has(id)) {
      warnings.push(
        `${provider}: two declarations share the identity ${id}; the later one is dropped`,
      );
      continue;
    }
    seen.add(id);
    nodes.push({
      id,
      kind,
      name: entry.name,
      language: "lua",
      file: entry.location.file,
      // The exporter only ever emits declarations from inside the project: its
      // file list is filtered to the workspace root precisely so the server's
      // own bundled meta definitions stay out. Anything it hands back is
      // therefore the project's own code.
      external: false,
      evidence: evidenceOf(entry.location),
    });
  }

  const related = new Set<string>();
  for (const edge of report.edges) {
    // `from` is one-based into the exporter's own node list, which is the list
    // before unmapped or duplicate entries were dropped. Resolving through that
    // original array rather than through `nodes` keeps a dropped declaration
    // from silently re-pointing every later edge at its neighbour.
    const origin = report.nodes[edge.from - 1];
    if (origin === undefined) {
      warnings.push(
        `${provider}: an edge referenced declaration ${String(edge.from)}, which does not exist`,
      );
      continue;
    }
    const kind = NODE_KINDS[origin.kind];
    if (kind === undefined) continue;
    const from = identityOf(origin, kind);
    // Defensive rather than reachable, and worth keeping. A duplicate origin
    // resolves to the identity its twin already published, which is the right
    // endpoint — so the only way here is an origin whose kind mapped and whose
    // node was still never emitted, a state the loop above does not produce
    // today and a dangling endpoint if it ever did.
    /* c8 ignore next */
    if (!seen.has(from)) continue;

    // A reference whose own position is the declaration's is the declaration
    // being counted as a use of itself. `vm.getRefs` includes the definition
    // site, and an edge from a symbol to itself says nothing.
    if (
      edge.location.file === origin.location.file &&
      edge.location.startLine === origin.location.startLine &&
      edge.location.startColumn === origin.location.startColumn
    ) {
      continue;
    }

    // The declaration the reference sits inside is the one doing the
    // referencing. `vm.getRefs(D)` answers "where is D used", so the graph edge
    // runs from whatever declaration contains that position to D — an earlier
    // version pointed it at the file instead, which reversed the relationship
    // and named something that is not a declaration.
    const container = innermostContaining(report.nodes, edge.location);
    if (container === undefined) {
      // A use at file scope belongs to no declaration. Saying nothing is more
      // honest than attributing it to the file or to the nearest neighbour.
      continue;
    }
    const containerKind = NODE_KINDS[container.kind];
    if (containerKind === undefined) continue;
    const containerId = identityOf(container, containerKind);
    if (containerId === from) continue;
    // An edge is a relationship, not an occurrence. `vm.getRefs` reports every
    // use, so a function reading one upvalue twice yields two identical edges —
    // and the dump keys an edge by `(kind, from, to)` alone, so the second one
    // is a duplicate that fails the whole build. The first use keeps the
    // evidence, which is the earliest position that proves the relationship.
    const relation = `${containerId}\0${from}`;
    if (related.has(relation)) continue;
    related.add(relation);
    edges.push({
      from: containerId,
      to: from,
      kind: "references",
      evidence: evidenceOf(edge.location),
    });
  }

  return { nodes, edges, warnings, files: [...report.files] };
}

export namespace adaptLuaExport {
  export interface ILocation {
    file: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }

  export interface INode {
    name: string;
    kind: string;
    sourceType: string;
    location: ILocation;

    /** Span covering the declaration body, when it has one. */
    body?: ILocation;
  }

  export interface IEdge {
    from: number;
    kind: string;
    sourceType: string;
    location: ILocation;
  }

  export interface IReport {
    schemaVersion: number;
    files: string[];
    nodes: INode[];
    edges: IEdge[];
    skipped: { unnamed: number; outsideRoot: number; refsFailed: number };
    warnings: string[];
  }

  export interface IArtifact extends IReport {
    /** Effective Lua dialect reported by the analyzer that produced the body. */
    compilerVersion: string;
  }

  export interface IResult {
    nodes: ISamchonGraphNode[];
    edges: ISamchonGraphEdge[];
    files: string[];
    warnings: string[];
  }

  /**
   * Read the exporter's artifact, refusing anything that is not one.
   *
   * The producer is a Lua script running inside somebody else's server, and a
   * crashed or half-written run is a JSON file too. Checking the shape here
   * turns that into a declined candidate with a reason instead of a snapshot
   * whose arrays happen to be empty — which would publish "this project has no
   * symbols" as a fact.
   */
  export function parse(value: unknown, provider: string): IArtifact {
    const report = value as Partial<IArtifact> | null;
    if (report === null || typeof report !== "object") {
      throw new Error(`${provider}: the export artifact is not an object`);
    }
    if (report.schemaVersion !== 2) {
      throw new Error(
        `${provider}: unsupported export schemaVersion ${String(report.schemaVersion)}`,
      );
    }
    for (const [field, entries] of [
      ["files", report.files],
      ["nodes", report.nodes],
      ["edges", report.edges],
      ["warnings", report.warnings],
    ] as const) {
      if (!Array.isArray(entries)) {
        throw new Error(`${provider}: the export artifact has no ${field}`);
      }
    }
    for (const file of report.files as string[])
      if (typeof file !== "string" || file === "")
        throw new Error(`${provider}: a file entry is not a path`);
    for (const entry of report.nodes as INode[]) assertNode(entry, provider);
    for (const entry of report.edges as IEdge[]) assertEdge(entry, provider);
    if (
      typeof report.compilerVersion !== "string" ||
      report.compilerVersion.trim() === ""
    ) {
      throw new Error(
        `${provider}: the export artifact has no effective Lua runtime version`,
      );
    }
    // Every warning the shipped exporter emits is an operational failure:
    // workspace-root decoding, file enumeration, or one file's parse. Carrying
    // that text into an otherwise successful strict snapshot would publish the
    // missing declarations as though the project had none. Count rather than
    // echo the array so a failure in many files cannot amplify stderr.
    const operationalWarnings = report.warnings as unknown[];
    if (operationalWarnings.length !== 0) {
      throw new Error(
        `${provider}: the exporter reported ${String(operationalWarnings.length)} operational warnings, so its workspace snapshot is incomplete`,
      );
    }
    const refsFailed = refsFailedOf(report.skipped, provider);
    const skipped = countsOf(report.skipped, refsFailed);
    // `vm.getRefs` is the only relationship channel this provider has. One
    // failed query means the advertised `references` fact family is incomplete,
    // and absence in that partial result is indistinguishable from "no
    // references exist" unless the strict candidate fails closed.
    if (skipped.refsFailed !== 0) {
      throw new Error(
        `${provider}: reference collection failed for ${String(skipped.refsFailed)} declaration(s), so its references snapshot is incomplete`,
      );
    }
    return {
      schemaVersion: 2,
      compilerVersion: report.compilerVersion,
      files: report.files as string[],
      nodes: report.nodes as INode[],
      edges: report.edges as IEdge[],
      skipped,
      warnings: [],
    };
  }
  /* c8 ignore start -- declaration merging emits an unreachable namespace
   * creation arm after the function object already exists. */
}
/* c8 ignore stop */

function assertNode(entry: adaptLuaExport.INode, provider: string): void {
  if (typeof entry?.name !== "string" || entry.name === "")
    throw new Error(`${provider}: a declaration has no name`);
  if (typeof entry.kind !== "string" || entry.kind === "")
    throw new Error(`${provider}: ${entry.name} has no kind`);
  assertLocation(entry.location, `${provider}: ${entry.name}`);
  if (entry.body !== undefined) {
    assertLocation(entry.body, `${provider}: ${entry.name} body`);
    if (entry.body.file !== entry.location.file) {
      throw new Error(`${provider}: ${entry.name} body is in another file`);
    }
    if (!containsSpan(entry.body, entry.location)) {
      throw new Error(
        `${provider}: ${entry.name} body does not contain its declaration`,
      );
    }
  }
}

function assertEdge(entry: adaptLuaExport.IEdge, provider: string): void {
  if (!Number.isSafeInteger(entry?.from) || entry.from < 1)
    throw new Error(`${provider}: an edge has no origin declaration`);
  assertLocation(entry.location, `${provider}: edge ${String(entry.from)}`);
}

function assertLocation(
  location: adaptLuaExport.ILocation,
  subject: string,
): void {
  if (typeof location?.file !== "string" || location.file === "")
    throw new Error(`${subject} has no file`);
  for (const axis of [
    "startLine",
    "startColumn",
    "endLine",
    "endColumn",
  ] as const) {
    const value = location[axis];
    // Zero-based and therefore allowed to be zero, but never negative and never
    // fractional: a coordinate that is neither is a parse that went wrong
    // rather than a position in a file.
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`${subject} has no ${axis}`);
  }
  if (
    before(
      location.endLine,
      location.endColumn,
      location.startLine,
      location.startColumn,
    )
  ) {
    throw new Error(`${subject} has an inverted span`);
  }
}

/**
 * The two benign skip counters, plus proven reference-completion evidence.
 *
 * A producer that omitted a benign field and one that malformed it are the
 * same situation: reading either as zero keeps a miscount from becoming an
 * invented number. `refsFailed` has already passed the stricter check below.
 */
function countsOf(
  skipped: adaptLuaExport.IReport["skipped"] | undefined,
  refsFailed: number,
): adaptLuaExport.IReport["skipped"] {
  return {
    unnamed: countOf(skipped?.unnamed),
    outsideRoot: countOf(skipped?.outsideRoot),
    refsFailed,
  };
}

/**
 * Evidence that the exporter completed every reference query.
 *
 * The shipped exporter always initializes this counter before visiting a
 * declaration. Missing or malformed is therefore not another spelling of
 * zero: it is an artifact that cannot prove whether reference collection ran.
 */
function refsFailedOf(
  skipped: adaptLuaExport.IReport["skipped"] | undefined,
  provider: string,
): number {
  const value = skipped?.refsFailed;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(
      `${provider}: the export artifact has no valid refsFailed count`,
    );
  }
  return value as number;
}

function countOf(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : 0;
}

/**
 * What each exported declaration kind is, in the graph's vocabulary.
 *
 * Lua has no classes and no declared types, so the vocabulary it can honestly
 * fill is small. A `setfield` becomes a field rather than a method even when a
 * function is assigned to it: the exporter reports the assignment shape, and
 * calling it a method would claim a dispatch relationship the index never
 * proved. `setmethod` is the colon form, where the receiver is explicit.
 */
const NODE_KINDS: Record<string, GraphNodeKind | undefined> = {
  local: "variable",
  function: "function",
  global: "variable",
  field: "field",
  method: "method",
};

/**
 * The declaration whose body encloses a position, innermost first.
 *
 * Innermost because Lua nests: a function assigned inside another function's
 * body sits within both spans, and the reference belongs to the one that
 * actually contains the line. Ties go to the later declaration, which is the
 * inner one in source order.
 */
function innermostContaining(
  nodes: readonly adaptLuaExport.INode[],
  at: adaptLuaExport.ILocation,
): adaptLuaExport.INode | undefined {
  let found: adaptLuaExport.INode | undefined;
  for (const node of nodes) {
    const body = node.body ?? node.location;
    if (body.file !== at.file) continue;
    if (!contains(body, at)) continue;
    if (found === undefined || startsAfter(body, found.body ?? found.location))
      found = node;
  }
  return found;
}

function contains(
  span: adaptLuaExport.ILocation,
  at: adaptLuaExport.ILocation,
): boolean {
  return (
    !before(at.startLine, at.startColumn, span.startLine, span.startColumn) &&
    !before(span.endLine, span.endColumn, at.startLine, at.startColumn)
  );
}

function containsSpan(
  outer: adaptLuaExport.ILocation,
  inner: adaptLuaExport.ILocation,
): boolean {
  return (
    !before(
      inner.startLine,
      inner.startColumn,
      outer.startLine,
      outer.startColumn,
    ) &&
    !before(
      outer.endLine,
      outer.endColumn,
      inner.endLine,
      inner.endColumn,
    )
  );
}

function startsAfter(
  span: adaptLuaExport.ILocation,
  other: adaptLuaExport.ILocation,
): boolean {
  return before(
    other.startLine,
    other.startColumn,
    span.startLine,
    span.startColumn,
  );
}

function before(
  line: number,
  column: number,
  otherLine: number,
  otherColumn: number,
): boolean {
  return line !== otherLine ? line < otherLine : column < otherColumn;
}

function identityOf(
  node: adaptLuaExport.INode,
  kind: GraphNodeKind,
): string {
  return `${node.location.file}#${node.name}@${String(node.location.startLine + 1)}:${String(node.location.startColumn + 1)}:${kind}`;
}

function evidenceOf(location: adaptLuaExport.ILocation) {
  return {
    file: location.file,
    startLine: location.startLine + 1,
    startCol: location.startColumn + 1,
    endLine: location.endLine + 1,
    endCol: location.endColumn + 1,
  };
}
