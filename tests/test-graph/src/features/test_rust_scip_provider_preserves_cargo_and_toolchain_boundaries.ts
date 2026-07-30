import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import path from "node:path";

import { rustScipProvider } from "@samchon/graph";

import { spawnableCommand } from "../../../../packages/graph/src/utils/spawnableCommand";
import { GraphPaths } from "../internal/GraphPaths";

/** The stock Rust SCIP lane remains a complete, truthful navigation slice. */
export const test_rust_scip_provider_preserves_cargo_and_toolchain_boundaries =
  async () => {
    const root = GraphPaths.createTempDirectory("graph-rust-scip-provider-");
    try {
      writeFixture(root);
      const privateBin = path.join(root, ".samchon-graph", "bin");
      fs.mkdirSync(privateBin, { recursive: true });
      const tools = new Map([
        ["rust-analyzer", "fixture rust-analyzer"],
        ["rustc", "fixture rustc"],
        ["cargo", "fixture cargo"],
      ]);
      for (const [tool, output] of tools) {
        writeTool(platformExecutable(privateBin, tool), output);
      }
      const decoder = platformExecutable(privateBin, "scip");
      writeDecoder(decoder);
      const environment = pathEnvironment("");

      TestValidator.equals(
        "the Rust bulk provider fingerprints Cargo inputs without foreign checkouts",
        [
          typeof rustScipProvider.buildInputs === "function"
            ? rustScipProvider.buildInputs(root)
            : [],
          rustScipProvider.inputs(root),
          rustScipProvider.indexArgs("snapshot.scip"),
        ],
        [
          [
            ".cargo/config.toml",
            "Cargo.lock",
            "Cargo.toml",
            "nested/Cargo.toml",
            "rust-toolchain.toml",
          ],
          [
            ".cargo/config.toml",
            "Cargo.lock",
            "Cargo.toml",
            "nested/Cargo.toml",
            "nested/src/lib.rs",
            "rust-toolchain.toml",
            "src/main.rs",
          ],
          ["--output", "snapshot.scip"],
        ],
      );

      const analyzer = platformExecutable(privateBin, "rust-analyzer");
      TestValidator.equals(
        "Rust requires its analyzer, SCIP decoder, rustc, and Cargo together",
        rustScipProvider.resolve(root, environment),
        expectedCommand(analyzer, [
          "scip",
          ".",
          "--exclude-vendored-libraries",
        ]),
      );
      TestValidator.equals(
        "the decoder is the JSON-only SCIP CLI contract",
        rustScipProvider.decodeCommand(root, environment),
        expectedCommand(decoder, ["print", "--json"]),
      );
      TestValidator.error(
        "a vanished decoder is not treated as a successful Rust provider",
        () =>
          rustScipProvider.decodeCommand(
            path.join(root, "missing"),
            pathEnvironment(""),
          ),
      );

      const configuration = rustScipProvider.effectiveConfiguration(root, {
        ...environment,
        CARGO_HOME: "cargo-home",
        CARGO_CFG_TARGET_OS: "fixture",
        CARGO_FEATURE_EXPERIMENTAL: "1",
        CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: "fixture-linker",
        CARGO_UNDEFINED_FIXTURE: undefined,
        RUSTFLAGS: "--cfg fixture",
      });
      TestValidator.predicate(
        "Cargo cfg and feature settings are generation inputs",
        configuration.includes("CARGO_CFG_TARGET_OS=fixture") &&
          configuration.includes("CARGO_FEATURE_EXPERIMENTAL=1") &&
          configuration.some((row) =>
            row.startsWith(
              "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=sha256:",
            ),
          ) &&
          configuration.some((row) =>
            row.startsWith("CARGO_UNDEFINED_FIXTURE=sha256:"),
          ) &&
          configuration.includes("RUSTFLAGS=--cfg fixture"),
      );
      const cargoHome = path.join(root, "cargo-home");
      fs.mkdirSync(cargoHome);
      const cargoHomeConfig = path.join(cargoHome, "config.toml");
      fs.writeFileSync(cargoHomeConfig, "[build]\ntarget = \"fixture\"\n");
      const configuredHome = rustScipProvider.effectiveConfiguration(root, {
        ...environment,
        CARGO_HOME: cargoHome,
      });
      fs.writeFileSync(cargoHomeConfig, "[build]\ntarget = \"changed\"\n");
      TestValidator.predicate(
        "Cargo home and ancestor configuration contents invalidate the provider",
        configuredHome.some((row) =>
          row.startsWith(
            `cargo-config:${cargoHomeConfig.replaceAll("\\", "/")}:`,
          ),
        ) &&
          configuredHome.join("\n") !==
            rustScipProvider
              .effectiveConfiguration(root, {
                ...environment,
                CARGO_HOME: cargoHome,
              })
              .join("\n"),
      );
      TestValidator.equals(
        "the selected Rust toolchain versions are captured",
        [
          configuration.filter(
            (row) =>
              row.startsWith("rust-analyzer=") || row.startsWith("scip="),
          ),
          rustScipProvider.effectiveCompilerVersion(root, environment),
        ],
        [
          ["rust-analyzer=fixture rust-analyzer", "scip=fixture scip"],
          "rustc=fixture rustc; cargo=fixture cargo",
        ],
      );

      // An installed compiler that says nothing and a compiler that is not
      // there are different facts about the build universe, and only the second
      // one means the provider cannot describe what it indexed. Collapsing them
      // made a build universe that rebuilt itself whenever a process launch
      // failed for a reason unrelated to the project.
      //
      // This compiler has already answered once, so the row repeats what it
      // said rather than going quiet: a launch that stops answering is not
      // evidence that the toolchain changed, and treating it as evidence is
      // what rebuilt an artifact that was never stale.
      const rustc = platformExecutable(privateBin, "rustc");
      writeTool(rustc, "");
      TestValidator.predicate(
        "an installed compiler that reports no version is unreported",
        rustScipProvider
          .effectiveConfiguration(root, environment)
          .includes("rustc=unreported"),
      );
      fs.rmSync(rustc, { force: true });
      TestValidator.predicate(
        "a compiler that is not installed is unavailable",
        rustScipProvider
          .effectiveConfiguration(root, environment)
          .includes("rustc=unavailable"),
      );
      writeTool(rustc, "fixture rustc");

      for (const [tool, output] of [...tools.entries(), ["scip", ""]] as const) {
        const executable = platformExecutable(privateBin, tool);
        fs.rmSync(executable, { force: true });
        TestValidator.equals(
          `the missing ${tool} companion declines the whole provider`,
          rustScipProvider.resolve(root, environment),
          undefined,
        );
        if (tool === "scip") writeDecoder(executable);
        else writeTool(executable, output);
      }

      await assertProviderSnapshot(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

async function assertProviderSnapshot(root: string): Promise<void> {
  const indexer = path.join(root, "fake-rust-analyzer.cjs");
  fs.writeFileSync(
    indexer,
    [
      '"use strict";',
      'const fs = require("node:fs");',
      'const output = process.argv[process.argv.indexOf("--output") + 1];',
      "fs.writeFileSync(output, JSON.stringify({",
      "  metadata: {",
      '    ...(process.argv.includes("--explicit-root") ? { projectRoot: process.cwd() } : {}),',
      '    toolInfo: { name: "rust-analyzer", version: "fixture" },',
      "  },",
      "  documents: [{",
      "    language: \"rust\",",
      "    relativePath: \"src/main.rs\",",
      "    text: \"\",",
      '    symbols: [{ symbol: "scip-rust cargo fixture v1 `crate`/main().", displayName: "main", kind: "Function" }],',
      '    occurrences: [{ range: [0, 3, 7], symbol: "scip-rust cargo fixture v1 `crate`/main().", symbolRoles: 1 }],',
      "  }],",
      "}));",
    ].join("\n"),
  );
  const session = rustScipProvider.open({
    root,
    command: { command: process.execPath, args: [indexer] },
    languages: ["rust"],
    options: {},
  });
  try {
    const refresh = await session.refresh();
    TestValidator.equals(
      "the stock provider publishes its declared semantic-index facts only",
      [
        refresh.snapshot.provenance.provider,
        refresh.snapshot.provenance.authority,
        refresh.snapshot.provenance.facts,
        refresh.snapshot.provenance.compilerVersion,
        refresh.snapshot.provenance.capabilities.includes("sourceDigests"),
        refresh.snapshot.sources.get(path.join(root, "src", "main.rs"))
          ?.checkerDigest,
        refresh.snapshot.nodes.map((node) => node.name),
      ],
      [
        "rust-analyzer-scip",
        "semantic-index",
        ["contains", "references"],
        "rustc=fixture rustc; cargo=fixture cargo",
        false,
        "",
        ["main"],
      ],
    );
  } finally {
    await session.close();
  }

  const explicit = rustScipProvider.open({
    root,
    command: {
      command: process.execPath,
      args: [indexer, "--explicit-root"],
    },
    languages: ["rust"],
    options: {},
  });
  try {
    TestValidator.equals(
      "an explicit producer root is preserved and checked",
      (await explicit.refresh()).snapshot.nodes.map((node) => node.name),
      ["main"],
    );
  } finally {
    await explicit.close();
  }
}

function writeFixture(root: string): void {
  fs.mkdirSync(path.join(root, ".cargo"), { recursive: true });
  fs.mkdirSync(path.join(root, "nested", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "foreign", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "ignored"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(root, ".cargo", "config.toml"), "[build]\n");
  fs.writeFileSync(path.join(root, "Cargo.toml"), "[workspace]\n");
  fs.writeFileSync(path.join(root, "Cargo.lock"), "# fixture\n");
  fs.writeFileSync(path.join(root, "rust-toolchain.toml"), "[toolchain]\n");
  fs.writeFileSync(path.join(root, "src", "main.rs"), "fn main() {}\n");
  fs.writeFileSync(path.join(root, "nested", "Cargo.toml"), "[package]\n");
  fs.writeFileSync(path.join(root, "nested", "src", "lib.rs"), "pub fn nested() {}\n");
  fs.writeFileSync(path.join(root, "foreign", "Cargo.toml"), "[package]\n");
  fs.writeFileSync(path.join(root, "foreign", "src.rs"), "fn foreign() {}\n");
  fs.writeFileSync(path.join(root, "node_modules", "ignored", "Cargo.toml"), "[package]\n");
}

function writeTool(file: string, output: string): void {
  fs.writeFileSync(
    file,
    process.platform === "win32"
      ? output === ""
        ? "@exit /b 0\r\n"
        : `@echo ${output}\r\n@exit /b 0\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${output}'\n`,
  );
  fs.chmodSync(file, 0o755);
}

function writeDecoder(file: string): void {
  fs.writeFileSync(
    file,
    process.platform === "win32"
      ? [
          '@if "%~1"=="--version" (',
          "@echo fixture scip",
          "@exit /b 0",
          ")",
          `@"${process.execPath}" "${GraphPaths.fakeScipDecoder}" %*`,
          "",
        ].join("\r\n")
      : `#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  printf '%s\\n' 'fixture scip'\n  exit 0\nfi\n"${process.execPath}" "${GraphPaths.fakeScipDecoder}" "$@"\n`,
  );
  fs.chmodSync(file, 0o755);
}

function platformExecutable(directory: string, command: string): string {
  return path.join(
    directory,
    process.platform === "win32" ? `${command}.cmd` : command,
  );
}

function expectedCommand(
  executable: string,
  args: readonly string[] = [],
): ReturnType<typeof spawnableCommand> {
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
