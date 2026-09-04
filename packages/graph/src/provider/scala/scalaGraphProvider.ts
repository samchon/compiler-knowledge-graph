import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { compareOrdinal } from "@samchon/graph-sitter";

import { languageBuildInputs } from "../../indexer/languageBuildInputs";
import { spawnableCommand } from "../../utils/spawnableCommand";
import { assertGraphSnapshotContract } from "../assertGraphSnapshotContract";
import { IGraphProvider } from "../IGraphProvider";
import { providerInputFiles } from "../providerInputFiles";
import { resolveProviderCommand } from "../resolveProviderCommand";
import { toolchainVersion } from "../toolchainVersion";
import { SCALA_GRAPH_FACTS } from "./SCALA_GRAPH_FACTS";
import { SCALA_GRAPH_PRODUCER } from "./SCALA_GRAPH_PRODUCER";
import { SCALA_GRAPH_PROVIDER } from "./SCALA_GRAPH_PROVIDER";
import { ScalaGraphSession } from "./ScalaGraphSession";

const OVERRIDE = "SAMCHON_GRAPH_SCALA_GRAPH";
const TOOLCHAIN_OVERRIDE = "SAMCHON_GRAPH_JAVA_TOOLCHAIN";
const SERVER_CAPABILITY =
  "Serve BSP-driven Scala compiler graph generations over NDJSON.";

/** Scala sources, build definitions and usable BSP connection details. */
const scalaInputs = (root: string): string[] => [
  ...new Set([
    ...providerInputFiles(root, ["scala"], []),
    ...languageBuildInputs(root, ["scala"]),
    ...bspFiles(root),
  ]),
];

/** Compiler-owned Scala 2/3 facts produced in the repository's BSP compile. */
export const scalaGraphProvider: IGraphProvider = {
  name: SCALA_GRAPH_PROVIDER,
  languages: ["scala"],
  authority: "compiler",
  facts: SCALA_GRAPH_FACTS,
  resolution: {
    commands: [SCALA_GRAPH_PRODUCER, "java"],
    environmentOverrides: [OVERRIDE, TOOLCHAIN_OVERRIDE],
  },
  buildInputs: (root) => [
    ...languageBuildInputs(root, ["scala"]),
    ...bspFiles(root),
  ],
  configuration: (root, env) => [...scalaToolchain(root, env).rows],
  configurationDerivation: (root, env) => scalaToolchain(root, env),
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
      : `scala: ${SCALA_GRAPH_PROVIDER} publishes complete BSP target generations and cannot honor ${refused.join(", ")}`;
  },
  resolve: (root, env) => {
    if (bspFiles(root).length === 0) return undefined;
    const command = resolveProviderCommand(root, env, {
      command: SCALA_GRAPH_PRODUCER,
      override: OVERRIDE,
    });
    return command !== undefined &&
      publishesResidentServer(root, env, command) &&
      supportsProject(root, env, command)
      ? command
      : undefined;
  },
  open: (props) =>
    new ScalaGraphSession({
      root: props.root,
      languages: props.languages,
      provider: SCALA_GRAPH_PROVIDER,
      command: props.command,
      inputs: () => scalaInputs(props.root),
      configuration: () => scalaToolchain(props.root, process.env),
      validate: (snapshot) =>
        assertGraphSnapshotContract(
          snapshot,
          scalaGraphProvider,
          props.languages,
          props.root,
        ),
    }),
};

function bspFiles(root: string): string[] {
  const directory = path.join(root, ".bsp");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => `.bsp/${entry.name}`)
    .sort(compareOrdinal);
}

function scalaToolchain(
  root: string,
  env: NodeJS.ProcessEnv,
): toolchainVersion.IDerivation {
  return toolchainVersion.derive([
    toolchainVersion.observe({
      root,
      env,
      command: "java",
      override: TOOLCHAIN_OVERRIDE,
      args: ["--version"],
      label: "java",
    }),
    toolchainVersion.observe({
      root,
      env,
      command: SCALA_GRAPH_PRODUCER,
      override: OVERRIDE,
      args: ["--version"],
      label: SCALA_GRAPH_PRODUCER,
    }),
  ]);
}

function publishesResidentServer(
  root: string,
  env: NodeJS.ProcessEnv,
  command: IGraphProvider.ICommand,
): boolean {
  const invocation = spawnableCommand.append(
    { ...command, args: [...command.args] },
    ["graph-server", "--help"],
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
  return (
    result.status === 0 &&
    `${result.stdout}${result.stderr}`.includes(SERVER_CAPABILITY)
  );
}

function supportsProject(
  root: string,
  env: NodeJS.ProcessEnv,
  command: IGraphProvider.ICommand,
): boolean {
  const invocation = spawnableCommand.append(
    { ...command, args: [...command.args] },
    ["supports", "--cwd", root],
  );
  return (
    spawnSync(invocation.command, invocation.args, {
      cwd: root,
      encoding: "utf8",
      env,
      shell: false,
      timeout: 120_000,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    }).status === 0
  );
}
