import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { languageOf } from "../../indexer/languageOf";
import { GraphLanguage } from "../../typings";
import { spawnableCommand } from "../../utils/spawnableCommand";
import { IGraphProvider } from "../IGraphProvider";
import { providerInputFiles } from "../providerInputFiles";
import { resolveProviderCommand } from "../resolveProviderCommand";
import { toolchainVersion } from "../toolchainVersion";
import { scipProvider } from "../scip";

/**
 * rust-analyzer's stock SCIP export is a navigation artifact, not HIR facts.
 *
 * It therefore inherits only the bare-SCIP fact families. In particular, it
 * must not claim calls, constructions, trait implementations, or dispatch;
 * those require the separately gated HIR exporter.
 */
export const rustScipProvider = Object.assign(
  scipProvider({
    name: "rust-analyzer-scip",
    languages: ["rust"],
    authority: "semantic-index",
    buildInputs: rustBuildInputs,
    resolve: resolveRustScipCommand,
    decode: (root) => rustScipDecoder(root),
    indexArgs: rustScipIndexArgs,
    inputs: rustInputs,
    configuration: rustProviderConfiguration,
    compilerVersion: rustCompilerVersion,
    // rust-analyzer writes the protobuf default empty string for every
    // document, not a copy of the source bytes it analyzed.
    sourceText: false,
    // Stock rust-analyzer omits the protobuf-default project_root. The session
    // invokes `rust-analyzer scip .` with the project root as its exact cwd and
    // an isolated output artifact, so that cwd is the missing root evidence; an
    // explicit different root still fails the common check.
    projectRootFromInvocation: true,
    languageOf,
  }),
  {
    indexArgs: rustScipIndexArgs,
    inputs: rustInputs,
    decodeCommand: rustScipDecoder,
    effectiveConfiguration: rustScipConfiguration,
    effectiveCompilerVersion: rustCompilerVersionFor,
  },
);

function resolveRustScipCommand(
  root: string,
  env: NodeJS.ProcessEnv,
): IGraphProvider.ICommand | undefined {
  const analyzer = resolveTool(
    root,
    env,
    "rust-analyzer",
    "SAMCHON_GRAPH_RUST_ANALYZER",
  );
  const decoder = resolveTool(root, env, "scip", "SAMCHON_GRAPH_SCIP");
  const rustc = resolveTool(root, env, "rustc", "SAMCHON_GRAPH_RUSTC");
  const cargo = resolveTool(root, env, "cargo", "SAMCHON_GRAPH_CARGO");
  if (
    analyzer === undefined ||
    decoder === undefined ||
    rustc === undefined ||
    cargo === undefined
  ) {
    return undefined;
  }
  return spawnableCommand.append(
    { ...analyzer, args: [...analyzer.args] },
    ["scip", ".", "--exclude-vendored-libraries"],
  );
}

function rustScipDecoder(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): IGraphProvider.ICommand {
  const decoder = resolveTool(root, env, "scip", "SAMCHON_GRAPH_SCIP");
  if (decoder === undefined) {
    throw new Error(
      "rust-analyzer-scip: the SCIP decoder disappeared after provider selection",
    );
  }
  return spawnableCommand.append(
    { ...decoder, args: [...decoder.args] },
    ["print", "--json"],
  );
}

function rustScipIndexArgs(artifact: string): string[] {
  return ["--output", artifact];
}

function rustInputs(root: string): string[] {
  return mergeInputs(
    providerInputFiles(root, ["rust"], RUST_BUILD_FILE_NAMES),
    cargoConfigurationInputs(root),
  );
}

function rustBuildInputs(root: string): string[] {
  return mergeInputs(
    providerInputFiles(root, [], RUST_BUILD_FILE_NAMES),
    cargoConfigurationInputs(root),
  );
}

function cargoConfigurationInputs(root: string): string[] {
  const resolved = path.resolve(root);
  return [".cargo/config", ".cargo/config.toml"]
    .map((relative) => path.join(resolved, relative))
    .filter(isRegularFile)
    .map((file) => path.relative(resolved, file).replaceAll("\\", "/"));
}

function isRegularFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
    /* c8 ignore next 2 -- a Cargo config disappearing during input discovery
     * is fenced by the enclosing generation transaction. */
  } catch {
    return false;
  }
}

function rustProviderConfiguration(
  root: string,
  _languages?: readonly GraphLanguage[],
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return rustScipConfiguration(root, env);
}

function rustScipConfiguration(
  root: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    ...RUST_ENVIRONMENT_KEYS.map((key) => `${key}=${env[key] ?? ""}`),
    ...Object.entries(env)
      .filter(
        ([key]) =>
          key.startsWith("CARGO_CFG_") || key.startsWith("CARGO_FEATURE_"),
      )
      .sort(([left], [right]) => compareOrdinal(left, right))
      .map(([key, value]) => `${key}=${value ?? ""}`),
    ...Object.entries(env)
      .filter(
        ([key]) =>
          key.startsWith("CARGO_") &&
          !RUST_ENVIRONMENT_KEY_SET.has(key) &&
          !key.startsWith("CARGO_CFG_") &&
          !key.startsWith("CARGO_FEATURE_"),
      )
      .sort(([left], [right]) => compareOrdinal(left, right))
      .map(
        ([key, value]) =>
          `${key}=sha256:${createHash("sha256")
            .update(value ?? "", "utf8")
            .digest("hex")}`,
      ),
    ...cargoConfigurationSnapshot(root, env),
    toolVersion(
      root,
      env,
      "rust-analyzer",
      "SAMCHON_GRAPH_RUST_ANALYZER",
      ["--version"],
    ),
    toolVersion(root, env, "scip", "SAMCHON_GRAPH_SCIP", ["--version"]),
    toolVersion(root, env, "rustc", "SAMCHON_GRAPH_RUSTC", ["-vV"]),
    toolVersion(root, env, "cargo", "SAMCHON_GRAPH_CARGO", ["-V"]),
  ];
}

function cargoConfigurationSnapshot(
  root: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const candidates = new Set<string>();
  let current = path.resolve(root);
  for (;;) {
    for (const name of ["config", "config.toml"]) {
      candidates.add(path.join(current, ".cargo", name));
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const cargoHome =
    env.CARGO_HOME === undefined || env.CARGO_HOME === ""
      ? path.join(os.homedir(), ".cargo")
      : path.resolve(root, env.CARGO_HOME);
  for (const name of ["config", "config.toml"]) {
    candidates.add(path.join(cargoHome, name));
  }
  return [...candidates]
    .sort(compareOrdinal)
    .map((file) => `cargo-config:${portablePath(file)}:${fileDigest(file)}`);
}

function fileDigest(file: string): string {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    /* c8 ignore next 2 -- missing candidates are the expected negative state. */
  } catch {
    return "missing";
  }
}

function portablePath(file: string): string {
  return path.resolve(file).replaceAll("\\", "/");
}

function rustCompilerVersion(root: string): string {
  return rustCompilerVersionFor(root, process.env);
}

function rustCompilerVersionFor(
  root: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return [
    toolVersion(
      root,
      env,
      "rustc",
      "SAMCHON_GRAPH_RUSTC",
      ["-vV"],
    ),
    toolVersion(root, env, "cargo", "SAMCHON_GRAPH_CARGO", ["-V"]),
  ].join("; ");
}

function toolVersion(
  root: string,
  env: NodeJS.ProcessEnv,
  command: string,
  override: string,
  args: readonly string[],
): string {
  return toolchainVersion({ root, env, command, override, args });
}

function resolveTool(
  root: string,
  env: NodeJS.ProcessEnv,
  command: string,
  override: string,
): IGraphProvider.ICommand | undefined {
  return resolveProviderCommand(root, env, { command, override });
}

function mergeInputs(...groups: (readonly string[])[]): string[] {
  return [...new Set(groups.flat())].sort(compareOrdinal);
}

function compareOrdinal(left: string, right: string): number {
  /* c8 ignore next 2 -- input sets contain distinct normalized paths. */
  return left < right ? -1 : left > right ? 1 : 0;
}

const RUST_BUILD_FILE_NAMES: readonly string[] = [
  "Cargo.lock",
  "Cargo.toml",
  "rust-toolchain",
  "rust-toolchain.toml",
];

const RUST_ENVIRONMENT_KEYS: readonly string[] = [
  "CARGO_BUILD_TARGET",
  "CARGO_ENCODED_RUSTFLAGS",
  "CARGO_HOME",
  "CARGO_INCREMENTAL",
  "CARGO_TARGET_DIR",
  "PATH",
  "Path",
  "RUSTC",
  "RUSTC_WORKSPACE_WRAPPER",
  "RUSTC_WRAPPER",
  "RUSTDOCFLAGS",
  "RUSTFLAGS",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "SAMCHON_GRAPH_CARGO",
  "SAMCHON_GRAPH_RUST_ANALYZER",
  "SAMCHON_GRAPH_RUSTC",
  "SAMCHON_GRAPH_SCIP",
];
const RUST_ENVIRONMENT_KEY_SET = new Set<string>(RUST_ENVIRONMENT_KEYS);
