import { IBuildGraphOptions } from "../indexer/IBuildGraphOptions";
import { GraphLanguage } from "../typings";
import { GRAPH_PROVIDERS } from "./GRAPH_PROVIDERS";
import { IGraphProvider } from "./IGraphProvider";
import { selectGraphProviders } from "./selectGraphProviders";

export namespace providerTopology {
  export interface IRow {
    provider: string;
    languages: GraphLanguage[];
    command: string;
    args: string[];
    windowsVerbatimArguments: boolean;
    windowsDoubleEscapeArguments: boolean;
  }

  /**
   * Non-mutating provider eligibility and command snapshot.
   *
   * Eligibility only, deliberately. This used to carry each provider's
   * effective configuration as well, and a configuration row is a toolchain
   * version whose derivation launches the tool — so the resident source paid
   * several synchronous process launches per provider on every load, and then
   * paid for them again when the session it was about to refresh derived the
   * same rows for its own build universe.
   *
   * Worse than the cost was what it decided. A probe that failed for any
   * reason unrelated to the project came back as an `unavailable` row, the
   * serialized topology moved, and the resident answered that by discarding a
   * valid index and rebuilding every language. The build universe already has
   * an owner: {@link BatchGraphSession} reads the rows once per refresh and
   * rebuilds its own snapshot when they move. Asking here as well added a
   * second answer to a settled question and a way to get it wrong.
   */
  export function available(
    root: string,
    languages: readonly GraphLanguage[],
    options: IBuildGraphOptions,
    env: NodeJS.ProcessEnv = process.env,
    registry: readonly IGraphProvider[] = GRAPH_PROVIDERS,
  ): IRow[] {
    if (options.mode === "static") return [];
    return selectGraphProviders(
      root,
      languages,
      options,
      env,
      registry,
      false,
    ).candidates.map((candidate) => ({
      provider: candidate.provider.name,
      languages: [...candidate.languages].sort(compareOrdinal),
      command: candidate.command.command,
      args: [...candidate.command.args],
      windowsVerbatimArguments:
        candidate.command.windowsVerbatimArguments === true,
      windowsDoubleEscapeArguments:
        candidate.command.windowsDoubleEscapeArguments === true,
    }));
  }

  export function serialize(available: readonly IRow[]): string {
    return JSON.stringify(available);
  }
}

function compareOrdinal(left: string, right: string): number {
  /* c8 ignore next 2 -- topology values are distinct set members. */
  return left < right ? -1 : left > right ? 1 : 0;
}
