import { IGraphProvider } from "../IGraphProvider";
import { assertGraphSnapshotContract } from "../assertGraphSnapshotContract";
import { adaptTtscGraphDump } from "./adaptTtscGraphDump";
import { resolveTtscGraphCommand } from "./resolveTtscGraphCommand";
import { ttscGraphResolution } from "./ttscGraphResolution";
import { TtscGraphClient } from "./TtscGraphClient";
import { ttscGraphStrictRefusal } from "./ttscGraphStrictRefusal";

/**
 * The compiler-owned TypeScript provider: `ttscgraph serve`.
 *
 * Every clause here used to live inside `buildLspGraph`'s language loop as an
 * `if (language === "typescript")` arm — which command to resolve, which
 * options disqualified the lane, which client to construct. Stating it as a
 * registry entry is not a reorganization: it is what makes the provider
 * something a test can enumerate, an audit can name, and a fallback warning
 * can attribute.
 */
export const ttscGraphProvider: IGraphProvider = {
  name: "ttscgraph",
  languages: ["typescript"],

  // The TypeScript checker itself resolved these facts. Nothing downstream may
  // silently substitute a weaker lane for them without saying so.
  authority: "compiler",

  facts: adaptTtscGraphDump.EDGE_KINDS,
  resolution: ttscGraphResolution,

  // A `tsconfig` change can add or drop whole files from the program, and a
  // `package.json` change can move the resolution roots those files import
  // through. Neither is a `.ts` edit, so neither would be noticed by a
  // freshness check that watched only source extensions.
  buildInputs: ["tsconfig.json", "jsconfig.json", "package.json"],

  refuse: ttscGraphStrictRefusal,

  resolve: (root, env) => resolveTtscGraphCommand(root, env),

  open: (props) =>
    new TtscGraphClient({
      root: props.root,
      command: props.command.command,
      args: props.command.args,
      windowsVerbatimArguments:
        props.command.windowsVerbatimArguments,
      windowsDoubleEscapeArguments:
        props.command.windowsDoubleEscapeArguments,
      validate: (snapshot) =>
        assertGraphSnapshotContract(
          snapshot,
          ttscGraphProvider,
          props.languages,
          props.root,
        ),
    }),
};
