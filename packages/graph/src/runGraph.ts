import packageJson from "../package.json";
import { buildGraphDump } from "./indexer/buildGraphDump";
import { startServer } from "./mcp/startServer";
import { parseGraphArgs } from "./parseGraphArgs";
import { routeSummary } from "./routeSummary";
import { ISamchonGraphDump } from "./structures";
import { runView } from "./view";

const VERSION: string = packageJson.version;

export function runGraph(argv: readonly string[] = process.argv.slice(
  2,
)): number | undefined {
  try {
    // The viewer is a long-lived subprocess surface and is exercised by the
    // HTTP black-box test; a killed child cannot flush V8 coverage into c8.
    /* c8 ignore start */
    if (argv[0] === "view") {
      void runView(argv.slice(1))
        .then((code) => {
          if (typeof code === "number") process.exitCode = code;
        })
        .catch((error: unknown) => {
          writeError(error as Error);
          process.exitCode = 1;
        });
      return undefined;
    }
    /* c8 ignore stop */
    if (argv[0] === "dump") {
      void runDump(argv.slice(1));
      return undefined;
    }
    if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
      process.stdout.write(helpText());
      return 0;
    }

    const options = parseGraphArgs(argv);
    void startServer({ ...options, version: VERSION }).catch(
      (error: unknown) => {
        /* c8 ignore next 2 */
        writeError(error as Error);
        process.exit(1);
      },
    );
    return undefined;
  } catch (error) {
    writeError(error as Error);
    return 1;
  }
}

async function runDump(argv: readonly string[]): Promise<void> {
  const controller = new AbortController();
  // A benchmark timeout sends SIGTERM to this CLI process. Convert it into the
  // same abort contract resident callers use, so an in-flight strict producer
  // or language server retires its owned process tree before the dump exits.
  // Without this handler the timed-out CLI died first and left that server
  // consuming the host while the next supposedly quiet cell was measured.
  /* c8 ignore start -- exercised by the POSIX child-process integration; the
   * Windows coverage host cannot deliver a catchable SIGTERM to Node, so the
   * function identity itself is unreachable there as well as its body. */
  const abort = (): void => controller.abort();
  /* c8 ignore stop */
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const dump = await buildGraphDump({
      ...parseGraphArgs(argv),
      signal: controller.signal,
    });
    // What produced this graph, on stderr, before the payload goes to stdout.
    //
    // A dump says how long it took and nothing about which path it took, and
    // the two are not separable afterwards: a strict provider and the generic
    // language-server lane emit the same shape. A benchmark lane spent an hour
    // timing out without its log being able to say whether the strict producer
    // had served, had not been installed, or had been installed and declined.
    //
    // stderr rather than stdout because the payload reaches hundreds of
    // megabytes and callers pipe it to /dev/null; one line beside it costs
    // nothing and does not move a measured number the way writing the payload
    // to a file would.
    process.stderr.write(`${dumpSummary(dump)}\n`);
    process.stdout.write(`${JSON.stringify(dump, null, 2)}\n`);
  } catch (error) {
    writeError(error as Error);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

/**
 * What produced this graph, and what stopped anything better from producing it.
 *
 * The second half is not decoration. A dump that fell to the static syntax
 * reader looks, from its duration alone, like a fast semantic index — a
 * TypeScript corpus came back in under three seconds and was read as the
 * flagship provider being quick, when in fact neither the strict provider nor
 * the language server had served at all. The build already collects the reasons
 * and used to keep them inside a payload every caller discards.
 */
function dumpSummary(dump: ISamchonGraphDump): string {
  const served = (dump.provenance ?? []).map(
    (entry) => `${entry.provider}(${entry.languages.join(",")})`,
  );
  /* c8 ignore start -- naming a provider needs one installed, and this suite
   * installs none by design: its producers are deterministic fixtures, so every
   * dump it takes falls through and reports the other arm. */
  const by =
    served.length === 0 ? "no strict provider served" : served.join(" ");
  /* c8 ignore stop */
  const lines = [
    `@samchon/graph: indexer=${dump.indexer} ${by}`,
    `@samchon/graph: route=${routeSummary(dump)}`,
  ];
  /* c8 ignore start -- the field is optional in the dump contract and always
   * present in practice, so the empty-fallback arm guards a shape no producer
   * in this repository emits. */
  for (const warning of dump.warnings ?? [])
    lines.push(
      `@samchon/graph: ${warning.replace(/^@samchon\/graph:\s*/, "")}`,
    );
  /* c8 ignore stop */
  return lines.join("\n");
}

function helpText(): string {
  return `@samchon/graph

Usage:
  samchon-graph [--cwd DIR] [--mode auto|lsp|static] [--language LANG]
  samchon-graph dump [same options]
  samchon-graph view [same options] [--port N] [--no-open] [--max-nodes N]

Options:
  --no-strict               Stand strict providers down for comparison.
  --server CMD              Override the language server command.
  --server-arg ARG          Add one language server argument.
  --lsp-concurrency N       Concurrent reference requests.
  --lsp-ready-quiet-ms N    Quiet period that marks initial indexing settled.
  --graph-file PATH         Serve a pre-built dump instead of indexing.
`;
}

function writeError(error: Error): void {
  process.stderr.write(`@samchon/graph: ${error.message}\n`);
}
