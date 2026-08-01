import { IBuildGraphOptions } from "../indexer/IBuildGraphOptions";
import { GraphLanguage } from "../typings";
import { GRAPH_PROVIDERS } from "./GRAPH_PROVIDERS";
import { IGraphProvider } from "./IGraphProvider";

/**
 * Choose which registered providers serve which languages for one build.
 *
 * Discovery is data-driven: this function reads {@link GRAPH_PROVIDERS} and
 * asks each entry about itself, in order. It never names a language, and
 * adding a provider never edits it.
 */
export function selectGraphProviders(
  root: string,
  languages: readonly GraphLanguage[],
  options: IBuildGraphOptions,
  env: NodeJS.ProcessEnv = process.env,
  registry: readonly IGraphProvider[] = GRAPH_PROVIDERS,
  prepare = true,
): selectGraphProviders.IResult {
  assertOneOwnerPerLanguage(registry);
  const requested = new Set(languages);
  const candidates: selectGraphProviders.ICandidate[] = [];
  const warnings: string[] = [];
  // Asked to stand every strict provider down, and saying so.
  //
  // This exists for measurement: what a strict provider is worth can only be
  // stated against the same project indexed without one, on the same machine,
  // in the same run. Every other way of disabling one — capping files, naming a
  // server — works by tripping a refusal, which measures the refusal rather
  // than the fallback.
  if (options.strict === false) {
    return {
      candidates,
      warnings: [
        "strict providers were stood down by request, so every language falls " +
          "through to the generic language-server lane",
      ],
    };
  }

  for (const provider of registry) {
    const owned = provider.languages.filter((language) =>
      requested.has(language),
    );
    if (owned.length === 0) continue;
    const routes: selectGraphProviders.IRouteCandidate[] = [];
    for (const route of [provider, ...(provider.fallbacks ?? [])]) {
      const refusal = route.refuse(options);
      if (refusal !== undefined) {
        warnings.push(refusal);
        continue;
      }

      const command = route.resolve(root, env);
      if (command === undefined) {
        warnings.push(
          `${owned.join(", ")}: the ${route.name} ${route.authority} provider was not found for this project; trying the next strict route if one is available.`,
        );
        continue;
      }

      if (prepare && route.prepare !== undefined) {
        try {
          route.prepare(root, options);
        } catch (error) {
          warnings.push(
            `${owned.join(", ")}: the ${route.name} ${route.authority} provider could not prepare this project, so it cannot answer for it: ${(error as Error).message}`,
          );
          continue;
        }
      }
      routes.push({ provider: route, languages: owned, command });
    }
    const [selected, ...fallbacks] = routes;
    if (selected !== undefined) candidates.push({ ...selected, fallbacks });
  }

  return { candidates, warnings };
}

export namespace selectGraphProviders {
  /** One provider that can serve this build, and the languages it will own. */
  export interface ICandidate {
    provider: IGraphProvider;

    /**
     * The subset of the provider's languages this build actually selected.
     *
     * A Clang provider registered for C and C++ owns only C in a project with
     * no C++ sources, and its session must say so: publishing an empty C++
     * slice would delete nothing but would claim the language was indexed.
     */
    languages: GraphLanguage[];

    command: IGraphProvider.ICommand;

    /** Already-resolved strict routes attempted if this route fails. */
    fallbacks: IRouteCandidate[];
  }

  export type IRouteCandidate = Omit<ICandidate, "fallbacks">;

  export interface IResult {
    /** Providers that can serve this build, in registry order. */
    candidates: ICandidate[];

    /**
     * One sentence per language that a registered provider could have served
     * but will not, naming the provider and the reason.
     *
     * Every declined candidate produces exactly one of these. The condition
     * this replaces was folded into the indexer's language loop with no
     * `else`, so a caller whose options disabled the compiler-owned lane got a
     * generic-LSP success that read exactly like the strict result it had
     * silently replaced. A fallback nobody can see is the failure; the
     * sentence is the fix.
     */
    warnings: string[];
  }
}

/**
 * No language may have two registered owners.
 *
 * Checked over the whole registry rather than over the providers that happened
 * to resolve, because the defect is static: a registry where two entries claim
 * Go is malformed whether or not both indexers are installed today. Deferring
 * the check to the resolved set would let it pass on every machine missing one
 * of them and fail on the one machine that has both.
 */
function assertOneOwnerPerLanguage(
  registry: readonly IGraphProvider[],
): void {
  const owners = new Map<GraphLanguage, IGraphProvider>();
  const names = new Set<string>();
  for (const provider of registry) {
    for (const route of [provider, ...(provider.fallbacks ?? [])]) {
      if (names.has(route.name)) {
        throw new Error(
          `@samchon/graph: provider "${route.name}" is registered more than once; provenance needs one stable provider identity`,
        );
      }
      names.add(route.name);
      if (route.languages.length === 0) {
        throw new Error(
          `@samchon/graph: provider "${route.name}" owns no language, so nothing can select it`,
        );
      }
      if (new Set(route.facts).size !== route.facts.length) {
        throw new Error(
          `@samchon/graph: provider "${route.name}" declares one fact family more than once`,
        );
      }
      if (route !== provider) {
        if (route.fallbacks !== undefined) {
          throw new Error(
            `@samchon/graph: fallback provider "${route.name}" cannot declare another fallback tier`,
          );
        }
        if (!sameLanguages(route.languages, provider.languages)) {
          throw new Error(
            `@samchon/graph: fallback provider "${route.name}" does not own the same atomic languages as "${provider.name}"`,
          );
        }
      }
    }
    for (const language of provider.languages) {
      const existing = owners.get(language);
      if (existing !== undefined) {
        throw new Error(
          `@samchon/graph: providers "${existing.name}" and "${provider.name}" both claim ${language}; one language cannot have two owners`,
        );
      }
      owners.set(language, provider);
    }
  }
}

function sameLanguages(
  left: readonly GraphLanguage[],
  right: readonly GraphLanguage[],
): boolean {
  const uniqueLeft = new Set(left);
  const uniqueRight = new Set(right);
  return (
    uniqueLeft.size === uniqueRight.size &&
    [...uniqueLeft].every((language) => uniqueRight.has(language))
  );
}
