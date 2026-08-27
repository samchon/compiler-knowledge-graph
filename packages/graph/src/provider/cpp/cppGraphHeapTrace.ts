import fs from "node:fs";

const HEAP_TRACE_ENVIRONMENT = "SAMCHON_GRAPH_CPP_HEAP_TRACE";
const PREFIX = "@samchon/graph: cpp-heap ";

/**
 * Opt-in, payload-free heap trace for the native C/C++ route.
 *
 * Three hosts died on this route before anything said where the memory went,
 * and each answer since has come from making a stage state its own size rather
 * than inferring one from the stage after it. This says what the consumer holds
 * at the two boundaries that matter: when every page has been parsed and the
 * whole producer generation is resident, and when it has been adapted and
 * committed. The difference between those two is the number that decides
 * whether a page can be adapted as it arrives or the shape has to change.
 *
 * Counts, not payload. A shard count and a byte figure say nothing about the
 * code being indexed.
 */
export function cppGraphHeapTrace(
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => unknown = (line) =>
    typeof process.stderr.fd === "number"
      ? fs.writeSync(process.stderr.fd, line)
      : process.stderr.write(line),
  usage: () => NodeJS.MemoryUsage = () => process.memoryUsage(),
): cppGraphHeapTrace.ITrace | undefined {
  if (env[HEAP_TRACE_ENVIRONMENT] !== "1") return undefined;
  return {
    stage: (stage, shards) => {
      const memory = usage();
      const mib = (value: number): string =>
        String(Math.round(value / (1024 * 1024)));
      try {
        write(
          `${PREFIX}stage=${stage} shards=${String(shards)}` +
            ` heapUsedMiB=${mib(memory.heapUsed)}` +
            ` heapTotalMiB=${mib(memory.heapTotal)}` +
            ` rssMiB=${mib(memory.rss)}\n`,
        );
      } catch {
        // Observability must never alter provider transport or publication.
      }
    },
  };
}

export namespace cppGraphHeapTrace {
  export interface ITrace {
    /** Report what is resident at one named boundary of a refresh. */
    stage: (stage: "paged" | "committed", shards: number) => void;
  }
}
