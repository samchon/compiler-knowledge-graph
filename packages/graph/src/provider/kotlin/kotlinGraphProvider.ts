import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { spawnableCommand } from "../../utils/spawnableCommand";
import { assertGraphSnapshotContract } from "../assertGraphSnapshotContract";
import { IGraphProvider } from "../IGraphProvider";
import { providerInputFiles } from "../providerInputFiles";
import { resolveProviderCommand } from "../resolveProviderCommand";
import { standardScipProviders } from "../scip/standardScipProviders";
import { toolchainVersion } from "../toolchainVersion";
import { KOTLIN_GRAPH_FACTS } from "./KOTLIN_GRAPH_FACTS";
import { KOTLIN_GRAPH_PROVIDER } from "./KOTLIN_GRAPH_PROVIDER";
import { KotlinGraphSession } from "./KotlinGraphSession";

const OVERRIDE = "SAMCHON_GRAPH_KOTLINC_GRAPH";
const TOOLCHAIN_OVERRIDE = "SAMCHON_GRAPH_JAVA_TOOLCHAIN";
const GRAPH_OPTION = "--kotlin-graph-output";
const SERVER_COMMAND = "kotlin-graph-server";
const SERVER_CAPABILITY = "Serve compiler-owned Kotlin graph generations over NDJSON.";
const kotlinScipProvider = standardScipProviders.find(
  (provider) => provider.name === "scip-kotlinc",
);
/* c8 ignore next 4 -- the static standard-provider registry always contains
 * the scip-kotlinc descriptor; startup must still fail closed if it is edited. */
if (kotlinScipProvider === undefined) {
  throw new Error("kotlinc-graph: the scip-kotlinc fallback is not registered");
}
/**
 * The build files a registry entry watches, shared with the SCIP lane because
 * the two routes read the same project configuration.
 *
 * These are the registry's `buildInputs`, and they are deliberately *not* the
 * session's inputs. A registry entry declares the files outside its own
 * language whose change invalidates it; a session fingerprints everything it
 * compiled. Handing the first list to the second is what let a Kotlin source
 * edit leave the fingerprint unmoved, so the session reused a snapshot taken
 * before the edit and the coordinator's fence refused it correctly, and with
 * a digest that described bytes no longer on disk.
 */
const kotlinBuildInputs = kotlinScipProvider.buildInputs;
/* c8 ignore start -- every SCIP descriptor derives its build inputs from the
 * project; startup must still fail closed if that stops being true. */
if (typeof kotlinBuildInputs !== "function") {
  throw new Error(
    "kotlinc-graph: the scip-kotlinc fallback names no build inputs",
  );
}
/* c8 ignore stop */

/**
 * Every input whose change can move a Kotlin target's committed generation.
 *
 * Sources and build files together, because either alone is a half-answer: a
 * classpath edit in `pom.xml` recompiles sources it never touched, and a
 * source edit moves facts no build file mentions. This is the fingerprint that
 * decides whether the build has to run at all, so a file missing from it is a
 * file whose edit the route will not notice.
 */
const kotlinInputs = (root: string): string[] => [
  ...new Set([
    ...providerInputFiles(root, ["kotlin"], []),
    ...kotlinBuildInputs(root),
  ]),
];

/**
 * The compiler-owned Kotlin route: kotlinc writes the graph, not a second reader.
 *
 * The producer is a plugin on the project's own compile tasks, so the facts
 * come from the attributed trees the build already produced and cost one
 * traversal of each. That is what separates this entry from the SCIP lane
 * behind it, which runs a whole indexing build of its own and still cannot
 * prove a call because SCIP carries no distinct call role, while this route
 * publishes the call, access, and dispatch roles kotlinc resolved.
 *
 * It sits ahead of that lane rather than replacing it. A released `scip-java`
 * that predates `--kotlin-graph-output` is a perfectly good navigation indexer and
 * declining to it is the honest answer; what must not happen is this route
 * quietly answering with SCIP facts under a compiler-authority provenance.
 */
export const kotlinGraphProvider: IGraphProvider = {
  name: KOTLIN_GRAPH_PROVIDER,
  languages: ["kotlin"],
  authority: "compiler",
  facts: KOTLIN_GRAPH_FACTS,
  resolution: {
    commands: ["scip-java", "java"],
    environmentOverrides: [OVERRIDE, TOOLCHAIN_OVERRIDE],
  },
  fallbacks: [kotlinScipProvider],
  buildInputs: kotlinScipProvider.buildInputs,
  configuration: (root, env) => [...kotlinToolchain(root, env).rows],
  configurationDerivation: (root, env) => kotlinToolchain(root, env),
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
      : `kotlin: ${KOTLIN_GRAPH_PROVIDER} publishes whole-target generations from the project's own compile tasks and cannot honor ${refused.join(", ")}`;
  },
  resolve: (root, env) => {
    if (!hasGradleBuild(root)) return undefined;
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
    return publishesGraphOutput(root, env, launcher) &&
      publishesResidentServer(root, env, launcher)
      ? launcher
      : undefined;
  },
  open: (props) =>
    new KotlinGraphSession({
      root: props.root,
      languages: props.languages,
      provider: KOTLIN_GRAPH_PROVIDER,
      command: props.command,
      inputs: () => kotlinInputs(props.root),
      configuration: () => kotlinToolchain(props.root, process.env),
      validate: (snapshot) =>
        assertGraphSnapshotContract(
          snapshot,
          kotlinGraphProvider,
          props.languages,
          props.root,
        ),
    }),
};

/** The build-integrated exporter currently supports Kotlin/JVM Gradle only. */
function hasGradleBuild(root: string): boolean {
  return [
    "settings.gradle",
    "settings.gradle.kts",
    "build.gradle",
    "build.gradle.kts",
    "gradlew",
    "gradlew.bat",
  ].some((file) => fs.existsSync(path.join(root, file)));
}


/**
 * The JDK that will run the plugin and the launcher that will attach it.
 *
 * Both are identity, not decoration. A build that switches JDKs recompiles
 * against a different Kotlin compiler and resolves different overloads, and a
 * launcher upgrade can change the shard schema underneath an unchanged
 * project; a universe that ignored either would reuse facts neither produced.
 */
function kotlinToolchain(
  root: string,
  env: NodeJS.ProcessEnv,
): toolchainVersion.IDerivation {
  return toolchainVersion.derive([
    toolchainVersion.observe({
      root,
      env,
      command: "java",
      override: TOOLCHAIN_OVERRIDE,
      // `--version`, not `-version`. The single-dash form is the pre-Kotlin-9
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

function publishesResidentServer(
  root: string,
  env: NodeJS.ProcessEnv,
  command: IGraphProvider.ICommand,
): boolean {
  const invocation = spawnableCommand.append(
    { ...command, args: [...command.args] },
    [SERVER_COMMAND, "--help"],
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
  /* c8 ignore next -- an executed UTF-8 spawnSync returns both streams. */
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.includes(
    SERVER_CAPABILITY,
  );
}
