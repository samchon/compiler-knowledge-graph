import { buildGraph } from "./indexer/buildGraph";
import { LANGUAGE_SPECS } from "./indexer/LANGUAGE_SPECS";
import { GraphLanguage } from "./typings";

export type IGraphArguments = Parameters<typeof buildGraph>[0] & {
  graphFile?: string;
};

/** Parse the graph arguments shared by the MCP, dump, and viewer launchers. */
export function parseGraphArgs(argv: readonly string[]): IGraphArguments {
  const options: IGraphArguments = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    if (arg === "--cwd") options.cwd = next();
    else if (arg.startsWith("--cwd=")) options.cwd = arg.slice("--cwd=".length);
    else if (arg === "--no-strict") options.strict = false;
    else if (arg === "--mode") options.mode = parseMode(next());
    else if (arg.startsWith("--mode="))
      options.mode = parseMode(arg.slice("--mode=".length));
    else if (arg === "--language")
      options.languages = [...(options.languages ?? []), parseLanguage(next())];
    else if (arg.startsWith("--language="))
      options.languages = [
        ...(options.languages ?? []),
        parseLanguage(arg.slice("--language=".length)),
      ];
    else if (arg === "--server") options.server = next();
    else if (arg.startsWith("--server="))
      options.server = arg.slice("--server=".length);
    else if (arg === "--server-arg")
      options.serverArgs = [...(options.serverArgs ?? []), next()];
    else if (arg.startsWith("--server-arg="))
      options.serverArgs = [
        ...(options.serverArgs ?? []),
        arg.slice("--server-arg=".length),
      ];
    else if (arg === "--lsp-concurrency")
      options.lspConcurrency = parseGraphArgs.safeInteger(
        next(),
        "--lsp-concurrency",
      );
    else if (arg.startsWith("--lsp-concurrency="))
      options.lspConcurrency = parseGraphArgs.safeInteger(
        arg.slice("--lsp-concurrency=".length),
        "--lsp-concurrency",
      );
    else if (arg === "--lsp-ready-quiet-ms")
      options.lspReadyQuietMs = parseGraphArgs.safeInteger(
        next(),
        "--lsp-ready-quiet-ms",
      );
    else if (arg.startsWith("--lsp-ready-quiet-ms="))
      options.lspReadyQuietMs = parseGraphArgs.safeInteger(
        arg.slice("--lsp-ready-quiet-ms=".length),
        "--lsp-ready-quiet-ms",
      );
    else if (arg === "--graph-file") options.graphFile = next();
    else if (arg.startsWith("--graph-file="))
      options.graphFile = arg.slice("--graph-file=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function parseMode(value: string): "auto" | "lsp" | "static" {
  if (value === "auto" || value === "lsp" || value === "static") return value;
  throw new Error(`Invalid --mode: ${value}`);
}

const ALLOWED_LANGUAGES = new Set<string>([
  ...LANGUAGE_SPECS.map((spec) => spec.language),
]);

function parseLanguage(value: string): GraphLanguage {
  if (!ALLOWED_LANGUAGES.has(value))
    throw new Error(`Invalid --language: ${value}`);
  return value as GraphLanguage;
}

export namespace parseGraphArgs {
  export function safeInteger(
    value: string,
    label: string,
    minimum = 1,
    maximum = Number.MAX_SAFE_INTEGER,
  ): number {
    const parsed = Number(value);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed < minimum ||
      parsed > maximum
    ) {
      throw new Error(
        `Expected ${label} to be an integer from ${minimum} through ${maximum}, got: ${value}`,
      );
    }
    return parsed;
  }
  /* c8 ignore start -- declaration merging emits an `X || (X = {})` branch
   * after the function declaration, so the namespace's creation arm is
   * unreachable. */
}
/* c8 ignore stop */
