import { TestValidator } from "@nestia/e2e";
import {
  GRAPH_PROVIDERS,
  type GraphLanguage,
  type GraphEdgeKind,
  type IBulkGraphSession,
  type IGraphProvider,
  goGraphProvider,
  luaGraphProvider,
  rustScipProvider,
  standardScipProviders,
  standardSidecarProviders,
} from "@samchon/graph";
import { spawnSync } from "node:child_process";
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
      assertTheFixtureRejectsAWrongInvocation();
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
        "cc",
        "java",
        "dotnet",
        "python3",
        "ruby",
        "rust-analyzer",
        "rustc",
        "cargo",
        "scip_dart",
        "dart",
        "scip-php",
        "php",
        "lua-language-server",
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
        SAMCHON_GRAPH_JAVA_TOOLCHAIN: platformExecutable(bin, "java"),
        SAMCHON_GRAPH_DOTNET_TOOLCHAIN: platformExecutable(bin, "dotnet"),
        SAMCHON_GRAPH_PYTHON_TOOLCHAIN: platformExecutable(bin, "python3"),
        SAMCHON_GRAPH_RUBY_TOOLCHAIN: platformExecutable(bin, "ruby"),
        SAMCHON_GRAPH_RUST_ANALYZER: platformExecutable(bin, "rust-analyzer"),
        SAMCHON_GRAPH_RUSTC: platformExecutable(bin, "rustc"),
        SAMCHON_GRAPH_CARGO: platformExecutable(bin, "cargo"),
        SAMCHON_GRAPH_SCIP_DART: platformExecutable(bin, "scip_dart"),
        SAMCHON_GRAPH_DART_TOOLCHAIN: platformExecutable(bin, "dart"),
        SAMCHON_GRAPH_SCIP_PHP: platformExecutable(bin, "scip-php"),
        SAMCHON_GRAPH_PHP_TOOLCHAIN: platformExecutable(bin, "php"),
        SAMCHON_GRAPH_LUA: platformExecutable(bin, "lua-language-server"),
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
            `${producerOf(provider.name)}=${producerOf(provider.name)} v1.0.0`,
            "scip=scip v1.0.0",
            ...toolchainRowsOf(provider.name),
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
            expectedCompilerVersion(provider),
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
                expectationsForProvider(root, provider),
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
        if (provider.name === "scip-clang") {
          TestValidator.predicate(
            "scip-clang watches every ambiguous include identity it accepts",
            ["src/shared.inc", "src/extensionless"].every((file) =>
              buildInputs(provider, root).includes(file),
            ),
          );
          fs.appendFileSync(
            path.join(root, "build", "compile_commands.json"),
            "\n",
          );
          const buildConfigurationChanged = await session.refresh();
          TestValidator.predicate(
            "scip-clang rebuilds when its generated compilation database changes",
            buildConfigurationChanged.changed &&
              buildConfigurationChanged.mode === "rebuild" &&
              buildConfigurationChanged.generation === 2,
          );
          fs.appendFileSync(path.join(root, "src", "shared.inc"), "\n");
          const ambiguousIncludeChanged = await session.refresh();
          TestValidator.predicate(
            "scip-clang rebuilds when an accepted .inc document changes",
            ambiguousIncludeChanged.changed &&
              ambiguousIncludeChanged.mode === "rebuild" &&
              ambiguousIncludeChanged.generation === 3,
          );
          const database = path.join(root, "build", "compile_commands.json");
          const validDatabase = fs.readFileSync(database, "utf8");
          let rejected: Error | undefined;
          try {
            fs.appendFileSync(database, "\n[ not json");
            await session.refresh();
          } catch (error) {
            rejected =
              error instanceof Error ? error : new Error(String(error));
          } finally {
            fs.writeFileSync(database, validDatabase);
          }
          TestValidator.predicate(
            "an open scip-clang session revalidates its compilation database",
            rejected?.message.includes("no available compiler command") ===
              true &&
              session.generation === 3 &&
              session.current === ambiguousIncludeChanged.snapshot,
          );
        }
        await session.close();
        if (provider.name === "scip-java") {
          const javaOnly = provider.open({
            root,
            command,
            languages: ["java"],
            options: { cwd: root },
          });
          try {
            const javaSnapshot = await javaOnly.refresh();
            TestValidator.equals(
              "a Java-only scip-java slice publishes Java as its compiler",
              javaSnapshot.snapshot.provenance.compilerVersion,
              "java=java v1.0.0",
            );
          } finally {
            await javaOnly.close();
          }
        }
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
      // An installed tool whose probe does not answer and a tool that is not
      // installed used to produce the same row. They are different facts, and
      // a build universe computed from the first one rebuilt itself whenever a
      // process launch failed for a reason having nothing to do with the
      // project. `unavailable` is now decided by resolution rather than by the
      // probe — which narrows the conflation without closing it, because
      // resolution consults `PATH` by launching a lookup of its own.
      TestValidator.equals(
        "a resolved tool whose probe fails is unreported, not unavailable",
        [
          ...(clang.configuration?.(emptyRoot, {
            ...emptyPath(),
            SAMCHON_GRAPH_SCIP_CLANG: failingIndexer,
            SAMCHON_GRAPH_SCIP: failingDecoder,
          }) ?? []),
        ],
        ["scip-clang=unreported", "scip=unreported", "cc=unavailable"],
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
    luaGraphProvider,
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
    // A real compilation database, because scip-clang's toolchain is read from
    // it rather than from a fixed `clang` on PATH. Both documented entry shapes
    // appear: `arguments` is an already-split vector and `command` is one shell
    // string, and the second names a different driver so the provider cannot
    // pass by finding one.
    "build/compile_commands.json": JSON.stringify(
      [
        {
          directory: root,
          file: "src/main.c",
          arguments: ["clang", "-c", "src/main.c"],
        },
        {
          directory: root,
          file: "src/main.cpp",
          command: "cc -c src/main.cpp",
        },
      ],
      null,
      2,
    ),
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
    "src/shared.inc": "#define FIXTURE_VALUE 1\n",
    "src/extensionless": "#define EXTENSIONLESS_FIXTURE 1\n",
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
      expectationsForProvider(root, provider),
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

function expectationsForProvider(
  root: string,
  provider: IGraphProvider,
): readonly Conformance.IExpectation[] {
  return expectationsOf(root, provider.languages).filter(
    (expectation) =>
      !("edge" in expectation) ||
      provider.facts.includes(expectation.edge.kind),
  );
}

/**
 * The fixture is an oracle only if it can say no.
 *
 * Every provider passing its own arguments proves nothing on its own — the
 * fixture was written from the providers, so agreement is the default outcome.
 * What makes the contract table evidence is that a producer asked the wrong way
 * fails, which is the behaviour a real lane would eventually show and this
 * suite could not.
 */
function assertTheFixtureRejectsAWrongInvocation(): void {
  for (const [producer, args] of [
    // scip-java's real CLI takes the subcommand first; the flag alone is the
    // shape a provider would emit if it dropped it.
    ["scip-java", ["--output", "index.scip"]],
    // scip-ruby writes with `--index-file`, so `--output` is another tool's flag.
    ["scip-ruby", [".", "--output", "index.scip"]],
    // scip-clang takes its destination attached, not as a following argument.
    // Everything else it needs is present, so the detached spelling is the only
    // thing this case can be failing for.
    [
      "scip-clang",
      [
        "--compdb-path=compile_commands.json",
        "--temporary-output-dir=tmp",
        "--index-output-path",
        "index.scip",
      ],
    ],
    // And an invocation that kept the destination but lost the compilation
    // database would index a different program into the right file.
    [
      "scip-clang",
      ["--index-output-path=index.scip", "--temporary-output-dir=tmp"],
    ],
    // The same for a rust-analyzer run that stopped excluding vendored crates.
    ["rust-analyzer", ["scip", ".", "--output", "index.scip"]],
  ] as const) {
    const result = spawnSync(
      process.execPath,
      [GraphPaths.fakeStandardProvider, `--producer=${producer}`, ...args],
      { encoding: "utf8" },
    );
    TestValidator.predicate(
      `the fixture refuses an invocation ${producer} would not accept`,
      result.status !== 0,
    );
  }
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

  // Lua's producer is the language server itself, driven through its `--doc`
  // export with our exporter injected, so the fixture stands in for the server
  // rather than for a binary of ours. `prepare` writes the config that carries
  // the exporter's path, and the fixture refuses an invocation that lost it —
  // without that config the real server would silently run its stock
  // documentation export, which emits no references at all.
  luaGraphProvider.prepare?.(root, { cwd: root });
  const luaCommand: IGraphProvider.ICommand = {
    command: process.execPath,
    args: [GraphPaths.fakeStandardProvider, "--producer=lua-language-server"],
  };
  await assertRegisteredFixture(luaGraphProvider, luaCommand, root);

  // The arguments `resolveRustScipCommand` puts in front of the session's own,
  // not an invocation that skips them. A synthetic command without them opens
  // the same session against a producer that was never asked the way the
  // provider asks it, which is how a wrong subcommand would go unnoticed here
  // and be found only by a real lane.
  const rustCommand: IGraphProvider.ICommand = {
    command: process.execPath,
    args: [
      GraphPaths.fakeStandardProvider,
      "--producer=rust-analyzer",
      "scip",
      ".",
      "--exclude-vendored-libraries",
    ],
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
    if (provider.name === "rust-analyzer-scip") {
      TestValidator.equals(
        "the Rust fixture publishes only its fixed compiler and Cargo oracles",
        refreshed.snapshot.provenance.compilerVersion,
        "rustc=rustc v1.0.0; cargo=cargo v1.0.0",
      );
    }
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
/**
 * The toolchain rows each provider must publish for this fixture.
 *
 * `scip-clang` has two, because the fixture's compilation database records two
 * drivers and both are the compiler for the translation units that named them.
 * A single fixed name could not have said that.
 */
/**
 * The producer binary each provider actually runs.
 *
 * Usually the provider's own name, and stated here for the one place it is not:
 * Dart's indexer ships as `scip_dart`, because pub executables are named the
 * way Dart identifiers are. The provider stays `scip-dart` to match its five
 * siblings and the identity it publishes in provenance, so the configuration
 * row it emits is labelled after the command rather than the provider — and a
 * test that assumed the two were the same name was asserting a coincidence.
 */
function producerOf(provider: string): string {
  return provider === "scip-dart" ? "scip_dart" : provider;
}

function toolchainRowsOf(provider: string): string[] {
  const toolchains: Record<string, readonly string[]> = {
    "scip-clang": ["cc", "clang"],
    "scip-java": ["java"],
    "scip-dotnet": ["dotnet"],
    "scip-python": ["python3"],
    "scip-ruby": ["ruby"],
    "scip-dart": ["dart"],
    "scip-php": ["php"],
  };
  const toolchain = toolchains[provider];
  if (toolchain === undefined) {
    throw new Error(`${provider}: fixture declares no toolchain`);
  }
  return toolchain.map((tool) => `${tool}=${tool} v1.0.0`);
}

function expectedCompilerVersion(provider: IGraphProvider): string {
  return provider.name === "scip-java" &&
    provider.languages.includes("kotlin")
    ? ""
    : toolchainRowsOf(provider.name).join("; ");
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
