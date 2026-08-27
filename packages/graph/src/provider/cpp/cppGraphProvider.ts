import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
    // The width is a measurement, and its question has been answered twice
    // over. Worker count is not the term that grows -- both lanes died at two
    // workers as readily as at clangd's default four -- and the term that does
    // is not in the indexing path at all. Instrumenting the producer's
    // not-ready answer put a number on it: on libuv the last translation unit
    // finished indexing with 11.5 GiB free, and the host died seventy-six
    // seconds later, after the snapshot was already built. What spends those
    // gigabytes is answering the first page, which is why the fix is the size
    // this client asks for rather than anything on this line.
    //
    // The bound stays anyway, and on its own grounds. Eight GiB per worker is
    // this repository's figure, chosen against the first host trace and not
    // quoted from clangd: a 16 GiB host was not enough at four, so the rule has
    // to land below two there rather than shave one worker off and call it
    // sized. It is a stated ceiling on a cost that scales with width, not a
    // claim that this width is what made the lane survive — and it moves again
    // only against a new reading, never against a hope.
    const workers = Math.max(
      1,
      Math.min(
        os.availableParallelism(),
        Math.floor(os.totalmem() / (8 * 1024 * 1024 * 1024)),
      ),
    );
    const command = spawnableCommand.append(
      { ...props.command, args: [...props.command.args] },
      ["--background-index", `-j=${String(workers)}`],
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
