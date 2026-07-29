import { TestValidator } from "@nestia/e2e";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  goGraphProvider,
  providerInputFiles,
  resolveProviderCommand,
} from "@samchon/graph";
import { languageBuildInputs } from "../../../../packages/graph/src/indexer/languageBuildInputs";
import { spawnableCommand } from "../../../../packages/graph/src/utils/spawnableCommand";

import { GraphPaths } from "../internal/GraphPaths";

/** Provider discovery is project-local, platform-correct, and repository-safe. */
export const test_provider_commands_and_inputs_respect_project_boundaries =
  () => {
    const root = GraphPaths.createTempDirectory("graph-provider-resolution-");
    try {
      fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
      fs.mkdirSync(path.join(root, "ignored", "node_modules"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(root, "foreign", ".git"), { recursive: true });
      fs.mkdirSync(path.join(root, "embedded", "assets"), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, "main.go"), "package main\n");
      fs.writeFileSync(
        path.join(root, "embedded", "main.go"),
        'package embedded\n\nimport "embed"\n\n//go:embed assets/* local.txt\nvar content embed.FS\n',
      );
      fs.writeFileSync(
        path.join(root, "embedded", "assets", "message.txt"),
        "hello\n",
      );
      fs.writeFileSync(path.join(root, "embedded", "local.txt"), "local\n");
      fs.writeFileSync(path.join(root, "native.h"), "#define VALUE 1\n");
      fs.writeFileSync(path.join(root, "src", "nested", "worker.go"), "package nested\n");
      fs.writeFileSync(path.join(root, "go.mod"), "module example.com/main\n");
      fs.writeFileSync(path.join(root, "src", "nested", "go.mod"), "module example.com/nested\n");
      fs.writeFileSync(path.join(root, "ignored", "node_modules", "go.mod"), "ignored\n");
      fs.writeFileSync(path.join(root, "foreign", "go.mod"), "foreign\n");
      fs.writeFileSync(path.join(root, "foreign", "foreign.go"), "package foreign\n");
      fs.writeFileSync(
        path.join(root, "src", "nested", "model.rb"),
        "class Model; end\n",
      );
      fs.mkdirSync(path.join(root, "sorbet"), { recursive: true });
      fs.mkdirSync(path.join(root, "other"), { recursive: true });
      fs.writeFileSync(path.join(root, "sorbet", "config"), "--dir=.\n");
      fs.writeFileSync(path.join(root, "other", "config"), "--ignore=.\n");

      TestValidator.equals(
        "source and nested build inputs are sorted inside one checkout",
        providerInputFiles(root, ["go"], ["go.mod", "go.work"]),
        [
          "embedded/main.go",
          "go.mod",
          "main.go",
          "src/nested/go.mod",
          "src/nested/worker.go",
        ],
      );
      TestValidator.equals(
        "a path-qualified build input watches only that exact relative file",
        providerInputFiles(root, [], ["sorbet/config"]),
        ["sorbet/config"],
      );
      TestValidator.equals(
        "a generic lane keeps a path-qualified build input at its root",
        languageBuildInputs(root, ["ruby"]).filter((input) =>
          input.endsWith("sorbet/config"),
        ),
        ["sorbet/config"],
      );
      fs.mkdirSync(path.join(root, ".mvn"), { recursive: true });
      fs.mkdirSync(path.join(root, "gradle", "conventions"), {
        recursive: true,
      });
      for (const [file, contents] of [
        [".mvn/maven.config", "-Pfixture\n"],
        [
          ".mvn/wrapper/MavenWrapperDownloader.java",
          "final class MavenWrapperDownloader {}\n",
        ],
        ["mvnw", "#!/bin/sh\n"],
        ["gradle.lockfile", "empty=1\n"],
        ["gradle/libs.versions.toml", "[versions]\n"],
        [
          "gradle/wrapper/gradle-wrapper.properties",
          "distributionUrl=x\n",
        ],
        ["gradle/conventions/java.gradle", "allprojects {}\n"],
        ["gradle/conventions/kotlin.gradle.kts", "allprojects {}\n"],
        ["gradle-wrapper.properties", "unrelated=1\n"],
        [".mvn/unrelated.gradle.kts", "allprojects {}\n"],
        ["unrelated.kts", "println(\"not a Gradle script\")\n"],
      ] as const) {
        const absolute = path.join(root, file);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, contents);
      }
      const javaBuildInputs = languageBuildInputs(root, ["java"]);
      fs.mkdirSync(path.join(root, ".git"), { recursive: true });
      fs.writeFileSync(path.join(root, ".git", "declared.txt"), "private\n");
      TestValidator.equals(
        "exact build paths cross ignored directories but never Git metadata",
        providerInputFiles(root, [], [
          ".mvn/maven.config",
          ".git/declared.txt",
        ]),
        [".mvn/maven.config"],
      );
      fs.rmSync(path.join(root, ".git"), { recursive: true });
      fs.writeFileSync(path.join(root, ".git"), "gitdir: elsewhere\n");
      TestValidator.predicate(
        "a Git worktree marker is neither a named nor extensionless input",
        providerInputFiles(root, [], [".git"], [""]).includes(".git") ===
          false,
      );
      // Only scip-clang asks for the empty extension, and it asks because a C++
      // include universe really does contain files with no suffix. `extname`
      // reports no extension for a leading-dot name too, so every configuration
      // file in the project answered the same request and entered the strict
      // provider's input manifest — after which editing `.gitignore` rebuilt an
      // index that never read it. The worktree marker above was one witness of
      // that class; these are the rest of it.
      fs.mkdirSync(path.join(root, "include"), { recursive: true });
      for (const [file, contents] of [
        [".gitignore", "build/\n"],
        [".clang-format", "BasedOnStyle: LLVM\n"],
        ["include/api", "#pragma once\n"],
        ["LICENSE", "MIT\n"],
      ] as const) {
        fs.writeFileSync(path.join(root, file), contents);
      }
      const extensionless = providerInputFiles(root, [], [], [""]);
      TestValidator.predicate(
        "an extensionless include is watched and a dotfile is not",
        extensionless.includes("include/api") &&
          extensionless.includes("LICENSE") &&
          extensionless.includes(".gitignore") === false &&
          extensionless.includes(".clang-format") === false,
      );
      TestValidator.predicate(
        "generic JVM lanes watch Maven and Gradle build-universe inputs",
        [
          ".mvn/maven.config",
          ".mvn/wrapper/MavenWrapperDownloader.java",
          "mvnw",
          "gradle.lockfile",
          "gradle/libs.versions.toml",
          "gradle/wrapper/gradle-wrapper.properties",
          "gradle/conventions/java.gradle",
          "gradle/conventions/kotlin.gradle.kts",
        ].every((input) => javaBuildInputs.includes(input)) &&
          javaBuildInputs.includes("gradle-wrapper.properties") === false &&
          javaBuildInputs.includes(".mvn/unrelated.gradle.kts") === false &&
          javaBuildInputs.includes("unrelated.kts") === false,
      );
      fs.mkdirSync(path.join(root, "vendor"), { recursive: true });
      fs.mkdirSync(path.join(root, "vendor", "example.com", "dep"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(root, "vendor", ".git"), { recursive: true });
      fs.mkdirSync(path.join(root, "a", "vendor"), { recursive: true });
      fs.writeFileSync(path.join(root, "vendor", "modules.txt"), "# pinned\n");
      fs.writeFileSync(
        path.join(root, "vendor", "example.com", "dep", "dep.go"),
        "package dep\n",
      );
      fs.writeFileSync(path.join(root, "vendor", ".git", "ignored.go"), "ignored\n");
      fs.writeFileSync(path.join(root, "a", "go.mod"), "module example.com/a\n");
      fs.writeFileSync(
        path.join(root, "a", "vendor", "modules.txt"),
        "# nested pinned\n",
      );
      TestValidator.equals(
        "the Go provider fences module, workspace, source, and vendor inputs",
        [
          typeof goGraphProvider.buildInputs === "function"
            ? goGraphProvider.buildInputs(root)
            : [],
          goGraphProvider.inputs(root),
          goGraphProvider.indexArgs("snapshot.json"),
          goGraphProvider.providerConfiguration(root).some((row) =>
            row.startsWith("GOOS="),
          ),
        ],
        [
          [
            "a/go.mod",
            "a/vendor/modules.txt",
            "embedded/assets/message.txt",
            "embedded/local.txt",
            "go.mod",
            "native.h",
            "src/nested/go.mod",
            "vendor/example.com/dep/dep.go",
            "vendor/modules.txt",
          ],
          [
            "a/go.mod",
            "a/vendor/modules.txt",
            "embedded/assets/message.txt",
            "embedded/local.txt",
            "embedded/main.go",
            "go.mod",
            "main.go",
            "native.h",
            "src/nested/go.mod",
            "src/nested/worker.go",
            "vendor/example.com/dep/dep.go",
            "vendor/modules.txt",
          ],
          ["--output=snapshot.json"],
          true,
        ],
      );
      TestValidator.predicate(
        "an unavailable Go toolchain is part of the effective configuration",
        goGraphProvider
          .effectiveConfiguration(root, pathEnvironment(""))
          .includes("go-env=unavailable"),
      );
      const configuredGo = platformExecutable(root, "configured-go");
      writeGoEnvironmentExecutable(configuredGo);
      TestValidator.predicate(
        "a command-shim Go toolchain is probed through its exact invocation",
        goGraphProvider
          .effectiveConfiguration(root, {
            ...pathEnvironment(""),
            SAMCHON_GRAPH_GO_TOOLCHAIN: configuredGo,
          })
          .some(
            (row) =>
              row.startsWith("go-env=") &&
              row.includes('"GOVERSION":"go1.26-fixture"'),
          ),
      );
      const configuredScipGo = platformExecutable(
        root,
        "configured-scip-go",
      );
      writeVersionedExecutable(configuredScipGo, "scip-go v0.2.7");
      TestValidator.predicate(
        "the exact SCIP producer version is part of the effective configuration",
        goGraphProvider
          .effectiveConfiguration(root, {
            ...pathEnvironment(""),
            SAMCHON_GRAPH_SCIP_GO: configuredScipGo,
          })
          .includes("scip-go=scip-go v0.2.7"),
      );

      const command = "samchon-provider-resolution-fixture";
      const privateBin = path.join(root, ".samchon-graph", "bin");
      const packageBin = path.join(root, "node_modules", ".bin");
      fs.mkdirSync(privateBin, { recursive: true });
      fs.mkdirSync(packageBin, { recursive: true });
      const emptyPath = pathEnvironment("");

      // An installed toolchain whose probe does not answer is not an absent
      // one. Reporting `unavailable` for both moved the Go build universe over
      // a launch failure, and since a non-serving candidate's configuration is
      // part of the resident topology snapshot, that rebuilt every language.
      const failingGo = platformExecutable(privateBin, "go");
      writeExecutable(failingGo, 1);
      TestValidator.predicate(
        "an installed Go whose probe fails is unreported, not unavailable",
        goGraphProvider
          .effectiveConfiguration(root, {
            ...emptyPath,
            SAMCHON_GRAPH_GO_TOOLCHAIN: failingGo,
          })
          .includes("go-env=unreported"),
      );
      fs.rmSync(failingGo, { force: true });
      TestValidator.predicate(
        "a Go that is not installed is unavailable",
        goGraphProvider
          .effectiveConfiguration(root, emptyPath)
          .includes("go-env=unavailable"),
      );

      const local = platformExecutable(privateBin, command);
      const dependency = platformExecutable(packageBin, command);
      writeExecutable(local);
      writeExecutable(dependency);
      TestValidator.equals(
        "the graph-owned project executable wins over package shims and PATH",
        resolveProviderCommand(root, emptyPath, {
          command,
          override: "SAMCHON_TEST_PROVIDER",
          args: ["serve"],
        }),
        expectedCommand(local, ["serve"]),
      );
      const attempted = resolveProviderCommand.attempt(root, emptyPath, {
        command,
        override: "SAMCHON_TEST_PROVIDER",
        args: ["serve"],
      });
      TestValidator.equals(
        "resolution retains the exact executable before platform wrapping",
        [attempted.command, attempted.executable, attempted.asked],
        [expectedCommand(local, ["serve"]), local, true],
      );

      const goCommand = platformExecutable(privateBin, "samchon-graph-go");
      writeExecutable(goCommand);
      TestValidator.equals(
        "the shipped Go provider uses the common project-local resolver",
        goGraphProvider.resolve(root, emptyPath),
        expectedCommand(goCommand, ["--project", path.resolve(root)]),
      );
      fs.rmSync(goCommand, { force: true });
      const bundledGo = goGraphProvider.resolve(root, process.env);
      TestValidator.predicate(
        "the packaged Go source sidecar runs through the available toolchain",
        bundledGo !== undefined &&
          bundledGo.args.includes("-C") &&
          bundledGo.args.slice(-4).join(" ") ===
            `run . --project ${path.resolve(root)}`,
      );
      if (bundledGo === undefined) {
        throw new Error("the packaged Go source sidecar was not resolved");
      }
      const sourceFlag = bundledGo.args.indexOf("-C");
      const bundledSource = bundledGo.args[sourceFlag + 1];
      if (sourceFlag < 0 || bundledSource === undefined) {
        throw new Error("the packaged Go source directory was not resolved");
      }
      const bundledManifest = path.join(bundledSource, "go.mod");
      const hiddenManifest = `${bundledManifest}.test-hidden`;
      fs.renameSync(bundledManifest, hiddenManifest);
      try {
        TestValidator.equals(
          "a malformed package without its Go source sidecar declines cleanly",
          goGraphProvider.resolve(root, process.env),
          undefined,
        );
      } finally {
        fs.renameSync(hiddenManifest, bundledManifest);
      }
      TestValidator.equals(
        "the packaged Go source sidecar declines without a Go toolchain",
        goGraphProvider.resolve(root, emptyPath),
        undefined,
      );

      fs.rmSync(local, { force: true });
      TestValidator.equals(
        "a project dependency wins before PATH",
        resolveProviderCommand(root, emptyPath, {
          command,
          override: "SAMCHON_TEST_PROVIDER",
        }),
        expectedCommand(dependency),
      );

      const override = platformExecutable(root, "explicit-provider");
      writeExecutable(override);
      TestValidator.equals(
        "an absolute executable override wins before project-local discovery",
        resolveProviderCommand(
          root,
          {
            ...emptyPath,
            SAMCHON_TEST_PROVIDER: override,
          },
          { command, override: "SAMCHON_TEST_PROVIDER", args: ["index"] },
        ),
        expectedCommand(override, ["index"]),
      );
      if (process.platform === "win32") {
        const batchOverride = path.join(root, "explicit-provider.bat");
        writeExecutable(batchOverride);
        TestValidator.equals(
          "an absolute Windows batch override uses the exact command shim",
          resolveProviderCommand(
            root,
            {
              ...emptyPath,
              SAMCHON_TEST_PROVIDER: batchOverride,
            },
            { command, override: "SAMCHON_TEST_PROVIDER" },
          ),
          expectedCommand(batchOverride),
        );
        const argumentShimDirectory = path.join(
          root,
          "node_modules",
          ".bin",
        );
        fs.mkdirSync(argumentShimDirectory, { recursive: true });
        const argumentWriter = path.join(
          argumentShimDirectory,
          "literal-arguments.cmd",
        );
        const argumentProgram = path.join(root, "literal-arguments.cjs");
        const argumentOutput = path.join(root, "literal-arguments.txt");
        const siblingMarker = path.join(root, "injected-command.txt");
        fs.writeFileSync(
          argumentProgram,
          [
            '"use strict";',
            'const fs = require("node:fs");',
            "fs.writeFileSync(process.argv[2], process.argv[3]);",
            "",
          ].join("\n"),
        );
        fs.writeFileSync(
          argumentWriter,
          [
            "@echo off",
            `"${process.execPath}" "${argumentProgram}" %*`,
            "",
          ].join("\r\n"),
        );
        const literal =
          `space & pipe | input < output > group (x) caret ^ bang ! ` +
          `percent %PATH% quote " semi ; comma , star * question ? ` +
          `& type nul > "${siblingMarker}"`;
        const invocation = spawnableCommand(argumentWriter, [
          argumentOutput,
          literal,
        ]);
        const executed = spawnSync(invocation.command, invocation.args, {
          cwd: root,
          encoding: "utf8",
          windowsHide: true,
          windowsVerbatimArguments:
            invocation.windowsVerbatimArguments,
        });
        TestValidator.equals(
          "Windows command shims preserve every command metacharacter literally",
          [
            executed.status,
            fs.readFileSync(argumentOutput, "utf8"),
            fs.existsSync(siblingMarker),
          ],
          [0, literal, false],
        );
      }

      const pathBin = path.join(root, "path-bin");
      fs.mkdirSync(pathBin);
      const onPath = platformExecutable(pathBin, "path-only-provider");
      writeExecutable(onPath);
      TestValidator.equals(
        "PATH is consulted only after project-local candidates",
        resolveProviderCommand(root, pathEnvironment(pathBin), {
          command: "path-only-provider",
          override: "SAMCHON_TEST_PROVIDER",
        }),
        expectedCommand(onPath),
      );
      TestValidator.equals(
        "a relative override is not treated as an executable identity",
        resolveProviderCommand(
          root,
          {
            ...pathEnvironment(pathBin),
            SAMCHON_TEST_PROVIDER: "path-only-provider",
          },
          {
            command: "path-only-provider",
            override: "SAMCHON_TEST_PROVIDER",
          },
        ),
        expectedCommand(onPath),
      );
      TestValidator.equals(
        "a directory override is not treated as an executable file",
        resolveProviderCommand(
          root,
          {
            ...pathEnvironment(pathBin),
            SAMCHON_TEST_PROVIDER: root,
          },
          {
            command: "path-only-provider",
            override: "SAMCHON_TEST_PROVIDER",
          },
        ),
        expectedCommand(onPath),
      );
      if (process.platform !== "win32") {
        const injectionMarker = path.join(root, "lookup-injected.txt");
        const shellSyntax =
          `definitely-absent; printf injected > "${injectionMarker}"`;
        TestValidator.equals(
          "a POSIX PATH lookup treats project-derived shell syntax as one name",
          [
            resolveProviderCommand(root, pathEnvironment(pathBin), {
              command: shellSyntax,
            }),
            fs.existsSync(injectionMarker),
          ],
          [undefined, false],
        );
      }
      TestValidator.equals(
        "an unavailable provider resolves to no command",
        resolveProviderCommand(root, emptyPath, {
          command: "definitely-not-a-real-samchon-provider",
          override: "SAMCHON_TEST_PROVIDER",
        }),
        undefined,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

function platformExecutable(directory: string, command: string): string {
  return path.join(
    directory,
    process.platform === "win32" ? `${command}.cmd` : command,
  );
}

function writeExecutable(file: string, exitCode: number = 0): void {
  fs.writeFileSync(
    file,
    process.platform === "win32"
      ? `@exit /b ${exitCode}\r\n`
      : `#!/bin/sh\nexit ${exitCode}\n`,
  );
  fs.chmodSync(file, 0o755);
}

function writeVersionedExecutable(file: string, version: string): void {
  fs.writeFileSync(
    file,
    process.platform === "win32"
      ? `@echo ${version}\r\n@exit /b 0\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${version}'\n`,
  );
  fs.chmodSync(file, 0o755);
}

function writeGoEnvironmentExecutable(file: string): void {
  const body = '{"GOVERSION":"go1.26-fixture"}';
  fs.writeFileSync(
    file,
    process.platform === "win32"
      ? `@echo ${body}\r\n@exit /b 0\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${body}'\n`,
  );
  fs.chmodSync(file, 0o755);
}

function expectedCommand(
  executable: string,
  args: readonly string[] = [],
): { command: string; args: string[] } {
  return spawnableCommand(executable, args);
}

function pathEnvironment(value: string): NodeJS.ProcessEnv {
  return {
    PATH: value,
    Path: value,
    PATHEXT: ".EXE;.CMD;.BAT",
    SystemRoot: process.env.SystemRoot,
  };
}
