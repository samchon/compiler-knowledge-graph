import { languageBuildInputs } from "../../indexer/languageBuildInputs";
import { assertGraphSnapshotContract } from "../assertGraphSnapshotContract";
import { IGraphProvider } from "../IGraphProvider";
import { providerInputFiles } from "../providerInputFiles";
import { toolchainVersion } from "../toolchainVersion";
import { ISwiftGraphSnapshot } from "./ISwiftGraphSnapshot";
import { resolveSwiftGraphCommand } from "./resolveSwiftGraphCommand";
import { SWIFT_GRAPH_FACTS } from "./SWIFT_GRAPH_FACTS";
import { SWIFT_GRAPH_PRODUCER } from "./SWIFT_GRAPH_PRODUCER";
import { SWIFT_GRAPH_PROVIDER } from "./SWIFT_GRAPH_PROVIDER";
import { SwiftGraphSession } from "./SwiftGraphSession";

const OVERRIDE = "SAMCHON_GRAPH_SWIFT_GRAPH";
const TOOLCHAIN_OVERRIDE = "SAMCHON_GRAPH_SWIFT_TOOLCHAIN";

const swiftInputs = (root: string): string[] => [
  ...new Set([
    ...providerInputFiles(root, ["swift"], []),
    ...languageBuildInputs(root, ["swift"]),
  ]),
];

/** Standalone SwiftPM fallback over a frozen explicit IndexStoreDB unit set. */
export const swiftGraphProvider: IGraphProvider = {
  name: SWIFT_GRAPH_PROVIDER,
  languages: ["swift"],
  authority: "compiler",
  facts: SWIFT_GRAPH_FACTS,
  resolution: {
    commands: [SWIFT_GRAPH_PRODUCER, "swift"],
    environmentOverrides: [OVERRIDE, TOOLCHAIN_OVERRIDE],
  },
  buildInputs: (root) => languageBuildInputs(root, ["swift"]),
  configuration: (root, env) => [...swiftToolchain(root, env).rows],
  configurationDerivation: (root, env) => swiftToolchain(root, env),
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
      : `swift: ${SWIFT_GRAPH_PROVIDER} publishes complete SwiftPM module generations and cannot honor ${refused.join(", ")}`;
  },
  resolve: (root, env) => resolveSwiftGraphCommand(root, env),
  open: (props) =>
    new SwiftGraphSession({
      root: props.root,
      languages: props.languages,
      provider: SWIFT_GRAPH_PROVIDER,
      command: props.command,
      inputs: () => swiftInputs(props.root),
      configuration: () => swiftToolchain(props.root, process.env),
      validate: (snapshot) =>
        assertGraphSnapshotContract(
          snapshot,
          swiftGraphProvider,
          props.languages,
          props.root,
        ),
    }),
};

function swiftToolchain(
  root: string,
  env: NodeJS.ProcessEnv,
): toolchainVersion.IDerivation {
  return toolchainVersion.derive([
    toolchainVersion.observe({
      root,
      env,
      command: "swift",
      override: TOOLCHAIN_OVERRIDE,
      args: ["--version"],
      label: "swift",
    }),
    toolchainVersion.observe({
      root,
      env,
      command: SWIFT_GRAPH_PRODUCER,
      override: OVERRIDE,
      args: ["--version"],
      label: SWIFT_GRAPH_PRODUCER,
    }),
    `indexstore-db=${ISwiftGraphSnapshot.INDEX_STORE_DB_COMMIT}`,
  ]);
}
