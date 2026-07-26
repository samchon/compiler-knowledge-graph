import { TestValidator } from "@nestia/e2e";
import {
  IGraphProvider,
  reduce,
  rustScipProvider,
} from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { GraphPaths } from "../internal/GraphPaths";

const importLib = <T>(relative: string): Promise<T> =>
  import(
    pathToFileURL(path.join(GraphPaths.graphPackageRoot, "lib", relative)).href
  ) as Promise<T>;

/** Low-traffic security, topology, and command guards stay executable. */
export const test_defensive_boundaries_remain_explicit = async () => {
  const { confinedProjectInput } = await importLib<{
    confinedProjectInput: ((root: string, declared: string) => string) & {
      relative(root: string, declared: string): string;
    };
  }>("indexer/confinedProjectInput.js");
  const { parseGraphArgs } = await importLib<{
    parseGraphArgs: {
      safeInteger(
        value: string,
        label: string,
        minimum?: number,
        maximum?: number,
      ): number;
    };
  }>("parseGraphArgs.js");
  const { providerTopology } = await importLib<{
    providerTopology: {
      available(
        root: string,
        languages: readonly ["go"],
        options: { cwd: string },
        env: NodeJS.ProcessEnv,
        providers: readonly IGraphProvider[],
      ): Array<{ provider: string; command: string }>;
    };
  }>("provider/providerTopology.js");
  const { spawnableCommand } = await importLib<{
    spawnableCommand: {
      append(
        command: {
          command: string;
          args: readonly string[];
          windowsVerbatimArguments?: boolean;
        },
        trailing: readonly string[],
      ): unknown;
      windowsSystem(name: string, env?: NodeJS.ProcessEnv): string;
    };
  }>("utils/spawnableCommand.js");

  TestValidator.equals(
    "custom inclusive integer bounds accept their endpoints",
    parseGraphArgs.safeInteger("0", "fixture", 0, 0),
    0,
  );
  TestValidator.equals(
    "an empty viewer graph has no common root",
    reduce({ nodes: [], edges: [] }).nodes,
    [],
  );
  TestValidator.equals(
    "keeping ignored viewer nodes reports no ignored drop",
    reduce(
      {
        nodes: [
          {
            id: "a.ts#one:function",
            name: "one",
            kind: "function",
            file: "a.ts",
            ignored: true,
          },
        ],
        edges: [],
      },
      { keepIgnored: true },
    ).counts.droppedIgnored,
    0,
  );

  const root = GraphPaths.createTempDirectory("graph-confined-input-");
  const outside = GraphPaths.createTempDirectory("graph-confined-outside-");
  fs.writeFileSync(path.join(root, "inside.txt"), "inside\n");
  TestValidator.equals(
    "a confined input normalizes back to a portable relative path",
    confinedProjectInput.relative(root, "inside.txt"),
    "inside.txt",
  );
  for (const declared of ["", path.resolve(outside, "outside.txt"), "../escape"]) {
    TestValidator.error(`unsafe build input ${JSON.stringify(declared)} is refused`, () =>
      confinedProjectInput(root, declared),
    );
  }
  const junction = path.join(root, "junction");
  fs.symlinkSync(outside, junction, "junction");
  TestValidator.error("an existing junction cannot escape the checkout", () =>
    confinedProjectInput(root, "junction/missing.txt"),
  );

  const provider: IGraphProvider = {
    name: "topology-fixture",
    languages: ["go"],
    authority: "analyzer",
    facts: [],
    refuse: () => undefined,
    resolve: () => ({ command: process.execPath, args: [] }),
    open: () => {
      throw new Error("topology inspection must not open a provider");
    },
  };
  TestValidator.equals(
    "topology reports the resolved command for an eligible provider",
    providerTopology.available(
      root,
      ["go"],
      { cwd: root },
      emptyPath(),
      [provider],
    )[0]?.command,
    process.execPath,
  );
  // Deriving a configuration row launches the toolchain, and this snapshot is
  // taken on every resident load. A provider whose `configuration` throws is
  // the only way to prove the call is absent rather than merely cheap: an
  // assertion on the returned rows would still pass if the derivation ran and
  // its result were discarded.
  const configuredProvider: IGraphProvider = {
    ...provider,
    name: "configured-topology-fixture",
    configuration: () => {
      throw new Error("topology inspection must not derive configuration");
    },
  };
  TestValidator.equals(
    "topology never derives a provider's effective configuration",
    providerTopology.available(
      root,
      ["go"],
      { cwd: root },
      emptyPath(),
      [configuredProvider],
    )[0]?.provider,
    "configured-topology-fixture",
  );

  const rustConfiguration = rustScipProvider.configuration?.(root, {
    ...emptyPath(),
    CARGO_FEATURE_FIXTURE: undefined,
  });
  TestValidator.predicate(
    "Rust configuration preserves undefined Cargo flags and unavailable tools",
    rustConfiguration?.includes("CARGO_FEATURE_FIXTURE=") === true &&
      rustConfiguration.includes("rust-analyzer=unavailable") &&
      rustConfiguration.includes("scip=unavailable"),
  );

  TestValidator.error("a malformed verbatim command cannot be extended", () =>
    spawnableCommand.append(
      {
        command: "cmd.exe",
        args: ["/d"],
        windowsVerbatimArguments: true,
      },
      ["tail"],
    ),
  );

  const systemRoot = process.env.SystemRoot;
  delete process.env.SystemRoot;
  try {
    TestValidator.equals(
      "the Windows system helper has a deterministic last-resort root",
      spawnableCommand.windowsSystem("where.exe", {}),
      path.join("C:\\Windows", "System32", "where.exe"),
    );
  } finally {
    if (systemRoot !== undefined) process.env.SystemRoot = systemRoot;
  }
};

function emptyPath(): NodeJS.ProcessEnv {
  return {
    PATH: "",
    Path: "",
    PATHEXT: ".EXE;.CMD;.BAT",
    SystemRoot: process.env.SystemRoot,
  };
}
