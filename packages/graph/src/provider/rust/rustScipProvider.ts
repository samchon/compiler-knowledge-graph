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
    /* c8 ignore start -- a Cargo config disappearing during input discovery
     * is fenced by the enclosing generation transaction. */
  } catch {
    return false;
  }
  /* c8 ignore stop */
}

function rustProviderConfiguration(
  root: string,
  _languages?: readonly GraphLanguage[],
  env: NodeJS.ProcessEnv = process.env,
): toolchainVersion.IDerivation {
  return rustScipConfigurationDerivation(root, env);
}

function rustScipConfiguration(
  root: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [...rustScipConfigurationDerivation(root, env).rows];
}

function rustScipConfigurationDerivation(
  root: string,
  env: NodeJS.ProcessEnv,
): toolchainVersion.IDerivation {
  return toolchainVersion.derive([
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
    toolObservation(
      root,
      env,
      "rust-analyzer",
      "SAMCHON_GRAPH_RUST_ANALYZER",
      ["--version"],
    ),
    toolObservation(
      root,
      env,
      "scip",
      "SAMCHON_GRAPH_SCIP",
      ["--version"],
    ),
    toolObservation(root, env, "rustc", "SAMCHON_GRAPH_RUSTC", ["-vV"]),
    toolObservation(root, env, "cargo", "SAMCHON_GRAPH_CARGO", ["-V"]),
  ]);
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
    /* c8 ignore start -- missing candidates are the expected negative state. */
  } catch {
    return "missing";
  }
  /* c8 ignore stop */
}

function portablePath(file: string): string {
  return path.resolve(file).replaceAll("\\", "/");
}

/**
 * Selected from the rows this universe was computed from, not probed again.
 *
 * rustc and cargo already appear in the configuration, so re-deriving them was
 * a second instant that could disagree with the first — a row held to its last
 * established value beside one that re-asks publishes a compiler the universe
 * never saw. Labelled rather than positional, since the configuration also
 * carries environment keys and the indexer's own version.
 */
function rustCompilerVersion(
  _root: string,
  _languages: readonly GraphLanguage[] | undefined,
  configuration: readonly string[],
): string {
  const wanted = new Set(["rustc", "cargo"]);
  return configuration
    .filter((row) => wanted.has(row.slice(0, Math.max(0, row.indexOf("=")))))
    .join("; ");
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

function toolObservation(
  root: string,
  env: NodeJS.ProcessEnv,
  command: string,
  override: string,
  args: readonly string[],
): toolchainVersion.IObservation {
  return toolchainVersion.observe({
    root,
    env,
    command,
    override,
    args,
  });
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
