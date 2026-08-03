import { spawnSync } from "node:child_process";

import { assertGraphSnapshotContract } from "../assertGraphSnapshotContract";
import { IGraphProvider } from "../IGraphProvider";
import { resolveProviderCommand } from "../resolveProviderCommand";
import { spawnableCommand } from "../../utils/spawnableCommand";
import { RustGraphClient } from "./RustGraphClient";
import { RUST_HIR_FACTS } from "./RUST_HIR_FACTS";
import { RUST_GRAPH_PRODUCER_COMMIT } from "./RUST_GRAPH_PRODUCER_COMMIT";
import { RUST_HIR_PROVIDER } from "./RUST_HIR_PROVIDER";
import { rustScipProvider } from "./rustScipProvider";

const OVERRIDE = "SAMCHON_GRAPH_RUST_ANALYZER_HIR";

export const rustGraphProvider: IGraphProvider = {
  name: RUST_HIR_PROVIDER,
  languages: ["rust"],
  authority: "analyzer",
  facts: RUST_HIR_FACTS,
  resolution: {
    commands: ["samchon-rust-analyzer", "rust-analyzer"],
    environmentOverrides: [OVERRIDE],
  },
  fallbacks: [rustScipProvider],
  buildInputs: rustScipProvider.buildInputs,
  configuration: (_root, env) => [
    `producer-commit=${RUST_GRAPH_PRODUCER_COMMIT}`,
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
      : `rust: ${RUST_HIR_PROVIDER} publishes whole-program generations and cannot honor ${refused.join(", ")}`;
  },
  resolve: (root, env) => resolvePinned(root, env),
  open: (props) =>
    new RustGraphClient({
      root: props.root,
      command: props.command.command,
      args: props.command.args,
      producerCommit: RUST_GRAPH_PRODUCER_COMMIT,
      initializationOptions: props.options.initializationOptions,
      requestTimeoutMs: props.options.lspTimeoutMs,
      readyTimeoutMs: props.options.lspReadyTimeoutMs,
      maxMessageBytes: props.options.lspMaxMessageBytes,
      windowsVerbatimArguments: props.command.windowsVerbatimArguments,
      validate: (snapshot) =>
        assertGraphSnapshotContract(
          snapshot,
          rustGraphProvider,
          props.languages,
          props.root,
        ),
    }),
};

function resolvePinned(
  root: string,
  env: NodeJS.ProcessEnv,
): IGraphProvider.ICommand | undefined {
  for (const command of ["samchon-rust-analyzer", "rust-analyzer"]) {
    const candidate = resolveProviderCommand(root, env, {
      command,
      override: OVERRIDE,
    });
    if (candidate !== undefined && hasPinnedVersion(root, env, candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function hasPinnedVersion(
  root: string,
  env: NodeJS.ProcessEnv,
  command: IGraphProvider.ICommand,
): boolean {
  const invocation = spawnableCommand.append(
    { ...command, args: [...command.args] },
    ["--version"],
  );
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    encoding: "utf8",
    env,
    shell: false,
    timeout: 10_000,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.status !== 0 || result.error !== undefined) return false;
  const reported = /\(([0-9a-f]{7,40})(?:\s|\))/u.exec(
    result.stdout,
  )?.[1];
  return (
    reported !== undefined &&
    RUST_GRAPH_PRODUCER_COMMIT.startsWith(reported)
  );
}
