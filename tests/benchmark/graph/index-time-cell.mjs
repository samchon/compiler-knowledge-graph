import { GRAPH_PROVIDERS } from "@samchon/graph";

export const TOOL_SAMCHON = "samchon-graph";
export const TOOL_SAMCHON_FALLBACK = "samchon-graph-fallback";
export const TOOL_CODEGRAPH = "codegraph";
export const TOOL_CODEBASE_MEMORY = "codebase-memory";
export const TOOL_SERENA = "serena";

export const ALL_TOOLS = Object.freeze([
  TOOL_SAMCHON,
  TOOL_SAMCHON_FALLBACK,
  TOOL_CODEGRAPH,
  TOOL_CODEBASE_MEMORY,
  TOOL_SERENA,
]);

export function strictIntentOfTool(tool) {
  return tool === TOOL_SAMCHON
    ? true
    : tool === TOOL_SAMCHON_FALLBACK
      ? false
      : undefined;
}

/** The one canonical registry owner for a measured source language. */
export function expectedPrimaryProvider(
  language,
  registry = GRAPH_PROVIDERS,
) {
  const owners = registry.filter((provider) =>
    provider.languages.includes(language),
  );
  if (owners.length !== 1) {
    throw new Error(
      `index-time: expected one primary provider for ${String(language)}, found ${String(owners.length)}`,
    );
  }
  return owners[0].name;
}

/** Separate the route a graph cell asked for from the route that answered. */
export function indexRoute(language, tool, summary) {
  const strict = strictIntentOfTool(tool);
  if (strict === undefined) return undefined;
  const expected = expectedPrimaryProvider(language);
  const indexer =
    summary?.indexer === "lsp" ||
    summary?.indexer === "hybrid" ||
    summary?.indexer === "static"
      ? summary.indexer
      : null;
  const provenance = Array.isArray(summary?.provenance)
    ? summary.provenance
    : [];
  const primaryServed = provenance.some(
    (row) => row?.provider === expected,
  );
  const verdict =
    summary?.truncated === true || indexer === null
      ? "unknown"
      : indexer === "static"
        ? "static"
        : strict && primaryServed
          ? "served"
          : "fallback";
  return {
    schemaVersion: 1,
    intent: {
      strictProviders: strict ? "enabled" : "stood-down",
      expectedPrimaryProvider: strict ? expected : null,
    },
    outcome: {
      verdict,
      indexer,
      provenance,
      ...(summary?.truncated === true ? { truncated: true } : {}),
    },
  };
}

/** Parse the bounded dump side channel without guessing missing provenance. */
export function graphResultFromLog(text) {
  const servedPrefix = "@samchon/graph: indexer=";
  const routePrefix = "@samchon/graph: route=";
  const attemptingPrefix = "@samchon/graph: indexing with ";
  const lines = String(text).split(/\r?\n/u);
  const outcome = lines.find((line) => line.startsWith(servedPrefix));
  const intent = lines.find((line) => line.startsWith(attemptingPrefix));
  const routeLine = lines.find((line) => line.startsWith(routePrefix));
  let summary;
  if (routeLine !== undefined) {
    try {
      const parsed = JSON.parse(routeLine.slice(routePrefix.length));
      if (
        parsed?.schemaVersion === 1 &&
        Array.isArray(parsed.provenance)
      ) {
        summary = parsed;
      }
    } catch {
      summary = undefined;
    }
  }
  return {
    servedBy:
      outcome !== undefined
        ? outcome.slice(servedPrefix.length).trim()
        : intent === undefined
          ? "unknown"
          : `attempted ${intent.slice(attemptingPrefix.length).trim()}`,
    summary,
  };
}

/** Read the structured route, or conservatively classify a historical cell. */
export function effectiveIndexRoute(cell, language) {
  if (cell?.route?.schemaVersion === 1) return cell.route;
  const strict = strictIntentOfTool(cell?.tool);
  if (strict === undefined) return undefined;
  const expected = expectedPrimaryProvider(language);
  const servedBy = typeof cell?.servedBy === "string" ? cell.servedBy : "";
  const indexer = servedBy.startsWith("lsp ")
    ? "lsp"
    : servedBy.startsWith("hybrid ")
      ? "hybrid"
      : servedBy.startsWith("static ")
        ? "static"
        : null;
  const providers = [
    ...servedBy.matchAll(/(?:^|\s)([A-Za-z0-9_.-]+)\([^)]*\)/gu),
  ].map((match) => match[1]);
  const primaryServed = providers.includes(expected);
  const verdict =
    indexer === null
      ? "unknown"
      : indexer === "static"
        ? "static"
        : strict && primaryServed
          ? "served"
          : "fallback";
  return {
    schemaVersion: 1,
    intent: {
      strictProviders: strict ? "enabled" : "stood-down",
      expectedPrimaryProvider: strict ? expected : null,
    },
    outcome: {
      verdict,
      indexer,
      provenance: [],
      historical: true,
    },
  };
}

export function timedOutIndexCell({
  project,
  language,
  tool,
  timedOutMs,
  servedBy,
}) {
  const strict = strictIntentOfTool(tool);
  return {
    project,
    language,
    tool,
    buildMs: null,
    timedOutMs,
    ...(strict === undefined ? {} : { strict }),
    servedBy,
    ...(strict === undefined
      ? {}
      : { route: indexRoute(language, tool, undefined) }),
  };
}
