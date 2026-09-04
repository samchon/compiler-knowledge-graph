import fs from "node:fs";
import path from "node:path";

import { spawnableCommand } from "../../utils/spawnableCommand";
import { assertGraphSnapshotContract } from "../assertGraphSnapshotContract";
import { IGraphProvider } from "../IGraphProvider";
import { resolveProviderCommand } from "../resolveProviderCommand";
import { standardScipProviders } from "../scip/standardScipProviders";
import { CSHARP_ROSLYN_FACTS } from "./CSHARP_ROSLYN_FACTS";
import { CSHARP_ROSLYN_PRODUCER } from "./CSHARP_ROSLYN_PRODUCER";
import { CSHARP_ROSLYN_PROVIDER } from "./CSHARP_ROSLYN_PROVIDER";
import { CsharpGraphClient } from "./CsharpGraphClient";

const OVERRIDE = "SAMCHON_GRAPH_ROSLYN_WORKSPACE";
const DOTNET_OVERRIDE = "SAMCHON_GRAPH_DOTNET_TOOLCHAIN";
const scipDotnet = standardScipProviders.find(
  (provider) => provider.name === "scip-dotnet",
);
/* c8 ignore next 4 -- the static standard-provider registry always contains
 * the scip-dotnet fallback; startup must still fail closed if it is edited. */
if (scipDotnet === undefined) {
  throw new Error("roslyn-workspace: the scip-dotnet fallback is not registered");
}

/** Compiler-owned C# graph over one resident immutable Roslyn Solution. */
export const csharpGraphProvider: IGraphProvider = {
  name: CSHARP_ROSLYN_PROVIDER,
  languages: ["csharp"],
  authority: "compiler",
  facts: CSHARP_ROSLYN_FACTS,
  resolution: {
    commands: [CSHARP_ROSLYN_PRODUCER, "dotnet"],
    environmentOverrides: [OVERRIDE, DOTNET_OVERRIDE],
  },
  fallbacks: [scipDotnet],
  buildInputs: scipDotnet.buildInputs,
  configuration: (_root, env) => [
    "producer-schema=1",
    `${OVERRIDE}=${env[OVERRIDE] ?? "unconfigured"}`,
    `${DOTNET_OVERRIDE}=${env[DOTNET_OVERRIDE] ?? "unconfigured"}`,
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
      : `csharp: ${CSHARP_ROSLYN_PROVIDER} publishes whole-solution generations and cannot honor ${refused.join(", ")}`;
  },
  resolve: (root, env) => resolveCsharpGraphCommand(root, env),
  open: (props) =>
    new CsharpGraphClient({
      root: props.root,
      command: props.command.command,
      args: props.command.args,
      initializationOptions: props.options.initializationOptions,
      requestTimeoutMs: props.options.lspTimeoutMs,
      readyTimeoutMs: props.options.lspReadyTimeoutMs,
      maxMessageBytes: props.options.lspMaxMessageBytes,
      windowsVerbatimArguments: props.command.windowsVerbatimArguments,
      validate: (snapshot) =>
        assertGraphSnapshotContract(
          snapshot,
          csharpGraphProvider,
          props.languages,
          props.root,
        ),
    }),
};

function resolveCsharpGraphCommand(
  root: string,
  env: NodeJS.ProcessEnv,
): IGraphProvider.ICommand | undefined {
  if (!hasEntryPoint(root)) return undefined;
  const installed = resolveProviderCommand(root, env, {
    command: CSHARP_ROSLYN_PRODUCER,
    override: OVERRIDE,
  });
  if (installed !== undefined) return installed;
  const project = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "sidecars",
    "csharp",
    "Samchon.Graph.CSharp.csproj",
  );
  /* c8 ignore start -- the package build copies this enumerated source file;
   * absence can only mean the installed package itself is corrupt. */
  if (!fs.existsSync(project)) return undefined;
  /* c8 ignore stop */
  const dotnetAttempt = resolveProviderCommand.attempt(root, env, {
    command: "dotnet",
    override: DOTNET_OVERRIDE,
  });
  const dotnet = dotnetAttempt.command;
  return dotnet === undefined
    ? undefined
    : spawnableCommand.append(
        { ...dotnet, args: [...dotnet.args] },
        [
          "run",
          "--project",
          project,
          "--configuration",
          "Release",
          "--verbosity",
          "quiet",
          "--no-launch-profile",
          "--",
          "--dotnet-host",
          dotnetAttempt.executable!,
        ],
      );
}

function hasEntryPoint(root: string): boolean {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  if (
    entries.some(
      (entry) =>
        entry.isFile() &&
        [".sln", ".slnx", ".csproj"].includes(
          path.extname(entry.name).toLowerCase(),
        ),
    )
  ) {
    return true;
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        ![".git", ".wiki", "bin", "node_modules", "obj"].includes(
          entry.name,
        ),
    )
    .some((entry) => hasProject(path.join(root, entry.name)));
}

function hasProject(directory: string): boolean {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".csproj") {
      return true;
    }
    if (
      entry.isDirectory() &&
      ![".git", ".wiki", "bin", "node_modules", "obj"].includes(entry.name) &&
      hasProject(path.join(directory, entry.name))
    ) {
      return true;
    }
  }
  return false;
}
