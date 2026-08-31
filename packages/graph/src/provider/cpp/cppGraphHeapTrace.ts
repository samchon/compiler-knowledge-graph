import fs from "node:fs";

const HEAP_TRACE_ENVIRONMENT = "SAMCHON_GRAPH_CPP_HEAP_TRACE";
const PREFIX = "@samchon/graph: cpp-heap ";

/**
 * Opt-in, payload-free heap and timing trace for the native C/C++ route.
 *
 * Several hosts have died on this route, and every answer so far has come from
 * making a stage state its own size rather than inferring one from the stage
 * after it. Twice now the reading that was needed did not exist because the run
 * died before the boundary that would have reported it -- once mid-parse with
 * the generation incomplete, once forty-three minutes into a walk that never
 * finished. A trace that only speaks at the end says nothing about the runs
 * that do not get there.
 *
 * So the walk reports as it goes, every `WALK_STRIDE` shards, and the two
 * boundaries still report exactly. A run that dies partway now says how far it
 * got, how long that took, and what it was holding.
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
    stage: (stage, shards, split) => {
      const memory = usage();
      const mib = (value: number): string =>
        String(Math.round(value / (1024 * 1024)));
      const ms = (value: number): string => String(Math.round(value));
      try {
        write(
          `${PREFIX}stage=${stage} shards=${String(shards)}` +
            ` elapsedMs=${ms(split.elapsedMs)}` +
            ` producerMs=${ms(split.producerMs)}` +
            ` producerFetchMs=${ms(split.producerFetchMs)}` +
            ` producerEncodeMs=${ms(split.producerEncodeMs)}` +
            ` bodyMs=${ms(split.bodyMs)}` +
            ` adaptMs=${ms(split.adaptMs)}` +
            ` nodes=${String(split.nodes)}` +
            ` nodesOffMain=${String(split.nodesOffMain)}` +
            ` entities=${String(split.entities)}` +
            ` relationships=${String(split.relationships)}` +
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
    /**
     * Report what is resident at one named boundary of a refresh, and how long
     * this refresh has taken to reach it.
     *
     * The time matters as much as the bytes. A generation that pages in eighty
     * minutes has not passed because it eventually fit; it has arrived just
     * before the job timeout. Two stamped boundaries separate the walk from
     * what closing costs, which are paid by different sides of the protocol.
     */
    stage: (
      stage: "walking" | "paged" | "committed",
      shards: number,
      split: ISplit,
    ) => void;
  }

  /**
   * Where a refresh's time went, so far.
   *
   * `elapsedMs` is wall clock since the refresh began. `producerMs` is what was
   * spent awaiting the producer's answers and `adaptMs` what was spent turning
   * them into shards -- the two halves of a walk, paid by different processes.
   * A stride that costs thirteen seconds a shard is a different problem
   * depending on which of them owns it, and no reading so far could say.
   */
  export interface ISplit {
    elapsedMs: number;
    producerMs: number;

    /**
     * The producer's own account of its time, summed over the pages so far.
     *
     * Every page carries the phase telemetry the producer measured while
     * building it: what it spent before encoding -- the cursor lookup, the
     * shard reads, the body digests -- and what the encoding itself cost. The
     * client already knew how long it waited; these say what it was waiting
     * for, without a second instrument on the other side of the pipe.
     */
    producerFetchMs: number;
    producerEncodeMs: number;

    /** Reading the bodies the producer published, by the digest that named them. */
    bodyMs: number;
    adaptMs: number;

    /**
     * Nodes adapted so far, and how many came from a file other than the
     * shard's own main file.
     *
     * A shard is one translation unit's view, so every symbol a header
     * declares is materialised again in every unit that includes it, and
     * libuv's headers are included by all 242 of its units. If that is where
     * the consumer's seven gibibytes of live graph goes, this ratio says so --
     * and if it is not, it stops a producer being rebuilt around a guess.
     */
    nodes: number;
    nodesOffMain: number;

    /**
     * Distinct entities and relationships the walk has actually derived.
     *
     * `nodes` counts namings: every shard lists every entity it saw, so a
     * header's declarations are counted once per including unit. These count
     * what was made. The gap between the two is what sharing is worth, and if
     * there is no gap then two units that read the same header are still
     * arriving at two different entities -- a different problem than the one
     * being solved, and one no amount of sharing would fix.
     */
    entities: number;
    relationships: number;
  }
}
