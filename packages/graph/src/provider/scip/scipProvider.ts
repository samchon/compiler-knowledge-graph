import { GraphLanguage, GraphProviderAuthority } from "../../typings";
import { IGraphProvider } from "../IGraphProvider";
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
 * Every entry built this way inherits {@link adaptScipIndex.EDGE_KINDS} as its
 * provable facts, which is the point: a bare SCIP index cannot prove a call, a
 * construction, or a decorator, and a provider that claimed one
 * would be rejected by its own snapshot contract. A language that can prove
 * more does it through typed enrichment, not by widening this list.
 */
export function scipProvider(props: scipProvider.IProps): IGraphProvider {
  const name = props.name;
  const authority = props.authority ?? "semantic-index";
  const buildInputs = props.buildInputs;
  const resolve = props.resolve;
  const prepare = props.prepare;
  const decode = props.decode;
  const indexArgs = props.indexArgs;
  const inputs = props.inputs;
  const configuration = props.configuration;
  const compilerVersion = props.compilerVersion;
  const sourceText = props.sourceText;
  const projectRootFromInvocation = props.projectRootFromInvocation;
  const languageOf = props.languageOf;
  const languages = Object.freeze([...props.languages]);
  const enrichment =
    props.enrichment === undefined
      ? undefined
      : ScipEnrichment.normalize(props.enrichment, languages);
  const facts = Object.freeze([
    ...adaptScipIndex.EDGE_KINDS,
    ...(enrichment?.facts ?? []),
  ]);
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
          configuration: (root, env) =>
            configuration(root, languages, env),
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
        indexArgs,
        inputs: () => inputs(open.root, open.languages),
        ...(configuration === undefined
          ? {}
          : {
              configuration: () =>
                configuration(open.root, open.languages),
            }),
        ...(compilerVersion === undefined
          ? {}
          : {
              compilerVersion: () =>
                compilerVersion(open.root, open.languages),
            }),
        ...(sourceText === undefined
          ? {}
          : { sourceText }),
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
    indexArgs: (artifact: string) => string[];

    /** Every project-relative input whose change invalidates the artifact. */
    inputs: (root: string, languages: readonly GraphLanguage[]) => string[];

    /** Non-file build settings whose change invalidates the artifact. */
    configuration?: (
      root: string,
      languages: readonly GraphLanguage[],
      env?: NodeJS.ProcessEnv,
    ) => readonly string[];

    /** The compiler/toolchain revision that the indexer's analysis targets. */
    compilerVersion?: (
      root: string,
      languages: readonly GraphLanguage[],
    ) => string;

    /** Whether this producer's document text is exact source evidence. */
    sourceText?: boolean;

    /** Bind an omitted protobuf project root to this isolated invocation. */
    projectRootFromInvocation?: boolean;

    /** Versioned language facts added after the common SCIP adapter. */
    enrichment?: ScipEnrichment.IContract;

    languageOf: (file: string) => GraphLanguage;
  }
}
