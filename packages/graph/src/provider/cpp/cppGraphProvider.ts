import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { spawnableCommand } from "../../utils/spawnableCommand";
import { assertGraphSnapshotContract } from "../assertGraphSnapshotContract";
import { IGraphProvider } from "../IGraphProvider";
import { resolveProviderCommand } from "../resolveProviderCommand";
import { standardScipProviders } from "../scip/standardScipProviders";
import { CPP_CLANG_FACTS } from "./CPP_CLANG_FACTS";
import { CPP_CLANG_PRODUCER_COMMIT } from "./CPP_CLANG_PRODUCER_COMMIT";
import { CPP_CLANG_PROVIDER } from "./CPP_CLANG_PROVIDER";
import { CppGraphClient } from "./CppGraphClient";

const OVERRIDE = "SAMCHON_GRAPH_CLANGD_SNAPSHOT";
const clangScipProvider = standardScipProviders.find(
  (provider) => provider.name === "scip-clang",
);
/* c8 ignore next 4 -- the static standard-provider registry always contains
 * the scip-clang descriptor; startup must still fail closed if it is edited. */
if (clangScipProvider === undefined) {
  throw new Error("clangd-snapshot: the scip-clang fallback is not registered");
}

export const cppGraphProvider: IGraphProvider = {
  name: CPP_CLANG_PROVIDER,
  languages: ["c", "cpp"],
  authority: "compiler",
  facts: CPP_CLANG_FACTS,
  resolution: {
    commands: ["samchon-clangd", "clangd"],
    projectCommandSources: [
      "compile_commands.json",
      "build/compile_commands.json",
    ],
    environmentOverrides: [OVERRIDE],
  },
  fallbacks: [clangScipProvider],
  buildInputs: clangScipProvider.buildInputs,
  configuration: (_root, env) => [
    `producer-commit=${CPP_CLANG_PRODUCER_COMMIT}`,
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
      : `c, cpp: ${CPP_CLANG_PROVIDER} publishes whole-compilation-database generations and cannot honor ${refused.join(", ")}`;
  },
  resolve: (root, env) => resolvePinned(root, env),
  prepare: (root) => {
    if (compilationDatabase(root) === undefined) {
      throw new Error(
        "clangd-snapshot: compile_commands.json or build/compile_commands.json must contain at least one command",
      );
    }
  },
  open: (props) => {
    // `--background-index` is what makes a whole-compilation-database snapshot
    // possible at all: the producer is ready when every translation unit the
    // database registers has been indexed, and nothing else starts that work.
    //
    // No `-j`. This provider carried one, derived from installed memory at
    // eight GiB per worker, on the theory that concurrent translation units
    // were what exhausted a 16 GiB CI host. They were not. The producer copied
    // each completed translation unit and serialized it to JSON to derive a
    // body digest — a second pass over every occurrence in the unit, on top of
    // the serialization that already writes the shard. That is why one worker
    // still took a 16 GiB host from 5,831 MiB free to 209 MiB on C++, and why
    // plain C spent ten minutes with 53 units left to index while twelve GiB
    // sat free: the clamp cost the C lane half its width and bought the C++
    // lane nothing, because worker count was never the term that grew.
    //
    // The pinned producer derives that identity from the fields it already
    // holds instead, so the term is gone rather than divided. Width belongs to
    // the producer, which knows what one unit costs it; this provider states
    // the pin and lets clangd size itself, and a memory bound here would need
    // a measurement of the fixed producer that nobody has yet taken.
    const command = spawnableCommand.append(
      { ...props.command, args: [...props.command.args] },
      ["--background-index"],
    );
    return new CppGraphClient({
      root: props.root,
      languages: props.languages,
      command: command.command,
      args: command.args,
      producerCommit: CPP_CLANG_PRODUCER_COMMIT,
      initializationOptions: props.options.initializationOptions,
      requestTimeoutMs: props.options.lspTimeoutMs,
      readyTimeoutMs: props.options.lspReadyTimeoutMs,
      maxMessageBytes: props.options.lspMaxMessageBytes,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      validate: (snapshot) =>
        assertGraphSnapshotContract(
          snapshot,
          cppGraphProvider,
          props.languages,
          props.root,
        ),
    });
  },
};

function resolvePinned(
  root: string,
  env: NodeJS.ProcessEnv,
): IGraphProvider.ICommand | undefined {
  for (const command of ["samchon-clangd", "clangd"]) {
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
  return (
    result.status === 0 &&
    result.error === undefined &&
    result.stdout.includes(CPP_CLANG_PRODUCER_COMMIT)
  );
}

function compilationDatabase(root: string): string | undefined {
  for (const relative of [
    "compile_commands.json",
    path.join("build", "compile_commands.json"),
  ]) {
    const candidate = path.join(root, relative);
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as unknown;
      if (Array.isArray(parsed) && parsed.length !== 0) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}
