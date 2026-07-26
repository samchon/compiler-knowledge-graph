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
  // disambiguates. It is not in `evidence` alone because two nodes that differ
  // only by position would otherwise collapse into one id.
  const seen = new Set<string>();
  for (const entry of report.nodes) {
    const kind = NODE_KINDS[entry.kind];
    if (kind === undefined) {
      warnings.push(
        `${provider}: the exporter emitted an unmapped declaration kind ${entry.kind}`,
      );
      continue;
    }
    const line = entry.location.startLine + 1;
    const id = `${entry.location.file}#${entry.name}@${String(line)}:${kind}`;
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
      file: entry.location.file,
      evidence: evidenceOf(entry.location),
    });
  }

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
    const from = `${origin.location.file}#${origin.name}@${String(origin.location.startLine + 1)}:${kind}`;
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

    edges.push({
      from,
      // The reference target is a position, not a declaration: the exporter
      // reports where the symbol is used, and the graph's `to` is a node id.
      // Pointing at the file keeps the edge honest — it says this declaration
      // is referenced from there — without inventing a declaration that the
      // index never resolved.
      to: edge.location.file,
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

  export interface IResult {
    nodes: ISamchonGraphNode[];
    edges: ISamchonGraphEdge[];
    files: string[];
    warnings: string[];
  }
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

function evidenceOf(location: adaptLuaExport.ILocation) {
  return {
    file: location.file,
    startLine: location.startLine + 1,
    startCol: location.startColumn + 1,
    endLine: location.endLine + 1,
    endCol: location.endColumn + 1,
  };
}
