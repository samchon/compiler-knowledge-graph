import fs from "node:fs";
import path from "node:path";

import { languageOf } from "../../indexer/languageOf";
import { GraphLanguage } from "../../typings";
import { spawnableCommand } from "../../utils/spawnableCommand";
import { IGraphProvider } from "../IGraphProvider";
import { providerInputFiles } from "../providerInputFiles";
import { resolveProviderCommand } from "../resolveProviderCommand";
import { toolchainVersion } from "../toolchainVersion";
import { scipProvider } from "./scipProvider";

const clangScipProvider = createScipProvider({
  name: "scip-clang",
  // Not `clang`. scip-clang carries its own Clang and needs an external driver
  // only for CUDA; requiring one declined every project built with GCC or MSVC
  // even though its compilation database was exactly what the indexer consumes.
  // What the index means is decided by the driver each translation unit was
  // actually compiled with, and the database records that per entry.
  toolchain: { label: "cc", fromProject: compilationDatabaseCompilers },
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
  toolchain: {
    label: "java",
    aliases: ["java"],
    override: "SAMCHON_GRAPH_JAVA_TOOLCHAIN",
  },
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
  toolchain: {
    label: "dotnet",
    aliases: ["dotnet"],
    override: "SAMCHON_GRAPH_DOTNET_TOOLCHAIN",
  },
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
  // `python3` is not the command a Windows Python answers to. The python.org
  // installer creates `python.exe` and `py.exe`; only the Microsoft Store build
  // creates `python3.exe`, so requiring the one spelling declined the strict
  // lane on most Windows machines that had a working interpreter.
  toolchain: {
    label: "python3",
    aliases: ["python3", "python", "py"],
    override: "SAMCHON_GRAPH_PYTHON_TOOLCHAIN",
  },
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
  toolchain: {
    label: "ruby",
    aliases: ["ruby"],
    override: "SAMCHON_GRAPH_RUBY_TOOLCHAIN",
  },
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
  toolchain: IToolchain;
}

/**
 * How to find the programs whose versions say what an index means.
 *
 * Two shapes, because two different questions were being answered by one
 * hard-coded command name.
 *
 * `aliases` is one program with more than one spelling. Which spelling exists
 * is a property of the machine — a Windows Python answers to `python` or `py`
 * and usually not to `python3` — so the first that resolves is the program, and
 * the row names the spelling that answered.
 *
 * `fromProject` is a set of programs the project itself names. A compilation
 * database records the driver each translation unit was compiled with, and that
 * is the compiler whose semantics the index carries; it may be `gcc`, `cl.exe`,
 * or several at once, and no fixed name can stand in for it.
 */
interface IToolchain {
  aliases?: readonly string[];
  fromProject?: (root: string) => readonly string[];

  /**
   * Environment variable selecting an absolute development build.
   *
   * Only meaningful for `aliases`, which name one program. A `fromProject`
   * toolchain has no single program to redirect, and one override would answer
   * for every driver the database named.
   */
  override?: string;

  /** What the row calls this toolchain when nothing resolved. */
  label: string;
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
      // that would publish `unavailable` into the field a consumer degrades
      // against — which is worse than declining, because a fallback at least
      // says so. `rust-analyzer-scip` refuses without `rustc` and `cargo` for
      // the same reason.
      //
      // What has to resolve is the toolchain the project actually uses, not one
      // chosen name for it. Requiring `clang` declined every GCC or MSVC project
      // whose compilation database scip-clang would have consumed, and requiring
      // `python3` declined a Windows interpreter installed as `python`.
      const toolchain = resolveToolchain(root, env, props.toolchain);
      const resolvedArgs = props.resolveArgs?.(root);
      if (
        indexer === undefined ||
        decoder === undefined ||
        toolchain.length === 0 ||
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
      ...toolchainVersions(root, env, props.toolchain),
    ],
    compilerVersion: (root) =>
      toolchainVersions(root, process.env, props.toolchain).join("; "),
    sourceText: true,
    languageOf,
  });
}

/**
 * Every program the toolchain names that this machine actually has.
 *
 * Empty means the provider cannot say what its index would mean. An `aliases`
 * toolchain stops at the first spelling that resolves, because the alternatives
 * are one program; a `fromProject` toolchain keeps every driver the project
 * named that resolves, because they are several.
 */
function resolveToolchain(
  root: string,
  env: NodeJS.ProcessEnv,
  toolchain: IToolchain,
): IToolchainTool[] {
  const override =
    toolchain.override === undefined ? {} : { override: toolchain.override };
  for (const command of toolchain.aliases ?? []) {
    const tool: IToolchainTool = { command, ...override };
    if (
      toolchainVersion.resolve({ root, env, args: VERSION_ARGS, ...tool }) !==
      undefined
    ) {
      return [tool];
    }
  }
  const found: IToolchainTool[] = [];
  for (const named of toolchain.fromProject?.(root) ?? []) {
    // An absolute driver is probed exactly as recorded. The build named that
    // file, and another program of the same basename on this machine's `PATH`
    // is not the one those translation units were compiled with.
    const tool: IToolchainTool = path.isAbsolute(named)
      ? { command: path.basename(named), executable: named }
      : { command: named };
    if (
      toolchainVersion.resolve({ root, env, args: VERSION_ARGS, ...tool }) !==
      undefined
    ) {
      found.push(tool);
    }
  }
  return found;
}

function toolchainVersions(
  root: string,
  env: NodeJS.ProcessEnv,
  toolchain: IToolchain,
): string[] {
  const tools = resolveToolchain(root, env, toolchain);
  // A toolchain that resolves nothing still owes the configuration a row.
  // Naming what it looked for keeps the row stable across runs, and
  // `unavailable` is what a reader has to see rather than an absent field.
  if (tools.length === 0) return [`${toolchain.label}=unavailable`];
  return tools.map((tool) =>
    toolchainVersion({ root, env, args: VERSION_ARGS, ...tool }),
  );
}

interface IToolchainTool {
  command: string;
  override?: string;
  executable?: string;
}

/**
 * Every distinct compiler driver the project's compilation database names.
 *
 * The database is the build's own record of how each translation unit was
 * compiled, so its first token is the program whose semantics the index
 * carries. Both documented shapes are read: `command` is one shell string and
 * `arguments` is an already-split vector.
 */
function compilationDatabaseCompilers(root: string): string[] {
  const database = compilationDatabase(root);
  if (database === undefined) return [];
  let entries: unknown;
  try {
    entries = JSON.parse(fs.readFileSync(database, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const drivers = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { command?: unknown; arguments?: unknown };
    const driver = Array.isArray(record.arguments)
      ? record.arguments[0]
      : typeof record.command === "string"
        ? firstToken(record.command)
        : undefined;
    if (typeof driver === "string" && driver !== "") drivers.add(driver);
  }
  return [...drivers].sort(compareOrdinal);
}

/**
 * The program a compile command runs, honouring one level of quoting.
 *
 * A Windows database records `"C:\\Program Files\\LLVM\\bin\\clang.exe" -c ...`,
 * and splitting that on whitespace would name a directory.
 */
function firstToken(command: string): string | undefined {
  const trimmed = command.trimStart();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end === -1 ? undefined : trimmed.slice(1, end);
  }
  const token = /^\S+/.exec(trimmed);
  return token === null ? undefined : token[0];
}

function compareOrdinal(left: string, right: string): number {
  /* c8 ignore next 2 -- driver names are distinct set members. */
  return left < right ? -1 : left > right ? 1 : 0;
}

const VERSION_ARGS: readonly string[] = ["--version"];

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
  return toolchainVersion({ root, env, command, override, args: ["--version"] });
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
