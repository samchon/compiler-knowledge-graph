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
    // Sized for the machine, like every other producer this repository
    // launches. `--background-index` is what makes a whole-compilation-database
    // snapshot possible at all, and clangd's `-j` bounds the workers it uses
    // for it; left unset it takes the core count, and each worker holds a
    // translation unit's AST while it runs.
    //
    // The bound is measured rather than assumed. A 16 GiB CI host indexing
    // libuv and fmt at the default width ran out of memory — a trace of the
    // host recorded free memory collapsing to 173 MiB and then 35 MiB, with
    // the sawtooth of repeated kills before it — and took the runner agent
    // with it. Eight GiB per worker is this repository's figure, chosen
    // against that observation and not quoted from clangd: sixteen was not
    // enough at four, so the rule has to land below two there rather than
    // shave a worker off and call it sized.
    //
    // What this cannot do is bound what the producer retains for the whole
    // database, which is a function of the project rather than of the worker
    // count. That makes the narrow width a measurement as much as a fix: if
    // one worker still exhausts the host, concurrency was never the term that
    // mattered, and the answer lies in the producer rather than here.
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
