import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { spawnableCommand } from "../../utils/spawnableCommand";
import { IGraphProvider } from "../IGraphProvider";
import { resolveProviderCommand } from "../resolveProviderCommand";
import { SWIFT_GRAPH_PRODUCER } from "./SWIFT_GRAPH_PRODUCER";

const OVERRIDE = "SAMCHON_GRAPH_SWIFT_GRAPH";
const SERVER_CAPABILITY =
  "Serve explicit-output-unit SwiftPM IndexStoreDB generations over NDJSON.";

/** Resolve a compatible standalone producer on one explicitly supported host. */
export function resolveSwiftGraphCommand(
  root: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): IGraphProvider.ICommand | undefined {
  if (
    !["darwin", "linux"].includes(platform) ||
    !fs.existsSync(path.join(root, "Package.swift"))
  ) {
    return undefined;
  }
  const command = resolveProviderCommand(root, env, {
    command: SWIFT_GRAPH_PRODUCER,
    override: OVERRIDE,
  });
  return command !== undefined &&
    publishesResidentServer(root, env, command) &&
    supportsProject(root, env, command)
    ? command
    : undefined;
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
  return `${result.stdout}${result.stderr}`.includes(
    SERVER_CAPABILITY,
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
