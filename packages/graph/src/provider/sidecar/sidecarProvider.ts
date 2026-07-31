import {
  GraphEdgeKind,
  GraphLanguage,
  GraphProviderAuthority,
} from "../../typings";
import { assertGraphSnapshotContract } from "../assertGraphSnapshotContract";
import { IGraphProvider } from "../IGraphProvider";
import { toolchainVersion } from "../toolchainVersion";
import { SidecarSession } from "./SidecarSession";

/** Build one registry entry for a normalized compiler/analyzer sidecar. */
export function sidecarProvider(
  props: sidecarProvider.IProps,
): IGraphProvider {
  const configuration = props.configuration;
  const provider: IGraphProvider = {
    name: props.name,
    languages: props.languages,
    authority: props.authority,
    facts: props.facts,
    ...(props.resolution === undefined
      ? {}
      : { resolution: props.resolution }),
    ...(props.buildInputs === undefined
      ? {}
      : { buildInputs: props.buildInputs }),
    ...(configuration === undefined
      ? {}
      : {
          configuration: (root, env) => [
            ...toolchainVersion.normalize(
              configuration(root, props.languages, env),
            ).rows,
          ],
          configurationDerivation: (root, env) =>
            toolchainVersion.normalize(
              configuration(root, props.languages, env),
            ),
        }),
    refuse: (options) => {
      const refused: string[] = [];
      if (options.server !== undefined) refused.push("server");
      if (options.maxFiles !== undefined) refused.push("maxFiles");
      if (options.lspReferenceLimit !== undefined) {
        refused.push("lspReferenceLimit");
      }
      if (refused.length === 0) return undefined;
      const disabled = refused.join(", ");
      return (
        `${props.languages.join(", ")}: the ${props.name} ${props.authority} ` +
        `provider is disabled by ${disabled}; it publishes whole-workspace ` +
        "snapshots and has no bounded mode, so these languages fall through " +
        "to the generic language-server lane. " +
        `Drop ${refused.length === 1 ? "that option" : "those options"} for a strict index.`
      );
    },
    resolve: props.resolve,
    ...(props.prepare === undefined ? {} : { prepare: props.prepare }),
    open: (open) =>
      new SidecarSession({
        root: open.root,
        languages: open.languages,
        provider: props.name,
        authority: props.authority,
        facts: props.facts,
        validate: (snapshot) =>
          assertGraphSnapshotContract(
            snapshot,
            provider,
            open.languages,
            open.root,
          ),
        command: open.command,
        indexArgs: (artifact) =>
          props.indexArgs(artifact, open.root, open.languages),
        inputs: () => props.inputs(open.root, open.languages),
        ...(configuration === undefined
          ? {}
          : {
              configuration: () =>
                configuration(open.root, open.languages),
            }),
      }),
  };
  return provider;
}

export namespace sidecarProvider {
  export interface IProps {
    name: string;
    languages: readonly GraphLanguage[];
    authority: GraphProviderAuthority;
    facts: readonly GraphEdgeKind[];
    resolution?: IGraphProvider.IResolution;
    buildInputs?: IGraphProvider["buildInputs"];
    resolve: IGraphProvider["resolve"];
    prepare?: IGraphProvider["prepare"];
    indexArgs: (
      artifact: string,
      root: string,
      languages: readonly GraphLanguage[],
    ) => string[];
    inputs: (root: string, languages: readonly GraphLanguage[]) => string[];
    configuration?: (
      root: string,
      languages: readonly GraphLanguage[],
      env?: NodeJS.ProcessEnv,
    ) => readonly string[] | toolchainVersion.IDerivation;
  }
}
