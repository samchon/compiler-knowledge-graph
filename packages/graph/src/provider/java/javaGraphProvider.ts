import { spawnSync } from "node:child_process";

import { spawnableCommand } from "../../utils/spawnableCommand";
import { assertGraphSnapshotContract } from "../assertGraphSnapshotContract";
import { IGraphProvider } from "../IGraphProvider";
import { providerInputFiles } from "../providerInputFiles";
import { resolveProviderCommand } from "../resolveProviderCommand";
import { standardScipProviders } from "../scip/standardScipProviders";
import { toolchainVersion } from "../toolchainVersion";
import { JAVA_GRAPH_FACTS } from "./JAVA_GRAPH_FACTS";
import { JAVA_GRAPH_PROVIDER } from "./JAVA_GRAPH_PROVIDER";
import { JavaGraphSession } from "./JavaGraphSession";
import { jdtGraphProvider } from "./jdtGraphProvider";

const OVERRIDE = "SAMCHON_GRAPH_JAVAC_GRAPH";
const TOOLCHAIN_OVERRIDE = "SAMCHON_GRAPH_JAVA_TOOLCHAIN";
const GRAPH_OPTION = "--graph-output";
const javaScipProvider = standardScipProviders.find(
  (provider) => provider.name === "scip-java",
);
/* c8 ignore next 4 -- the static standard-provider registry always contains
 * the scip-java descriptor; startup must still fail closed if it is edited. */
if (javaScipProvider === undefined) {
  throw new Error("javac-graph: the scip-java fallback is not registered");
}
/**
 * The build files a registry entry watches, shared with the SCIP lane because
 * the two routes read the same project configuration.
 *
 * These are the registry's `buildInputs`, and they are deliberately *not* the
 * session's inputs. A registry entry declares the files outside its own
 * language whose change invalidates it; a session fingerprints everything it
 * compiled. Handing the first list to the second is what let a Java source
 * edit leave the fingerprint unmoved, so the session reused a snapshot taken
 * before the edit and the coordinator's fence refused it — correctly, and with
 * a digest that described bytes no longer on disk.
 */
const javaBuildInputs = javaScipProvider.buildInputs;
/* c8 ignore next 4 -- every SCIP descriptor derives its build inputs from the
 * project; startup must still fail closed if that stops being true. */
if (typeof javaBuildInputs !== "function") {
  throw new Error("javac-graph: the scip-java fallback names no build inputs");
}

/**
 * Every input whose change can move a Java target's committed generation.
 *
 * Sources and build files together, because either alone is a half-answer: a
 * classpath edit in `pom.xml` recompiles sources it never touched, and a
 * source edit moves facts no build file mentions. This is the fingerprint that
 * decides whether the build has to run at all, so a file missing from it is a
 * file whose edit the route will not notice.
 */
const javaInputs = (root: string): string[] => [
  ...new Set([
    ...providerInputFiles(root, ["java"], []),
    ...javaBuildInputs(root),
  ]),
];

/**
 * The compiler-owned Java route: javac writes the graph, not a second reader.
 *
 * The producer is a plugin on the project's own compile tasks, so the facts
 * come from the attributed trees the build already produced and cost one
 * traversal of each. That is what separates this entry from the SCIP lane
 * behind it, which runs a whole indexing build of its own and still cannot
 * prove a call — SCIP has no call role, so `scip-java` publishes containment
 * and references and this route publishes what javac resolved.
 *
 * It sits ahead of that lane rather than replacing it. A released `scip-java`
 * that predates `--graph-output` is a perfectly good navigation indexer and
 * declining to it is the honest answer; what must not happen is this route
 * quietly answering with SCIP facts under a compiler-authority provenance.
 */
export const javaGraphProvider: IGraphProvider = {
  name: JAVA_GRAPH_PROVIDER,
  languages: ["java"],
  authority: "compiler",
  facts: JAVA_GRAPH_FACTS,
  resolution: {
    commands: ["scip-java", "java"],
    environmentOverrides: [OVERRIDE, TOOLCHAIN_OVERRIDE],
  },
  fallbacks: [jdtGraphProvider, javaScipProvider],
  buildInputs: javaScipProvider.buildInputs,
  configuration: (root, env) =>
    [...javaToolchain(root, env).rows],
  configurationDerivation: (root, env) => javaToolchain(root, env),
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
      : `java: ${JAVA_GRAPH_PROVIDER} publishes whole-target generations from the project's own compile tasks and cannot honor ${refused.join(", ")}`;
  },
  resolve: (root, env) => {
    const launcher = resolveProviderCommand(root, env, {
      command: "scip-java",
      override: OVERRIDE,
    });
    if (launcher === undefined) return undefined;
    // The graph output is a capability of the launcher, not of its name. A
    // released build without it answers `index` perfectly well and writes no
    // graph at all, so the strict route would run a whole build and then find
    // nothing to read. Asking `index --help` costs one process and turns that
    // into an ordinary decline before anything is compiled.
    return publishesGraphOutput(root, env, launcher) ? launcher : undefined;
  },
  open: (props) =>
    new JavaGraphSession({
      root: props.root,
      languages: props.languages,
      provider: JAVA_GRAPH_PROVIDER,
      command: props.command,
      inputs: () => javaInputs(props.root),
      configuration: () => javaToolchain(props.root, process.env),
      validate: (snapshot) =>
        assertGraphSnapshotContract(
          snapshot,
          javaGraphProvider,
          props.languages,
          props.root,
        ),
    }),
};


/**
 * The JDK that will run the plugin and the launcher that will attach it.
 *
 * Both are identity, not decoration. A build that switches JDKs recompiles
 * against a different `java.base` and resolves different overloads, and a
 * launcher upgrade can change the shard schema underneath an unchanged
 * project; a universe that ignored either would reuse facts neither produced.
 */
function javaToolchain(
  root: string,
  env: NodeJS.ProcessEnv,
): toolchainVersion.IDerivation {
  return toolchainVersion.derive([
    toolchainVersion.observe({
      root,
      env,
      command: "java",
      override: TOOLCHAIN_OVERRIDE,
      // `--version`, not `-version`. The single-dash form is the pre-Java-9
      // spelling and writes to standard error, where the shared probe does not
      // read; the JDK has answered the double-dash form on standard output
      // since 9, and the SCIP lane already asks every toolchain that way.
      args: ["--version"],
      label: "java",
    }),
    toolchainVersion.observe({
      root,
      env,
      command: "scip-java",
      override: OVERRIDE,
      args: ["--version"],
      label: "scip-java",
    }),
  ]);
}

function publishesGraphOutput(
  root: string,
  env: NodeJS.ProcessEnv,
  command: IGraphProvider.ICommand,
): boolean {
  const invocation = spawnableCommand.append(
    { ...command, args: [...command.args] },
    ["index", "--help"],
  );
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    encoding: "utf8",
    env,
    shell: false,
    timeout: 30_000,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  // No separate arm for a launch that never happened: a spawn error leaves
  // both streams empty, which is already the answer this returns for a
  // launcher that ran and published nothing.
  /* c8 ignore start -- an executed spawnSync with UTF-8 encoding returns
   * strings; the null arms exist only for Node's broader result type. */
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.includes(GRAPH_OPTION);
  /* c8 ignore stop */
}
