import { IBuildGraphOptions } from "../indexer/IBuildGraphOptions";
import { GraphLanguage } from "../typings";
import { GRAPH_PROVIDERS } from "./GRAPH_PROVIDERS";
import { IGraphProvider } from "./IGraphProvider";
import { selectGraphProviders } from "./selectGraphProviders";
import { toolchainVersion } from "./toolchainVersion";

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

  /**
   * This topology, with each unasked configuration row restored from the last
   * one that established something.
   *
   * `BatchGraphSession` already does this for a provider that is serving. The
   * topology is the other half, and until now it did not: a probe that failed
   * to launch inside a candidate nothing is currently using still changed the
   * serialized topology, and the resident source treats any change as
   * structural and rebuilds every language. A `where.exe` that could not start
   * cost a full reindex of a project it had nothing to do with.
   *
   * The exposure grows with the registry. Every provider registered for a
   * language this project does not use is another candidate whose toolchain
   * gets probed on every refresh, and a half-installed toolchain is exactly the
   * kind that fails intermittently — which is also why it is not serving.
   *
   * Row by row and provider by provider, for the reason the session-level
   * repair had to be: substituting a whole derivation because one entry went
   * unasked throws away the entries that did establish something, including a
   * setting the user genuinely changed.
   */
  export function reestablish(
    live: readonly IRow[],
    established: readonly IRow[] | undefined,
  ): IRow[] {
    if (established === undefined) return [...live];
    const prior = new Map(established.map((row) => [row.provider, row]));
    return live.map((row) => {
      const before = prior.get(row.provider)?.configuration;
      if (row.configuration === undefined || before === undefined) return row;
      return {
        ...row,
        configuration: [
          ...toolchainVersion.reestablish(row.configuration, before),
        ],
      };
    });
  }
}

function compareOrdinal(left: string, right: string): number {
  /* c8 ignore next 2 -- topology values are distinct set members. */
  return left < right ? -1 : left > right ? 1 : 0;
}
