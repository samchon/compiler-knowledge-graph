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

export function timedOutIndexCell({
  project,
  tool,
  timedOutMs,
  servedBy,
}) {
  const strict = strictIntentOfTool(tool);
  return {
    project,
    tool,
    buildMs: null,
    timedOutMs,
    ...(strict === undefined ? {} : { strict }),
    servedBy,
  };
}
