import { AsyncSamchonGraphSource } from "./AsyncSamchonGraphSource";
import { RESULT_AUDIT } from "./operations/RESULT_AUDIT";
import { RESULT_AUDIT_DETAILS } from "./operations/RESULT_AUDIT_DETAILS";
import { RESULT_AUDIT_SELECTION } from "./operations/RESULT_AUDIT_SELECTION";
import { RESULT_AUDIT_ESCAPE } from "./operations/RESULT_AUDIT_ESCAPE";
import { resultNext } from "./operations/resultNext";
import { graphTrust } from "./operations/graphTrust";
import { runDetails } from "./operations/runDetails";
import { runEntrypoints } from "./operations/runEntrypoints";
import { runLookup } from "./operations/runLookup";
import { runOverview } from "./operations/runOverview";
import { runTour } from "./operations/runTour";
import { runTrace } from "./operations/runTrace";
import { SamchonGraphMemory } from "./SamchonGraphMemory";
import { SamchonRepositoryContextMemory } from "./repository";
import { ISamchonGraphApplication, ISamchonGraphEscape } from "./structures";

/**
 * The MCP tool surface as a plain class over the resident
 * {@link SamchonGraphMemory}.
 *
 * Its public method is the MCP tool: `typia.llm.application` reflects
 * {@link ISamchonGraphApplication} to generate the tool's JSON schema and
 * argument validator from the signature and JSDoc, with no hand-written schema,
 * and `@typia/mcp`'s `createMcpServer` registers it (see `./mcp/createServer`).
 * The method delegates to the pure graph functions in `./operations`, which are
 * unit-testable without a transport; this class only binds them to the graph.
 *
 * Every method answers from the current resident graph. The source may refresh
 * that graph before the operation when project files changed. Output is kept
 * compact and bounded so a model can read structure without a file read, which
 * is the token win the redesign exists for.
 */
export class SamchonGraphApplication implements ISamchonGraphApplication {
  private readonly graph: () =>
    | SamchonGraphMemory
    | Promise<SamchonGraphMemory>;
  private readonly topology:
    | (() =>
        | SamchonRepositoryContextMemory
        | Promise<SamchonRepositoryContextMemory>)
    | undefined;

  public constructor(
    source: AsyncSamchonGraphSource,
    topology?: () =>
      | SamchonRepositoryContextMemory
      | Promise<SamchonRepositoryContextMemory>,
  ) {
    this.graph = typeof source === "function" ? source : () => source;
    this.topology = topology;
  }

  public async inspect_code_graph(
    props: ISamchonGraphApplication.IProps,
  ): Promise<ISamchonGraphApplication.IOutput> {
    // An escape performs no graph work at all, so it never loads the graph:
    // a developer on a cold checkout can leave without paying for an index
    // they said they did not need.
    if (props.request.type === "escape") {
      return {
        audit: RESULT_AUDIT_ESCAPE,
        next: resultNext(
          "outside",
          "The caller chose to leave the graph, so this call carries no graph facts.",
        ),
        result: this.escape(props.request.reason, props.request.nextStep),
      };
    }
    const graph = await this.load();
    switch (props.request.type) {
      case "entrypoints": {
        // A ranked shortlist matched against the question: its facts come from
        // the index, but its selection is heuristic.
        const r = runEntrypoints(graph, props.request);
        return {
          audit: RESULT_AUDIT_SELECTION(graph.indexer),
          ...graphTrust(graph, props.request.type),
          next: r.next,
          result: r.result,
        };
      }
      case "lookup": {
        // Natural-query matching, scoring, per-file capping, and limiting make
        // this a selection audit even though every returned fact is indexed.
        const r = runLookup(graph, props.request);
        return {
          audit: RESULT_AUDIT_SELECTION(graph.indexer),
          ...graphTrust(graph, props.request.type),
          next: r.next,
          result: r.result,
        };
      }
      case "trace": {
        const r = runTrace(graph, props.request);
        return {
          audit: RESULT_AUDIT(graph.indexer),
          ...graphTrust(graph, props.request.type),
          next: r.next,
          result: r.result,
        };
      }
      case "details": {
        const r = runDetails(graph, props.request);
        return {
          audit: RESULT_AUDIT_DETAILS(graph.indexer, props.request.memberLimit),
          ...graphTrust(graph, props.request.type),
          next: r.next,
          result: r.result,
        };
      }
      case "overview": {
        const r = runOverview(graph, props.request);
        return {
          audit: RESULT_AUDIT(graph.indexer),
          ...graphTrust(graph, props.request.type),
          next: r.next,
          result: r.result,
        };
      }
      case "tour": {
        // The tour ranks against the question, and the question is `props`
        // — the caller wrote it once, at the top, in the user's words. It ranks
        // seeds, walks bounded flows, and slices to a limit.
        const r = runTour(graph, props.request, props.question);
        return {
          audit: RESULT_AUDIT_SELECTION(graph.indexer),
          ...graphTrust(graph, props.request.type),
          next: r.next,
          result: r.result,
        };
      }
      case "topology": {
        if (this.topology === undefined) {
          throw new Error(
            "@samchon/graph: repository-context source is unavailable",
          );
        }
        const topology = await this.topology();
        const confirmed = await this.load();
        const compatible =
          graph.project === topology.dump.project &&
          topology.dump.provenance.length !== 0 &&
          graph.inputGeneration !== undefined &&
          graph.inputGeneration === confirmed.inputGeneration;
        const join = compatible
          ? {
              state: "compatible" as const,
              topologyInputGeneration: topology.dump.inputGeneration,
              codeInputGeneration: graph.inputGeneration!,
            }
          : {
              state: "unavailable" as const,
              topologyInputGeneration: topology.dump.inputGeneration,
              ...(graph.inputGeneration !== undefined
                ? { codeInputGeneration: graph.inputGeneration }
                : {}),
              // One reason per condition, because a reason is a claim like any
              // other. Collapsing these would report a generation that moved
              // to a caller whose two planes describe different repositories
              // and never had a generation in common — a sentence the evidence
              // does not support, in the field a reader consults precisely
              // when the joins they expected are missing.
              reason:
                graph.project !== topology.dump.project
                  ? "The code graph and the repository-context model describe different projects, so their file identities are not comparable."
                  : topology.dump.provenance.length === 0
                    ? "No repository-context provider produced a compatible current generation."
                    : "The code generation moved while topology was loading, or the code dump predates cross-plane generation fencing.",
            };
        const result = topology.inspect(
          props.request,
          join,
          new Set(
            graph.nodes
              .filter((node) => node.kind === "file")
              .map((node) => node.file),
          ),
        );
        return {
          audit:
            "Repository topology is returned from declared or owning-tool models; file joins are included only when the code generation stayed stable across the topology load.",
          // A topology result that matched nothing is `outside`, the same
          // answer `lookup` gives a name it could not resolve. `answer` states
          // that the result carries the evidence and the caller should stop;
          // an empty one carries none, and saying otherwise would end the
          // caller's search on the strength of a repository model that never
          // mentioned what they asked about.
          next:
            result.nodes.length === 0
              ? resultNext(
                  "outside",
                  "No repository topology node matched the requested query or available provider facts.",
                )
              : resultNext(
                  "answer",
                  result.truncated
                    ? "The requested repository orientation is present, and the result states that its configured bounds truncated additional facts."
                    : "The requested repository orientation is present in this topology result.",
                ),
          result,
        };
      }
      default:
        props.request satisfies never;
        throw new Error("Unknown graph request type");
    }
  }

  private escape(reason: string, nextStep?: string): ISamchonGraphEscape {
    return {
      type: "escape",
      skipped: true,
      reason,
      ...(nextStep !== undefined ? { nextStep } : {}),
    };
  }

  private async load(): Promise<SamchonGraphMemory> {
    // Call the source on every request instead of caching its result forever:
    // the source itself now owns staleness (a resident source refreshes only
    // when a file actually changed since its last snapshot; a static
    // `--graph-file` source memoizes since it never changes). This is what
    // lets `inspect_code_graph` honor its own "rebuild after an edit"
    // guidance automatically instead of serving a permanently stale graph
    // until the whole MCP server is restarted.
    return this.graph();
  }
}
