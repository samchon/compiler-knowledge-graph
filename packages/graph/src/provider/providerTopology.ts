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

    /**
     * Effective settings, present only for a candidate that did not serve.
     *
     * A configuration row is a toolchain version, and deriving one launches the
     * tool. For a provider that is serving, its own session already derives
     * these once per refresh to decide whether its artifact is stale, so asking
     * again here would be a second answer to a settled question — paid on every
     * resident load, which is every request a long-lived server answers.
     *
     * A candidate that resolved and then did not serve has no session to ask.
     * Its build universe is the only evidence that the reason it fell back has
     * been repaired: a developer who fixes the toolchain and edits nothing
     * would otherwise stay on the generic lane until some unrelated file moved.
     *
     * The cost of that is worth stating. A probe that fails for a reason
     * unrelated to the project moves this row, and a moved row rebuilds every
     * language rather than one artifact. It is accepted only because a
     * non-serving candidate is already degraded, where one rebuild is cheaper
     * than never retrying; for a serving provider, where it would be pure loss,
     * the derivation is absent entirely.
     */
    configuration?: string[];
  }

  /**
   * Non-mutating provider eligibility and command snapshot.
   *
   * `servedBy` names the providers that actually produced this build. Rows
   * outside it carry their configuration, for the reason {@link IRow} states.
   */
  export function available(
    root: string,
    languages: readonly GraphLanguage[],
    options: IBuildGraphOptions,
    env: NodeJS.ProcessEnv = process.env,
    registry: readonly IGraphProvider[] = GRAPH_PROVIDERS,
    servedBy: ReadonlySet<string> = new Set(),
  ): IRow[] {
    if (options.mode === "static") return [];
    return selectGraphProviders(
      root,
      languages,
      options,
      env,
      registry,
      false,
    ).candidates.map((candidate) => {
      const configuration =
        servedBy.has(candidate.provider.name) ||
        candidate.provider.configuration === undefined
          ? undefined
          : [...candidate.provider.configuration(root, env)].sort(
              compareOrdinal,
            );
      return {
        provider: candidate.provider.name,
        languages: [...candidate.languages].sort(compareOrdinal),
        command: candidate.command.command,
        args: [...candidate.command.args],
        windowsVerbatimArguments:
          candidate.command.windowsVerbatimArguments === true,
        windowsDoubleEscapeArguments:
          candidate.command.windowsDoubleEscapeArguments === true,
        ...(configuration === undefined ? {} : { configuration }),
      };
    });
  }

  export function serialize(available: readonly IRow[]): string {
    return JSON.stringify(available);
  }
}

function compareOrdinal(left: string, right: string): number {
  /* c8 ignore next 2 -- topology values are distinct set members. */
  return left < right ? -1 : left > right ? 1 : 0;
}
