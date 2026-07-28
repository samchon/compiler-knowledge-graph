import {
  GraphEdgeKind,
  GraphLanguage,
  GraphProviderAuthority,
} from "../../typings";
import { IGraphProvider } from "../IGraphProvider";
import { toolchainVersion } from "../toolchainVersion";
import { adaptScipIndex } from "./adaptScipIndex";
import { ScipSession } from "./ScipSession";
import { ScipEnrichment } from "./ScipEnrichment";

/**
 * Build a registry entry for one language-owned SCIP indexer.
 *
 * The ingestion, validation, and lifecycle are the same for every SCIP
 * indexer; what differs is which executable to run, what to pass it, and which
 * files decide its output. Those three are what a caller supplies here, so a
 * language provider is a description rather than a class — and the fourteen of
 * them cannot drift apart in the parts that are supposed to be identical.
 *
 * Every entry built this way starts from {@link adaptScipIndex.EDGE_KINDS} as
 * its provable facts. A producer that omits one of those common SCIP fields
 * narrows the list through `omitFacts`; a language that can prove more widens
 * it only through typed enrichment. A bare SCIP index cannot prove a call,
 * construction, or decorator, and a provider that claimed one would be
 * rejected by its own snapshot contract.
 */
export function scipProvider(props: scipProvider.IProps): IGraphProvider {
  const name = props.name;
  const authority = props.authority ?? "semantic-index";
  const buildInputs = props.buildInputs;
  const resolve = props.resolve;
  const prepare = props.prepare;
  const decode = props.decode;
  const indexArgs = props.indexArgs;
  const artifactFrom = props.artifactFrom;
  const inputs = props.inputs;
  const validateConfiguration = props.validateConfiguration;
  const configuration = props.configuration;
  const compilerVersion = props.compilerVersion;
  const sourceText = props.sourceText;
  const omitFacts = props.omitFacts;
  const projectRootFromInvocation = props.projectRootFromInvocation;
  const languageOf = props.languageOf;
  const preferFileLanguage = props.preferFileLanguage;
  const languages = Object.freeze([...props.languages]);
  const enrichment =
    props.enrichment === undefined
      ? undefined
      : ScipEnrichment.normalize(props.enrichment, languages);
  // The registry claim and the published provenance are the same list by
  // construction. `assertGraphSnapshotContract` requires them to be equal, so
  // subtracting a family from one and not the other would not narrow a claim —
  // it would refuse every snapshot the provider produced.
  const facts = Object.freeze(
    [...adaptScipIndex.EDGE_KINDS, ...(enrichment?.facts ?? [])].filter(
      (fact) => !(omitFacts ?? []).includes(fact),
    ),
  );
  const provider: IGraphProvider = {
    name,
    languages,
    authority,
    facts,
    ...(buildInputs === undefined
      ? {}
      : { buildInputs }),
    ...(configuration === undefined
      ? {}
      : {
          configuration: (root, env) => [
            ...toolchainVersion.normalize(
              configuration(root, languages, env),
            ).rows,
          ],
          configurationDerivation: (root, env) =>
            toolchainVersion.normalize(
              configuration(root, languages, env),
            ),
        }),

    // A SCIP indexer answers with a whole-workspace artifact and has no
    // bounded mode, so the same refusal the compiler-owned lane makes applies:
    // honouring a cap would mean indexing everything and then deleting facts,
    // which costs what the cap was meant to save and leaves missing edges
    // indistinguishable from absent ones.
    refuse: (options) => {
      const refused: string[] = [];
      if (options.server !== undefined) refused.push("server");
      if (options.maxFiles !== undefined) refused.push("maxFiles");
      if (options.lspReferenceLimit !== undefined) {
        refused.push("lspReferenceLimit");
      }
      if (refused.length === 0) return undefined;
      // Names the authority as well as the provider, because that is what a
      // reader loses: the sentence has to say which grade of fact the build
      // gave up, not merely which program it did not run.
      return (
        `${languages.join(", ")}: the ${name} ${authority} provider is disabled by ${refused.join(", ")}; ` +
        `it publishes whole-workspace indexes and has no bounded mode, so these languages fall through to the generic language-server lane. ` +
        `Drop ${refused.length === 1 ? "that option" : "those options"} for a strict index.`
      );
    },

    resolve,
    ...(prepare === undefined ? {} : { prepare }),

    open: (open) =>
      new ScipSession({
        root: open.root,
        languages: open.languages,
        provider: name,
        authority,
        command: open.command,
        decode: decode(open.root),
        indexArgs: (artifact) => indexArgs(artifact, open.root),
        ...(artifactFrom === undefined ? {} : { artifactFrom }),
        inputs: () => inputs(open.root, open.languages),
        ...(configuration === undefined
          ? {}
          : {
              configuration: () => {
                const current = toolchainVersion.normalize(
                  configuration(open.root, open.languages),
                );
                validateConfiguration?.(
                  open.root,
                  open.languages,
                  current.rows,
                );
                return current;
              },
            }),
        ...(compilerVersion === undefined
          ? {}
          : {
              compilerVersion: (configuration) =>
                compilerVersion(open.root, open.languages, configuration),
            }),
        ...(sourceText === undefined
          ? {}
          : { sourceText }),
        ...(omitFacts === undefined ? {} : { omitFacts }),
        ...(preferFileLanguage === undefined
          ? {}
          : { preferFileLanguage }),
        ...(projectRootFromInvocation === undefined
          ? {}
          : {
              projectRootFromInvocation,
            }),
        ...(enrichment === undefined
          ? {}
          : { enrichment }),
        languageOf,
      }),
  };
  return provider;
}

export namespace scipProvider {
  export interface IProps {
    /** Registry name, such as `scip-go`. */
    name: string;

    /** Every language this indexer owns. Never empty. */
    languages: readonly GraphLanguage[];

    /**
     * What its facts are grounded in.
     *
     * `semantic-index` unless the indexer is the language's own compiler
     * driving its real checker, in which case it is entitled to say so.
     */
    authority?: GraphProviderAuthority;

    /** Inputs outside the language's own extensions that invalidate a build. */
    buildInputs?: IGraphProvider["buildInputs"];

    resolve: IGraphProvider["resolve"];
    prepare?: IGraphProvider["prepare"];

    /** The pinned helper that decodes a binary index to JSON. */
    decode: (root: string) => { command: string; args: readonly string[] };

    /** Arguments that direct the indexer's output to one isolated artifact. */
    indexArgs: (artifact: string, root: string) => string[];
    artifactFrom?: (root: string) => string;

    /** Every project-relative input whose change invalidates the artifact. */
    inputs: (root: string, languages: readonly GraphLanguage[]) => string[];

    /** Non-file build settings whose change invalidates the artifact. */
    configuration?: (
      root: string,
      languages: readonly GraphLanguage[],
      env?: NodeJS.ProcessEnv,
    ) => readonly string[] | toolchainVersion.IDerivation;

    /** Refuse configuration rows that no longer meet provider selection. */
    validateConfiguration?: (
      root: string,
      languages: readonly GraphLanguage[],
      configuration: readonly string[],
    ) => void;

    /** The compiler/toolchain revision that the indexer's analysis targets. */
    /**
     * Given the configuration rows the universe was computed from, so the
     * published compiler is the one that universe saw rather than whatever a
     * second probe would return a moment later.
     */
    compilerVersion?: (
      root: string,
      languages: readonly GraphLanguage[],
      configuration: readonly string[],
    ) => string;

    /** Whether this producer's document text is exact source evidence. */
    sourceText?: boolean;

    /** Fact families this indexer provably does not emit. */
    omitFacts?: readonly GraphEdgeKind[];

    /** Bind an omitted protobuf project root to this isolated invocation. */
    projectRootFromInvocation?: boolean;

    /** Versioned language facts added after the common SCIP adapter. */
    enrichment?: ScipEnrichment.IContract;

    languageOf: (file: string) => GraphLanguage;

    /** Prefer file extensions over a producer's unreliable document language. */
    preferFileLanguage?: boolean;
  }
}
