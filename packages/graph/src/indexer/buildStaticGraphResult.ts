import { SamchonGraphSourceReader } from "../SamchonGraphSourceReader";
import { ISamchonGraphDump } from "../structures";
import { fallbackCoverage } from "../provider/fallbackCoverage";
import { dedupeEdges } from "./dedupeEdges";
import { dedupeNodes } from "./dedupeNodes";
import { finalizeGraph } from "./finalizeGraph";
import { IBuildGraphOptions } from "./IBuildGraphOptions";
import { IIndexerResult } from "./IIndexerResult";
import { staticGraphParts } from "./staticGraphParts";
import { wireEdges } from "./wireEdges";
import { wireNodes } from "./wireNodes";

/** Build one static dump together with the exact source bytes it consumed. */
export function buildStaticGraphResult(
  options: IBuildGraphOptions = {},
): IIndexerResult {
  const parts = staticGraphParts(options);
  const finalized = finalizeGraph(
    parts.root,
    [...parts.sources.keys()],
    parts.nodes,
    parts.edges,
  );
  const warnings = [...parts.warnings, ...finalized.warnings];
  const nodes = dedupeNodes(finalized.nodes, (id, count) =>
    warnings.push(
      `@samchon/graph: generic semantic declaration has ${count} locations; retaining canonical declaration and implementation spans: ${id}`,
    ),
  );
  const dump: ISamchonGraphDump = {
    project: parts.root,
    languages: parts.languages,
    indexer: "static",
    coverage: fallbackCoverage("@samchon/graph-sitter", parts.languages),
    unresolved: [],
    nodes: wireNodes(nodes),
    edges: wireEdges(dedupeEdges(finalized.edges), nodes),
    warnings,
  };
  return {
    dump,
    warnings,
    sources: new Map(parts.sources),
    source: new SamchonGraphSourceReader(parts.root, {
      texts: parts.sources,
    }),
  };
}
