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
     * The probe cost is accepted because a non-serving candidate has no other
     * way to report its repair. Its evidence metadata lets a transient launch
     * failure retain the prior established row; only a newly established
     * configuration change moves the topology and retries the candidate. For a
     * serving provider, where even the probe would be duplicate work, the
     * derivation is absent entirely.
     */
    configuration?: string[];

    /**
     * Exact configuration indexes whose derivation established nothing.
     *
     * Internal resident evidence only. {@link serialize} deliberately omits it
     * so topology remains the same public string snapshot it has always been.
     */
    configurationInconclusive?: number[];

    /** Stable private identities aligned with {@link configuration}. */
    configurationIdentities?: (string | undefined)[];
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
      const derivation =
        servedBy.has(candidate.provider.name) ||
        (candidate.provider.configurationDerivation === undefined &&
          candidate.provider.configuration === undefined)
          ? undefined
          : toolchainVersion.sort(
              candidate.provider.configurationDerivation?.(root, env) ??
                candidate.provider.configuration!(root, env),
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
        ...(derivation === undefined
          ? {}
          : {
              configuration: [...derivation.rows],
              ...(derivation.identities.some(
                (identity) => identity !== undefined,
              )
                ? {
                    configurationIdentities: [
                      ...derivation.identities,
                    ],
                  }
                : {}),
              ...(derivation.inconclusive.length === 0
                ? {}
                : {
                    configurationInconclusive: [
                      ...derivation.inconclusive,
                    ],
                  }),
            }),
      };
    });
  }

  export function serialize(available: readonly IRow[]): string {
    return JSON.stringify(
      available.map(
        ({
          configurationInconclusive: _inconclusive,
          configurationIdentities: _identities,
          ...row
        }) => row,
      ),
    );
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
      const previous = prior.get(row.provider);
      if (
        row.configuration === undefined ||
        previous?.configuration === undefined
      ) {
        return row;
      }
      const derivation = toolchainVersion.sort(
        toolchainVersion.reestablish(
          {
            rows: row.configuration,
            inconclusive: row.configurationInconclusive ?? [],
            identities:
              row.configurationIdentities ??
              row.configuration.map(() => undefined),
          },
          {
            rows: previous.configuration,
            inconclusive:
              previous.configurationInconclusive ?? [],
            identities:
              previous.configurationIdentities ??
              previous.configuration.map(() => undefined),
          },
        ),
      );
      const {
        configurationInconclusive: _inconclusive,
        configurationIdentities: _identities,
        ...visible
      } = row;
      return {
        ...visible,
        configuration: [...derivation.rows],
        ...(derivation.identities.some(
          (identity) => identity !== undefined,
        )
          ? {
              configurationIdentities: [
                ...derivation.identities,
              ],
            }
          : {}),
        ...(derivation.inconclusive.length === 0
          ? {}
          : {
              configurationInconclusive: [
                ...derivation.inconclusive,
              ],
            }),
      };
    });
  }
}

function compareOrdinal(left: string, right: string): number {
  // Two-way: topology values are distinct set members, so the equal arm cannot
  // run, and an ignore directive over it would take the two reachable arms out
  // of the coverage gate with it -- which is how a reversed ordering stops
  // being a failing test.
  return left < right ? -1 : 1;
}
