import fs from "node:fs";

import type { LspClient } from "./LspClient";

const LSP_REQUEST_TRACE_ENV =
  "SAMCHON_GRAPH_LSP_REQUEST_TRACE";
const CUTOFF_SIGNALS = new WeakSet<AbortSignal>();
let nextTraceClientId = 1;

/**
 * Opt-in request timing for long-running benchmark diagnosis.
 *
 * Only request identity, method, lifecycle phase, outcome, and duration are
 * emitted. Parameters and paths stay out of the log.
 */
export function lspRequestTrace(
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => unknown = (line) =>
    typeof process.stderr.fd === "number"
      ? fs.writeSync(process.stderr.fd, line)
      : process.stderr.write(line),
  signal?: AbortSignal,
): LspClient.IRequestObserver | undefined {
  if (env[LSP_REQUEST_TRACE_ENV] !== "1") return undefined;
  const clientId = nextTraceClientId++;
  if (signal !== undefined && !CUTOFF_SIGNALS.has(signal)) {
    CUTOFF_SIGNALS.add(signal);
    const cutoff = (): void => {
      try {
        write("@samchon/graph: lsp-request phase=cutoff\n");
      } catch {
        // Diagnostics must never change signal or transport behavior.
      }
    };
    if (signal.aborted) cutoff();
    else signal.addEventListener("abort", cutoff, { once: true });
  }
  return (event) => {
    const prefix =
      `@samchon/graph: lsp-request client=${String(clientId)}` +
      ` id=${String(event.id)}` +
      ` method=${JSON.stringify(event.method)} phase=${event.phase}`;
    write(
      event.phase === "start"
        ? `${prefix}\n`
        : `${prefix} status=${event.status} durationMs=${event.durationMs.toFixed(3)}\n`,
    );
  };
}
