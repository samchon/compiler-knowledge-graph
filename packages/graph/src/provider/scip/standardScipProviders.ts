import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { languageOf } from "../../indexer/languageOf";
import { GraphLanguage } from "../../typings";
import { spawnableCommand } from "../../utils/spawnableCommand";
import { IGraphProvider } from "../IGraphProvider";
import { providerInputFiles } from "../providerInputFiles";
import { resolveProviderCommand } from "../resolveProviderCommand";
import { scipProvider } from "./scipProvider";

const clangScipProvider = createScipProvider({
  name: "scip-clang",
  compiler: { command: "clang", override: "SAMCHON_GRAPH_CLANG" },
  languages: ["c", "cpp"],
  command: "scip-clang",
  override: "SAMCHON_GRAPH_SCIP_CLANG",
  buildFiles: [
    "compile_commands.json",
    "CMakeLists.txt",
    "CMakePresets.json",
    "Makefile",
    "meson.build",
  ],
  buildExtensions: [".cmake"],
  resolveArgs: (root) => {
    const compdb = compilationDatabase(root);
    return compdb === undefined ? undefined : [`--compdb-path=${compdb}`];
  },
  indexArgs: (artifact) => [
    `--index-output-path=${artifact}`,
    `--temporary-output-dir=${path.join(path.dirname(artifact), "clang")}`,
  ],
});

const jvmScipProvider = createScipProvider({
  name: "scip-java",
  compiler: { command: "java", override: "SAMCHON_GRAPH_JAVA" },
  languages: ["java", "kotlin", "scala"],
  command: "scip-java",
  override: "SAMCHON_GRAPH_SCIP_JAVA",
  buildFiles: [
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "gradle.properties",
    "gradle-wrapper.properties",
    "build.sbt",
    "build.sc",
  ],
  indexArgs: (artifact) => ["index", "--output", artifact],
});

const dotnetScipProvider = createScipProvider({
  name: "scip-dotnet",
  compiler: { command: "dotnet", override: "SAMCHON_GRAPH_DOTNET" },
  languages: ["csharp"],
  command: "scip-dotnet",
  override: "SAMCHON_GRAPH_SCIP_DOTNET",
  buildFiles: [
    "global.json",
    "Directory.Build.props",
    "Directory.Build.targets",
    "Directory.Packages.props",
    "packages.lock.json",
    "nuget.config",
  ],
  buildExtensions: [".sln", ".csproj", ".fsproj", ".props", ".targets"],
  indexArgs: (artifact) => ["index", "--output", artifact],
});

const pythonScipProvider = createScipProvider({
  name: "scip-python",
  compiler: { command: "python3", override: "SAMCHON_GRAPH_PYTHON" },
  languages: ["python"],
  command: "scip-python",
  override: "SAMCHON_GRAPH_SCIP_PYTHON",
  buildFiles: [
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "Pipfile",
    "Pipfile.lock",
    "poetry.lock",
    "uv.lock",
    "pyrightconfig.json",
  ],
  resolveArgs: (root) => [
    "index",
    ".",
    "--project-name",
    path.basename(root),
  ],
  indexArgs: (artifact) => ["--output", artifact],
});

const rubyScipProvider = createScipProvider({
  name: "scip-ruby",
  compiler: { command: "ruby", override: "SAMCHON_GRAPH_RUBY" },
  languages: ["ruby"],
  command: "scip-ruby",
  override: "SAMCHON_GRAPH_SCIP_RUBY",
  buildFiles: [
    "Gemfile",
    "Gemfile.lock",
    ".ruby-version",
    "sorbet/config",
  ],
  buildExtensions: [".gemspec"],
  indexArgs: (artifact) => [".", "--index-file", artifact],
});

/** Standard SCIP producers in deterministic registry order. */
export const standardScipProviders: readonly IGraphProvider[] = [
  clangScipProvider,
  jvmScipProvider,
  dotnetScipProvider,
  pythonScipProvider,
  rubyScipProvider,
];

interface IStandardScipProvider {
  name: string;
  languages: readonly GraphLanguage[];
  command: string;
  override: string;
  buildFiles: readonly string[];
  buildExtensions?: readonly string[];
  resolveArgs?: (root: string) => readonly string[] | undefined;
  indexArgs: (artifact: string) => string[];

  /**
   * The toolchain whose semantics this index describes.
   *
   * A `semantic-index` provider still answers "which language version resolved
   * these facts", and it is not the indexer's own version: scip-python 0.6.6
   * says what built the artifact, while the interpreter it inferred the
   * environment from says what the artifact means. A consumer that cannot tell
   * them apart cannot know whether a rebuilt index describes the same program.
   */
  compiler: { command: string; override: string };
}

function createScipProvider(
  props: IStandardScipProvider,
): IGraphProvider {
  return scipProvider({
    name: props.name,
    languages: props.languages,
    authority: "semantic-index",
    buildInputs: (root) =>
      providerInputFiles(
        root,
        [],
        props.buildFiles,
        props.buildExtensions,
      ),
    resolve: (root, env) => {
      const indexer = resolveProviderCommand(root, env, {
        command: props.command,
        override: props.override,
      });
      const decoder = resolveScipDecoder(root, env);
      // The toolchain is required, not merely reported. A snapshot states which
      // language version resolved its facts, and a provider that cannot answer
      // that would publish `python3=unavailable` into the field a consumer
      // degrades against — which is worse than declining, because a fallback at
      // least says so. `rust-analyzer-scip` refuses without `rustc` and `cargo`
      // for the same reason.
      const compiler = resolveProviderCommand(root, env, props.compiler);
      const resolvedArgs = props.resolveArgs?.(root);
      if (
        indexer === undefined ||
        decoder === undefined ||
        compiler === undefined ||
        (props.resolveArgs !== undefined && resolvedArgs === undefined)
      ) {
        return undefined;
      }
      const args = resolvedArgs ?? [];
      return spawnableCommand.append(
        { ...indexer, args: [...indexer.args] },
        args,
      );
    },
    decode: (root) => {
      const decoder = resolveScipDecoder(root, process.env);
      if (decoder === undefined) {
        throw new Error(
          `${props.name}: the SCIP decoder disappeared after provider selection`,
        );
      }
      return spawnableCommand.append(
        { ...decoder, args: [...decoder.args] },
        ["print", "--json"],
      );
    },
    indexArgs: props.indexArgs,
    inputs: (root, languages) =>
      providerInputFiles(
        root,
        languages,
        props.buildFiles,
        props.buildExtensions,
      ),
    configuration: (root, _languages, env = process.env) => [
      toolVersion(root, env, props.command, props.override),
      toolVersion(root, env, "scip", "SAMCHON_GRAPH_SCIP"),
      toolVersion(root, env, props.compiler.command, props.compiler.override),
    ],
    compilerVersion: (root) =>
      toolVersion(
        root,
        process.env,
        props.compiler.command,
        props.compiler.override,
      ),
    sourceText: true,
    languageOf,
  });
}

function resolveScipDecoder(
  root: string,
  env: NodeJS.ProcessEnv,
): IGraphProvider.ICommand | undefined {
  return resolveProviderCommand(root, env, {
    command: "scip",
    override: "SAMCHON_GRAPH_SCIP",
  });
}

function toolVersion(
  root: string,
  env: NodeJS.ProcessEnv,
  command: string,
  override: string,
): string {
  const resolved = resolveProviderCommand(root, env, { command, override });
  if (resolved === undefined) return `${command}=unavailable`;
  const spawnable = spawnableCommand.append(
    { ...resolved, args: [...resolved.args] },
    ["--version"],
  );
  const result = spawnSync(
    spawnable.command,
    spawnable.args,
    {
      cwd: root,
      env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      windowsVerbatimArguments:
        spawnable.windowsVerbatimArguments,
      windowsHide: true,
    },
  );
  /* c8 ignore start -- an executed spawnSync with UTF-8 encoding returns a
   * string; the null arm exists only for Node's broader result type. Success
   * and unavailable results remain asserted by standard-provider tests. */
  const output = String(result.stdout ?? "").trim();
  return result.status === 0 && output !== ""
    ? `${command}=${output}`
    : `${command}=unavailable`;
  /* c8 ignore stop */
}

function compilationDatabase(root: string): string | undefined {
  for (const candidate of [
    path.join(root, "compile_commands.json"),
    path.join(root, "build", "compile_commands.json"),
  ]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}
