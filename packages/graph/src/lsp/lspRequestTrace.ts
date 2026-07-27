import type { LspClient } from "./LspClient";

const LSP_REQUEST_TRACE_ENV =
  "SAMCHON_GRAPH_LSP_REQUEST_TRACE";

/**
 * Opt-in request timing for long-running benchmark diagnosis.
 *
 * Only request identity, method, lifecycle phase, outcome, and duration are
 * emitted. Parameters and paths stay out of the log.
 */
export function lspRequestTrace(
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => unknown = process.stderr.write.bind(process.stderr),
): LspClient.IRequestObserver | undefined {
  if (env[LSP_REQUEST_TRACE_ENV] !== "1") return undefined;
  return (event) => {
    const prefix =
      `@samchon/graph: lsp-request id=${String(event.id)}` +
      ` method=${JSON.stringify(event.method)} phase=${event.phase}`;
    write(
      event.phase === "start"
        ? `${prefix}\n`
        : `${prefix} status=${event.status} durationMs=${event.durationMs.toFixed(3)}\n`,
    );
  };
}
