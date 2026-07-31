import { IGraphProvider } from "../IGraphProvider";

export const ttscGraphResolution = Object.freeze({
  commands: Object.freeze(["ttscgraph", "ttscserver"] as const),
  environmentOverrides: Object.freeze(["TTSC_GRAPH_BINARY"] as const),
}) satisfies IGraphProvider.IResolution;
