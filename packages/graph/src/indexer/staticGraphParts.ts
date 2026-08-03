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
import { languageOf } from "./languageOf";
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
  const contextualLanguages = new Set<GraphSitterLanguage>();
  for (const absolutePath of discovered) {
    const owners = staticOwners(absolutePath, allowed);
    if (owners.length === 1) contextualLanguages.add(owners[0]!);
  }
  const files: IGraphSitterFile[] = [];
  for (const absolutePath of discovered) {
    const source = readText(absolutePath);
    /* c8 ignore next */
    if (source === undefined) continue;
    const owners = staticOwners(absolutePath, allowed);
    const language = staticOwner(absolutePath, owners, contextualLanguages);
    /* c8 ignore next -- normal discovery cannot return a path outside its requested registry. */
    if (language === undefined) continue;
    files.push({
      absolutePath,
      relativePath: projectRelative(root, absolutePath),
      language,
      source,
    });
  }
  const parts = graphSitterParts({ root, files });
  return parts;
}

/** Keep graph-sitter's file identity singular while honoring explicit filters. */
function staticOwners(
  absolutePath: string,
  allowed: ReadonlySet<GraphLanguage> | undefined,
): GraphSitterLanguage[] {
  return languagesOf(absolutePath).filter(
    (language): language is GraphSitterLanguage =>
      (allowed === undefined || allowed.has(language)) &&
      isGraphSitterLanguage(language),
  );
}

/** Resolve a shared header from the unambiguous translation units around it. */
function staticOwner(
  absolutePath: string,
  owners: readonly GraphSitterLanguage[],
  contextualLanguages: ReadonlySet<GraphSitterLanguage>,
): GraphSitterLanguage | undefined {
  if (owners.length <= 1) return owners[0];
  if (owners.includes("cpp") && contextualLanguages.has("cpp")) return "cpp";
  if (owners.includes("c") && contextualLanguages.has("c")) return "c";
  // Multiple supported owners currently means a shared .h with both owners
  // still allowed, so the singular compatibility owner is one of this set.
  return languageOf(absolutePath) as GraphSitterLanguage;
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
