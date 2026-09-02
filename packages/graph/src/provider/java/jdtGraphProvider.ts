import { assertGraphSnapshotContract } from "../assertGraphSnapshotContract";
import { IGraphProvider } from "../IGraphProvider";
import { resolveProviderCommand } from "../resolveProviderCommand";
import { standardScipProviders } from "../scip/standardScipProviders";
import { JdtGraphClient } from "./JdtGraphClient";
import { JDT_GRAPH_FACTS } from "./JDT_GRAPH_FACTS";
import { JDT_GRAPH_PRODUCER_COMMIT } from "./JDT_GRAPH_PRODUCER_COMMIT";
import { JDT_GRAPH_PROVIDER } from "./JDT_GRAPH_PROVIDER";

const OVERRIDE = "SAMCHON_GRAPH_JDT_WORKSPACE";
const javaScipProvider = standardScipProviders.find(
  (provider) => provider.name === "scip-java",
);
/* c8 ignore next 4 -- the static standard-provider registry always contains
 * the scip-java descriptor; startup must still fail closed if it is edited. */
if (javaScipProvider === undefined) {
  throw new Error("jdt-workspace: the scip-java fallback is not registered");
}

/** Resident JDT semantic-owner lane backed by one bulk executeCommand. */
export const jdtGraphProvider: IGraphProvider = {
  name: JDT_GRAPH_PROVIDER,
  languages: ["java"],
  authority: "compiler",
  facts: JDT_GRAPH_FACTS,
  resolution: {
    commands: ["samchon-jdtls"],
    environmentOverrides: [OVERRIDE],
  },
  buildInputs: javaScipProvider.buildInputs,
  configuration: (_root, env) => [
    `producer-commit=${JDT_GRAPH_PRODUCER_COMMIT}`,
    `${OVERRIDE}=${env[OVERRIDE] ?? "unconfigured"}`,
  ],
  refuse: (options) => {
    const refused = [
      options.server === undefined ? undefined : "server",
      options.maxFiles === undefined ? undefined : "maxFiles",
      options.lspReferenceLimit === undefined
        ? undefined
        : "lspReferenceLimit",
    ].filter((value): value is string => value !== undefined);
    return refused.length === 0
      ? undefined
      : `java: ${JDT_GRAPH_PROVIDER} publishes one whole resident workspace generation and cannot honor ${refused.join(", ")}`;
  },
  resolve: (root, env) =>
    resolveProviderCommand(root, env, {
      command: "samchon-jdtls",
      override: OVERRIDE,
    }),
  open: (props) =>
    new JdtGraphClient({
      root: props.root,
      command: props.command.command,
      args: props.command.args,
      initializationOptions: props.options.initializationOptions,
      requestTimeoutMs: props.options.lspTimeoutMs,
      maxMessageBytes: props.options.lspMaxMessageBytes,
      windowsVerbatimArguments: props.command.windowsVerbatimArguments,
      validate: (snapshot) =>
        assertGraphSnapshotContract(
          snapshot,
          jdtGraphProvider,
          props.languages,
          props.root,
        ),
    }),
};
