import {
  type GraphSitterLanguage,
  graphSitterParts,
  type IGraphSitterEdge,
  type IGraphSitterFile,
  type IGraphSitterNode,
  isGraphSitterLanguage,
} from "@samchon/graph-sitter";
import path from "node:path";
import { ISamchonGraphEdge, ISamchonGraphNode } from "../structures";
import { GraphLanguage } from "../typings";
import { projectRelative, readText } from "../utils/fs";
import { IBuildGraphOptions } from "./IBuildGraphOptions";
import { IStaticGraphParts } from "./IStaticGraphParts";
import { languagesOf } from "./languages";
import { normalizeRequestedLanguages } from "./normalizeRequestedLanguages";
import { selectGraphSources } from "./selectGraphSources";

/**
 * Discover a project snapshot and delegate its best-effort syntax extraction to
 * the isolated graph-sitter package.
 */
export function staticGraphParts(
  options: IBuildGraphOptions = {},
  selectedFiles?: readonly string[],
): IStaticGraphParts {
  const root = path.resolve(options.cwd ?? process.cwd());
  const discovered = selectedFiles ?? selectGraphSources(root, options).files;
  const requested = normalizeRequestedLanguages(options.languages);
  const allowed = requested === undefined ? undefined : new Set(requested);
  const files: IGraphSitterFile[] = [];
  for (const absolutePath of discovered) {
    // Source selection and extraction share the same multi-owner registry. A
    // plain .h is therefore parsed for every selected C/C++ ownership view,
    // while exact .H remains C++ as declared by the registry.
    const source = readText(absolutePath);
    /* c8 ignore next */
    if (source === undefined) continue;
    for (const language of languagesOf(absolutePath)) {
      if (allowed !== undefined && !allowed.has(language)) continue;
      /* c8 ignore next */
      if (!isGraphSitterLanguage(language)) continue;
      files.push({
        absolutePath,
        relativePath: projectRelative(root, absolutePath),
        language,
        source,
      });
    }
  }
  const parts = graphSitterParts({ root, files });
  return parts;
}

// The package boundary is intentionally structural and acyclic. These
// bidirectional checks make any raw node, edge, or language drift a compile
// failure before an adapter can silently weaken the public graph contract.
type Assert<T extends true> = T;
type NodeContractParity = Assert<
  IGraphSitterNode extends ISamchonGraphNode
    ? ISamchonGraphNode extends IGraphSitterNode
      ? true
      : false
    : false
>;
type EdgeContractParity = Assert<
  IGraphSitterEdge extends ISamchonGraphEdge
    ? ISamchonGraphEdge extends IGraphSitterEdge
      ? true
      : false
    : false
>;
type LanguageContractParity = Assert<
  GraphSitterLanguage extends Exclude<GraphLanguage, "unknown">
    ? Exclude<GraphLanguage, "unknown"> extends GraphSitterLanguage
      ? true
      : false
    : false
>;
