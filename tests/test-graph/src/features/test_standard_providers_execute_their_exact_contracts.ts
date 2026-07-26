import { TestValidator } from "@nestia/e2e";
import {
  GRAPH_PROVIDERS,
  type GraphLanguage,
  type GraphEdgeKind,
  type IBulkGraphSession,
  type IGraphProvider,
  goGraphProvider,
  rustScipProvider,
  standardScipProviders,
  standardSidecarProviders,
} from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";

import { Conformance } from "../internal/Conformance";
import { GraphPaths } from "../internal/GraphPaths";
import { ttscGraphProvider } from "../../../../packages/graph/src/provider/ttscgraph/ttscGraphProvider";

/**
 * An atomic strict provider must carry the shared semantic corpus for every
 * language it owns; startup and a nonempty payload alone cannot prove that.
 */
export const test_standard_providers_execute_their_exact_contracts =
  async () => {
    const root = GraphPaths.createTempDirectory("graph-standard-providers-");
    const previous = new Map<string, string | undefined>();
    try {
      previous.set(
        "SAMCHON_GRAPH_FIXTURE_MODE",
        process.env.SAMCHON_GRAPH_FIXTURE_MODE,
      );
      delete process.env.SAMCHON_GRAPH_FIXTURE_MODE;
      writeProject(root);
      assertFixtureRegistryCoverage();
      const bin = path.join(root, ".samchon-graph", "bin");
      fs.mkdirSync(bin, { recursive: true });

      // The toolchain shims matter as much as the indexer ones: a
      // `semantic-index` provider still has to say which language version
      // resolved its facts, and reading that off whatever the host happens to
      // have installed would make this suite's answer depend on the machine.
      const names = [
        "scip-clang",
        "scip-java",
        "scip-dotnet",
        "scip-python",
        "scip-ruby",
        "scip",
        "clang",
        "java",
        "dotnet",
        "python3",
        "ruby",
        "samchon-graph-swift",
        "samchon-graph-zig",
        "samchon-graph-php",
        "samchon-graph-lua",
        "samchon-graph-dart",
      ];
      for (const name of names) {
        writeShim(platformExecutable(bin, name), name);
      }

      const overrides: Record<string, string> = {
        SAMCHON_GRAPH_SCIP_CLANG: platformExecutable(bin, "scip-clang"),
        SAMCHON_GRAPH_SCIP_JAVA: platformExecutable(bin, "scip-java"),
        SAMCHON_GRAPH_SCIP_DOTNET: platformExecutable(bin, "scip-dotnet"),
        SAMCHON_GRAPH_SCIP_PYTHON: platformExecutable(bin, "scip-python"),
        SAMCHON_GRAPH_SCIP_RUBY: platformExecutable(bin, "scip-ruby"),
        SAMCHON_GRAPH_SCIP: platformExecutable(bin, "scip"),
        SAMCHON_GRAPH_CLANG: platformExecutable(bin, "clang"),
        SAMCHON_GRAPH_JAVA: platformExecutable(bin, "java"),
        SAMCHON_GRAPH_DOTNET: platformExecutable(bin, "dotnet"),
        SAMCHON_GRAPH_PYTHON: platformExecutable(bin, "python3"),
        SAMCHON_GRAPH_RUBY: platformExecutable(bin, "ruby"),
        SAMCHON_GRAPH_SWIFT: platformExecutable(bin, "samchon-graph-swift"),
        SAMCHON_GRAPH_ZIG: platformExecutable(bin, "samchon-graph-zig"),
        SAMCHON_GRAPH_PHP: platformExecutable(bin, "samchon-graph-php"),
        SAMCHON_GRAPH_LUA: platformExecutable(bin, "samchon-graph-lua"),
        SAMCHON_GRAPH_DART: platformExecutable(bin, "samchon-graph-dart"),
      };
      for (const [key, value] of Object.entries(overrides)) {
        previous.set(key, process.env[key]);
        process.env[key] = value;
      }

      for (const provider of standardScipProviders) {
        const command = provider.resolve(root, process.env);
        TestValidator.predicate(
          `${provider.name} resolves its exact producer and decoder`,
          command !== undefined,
        );
        if (command === undefined) {
          throw new Error(`${provider.name}: fixture command did not resolve`);
        }
        TestValidator.predicate(
          `${provider.name} records indexer, decoder, and toolchain versions`,
          sameArray(provider.configuration?.(root, process.env), [
            `${provider.name}=${provider.name} v1.0.0`,
            "scip=scip v1.0.0",
            `${toolchainOf(provider.name)}=${toolchainOf(provider.name)} v1.0.0`,
          ]),
        );
        TestValidator.predicate(
          `${provider.name} watches source and build inputs`,
          buildInputs(provider, root).length > 0,
        );
        const session = provider.open({
          root,
          command,
          languages: provider.languages,
          options: { cwd: root },
        });
        const refreshed = await session.refresh();
        const unchanged = await session.refresh();
        const independent = await indexOnce(provider, command, root);
        // A `semantic-index` snapshot still has to say which toolchain resolved
        // its facts. Without it a consumer cannot tell one program indexed twice
        // from two runtimes indexed once, and the strict experiment lane rejects
        // the provenance as incomplete.
        TestValidator.predicate(
          `${provider.name} publishes the toolchain its facts describe`,
          refreshed.snapshot.provenance.compilerVersion ===
            `${toolchainOf(provider.name)}=${toolchainOf(provider.name)} v1.0.0`,
        );
        TestValidator.predicate(
          `${provider.name} publishes the shared strict-fixture corpus`,
          refreshed.mode === "initial" &&
            refreshed.generation === 1 &&
            unchanged.mode === "unchanged" &&
            unchanged.generation === 1 &&
            Conformance.failures(
              Conformance.check(
                refreshed.snapshot,
                expectationsOf(root, provider.languages),
              ),
              Conformance.structure(
                refreshed.snapshot,
                provider,
                provider.languages,
                root,
              ),
              Conformance.published(refreshed.snapshot),
              Conformance.deterministic(
                refreshed.snapshot,
                independent,
              ),
            ).length === 0,
        );
        await session.close();
        await assertHeuristicTwinFails(provider, command, root);
      }

      for (const provider of standardSidecarProviders) {
        const command = provider.resolve(root, process.env);
        TestValidator.predicate(
          `${provider.name} resolves its named sidecar contract`,
          command !== undefined,
        );
        if (command === undefined) {
          throw new Error(`${provider.name}: fixture command did not resolve`);
        }
        TestValidator.predicate(
          `${provider.name} watches source and build inputs`,
          buildInputs(provider, root).length > 0,
        );
        const session = provider.open({
          root,
          command,
          languages: provider.languages,
          options: { cwd: root },
        });
        const refreshed = await session.refresh();
        const unchanged = await session.refresh();
        const independent = await indexOnce(provider, command, root);
        TestValidator.predicate(
          `${provider.name} publishes the shared strict-fixture corpus`,
          refreshed.mode === "initial" &&
            refreshed.generation === 1 &&
            unchanged.mode === "unchanged" &&
            unchanged.generation === 1 &&
            refreshed.snapshot.provenance.provider === provider.name &&
            Conformance.failures(
              Conformance.check(
                refreshed.snapshot,
                expectationsOf(root, provider.languages),
              ),
              Conformance.structure(
                refreshed.snapshot,
                provider,
                provider.languages,
                root,
              ),
              Conformance.published(refreshed.snapshot),
              Conformance.deterministic(
                refreshed.snapshot,
                independent,
              ),
            ).length === 0,
        );
        await session.close();
        await assertHeuristicTwinFails(
          provider,
          command,
          root,
        );
      }
      await assertRemainingRegisteredFixtures(root);

      const emptyRoot = GraphPaths.createTempDirectory(
        "graph-standard-provider-missing-",
      );
      const clang = standardScipProviders.find(
        (provider) => provider.name === "scip-clang",
      )!;
      TestValidator.equals(
        "Clang declines a checkout without a compilation database",
        clang.resolve(emptyRoot, emptyPath()),
        undefined,
      );
      TestValidator.predicate(
        "unavailable standard tools remain explicit configuration facts",
        clang
          .configuration?.(emptyRoot, emptyPath())
          .every((row) => row.endsWith("=unavailable")) === true,
      );

      const failingIndexer = platformExecutable(emptyRoot, "failing-clang");
      const failingDecoder = platformExecutable(emptyRoot, "failing-scip");
      writeFailingShim(failingIndexer);
      writeFailingShim(failingDecoder);
      fs.writeFileSync(path.join(emptyRoot, "compile_commands.json"), "[]\n");
      TestValidator.predicate(
        "failing standard version probes are reported as unavailable",
        clang
          .configuration?.(emptyRoot, {
            ...emptyPath(),
            SAMCHON_GRAPH_SCIP_CLANG: failingIndexer,
            SAMCHON_GRAPH_SCIP: failingDecoder,
          })
          .every((row) => row.endsWith("=unavailable")) === true,
      );

      const decoder = process.env.SAMCHON_GRAPH_SCIP;
      const searchPath = process.env.PATH;
      const searchPathAlias = process.env.Path;
      delete process.env.SAMCHON_GRAPH_SCIP;
      process.env.PATH = "";
      process.env.Path = "";
      try {
        TestValidator.error(
          "a decoder disappearing after selection refuses to open the slice",
          () =>
            clang.open({
              root: emptyRoot,
              command: {
                command: process.execPath,
                args: [
                  GraphPaths.fakeStandardProvider,
                  "--producer=scip-clang",
                ],
              },
              languages: clang.languages,
              options: { cwd: emptyRoot },
            }),
        );
      } finally {
        if (decoder !== undefined) process.env.SAMCHON_GRAPH_SCIP = decoder;
        if (searchPath === undefined) delete process.env.PATH;
        else process.env.PATH = searchPath;
        if (searchPathAlias === undefined) delete process.env.Path;
        else process.env.Path = searchPathAlias;
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

function buildInputs(
  provider: (typeof standardScipProviders)[number],
  root: string,
): readonly string[] {
  return typeof provider.buildInputs === "function"
    ? provider.buildInputs(root)
    : (provider.buildInputs ?? []);
}

function assertFixtureRegistryCoverage(): void {
  const exercised = [
    ttscGraphProvider,
    goGraphProvider,
    rustScipProvider,
    ...standardScipProviders,
    ...standardSidecarProviders,
  ]
    .map((provider) => provider.name)
    .sort();
  TestValidator.equals(
    "the semantic corpus has an exact fixture for every registered strict provider",
    GRAPH_PROVIDERS.map((provider) => provider.name).sort(),
    exercised,
  );
}

function writeProject(root: string): void {
  const files: Record<string, string> = {
    "compile_commands.json": "[]\n",
    "CMakeLists.txt": "project(fixture)\n",
    "pom.xml": "<project />\n",
    "global.json": "{}\n",
    "pyproject.toml": "[project]\nname = \"fixture\"\n",
    Gemfile: "source \"https://example.invalid\"\n",
    "Package.swift": "// swift-tools-version: 6.0\n",
    "build.zig": "pub fn build() void {}\n",
    "composer.json": "{}\n",
    ".luarc.json": "{}\n",
    "pubspec.yaml": "name: fixture\n",
    "Cargo.toml": "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n",
    "go.mod": "module fixture\n\ngo 1.24\n",
    "tsconfig.json": "{\"compilerOptions\":{}}\n",
    "src/index.ts": "export { caller } from \"./core/order\";\n",
    "src/core/order.ts": "// mentionedInComment must remain prose\nexport function caller() { return callee(); }\nexport function callee() { return 1; }\n",
    "src/empty.ts": "export {};\n",
    "src/lib.rs": "// mentionedInComment must remain prose\npub fn caller() { callee(); }\npub fn callee() {}\n",
    "src/main.go": "// mentionedInComment must remain prose\npackage main\nfunc caller() { callee() }\nfunc callee() {}\n",
    "src/main.c": "/* mentionedInComment must remain prose */\nint callee(void);\nint caller(void) { return callee(); }\nint callee(void) { return 1; }\n",
    "src/main.cpp": "// mentionedInComment must remain prose\nint callee();\nint caller() { return callee(); }\nint callee() { return 1; }\n",
    "src/Main.java": "// mentionedInComment must remain prose\nclass Main { static void caller() { callee(); } static void callee() {} }\n",
    "src/Main.kt": "// mentionedInComment must remain prose\nfun caller() { callee() }\nfun callee() {}\n",
    "src/Main.scala": "// mentionedInComment must remain prose\nobject Main { def caller(): Unit = callee(); def callee(): Unit = () }\n",
    "src/Main.cs": "// mentionedInComment must remain prose\nclass Main { static void caller() { callee(); } static void callee() {} }\n",
    "src/main.py": "# mentionedInComment must remain prose\ndef caller():\n    callee()\ndef callee():\n    return 1\n",
    "src/main.rb": "# mentionedInComment must remain prose\ndef caller; callee; end\ndef callee; 1; end\n",
    "src/Main.swift": "// mentionedInComment must remain prose\nfunc caller() { callee() }\nfunc callee() {}\n",
    "src/main.zig": "// mentionedInComment must remain prose\nfn caller() void { callee(); }\nfn callee() void {}\n",
    "src/main.php": "<?php\n// mentionedInComment must remain prose\nfunction caller() { callee(); }\nfunction callee() {}\n",
    "src/main.lua": "-- mentionedInComment must remain prose\nfunction caller() callee() end\nfunction callee() end\n",
    "src/main.dart": "// mentionedInComment must remain prose\nvoid caller() { callee(); }\nvoid callee() {}\n",
  };
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
}

async function assertHeuristicTwinFails(
  provider: IGraphProvider,
  command: IGraphProvider.ICommand,
  root: string,
): Promise<void> {
  const prior = process.env.SAMCHON_GRAPH_FIXTURE_MODE;
  process.env.SAMCHON_GRAPH_FIXTURE_MODE = "heuristic";
  let session: ReturnType<IGraphProvider["open"]> | undefined;
  try {
    session = provider.open({
      root,
      command,
      languages: provider.languages,
      options: { cwd: root },
    });
    const refreshed = await session.refresh();
    const failures = Conformance.check(
      refreshed.snapshot,
      expectationsOf(root, provider.languages),
    ).failures;
    TestValidator.predicate(
      `${provider.name} rejects only the common comment-only semantic negative twin`,
      failures.length > 0 &&
        failures.every((failure) => failure.includes("mentionedInComment")),
    );
  } finally {
    try {
      await session?.close();
    } finally {
      if (prior === undefined) delete process.env.SAMCHON_GRAPH_FIXTURE_MODE;
      else process.env.SAMCHON_GRAPH_FIXTURE_MODE = prior;
    }
  }
}

function expectationsOf(
  root: string,
  languages: readonly GraphLanguage[],
  relationship: GraphEdgeKind = "references",
): readonly Conformance.IExpectation[] {
  return languages.flatMap((language) => {
    const file = SOURCE_FILES[language];
    const caller = sourceSpans(root, file, "caller")[0]!;
    const callee = sourceSpans(root, file, "callee");
    const calleeDefinition = callee.at(-1)!;
    const calleeReference = callee.at(-2)!;
    return [
      {
        reason: "the strict fixture resolves the caller declaration",
        node: {
          name: "caller",
          kind: "function",
          language,
          file,
          evidence: caller,
        },
      },
      {
        reason: "the strict fixture resolves the referenced callee declaration",
        node: {
          name: "callee",
          kind: "function",
          language,
          file,
          evidence: calleeDefinition,
        },
      },
      {
        reason: "a name occurring only in prose is not a declaration",
        node: {
          name: "mentionedInComment",
          kind: "function",
          language,
          present: false,
        },
      },
      {
        reason: "a resolved occurrence is published as a reference",
        edge: {
          kind: relationship,
          from: { name: "caller", kind: "function", language, file },
          to: { name: "callee", kind: "function", language, file },
          evidence: calleeReference,
        },
      },
      {
        reason: "a prose occurrence is never promoted to a reference",
        edge: {
          kind: relationship,
          from: { name: "caller", kind: "function", language, file },
          to: {
            name: "mentionedInComment",
            kind: "function",
            language,
            file,
          },
          present: false,
        },
      },
    ];
  });
}

async function assertRemainingRegisteredFixtures(root: string): Promise<void> {
  await assertRegisteredFixture(
    ttscGraphProvider,
    {
      command: process.execPath,
      args: [GraphPaths.fakeTtscGraphServer, "--conformance"],
    },
    root,
    "calls",
  );
  await assertTtscHeuristicTwinFails(root);

  const goCommand: IGraphProvider.ICommand = {
    command: process.execPath,
    args: [GraphPaths.fakeStandardProvider, "--producer=samchon-graph-go"],
  };
  await assertRegisteredFixture(goGraphProvider, goCommand, root);
  await assertHeuristicTwinFails(goGraphProvider, goCommand, root);

  const rustCommand: IGraphProvider.ICommand = {
    command: process.execPath,
    args: [GraphPaths.fakeStandardProvider, "--producer=rust-analyzer"],
  };
  await assertRegisteredFixture(rustScipProvider, rustCommand, root);
  await assertHeuristicTwinFails(rustScipProvider, rustCommand, root);
}

async function assertRegisteredFixture(
  provider: IGraphProvider,
  command: IGraphProvider.ICommand,
  root: string,
  relationship: GraphEdgeKind = "references",
): Promise<void> {
  const session = provider.open({
    root,
    command,
    languages: provider.languages,
    options: { cwd: root },
  });
  try {
    const refreshed = await session.refresh();
    const unchanged = await session.refresh();
    const independent = await indexOnce(provider, command, root);
    // Compared rather than reduced to a predicate: a conformance report names
    // exactly which invariant a provider broke, and folding it into a boolean
    // throws that away at the one moment it is worth having.
    TestValidator.equals(
      `${provider.name} executes the shared registered-provider corpus`,
      [
        refreshed.mode,
        refreshed.generation,
        unchanged.mode,
        unchanged.generation,
        Conformance.failures(
          Conformance.check(
            refreshed.snapshot,
            expectationsOf(root, provider.languages, relationship),
          ),
          Conformance.structure(
            refreshed.snapshot,
            provider,
            provider.languages,
            root,
          ),
          Conformance.published(refreshed.snapshot),
          Conformance.deterministic(refreshed.snapshot, independent),
        ),
      ],
      ["initial", 1, "unchanged", 1, []],
    );
  } finally {
    await session.close();
  }
}

async function assertTtscHeuristicTwinFails(root: string): Promise<void> {
  const session = ttscGraphProvider.open({
    root,
    command: {
      command: process.execPath,
      args: [
        GraphPaths.fakeTtscGraphServer,
        "--conformance",
        "--conformance-heuristic",
      ],
    },
    languages: ["typescript"],
    options: { cwd: root },
  });
  try {
    const refreshed = await session.refresh();
    const failures = Conformance.check(
      refreshed.snapshot,
      expectationsOf(root, ["typescript"], "calls"),
    ).failures;
    TestValidator.predicate(
      "ttscgraph rejects only the common comment-only semantic negative twin",
      failures.length > 0 &&
        failures.every((failure) => failure.includes("mentionedInComment")),
    );
  } finally {
    await session.close();
  }
}

async function indexOnce(
  provider: IGraphProvider,
  command: IGraphProvider.ICommand,
  root: string,
): Promise<IBulkGraphSession.ISnapshot> {
  const session = provider.open({
    root,
    command,
    languages: provider.languages,
    options: { cwd: root },
  });
  try {
    return (await session.refresh()).snapshot;
  } finally {
    await session.close();
  }
}

function sourceSpans(
  root: string,
  file: string,
  word: string,
): Conformance.ISpanExpectation[] {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  const output: Conformance.ISpanExpectation[] = [];
  let offset = 0;
  for (;;) {
    const found = text.indexOf(word, offset);
    if (found < 0) return output;
    const prefix = text.slice(0, found);
    const line = prefix.split("\n").length;
    const column = found - prefix.lastIndexOf("\n");
    output.push({
      file,
      startLine: line,
      startCol: column,
      endLine: line,
      endCol: column + word.length,
    });
    offset = found + word.length;
  }
}

const SOURCE_FILES: Record<GraphLanguage, string> = {
  typescript: "src/core/order.ts",
  go: "src/main.go",
  rust: "src/lib.rs",
  cpp: "src/main.cpp",
  c: "src/main.c",
  java: "src/Main.java",
  csharp: "src/Main.cs",
  kotlin: "src/Main.kt",
  swift: "src/Main.swift",
  scala: "src/Main.scala",
  zig: "src/main.zig",
  python: "src/main.py",
  ruby: "src/main.rb",
  php: "src/main.php",
  lua: "src/main.lua",
  dart: "src/main.dart",
};

function platformExecutable(directory: string, command: string): string {
  return path.join(
    directory,
    process.platform === "win32" ? `${command}.cmd` : command,
  );
}

function writeShim(file: string, producer: string): void {
  const fixture = GraphPaths.fakeStandardProvider;
  fs.writeFileSync(
    file,
    process.platform === "win32"
      ? [
          "@echo off",
          `"${process.execPath}" "${fixture}" "--producer=${producer}" %*`,
          "",
        ].join("\r\n")
      : [
          "#!/bin/sh",
          `exec "${process.execPath}" "${fixture}" "--producer=${producer}" "$@"`,
          "",
        ].join("\n"),
  );
  fs.chmodSync(file, 0o755);
}

function writeFailingShim(file: string): void {
  fs.writeFileSync(
    file,
    process.platform === "win32"
      ? "@exit /b 1\r\n"
      : "#!/bin/sh\nexit 1\n",
  );
  fs.chmodSync(file, 0o755);
}

function emptyPath(): NodeJS.ProcessEnv {
  return {
    PATH: "",
    Path: "",
    PATHEXT: ".EXE;.CMD;.BAT",
    SystemRoot: process.env.SystemRoot,
  };
}

/**
 * The toolchain a SCIP entry describes, as the registry declares it.
 *
 * Named here rather than matched loosely, because the fixture prints the same
 * `<producer> v1.0.0` for every shim: a check that only looked at the suffix
 * would pass if `compilerVersion` were wired to the indexer instead, which is
 * the one thing these cases exist to distinguish.
 */
function toolchainOf(provider: string): string {
  const toolchains: Record<string, string> = {
    "scip-clang": "clang",
    "scip-java": "java",
    "scip-dotnet": "dotnet",
    "scip-python": "python3",
    "scip-ruby": "ruby",
  };
  const toolchain = toolchains[provider];
  if (toolchain === undefined) {
    throw new Error(`${provider}: fixture declares no toolchain`);
  }
  return toolchain;
}

function sameArray(
  left: readonly string[] | undefined,
  right: readonly string[],
): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
