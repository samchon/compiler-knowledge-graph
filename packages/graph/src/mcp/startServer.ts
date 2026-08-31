import fs from "node:fs";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AsyncSamchonGraphSource } from "../AsyncSamchonGraphSource";
import { createResidentGraphSource } from "../indexer/createResidentGraphSource";
import { discoverLanguages } from "../indexer/discoverLanguages";
import { IBuildGraphOptions } from "../indexer/IBuildGraphOptions";
import { IResidentGraphSource } from "../indexer/IResidentGraphSource";
import { normalizeRequestedLanguages } from "../indexer/normalizeRequestedLanguages";
import { parseGraphDump } from "../indexer/parseGraphDump";
import { SamchonGraphMemory } from "../SamchonGraphMemory";
import { SamchonGraphSourceReader } from "../SamchonGraphSourceReader";
import { GraphLanguage } from "../typings";
import {
  createResidentRepositoryContextMemorySource,
  createResidentRepositoryContextSource,
} from "../repository";
import { createCompositeResidentClose } from "./createCompositeResidentClose";
import { createResidentCloseHandler } from "./createResidentCloseHandler";
import { createResidentGraphMemorySource } from "./createResidentGraphMemorySource";
import { createServer } from "./createServer";

/**
 * Serve the graph tools over MCP on stdio. The server answers the MCP handshake
 * immediately and opens the resident incremental graph session on the first real
 * tool call, so a large project cannot make the client give up before tools are
 * advertised and an escape request still performs no graph work.
 *
 * That is not a nicety. A host may lazy-load a tool's schema behind a search
 * step (§4b), so a server that is still `pending` at session init is a server
 * the model starts its turn *without* — it shells out to `grep` and `find`
 * instead, and every extra call re-sends the whole context. The tool that exists
 * to cut the context bill is then absent from the turn that runs it up.
 */
export async function startServer(
  options: IBuildGraphOptions & { version: string; graphFile?: string },
): Promise<void> {
  // A pre-built dump (`--graph-file`) serves immediately — the expensive index
  // was paid once, outside this process, the same way comparator tools pay
  // their `init`. It is a static snapshot with no live LSP connection behind
  // it, so it is read once and cached forever rather than watched for edits.
  //
  // Without `--graph-file`, the resident source keeps every language's LSP
  // connection open past the first build and re-scans only when a source file's
  // contents have changed since the last check, reusing the warm connection
  // instead of restarting the language server (and paying its full cold start,
  // e.g. kotlin-language-server's Gradle sync) on every call.
  //
  // Either way the active language(s) are resolved eagerly here — from the
  // dump itself, or from a cheap file-extension scan that doesn't need a live
  // LSP session — so the tool description can name the language a session
  // actually indexes instead of staying generic. Neither reads a graph.
  let source: AsyncSamchonGraphSource;
  let languages: GraphLanguage[];
  let resident: IResidentGraphSource | undefined;
  if (options.graphFile !== undefined) {
    const dump = parseGraphDump(
      JSON.parse(fs.readFileSync(options.graphFile, "utf8")),
    );
    languages = dump.languages;
    source = once(() =>
      // A graph file proves the generation it was built from, but this static
      // server never revalidates that token against the current checkout.
      // Preserve the graph facts while withholding cross-plane compatibility:
      // otherwise a current topology model could join to arbitrarily stale
      // code merely because two reads returned the same memoized object.
      SamchonGraphMemory.from(
        { ...dump, generation: undefined },
        SamchonGraphSourceReader.none(dump.project),
      ),
    );
  } else {
    const root = path.resolve(options.cwd ?? process.cwd());
    languages =
      normalizeRequestedLanguages(options.languages) ??
      discoverLanguages(root, options);
    const opened = createResidentGraphSource(options);
    resident = opened;
    source = createResidentGraphMemorySource(opened);
  }
  const topologyResident = createResidentRepositoryContextSource(
    options.graphFile === undefined
      ? path.resolve(options.cwd ?? process.cwd())
      : (await source()).project,
  );
  const topology = createResidentRepositoryContextMemorySource(
    topologyResident,
  );
  const server = createServer(source, options.version, languages, topology);
  const transport = new StdioServerTransport();
  // The resident source holds a live language-server process per language, and
  // nothing else is going to end them: a client that disconnects closes the
  // transport, and a client that exits closes our stdin. Either way the session
  // goes with it — an orphaned language server outliving the MCP server that
  // spawned it would hold the process's event loop open and keep a whole Gradle
  // or solution load resident behind a session nobody is talking to.
  const close = createResidentCloseHandler(
    createCompositeResidentClose([resident, topologyResident]),
  );
  // These two bodies run only when the MCP transport is torn down gracefully --
  // a client that closes the transport, or a client exit that ends our stdin.
  // The deterministic harness disconnects by killing the spawned server
  // process, which never runs a graceful teardown handler, so there is no
  // in-process trigger for either callback. The close logic itself is covered
  // by the createResidentCloseHandler tests; only these process-boundary
  // bindings are exempt.
  /* c8 ignore start */
  transport.onclose = () => void close();
  process.stdin.once("end", () => void close());
  /* c8 ignore stop */
  await server.connect(transport);
}

// Memoizes a zero-arg function's first resolved value; a rejected call is not
// cached so a transient failure can be retried on the next call.
function once<T>(fn: () => T): () => T {
  let value: T | undefined;
  let loaded = false;
  return () => {
    if (!loaded) {
      value = fn();
      loaded = true;
    }
    return value as T;
  };
}
