import fs from "node:fs";

const PHASE_TRACE_ENVIRONMENT = "SAMCHON_GRAPH_TTSC_PHASE_TRACE";
const PREFIX = "@samchon/graph: ttscgraph-phase ";
const PRODUCER_LINE =
  /^@samchon\/graph: ttscgraph-phase owner=producer request=[1-9]\d* mode=(?:initial|reload|unchanged|incremental|rebuild|error) phase=(?:native-load|semantic-refresh|shard-export|encode|producer-total) durationMs=\d+\.\d{3}$/u;

/** Opt-in, payload-free timing trace for the native TypeScript graph route. */
export function ttscGraphPhaseTrace(
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => unknown = (line) =>
    typeof process.stderr.fd === "number"
      ? fs.writeSync(process.stderr.fd, line)
      : process.stderr.write(line),
): ttscGraphPhaseTrace.ITrace | undefined {
  if (env[PHASE_TRACE_ENVIRONMENT] !== "1") return undefined;
  const emit = (line: string): void => {
    try {
      write(line);
    } catch {
      // Observability must never alter provider transport or publication.
    }
  };
  return {
    event: (event) => {
      emit(
        `${PREFIX}owner=consumer request=${String(event.request)}` +
          ` mode=${event.mode} phase=${event.phase}` +
          ` durationMs=${event.durationMs.toFixed(3)}\n`,
      );
    },
    forwardProducer: (buffer, chunk) => {
      const joined = buffer + chunk;
      const lines = joined.split("\n");
      const remainder = lines.pop()!;
      for (const raw of lines) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (PRODUCER_LINE.test(line)) emit(`${line}\n`);
      }
      return remainder.length <= 4_096 ? remainder : remainder.slice(-4_096);
    },
  };
}

export namespace ttscGraphPhaseTrace {
  export interface IEvent {
    request: number;
    mode: string;
    phase:
      | "producer-roundtrip"
      | "native-normalize"
      | "common-commit"
      | "mcp-ready";
    durationMs: number;
  }

  export interface ITrace {
    event: (event: IEvent) => void;
    forwardProducer: (buffer: string, chunk: string) => string;
  }
}
