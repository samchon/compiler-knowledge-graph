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
    // Eight GiB a worker. Twelve was tried against the C++ host and reverted:
    // it bought nothing there -- one worker died as readily as two -- and it
    // cost the C lane the run. Halving the width doubled indexing, which then
    // did not finish inside the ten-minute readiness window: sixty-four of
    // libuv's units were still going when the wait expired, against seven and
    // a half minutes for all 242 at two workers.
    //
    // The width experiment has now come back negative twice, from opposite
    // directions, and the reason it keeps doing so is that C++ does not fail
    // on how many units are in flight. What follows is the note from when that
    // was first measured.
    //
    // The earlier note recorded the width experiment as negative -- both lanes
    // died at two workers as readily as at four. That was measured while the
    // deaths were in paging, where width does not appear at all, so it says
    // nothing about the case that is left. C++ now fails before any page is
    // requested:
    //
    //     14:11:59  14,666 MiB free of 15,990
    //     14:12:09   9,508     (5.1 GiB in ten seconds)
    //     14:12:48   27 translation units are still indexing
    //     14:13:19     188     -> SIGTERM
    //
    // Eighty seconds, and twenty-seven of thirty-one units still queued: four
    // or five `fmt` translation units in flight and just written exhaust a 16
    // GiB host. Roughly three and a half gigabytes each, against a rule that
    // budgeted eight for two of them. In indexing, unlike in paging, width is
    // a multiplier, so this is the one place the number can still be wrong.
    //
    // Twelve leaves one worker on a 16 GiB host and two from 24 GiB up. It
    // costs the C lane: libuv indexed 242 units in seven and a half minutes at
    // two workers and will take about fifteen at one, which a job whose
    // producer comes from cache can afford and one that builds it cannot.
    //
    // The honest reason this matters more than the arithmetic: when the host
    // dies, the runner takes the log with it. `cpp`'s job log for the run that
    // produced the trace above does not exist -- the agent was killed before it
    // uploaded. The producer reports its largest body in bytes now, split by
    // family, and that reading is the one that says which array to fix. It
    // cannot be read from a machine that is dead.
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
