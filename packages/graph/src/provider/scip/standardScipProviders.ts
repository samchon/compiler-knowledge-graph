import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dartPackageConfigInputs } from "../../indexer/dartPackageConfigInputs";
import { languageOf } from "../../indexer/languageOf";
import { GraphEdgeKind, GraphLanguage } from "../../typings";
import { BoundedMap } from "../../utils/BoundedMap";
import { isSpawnableFile } from "../../utils/isSpawnableFile";
import { spawnableCommand } from "../../utils/spawnableCommand";
import { IGraphProvider } from "../IGraphProvider";
import { providerInputFiles } from "../providerInputFiles";
import { resolveProviderCommand } from "../resolveProviderCommand";
import { toolchainVersion } from "../toolchainVersion";
import { scipProvider } from "./scipProvider";

const SCIP_DECODER = Object.freeze({
  command: "scip",
  override: "SAMCHON_GRAPH_SCIP",
});

const clangScipProvider = createScipProvider({
  name: "scip-clang",
  // scip-clang 0.4.0 writes occurrence range/symbol/roles only. Its
  // SymbolInformation never sets enclosing_symbol, and its relationships set
  // implementation/reference flags but never is_type_definition. None of
  // those fields can ground the common adapter's three edge families.
  omitFacts: ["contains", "references", "type_ref"],
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
  // `.h`, `.inc`, and extensionless include documents can be accepted from a
  // C++-only SCIP artifact, so resident freshness has to watch the same
  // identities even when the C registry is not part of the selected slice.
  buildExtensions: [".cmake", ".h", ".inc", ""],
  // scip-clang 0.4.0 writes `CPP` into every SCIP document, with an upstream
  // FIXME to detect the language. Trusting it makes a C-only session discard
  // every `.c` document as foreign C++ even though the path identifies it.
  preferFileLanguage: true,
  // Build output directories stay out of the ordinary source walk, but this is
  // the exact generated file scip-clang consumes. Without declaring it
  // separately, editing build/compile_commands.json leaves a resident session
  // on the old universe even though the next producer run would read the new
  // database.
  derivedInputs: compilationDatabaseInputs,
  validateConfiguration: (_root, configuration) => {
    if (
      configuration
        .slice(2)
        .some((row) => row.endsWith("=unavailable"))
    ) {
      throw new Error(
        "scip-clang: the current compilation database is invalid or names an unavailable compiler command",
      );
    }
  },
  resolveArgs: (root) => {
    const compdb = compilationDatabase(root);
    return compdb === undefined ? undefined : [`--compdb-path=${compdb}`];
  },
  // The producer's own defaults, and nothing bought on top of them.
  //
  // Two flags were tried here for reproducibility and both are gone. Neither
  // delivered it, because it is not scip-clang 0.4.0's to give: `--deterministic`
  // sits in its "Debugging" group saying "Does not support deterministic work
  // scheduling yet", and `--print-statistics-path` warns that "non-determinism
  // may affect the number of files skipped by individual indexing jobs". The
  // driver hands each well-behaved header to one translation unit, and which
  // one wins follows the schedule — so the file set moves, not only the facts.
  //
  // What they did deliver was cost. `--jobs=1` fixed the variance by
  // serializing the compiler and took a large real C project from about sixteen
  // seconds to about eleven minutes, which puts the strict lane behind the
  // generic fallback it exists to beat. `--deterministic` alone then held the
  // C++ conformance lane above forty-three minutes where it had run in under
  // eleven, and its own generations still did not reproduce.
  //
  // And this package does not need the ordering it offers. `parseScipIndex`
  // canonicalizes documents, occurrences, symbols, relationships and
  // documentation itself, with cases proving every permutation of a multi-unit
  // artifact folds to one snapshot. Paying the producer to sort what is sorted
  // again on arrival buys nothing and costs a conformance lane.
  //
  // The temporary directory stays. It is not part of that bargain: it keeps the
  // producer's scratch inside the generation this session owns and out of the
  // tree being indexed.
  indexArgs: (artifact) => [
    `--index-output-path=${artifact}`,
    `--temporary-output-dir=${path.join(path.dirname(artifact), "clang")}`,
  ],
});

const jvmScipProvider = createScipProvider({
  name: "scip-java",
  // scip-java 0.13.1 sets enclosing ranges in both the javac and kotlinc
  // producers and enclosing_symbol for javac locals, but no producer sets a
  // type-definition relationship.
  omitFacts: ["type_ref"],
  toolchain: {
    label: "java",
    aliases: ["java"],
    override: "SAMCHON_GRAPH_JAVA_TOOLCHAIN",
  },
  // Upstream calls this a Java and Kotlin indexer and ships only javac and
  // kotlinc producers. Claiming Scala made an installed scip-java displace the
  // Scala language-server lane with a tool that cannot index the language.
  languages: ["java", "kotlin"],
  command: "scip-java",
  override: "SAMCHON_GRAPH_SCIP_JAVA",
  buildFiles: [
    ".mvn/extensions.xml",
    ".mvn/jvm.config",
    ".mvn/maven.config",
    ".mvn/wrapper/MavenWrapperDownloader.java",
    ".mvn/wrapper/maven-wrapper.jar",
    ".mvn/wrapper/maven-wrapper.properties",
    "pom.xml",
    "mvnw",
    "mvnw.cmd",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "gradle.properties",
    "gradle.lockfile",
    "gradle/wrapper/gradle-wrapper.properties",
    "gradle/verification-metadata.xml",
    "gradle/wrapper/gradle-wrapper.jar",
    "gradlew",
    "gradlew.bat",
    "libs.versions.toml",
  ],
  buildExtensions: [".gradle", ".gradle.kts"],
  // scip-java's injected Gradle tasks are not compatible with a project's
  // configuration cache in the released producer. The build command after
  // `--` replaces its defaults, so retain those exact tasks while disabling
  // only the cache for this isolated indexing build. Maven must keep its own
  // default command; choosing by the root is therefore part of the provider
  // contract rather than a fixture-specific Gradle property change.
  indexArgs: jvmScipIndexArgs,
  // Java is both the runtime that launches scip-java and the compiler for a
  // Java-only slice. It is not Kotlin's compiler. Until the producer exposes
  // the Kotlin compiler revision it drove, a Kotlin-containing slice leaves
  // the compiler field empty instead of misnaming the JVM.
  compilerVersion: (languages, configuration) =>
    languages.includes("kotlin")
      ? ""
      : standardCompilerVersion("scip-java", configuration),
});

function jvmScipIndexArgs(artifact: string, root: string): string[] {
  const output = ["index", "--output", artifact];
  const gradle = [
    "settings.gradle",
    "settings.gradle.kts",
    "gradlew",
    "gradlew.bat",
    "build.gradle",
    "build.gradle.kts",
  ].some((file) =>
    fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile(),
  );
  return gradle
    ? [
        ...output,
        "--",
        "--no-configuration-cache",
        "clean",
        "scipPrintDependencies",
        "scipCompileAll",
      ]
    : output;
}

const dotnetScipProvider = createScipProvider({
  name: "scip-dotnet",
  // scip-dotnet 0.2.14 emits semantic declarations, but its occurrences carry
  // no enclosing_range and its SymbolInformation carries neither
  // enclosing_symbol nor type-definition relationships. The common adapter
  // therefore cannot ground an origin for references or derive the other two
  // families without guessing from C# syntax.
  omitFacts: ["contains", "references", "type_ref"],
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
  // scip-python 0.6.6 never populates `SymbolInformation.enclosing_symbol`.
  // Every construction site in the published bundle passes `symbol`,
  // `documentation` and `relationships` only, and the field appears nowhere but
  // the generated protobuf accessors. `contains` is derived from exactly that
  // field, so claiming the family told a consumer containment was proven and
  // left it to read the absence as a project with no structure rather than an
  // indexer that cannot describe one.
  // The same bundle's only relationships are implementation relationships;
  // it never sets Relationship.is_type_definition.
  omitFacts: ["contains", "type_ref"],
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
  // scip-ruby 0.4.7 sets range/symbol/roles on occurrences, but no enclosing
  // range, enclosing symbol, or type-definition relationship.
  omitFacts: ["contains", "references", "type_ref"],
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
  indexArgs: rubyScipIndexArgs,
});

/**
 * Dart, which used to be registered as a sidecar that was never written.
 *
 * `samchon-graph-dart` named a program that does not exist anywhere in this
 * repository — `sidecars/` holds exactly one directory, `go` — so every Dart
 * build fell through to the language-server lane, which exceeded an hour on a
 * mid-sized package twice over. A real indexer for the language has existed on
 * pub.dev the whole time. The entry was not unfinished work; it was the wrong
 * architecture.
 *
 * `--output` despite the published docs listing no such flag: `bin/scip_dart.dart`
 * declares it (`addOption('output', abbr: 'o', defaultsTo: 'index.scip')`). The
 * source settles what a summary could not, which is the same reason the CLI
 * contracts of every other entry here were read out of their upstream sources
 * rather than their READMEs.
 */
const dartScipProvider = createScipProvider({
  name: "scip-dart",
  // scip-dart 1.6.2 constructs occurrences without enclosing ranges and emits
  // only implementation/reference relationships on symbols.
  omitFacts: ["contains", "references", "type_ref"],
  toolchain: {
    label: "dart",
    aliases: ["dart"],
    override: "SAMCHON_GRAPH_DART_TOOLCHAIN",
  },
  languages: ["dart"],
  command: "scip_dart",
  override: "SAMCHON_GRAPH_SCIP_DART",
  buildFiles: ["pubspec.yaml", "pubspec.lock", "analysis_options.yaml"],
  derivedInputs: dartPackageConfigInputs,
  indexArgs: (artifact) => ["--output", artifact, "."],
});

/**
 * PHP, whose indexer cannot be told where to put its own output.
 *
 * `bin/scip-php` declares exactly two options, `--help` and `--memory-limit`.
 * It takes `getcwd()` as the project root and ends with
 * `file_put_contents('index.scip', …)`, so it writes into the tree it is
 * indexing and there is no flag to say otherwise. `artifactFrom` names that
 * path and the session moves the file out before anything reads it — which is
 * why this needed a mechanism rather than a registry line, and why it arrived
 * after dart despite both having had a real indexer all along.
 *
 * Composer, and inside the project rather than beside it. Its instructions are
 * `composer require --dev` followed by `vendor/bin/scip-php`, and current main
 * explicitly falls back to the analyzed project's `cwd/vendor` when Composer
 * has flattened the package dependencies there. The latest v0.0.2 tag predates
 * that upstream fix, so a fixture using the documented arrangement has to pin
 * a revision that contains it.
 *
 * That is why `resolveProviderCommand` looks in `vendor/bin`: for this
 * ecosystem, an indexer installed into the project is the expected arrangement
 * and a global copy is the unusual one.
 */
const phpScipProvider = createScipProvider({
  name: "scip-php",
  // scip-php 0.0.2 writes only range/symbol/roles for occurrences and symbol
  // metadata without any of the common adapter's grounding fields.
  omitFacts: ["contains", "references", "type_ref"],
  toolchain: {
    label: "php",
    aliases: ["php"],
    override: "SAMCHON_GRAPH_PHP_TOOLCHAIN",
  },
  languages: ["php"],
  command: "scip-php",
  override: "SAMCHON_GRAPH_SCIP_PHP",
  buildFiles: [
    "composer.json",
    "composer.lock",
    "phpstan.neon",
    "phpstan.neon.dist",
  ],
  // The CLI has no version flag: its only options are `--help` and
  // `--memory-limit`. Invoking the conventional `--version` does not fail; it
  // performs a full index and writes `index.scip`, so a probe would mutate the
  // project before the guarded build even starts. Composer's pinned package
  // metadata is the stable identity when present, and `unreported` is the
  // honest answer for a global binary or the package's own checkout.
  producerConfiguration: phpProducerConfiguration,
  indexArgs: () => [],
  artifactFrom: (root) => path.join(root, "index.scip"),
});

/** Standard SCIP producers in deterministic registry order. */
export const standardScipProviders: readonly IGraphProvider[] = [
  clangScipProvider,
  jvmScipProvider,
  dotnetScipProvider,
  pythonScipProvider,
  rubyScipProvider,
  dartScipProvider,
  phpScipProvider,
];

interface IStandardScipProvider {
  name: string;

  /** Fact families this indexer provably does not emit. */
  omitFacts: readonly GraphEdgeKind[];
  languages: readonly GraphLanguage[];
  command: string;
  override: string;
  buildFiles: readonly string[];
  buildExtensions?: readonly string[];

  /**
   * Build inputs that are not a filename pattern but a fact about the project.
   *
   * Dart's resolved dependency set lives in `.dart_tool/package_config.json`,
   * which `pub get` writes and no glob over the tracked tree would find. Leaving
   * it out would let a changed dependency graph produce the same universe, so a
   * project that resolved differently would serve an index built against the
   * packages it used to have.
   */
  derivedInputs?: (root: string) => readonly string[];
  validateConfiguration?: (
    root: string,
    configuration: readonly string[],
  ) => void;
  preferFileLanguage?: boolean;
  resolveArgs?: (root: string) => readonly string[] | undefined;
  indexArgs: (artifact: string, root: string) => string[];

  /** Select the compiler row this language slice can honestly publish. */
  compilerVersion?: (
    languages: readonly GraphLanguage[],
    configuration: readonly string[],
  ) => string;

  /**
   * Derive the producer's configuration row without assuming `--version`.
   *
   * Most indexers implement that conventional flag. scip-php does not, and
   * treating an unsupported flag as a harmless probe runs the indexer.
   */
  producerConfiguration?: (
    root: string,
    env: NodeJS.ProcessEnv,
    attempt: resolveProviderCommand.IAttempt,
  ) => toolchainVersion.IObservation;

  /** Where a producer that takes no output flag writes, relative to the root. */
  artifactFrom?: (root: string) => string;

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
type IToolchain =
  | {
      aliases: readonly string[];
      fromProject?: never;

      /** Absolute development build selected for this one alias family. */
      override?: string;

      /** What the row calls this toolchain when nothing resolved. */
      label: string;
    }
  | {
      aliases?: never;
      fromProject: (
        root: string,
        env: NodeJS.ProcessEnv,
      ) => readonly string[];
      override?: never;

      /** What the rows call this toolchain when the project names none. */
      label: string;
    };

/** One deduplicated, ordinally sorted input list, derived entries included. */
function withDerived(
  found: readonly string[],
  derived: readonly string[] | undefined,
): string[] {
  if (derived === undefined || derived.length === 0) return [...found];
  return [...new Set([...found, ...derived])].sort(compareInputPath);
}

function compareInputPath(left: string, right: string): number {
  /* c8 ignore next 2 -- merged input identities are distinct set members. */
  return left < right ? -1 : left > right ? 1 : 0;
}

function createScipProvider(
  props: IStandardScipProvider,
): IGraphProvider {
  const validateConfiguration = props.validateConfiguration;
  const producerConfiguration = props.producerConfiguration;
  const resolution = Object.freeze({
    commands: Object.freeze([
      props.command,
      SCIP_DECODER.command,
      ...(props.toolchain.aliases ?? [props.toolchain.label]),
    ]),
    environmentOverrides: Object.freeze([
      props.override,
      SCIP_DECODER.override,
      ...(props.toolchain.override === undefined
        ? []
        : [props.toolchain.override]),
    ]),
  }) satisfies IGraphProvider.IResolution;
  return Object.assign(
    scipProvider({
      name: props.name,
      languages: props.languages,
      authority: "semantic-index",
      omitFacts: props.omitFacts,
      ...(props.preferFileLanguage === undefined
        ? {}
        : { preferFileLanguage: props.preferFileLanguage }),
      buildInputs: (root) =>
        withDerived(
          providerInputFiles(root, [], props.buildFiles, props.buildExtensions),
          props.derivedInputs?.(root),
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
          toolchain.some((tool) => tool.resolved === undefined) ||
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
      ...(props.artifactFrom === undefined
        ? {}
        : { artifactFrom: props.artifactFrom }),
      inputs: (root, languages) =>
        withDerived(
          providerInputFiles(
            root,
            languages,
            props.buildFiles,
            props.buildExtensions,
          ),
          props.derivedInputs?.(root),
        ),
      ...(validateConfiguration === undefined
        ? {}
        : {
            validateConfiguration: (
              root,
              _languages,
              configuration,
            ) => validateConfiguration(root, configuration),
          }),
      configuration: (root, _languages, env = process.env) => {
        const producerRow =
          producerConfiguration === undefined
            ? toolVersion(root, env, props.command, props.override)
            : producerConfiguration(
                root,
                env,
                resolveProviderCommand.attempt(root, env, {
                  command: props.command,
                  override: props.override,
                }),
              );
        return toolchainVersion.derive([
          producerRow,
          toolVersion(
            root,
            env,
            SCIP_DECODER.command,
            SCIP_DECODER.override,
          ),
          ...toolchainVersions(root, env, props.toolchain),
        ]);
      },
      // Selected from the configuration rather than re-derived, so the
      // published compiler is the one this universe was computed from. Labelled
      // rather than positional: the indexer and the decoder are named exactly,
      // and whatever remains is the toolchain.
      compilerVersion: (_root, selectedLanguages, configuration) =>
        props.compilerVersion?.(selectedLanguages, configuration) ??
        standardCompilerVersion(props.command, configuration),
      sourceText: true,
      languageOf,
    }),
    {
      resolution,
    },
  );
}

/**
 * Invoke scip-ruby with explicit package identity only when none is declared.
 *
 * The producer documents `--gem-metadata` for repositories without a
 * `Gemfile.lock` or gemspec. Omitting it makes that supported project shape
 * fail before indexing, which is exactly what the upstream config-only fixture
 * exposed. A declared package keeps the producer's native inference.
 */
function rubyScipIndexArgs(artifact: string, root: string): string[] {
  const args = [".", "--index-file", artifact];
  const declared =
    fs.statSync(path.join(root, "Gemfile.lock"), {
      throwIfNoEntry: false,
    })?.isFile() === true ||
    fs
      .readdirSync(root, { withFileTypes: true })
      .some((entry) => entry.isFile() && entry.name.endsWith(".gemspec"));
  if (declared) return args;
  const inferred =
    path
      .basename(root)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace";
  return [...args, "--gem-metadata", `${inferred}@workspace`];
}

/**
 * Identify scip-php from the Composer lock that installed it.
 *
 * The lock is already a declared build input. Including both its version and
 * immutable source reference distinguishes two commits published under the
 * same development version without executing the indexer as a probe.
 */
function phpProducerConfiguration(
  root: string,
  _env: NodeJS.ProcessEnv,
  attempt: resolveProviderCommand.IAttempt,
): toolchainVersion.IObservation {
  const label = "scip-php";
  if (!attempt.asked) return toolchainVersion.unasked(label);
  const executable = attempt.executable;
  if (executable === undefined) {
    return toolchainVersion.conclusive(`${label}=unavailable`);
  }
  // A Composer lock identifies only the project-local binary that Composer
  // installed. An override, private development build, npm shim, or PATH binary
  // may be different bytes even when this checkout happens to contain a lock;
  // attributing the lock's commit to it would make the build universe lie.
  if (!isComposerScipPhp(root, executable)) {
    return phpExecutableConfiguration(label, executable);
  }
  try {
    const lock = JSON.parse(
      fs.readFileSync(path.join(root, "composer.lock"), "utf8"),
    ) as {
      packages?: unknown;
      "packages-dev"?: unknown;
    };
    const packages = [
      ...(Array.isArray(lock.packages) ? lock.packages : []),
      ...(Array.isArray(lock["packages-dev"]) ? lock["packages-dev"] : []),
    ];
    const installed = packages.find(
      (entry): entry is {
        name: string;
        version?: unknown;
        source?: { reference?: unknown };
      } =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { name?: unknown }).name === "davidrjenni/scip-php",
    );
    if (installed === undefined) {
      return toolchainVersion.conclusive(`${label}=unreported`);
    }
    const version =
      typeof installed.version === "string" && installed.version.trim() !== ""
        ? installed.version.trim()
        : "unreported";
    const reference =
      typeof installed.source?.reference === "string" &&
      installed.source.reference.trim() !== ""
        ? `@${installed.source.reference.trim()}`
        : "";
    return toolchainVersion.conclusive(
      `${label}=${version}${reference}`,
    );
  } catch {
    return toolchainVersion.conclusive(`${label}=unreported`);
  }
}

/**
 * Identify an executable that has no safe version command.
 *
 * Both the selected path and its bytes decide the program: two equal wrappers
 * in different installations can target different dependency trees, while an
 * in-place replacement keeps the path and changes the implementation. Hashing
 * both avoids publishing a machine path while still moving the build universe
 * for either change. A read that cannot complete is inconclusive, not evidence
 * that the resolved binary has no identity.
 */
function phpExecutableConfiguration(
  label: string,
  executable: string,
): toolchainVersion.IObservation {
  try {
    const selected = path.resolve(executable);
    const digest = createHash("sha256")
      .update(selected, "utf8")
      .update("\0", "utf8")
      .update(fs.readFileSync(selected))
      .digest("hex");
    return toolchainVersion.conclusive(`${label}=sha256:${digest}`);
    /* c8 ignore start -- resolution stat'd this exact regular file immediately
     * before the callback; only a synchronous removal or permission race can
     * make this read fail, and no deterministic cross-platform fixture can
     * enter between those two calls. */
  } catch {
    return toolchainVersion.unasked(label);
  }
  /* c8 ignore stop */
}

function isComposerScipPhp(
  root: string,
  executable: string,
): boolean {
  const vendorBin = path.resolve(root, "vendor", "bin");
  const relative = path.relative(vendorBin, path.resolve(executable));
  return (
    path.dirname(relative) === "." &&
    /^scip-php(?:\.(?:exe|cmd|bat))?$/i.test(path.basename(relative))
  );
}

function standardCompilerVersion(
  indexer: string,
  configuration: readonly string[],
): string {
  return configuration
    .filter((row) => {
      const label = row.slice(0, Math.max(0, row.indexOf("=")));
      return label !== indexer && label !== "scip";
    })
    .join("; ");
}

/**
 * Every program the toolchain names, carrying both answers and non-answers.
 *
 * An `aliases` toolchain stops at the first spelling that resolves, because the
 * alternatives are one program; if none resolves, its one entry records whether
 * every lookup actually ran. A `fromProject` toolchain keeps one entry for every
 * driver the project named, including an absent or unasked one, because omitting
 * one compiler would publish only part of the program's semantic identity.
 */
function resolveToolchain(
  root: string,
  env: NodeJS.ProcessEnv,
  toolchain: IToolchain,
): IToolchainTool[] {
  if (toolchain.aliases !== undefined) {
    const triedAliases = new Set<string>();
    let aliasesAsked = true;
    // The override selects one absolute program, so it is consulted once under
    // the toolchain's own label. Offering it to each alias in turn would make
    // the first spelling always resolve, and the row would name `python3` for a
    // binary the developer pointed at deliberately.
    //
    // Consulted, not obeyed: `resolveProviderCommand` rejects an override that
    // no longer points at a program and then continues its ordinary search, so
    // a stale one resolves to whatever the label finds anyway. The aliases
    // below then only run on a machine where that spelling is absent too.
    if (
      toolchain.override !== undefined &&
      env[toolchain.override] !== undefined
    ) {
      const overridden = resolved(root, env, {
        command: toolchain.label,
        identity: `toolchain:${toolchain.label}`,
        override: toolchain.override,
      });
      triedAliases.add(toolchain.label);
      aliasesAsked &&= overridden.asked;
      if (overridden.resolved !== undefined) return [overridden];
    }
    for (const command of toolchain.aliases) {
      if (triedAliases.has(command)) continue;
      const alias = resolved(root, env, {
        command,
        identity: `toolchain:${toolchain.label}`,
      });
      aliasesAsked &&= alias.asked;
      if (alias.resolved !== undefined) return [alias];
    }
    return [
      {
        command: toolchain.label,
        identity: `toolchain:${toolchain.label}`,
        label: toolchain.label,
        asked: aliasesAsked,
      },
    ];
  }
  const namedTools = toolchain.fromProject(root, env);
  if (namedTools.length === 0) {
    return [
      {
        command: toolchain.label,
        identity: `toolchain:${toolchain.label}`,
        label: toolchain.label,
        asked: true,
      },
    ];
  }
  return namedTools.map((named) => {
    // An absolute driver is probed exactly as recorded. The build named that
    // file, and another program of the same basename on this machine's `PATH`
    // is not the one those translation units were compiled with.
    return resolved(
      root,
      env,
      path.isAbsolute(named)
        ? {
            command: named,
            identity: driverIdentity(named),
            label: driverLabel(named),
            executable: named,
          }
        : {
            command: named,
            identity: driverIdentity(named),
            label: driverLabel(named),
          },
    );
  });
}

/**
 * Resolve one candidate and carry the answer, rather than asking twice.
 *
 * Deciding whether a toolchain exists and then reading its version used to be
 * two independent resolutions of the same name, and on Windows a resolution
 * that misses the project's own bin is a `where.exe` launch. Every extra launch
 * is another chance for a hiccup to report an installed tool as absent, which
 * moves a build universe that nothing about the project moved.
 */
function resolved(
  root: string,
  env: NodeJS.ProcessEnv,
  tool: Omit<IToolchainTool, "asked">,
): IToolchainTool {
  const attempt = toolchainVersion.attempt({
    root,
    env,
    args: VERSION_ARGS,
    ...tool,
  });
  return {
    ...tool,
    asked: attempt.asked,
    ...(attempt.command === undefined ? {} : { resolved: attempt.command }),
  };
}

function toolchainVersions(
  root: string,
  env: NodeJS.ProcessEnv,
  toolchain: IToolchain,
): toolchainVersion.IObservation[] {
  const tools = resolveToolchain(root, env, toolchain);
  return tools.map((tool) => {
    const label = tool.label ?? tool.command;
    if (tool.resolved === undefined) {
      return tool.asked
        ? toolchainVersion.conclusive(
            `${label}=unavailable`,
            tool.identity,
          )
        : toolchainVersion.unasked(label, tool.identity);
    }
    return toolchainVersion.observe({
      root,
      env,
      args: VERSION_ARGS,
      ...tool,
    });
  });
}

interface IToolchainTool {
  command: string;
  identity: string;
  asked: boolean;
  label?: string;
  override?: string;
  executable?: string;

  /** The invocation this candidate resolved to, once it has. */
  resolved?: IGraphProvider.ICommand;
}

/**
 * What a compile command's driver is called, once the machine is taken off it.
 *
 * A database records the path the build ran, so the same compiler is
 * `/usr/lib/ccache/gcc`, `gcc`, or `C:\LLVM\bin\clang.exe` depending on where
 * it was configured. The provenance field is compared across platforms and
 * checkouts, so it carries the program's name rather than one machine's spelling
 * of its location.
 */
function driverLabel(named: string): string {
  return lastSegment(named).replace(WINDOWS_EXECUTABLE_SUFFIX, "");
}

/** Stable private identity for one project-selected compiler driver. */
function driverIdentity(named: string): string {
  return `toolchain-driver:sha256:${createHash("sha256")
    .update(named.replaceAll("\\", "/"), "utf8")
    .digest("hex")}`;
}

/**
 * The last path segment, on either platform's separator.
 *
 * `path.basename` follows the *running* platform's rules, and a compilation
 * database is written by one machine and can be read on another: a
 * Windows-authored `C:\ccache\ccache.exe` read on Linux comes back whole, so
 * every comparison against it fails.
 */
function lastSegment(named: string): string {
  const segments = named.split(/[\\/]/);
  return segments[segments.length - 1]!;
}

/**
 * Every distinct compiler driver the project's compilation database names.
 *
 * The database is the build's own record of how each translation unit was
 * compiled, so the program each entry runs is the compiler whose semantics the
 * index carries. Both documented shapes are read: `command` is one shell string
 * and `arguments` is an already-split vector.
 *
 * Memoized against the bytes actually parsed. Size plus modification time is
 * not content identity: a build can preserve a timestamp while replacing one
 * same-length driver name with another, and the surrounding generation fence
 * would then rebuild with stale compiler provenance. The memo still avoids
 * repeated JSON parsing, which is the expensive part for a database routinely
 * tens of megabytes long.
 */
function compilationDatabaseCompilers(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const database = compilationDatabase(root);
  if (database === undefined) return [];
  let contents: Buffer;
  try {
    contents = fs.readFileSync(database);
    /* c8 ignore start -- the database was stat'd moments ago by
     * `compilationDatabase`; a removal in between leaves nothing to parse and
     * the read below reports it. */
  } catch {
    return [];
  }
  /* c8 ignore stop */
  const key = `${database}${SEPARATOR}${createHash("sha256")
    .update(contents)
    .digest("hex")}`;
  let commands = compilationDatabases.get(key);
  if (commands === undefined) {
    commands = readCompilationDatabaseCommands(contents);
    compilationDatabases.set(key, commands);
  }
  const drivers = new Set<string>();
  for (const command of commands) {
    const driver = compilerToken(command.tokens, command.directory, env);
    if (driver !== undefined) drivers.add(driver);
  }
  return [...drivers].sort(compareOrdinal);
}

interface ICompilationDatabaseCommand {
  tokens: string[];
  directory?: string;
}

function readCompilationDatabaseCommands(
  contents: Buffer,
): ICompilationDatabaseCommand[] {
  let entries: unknown;
  try {
    entries = JSON.parse(contents.toString("utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const commands: ICompilationDatabaseCommand[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as {
      command?: unknown;
      arguments?: unknown;
      directory?: unknown;
    };
    const tokens = Array.isArray(record.arguments)
      ? record.arguments.filter(
          (argument): argument is string => typeof argument === "string",
        )
      : typeof record.command === "string"
        ? splitCommand(record.command)
        : [];
    commands.push({
      tokens,
      ...(typeof record.directory === "string"
        ? { directory: record.directory }
        : {}),
    });
  }
  return commands;
}

/**
 * The compiler among a compile command's leading tokens.
 *
 * Two things stand in front of it in ordinary builds. A leading `NAME=value` is
 * a shell assignment, not a program. A compiler launcher — `ccache`, `sccache`,
 * `distcc`, `icecc`, which CMake inserts through `CMAKE_<LANG>_COMPILER_LAUNCHER`
 * — runs the real compiler as its argument, and publishing ccache's version as
 * the toolchain that decided the index's semantics would name a cache.
 */
function compilerToken(
  tokens: readonly string[],
  directory: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  let candidates = [...tokens];
  let index = 0;
  let options = true;
  let assignments = true;
  let envWrapped = false;
  let cwd =
    directory === undefined ? undefined : path.resolve(directory);
  let envBaseCwd = cwd;
  let environmentPath: IEnvSearchPath | null | undefined;
  let environmentPathext: string | null | undefined;
  let commandPath: IEnvSearchPath | undefined;

  for (;;) {
    const token = candidates[index++];
    if (token === undefined) return undefined;
    if (token === "") {
      if (envWrapped) return undefined;
      continue;
    }

    if (envWrapped && options && token === "--") {
      options = false;
      continue;
    }
    if (envWrapped && options && token === "-") {
      environmentPath = null;
      environmentPathext = null;
      options = false;
      continue;
    }
    if (envWrapped && options && token.startsWith("--")) {
      const [name, attached] = splitLongOption(token);
      if (ENV_LONG_OPTIONS_WITHOUT_OPERAND.has(name)) {
        if (
          attached !== undefined &&
          !ENV_LONG_OPTIONS_WITH_OPTIONAL_OPERAND.has(name)
        ) {
          return undefined;
        }
        if (name === "--ignore-environment") {
          environmentPath = null;
          environmentPathext = null;
        }
        if (
          name === "--null" ||
          name === "--help" ||
          name === "--version"
        ) {
          return undefined;
        }
        continue;
      }
      if (!ENV_LONG_OPTIONS_WITH_OPERAND.has(name)) return undefined;
      const operand = attached ?? candidates[index++];
      if (operand === undefined) return undefined;
      if (name === "--split-string") {
        const split = splitEnvString(operand);
        if (split === undefined) return undefined;
        candidates = [...split, ...candidates.slice(index)];
        index = 0;
        options = true;
        assignments = true;
      } else if (name === "--chdir") {
        cwd = resolveEnvCwd(envBaseCwd, operand);
        if (cwd === undefined) return undefined;
      } else if (name === "--unset") {
        if (!isEnvironmentName(operand)) return undefined;
        if (isEnvironmentVariable(operand, "PATH")) {
          environmentPath = null;
        }
        if (isEnvironmentVariable(operand, "PATHEXT")) {
          environmentPathext = null;
        }
      }
      continue;
    }
    if (envWrapped && options && token.startsWith("-")) {
      const parsed = parseShortEnvOptions(
        token,
        candidates,
        index,
        envBaseCwd,
        cwd,
        environmentPath,
        environmentPathext,
      );
      if (parsed === undefined) return undefined;
      candidates = parsed.tokens;
      index = parsed.index;
      cwd = parsed.cwd;
      environmentPath = parsed.environmentPath;
      environmentPathext = parsed.environmentPathext;
      commandPath = parsed.commandPath ?? commandPath;
      if (parsed.inserted) {
        options = true;
        assignments = true;
      }
      continue;
    }
    const assignment =
      assignments &&
      (envWrapped ? envAssignment(token) : shellAssignment(token));
    if (assignment) {
      options = false;
      if (isEnvironmentVariable(assignment.name, "PATH")) {
        environmentPath = {
          value: assignment.value,
          delimiter: path.delimiter,
        };
      }
      if (isEnvironmentVariable(assignment.name, "PATHEXT")) {
        environmentPathext = assignment.value;
        if (!envWrapped && environmentPath === undefined) {
          environmentPath = pathextSearchPath(env);
        }
      }
      continue;
    }
    if (assignments && envWrapped && token.startsWith("=")) return undefined;

    const program = programName(token);
    if (program === "env") {
      if (!envWrapped) {
        if (environmentPath === undefined) {
          environmentPath = inheritedSearchPath(env);
        }
        if (environmentPathext === undefined) {
          environmentPathext = inheritedPathext(env);
        }
      }
      envWrapped = true;
      envBaseCwd = cwd;
      candidates = candidates.slice(index);
      index = 0;
      options = true;
      assignments = true;
      commandPath = undefined;
      continue;
    }
    if (COMPILER_LAUNCHERS.has(program)) {
      options = false;
      assignments = false;
      commandPath = undefined;
      continue;
    }
    return resolveEnvDriver(
      token,
      cwd,
      commandPath ?? environmentPath,
      environmentPathext,
      env,
    );
  }
}

interface IEnvSearchPath {
  value: string;
  delimiter: string;
}

interface IParsedShortEnvOptions {
  tokens: string[];
  index: number;
  cwd: string | undefined;
  environmentPath: IEnvSearchPath | null | undefined;
  environmentPathext: string | null | undefined;
  commandPath?: IEnvSearchPath;
  inserted: boolean;
}

function parseShortEnvOptions(
  token: string,
  tokens: readonly string[],
  index: number,
  envBaseCwd: string | undefined,
  initialCwd: string | undefined,
  initialEnvironmentPath: IEnvSearchPath | null | undefined,
  initialEnvironmentPathext: string | null | undefined,
): IParsedShortEnvOptions | undefined {
  let cwd = initialCwd;
  let environmentPath = initialEnvironmentPath;
  let environmentPathext = initialEnvironmentPathext;
  let commandPath: IEnvSearchPath | undefined;
  const cluster = token.slice(1);
  for (let at = 0; at < cluster.length; at += 1) {
    const option = cluster[at]!;
    if (option === "i") {
      environmentPath = null;
      environmentPathext = null;
      continue;
    }
    if (option === "0") return undefined;
    if (option === "v") continue;
    if (!ENV_SHORT_OPTIONS_WITH_OPERAND.has(option)) return undefined;
    const attached = cluster.slice(at + 1);
    const operand = attached === "" ? tokens[index++] : attached;
    if (operand === undefined) return undefined;
    if (option === "L" || option === "U") {
      // login.conf can replace PATH, and its contents are not in the
      // compilation database. Decline instead of probing a different program.
      return undefined;
    }
    if (option === "S") {
      const split = splitEnvString(operand);
      if (split === undefined) return undefined;
      return {
        tokens: [...split, ...tokens.slice(index)],
        index: 0,
        cwd,
        environmentPath,
        environmentPathext,
        inserted: true,
      };
    }
    if (option === "C") {
      cwd = resolveEnvCwd(envBaseCwd, operand);
      if (cwd === undefined) return undefined;
    } else if (option === "P") {
      if (operand === "") return undefined;
      commandPath = { value: operand, delimiter: path.delimiter };
    } else if (option === "u") {
      if (!isEnvironmentName(operand)) return undefined;
      if (isEnvironmentVariable(operand, "PATH")) {
        environmentPath = null;
      }
      if (isEnvironmentVariable(operand, "PATHEXT")) {
        environmentPathext = null;
      }
    }
    // The rest of this token is the operand, so the option cluster ends here.
    break;
  }
  return {
    tokens: [...tokens],
    index,
    cwd,
    environmentPath,
    environmentPathext,
    ...(commandPath === undefined ? {} : { commandPath }),
    inserted: false,
  };
}

function splitLongOption(token: string): [string, string | undefined] {
  const equal = token.indexOf("=");
  return equal === -1
    ? [token, undefined]
    : [token.slice(0, equal), token.slice(equal + 1)];
}

function resolveEnvCwd(
  base: string | undefined,
  directory: string,
): string | undefined {
  if (directory === "") return undefined;
  if (path.isAbsolute(directory)) return path.resolve(directory);
  return base === undefined ? undefined : path.resolve(base, directory);
}

function inheritedSearchPath(
  env: NodeJS.ProcessEnv,
): IEnvSearchPath | null {
  const value = environmentValue(env, "PATH");
  return value === undefined
    ? null
    : {
        value,
        delimiter: path.delimiter,
      };
}

/**
 * The inherited command search that a leading shell `PATHEXT=` assignment
 * makes relevant.
 *
 * POSIX shells accept that assignment as ordinary environment data: it does
 * not turn a bare utility into a historical PATH lookup. Windows command
 * resolution does need the inherited PATH to apply the assigned executable
 * extensions to the utility that follows.
 */
function pathextSearchPath(
  env: NodeJS.ProcessEnv,
): IEnvSearchPath | null | undefined {
  /* c8 ignore next 3 -- each CI operating system exercises its native answer. */
  return process.platform === "win32"
    ? inheritedSearchPath(env)
    : undefined;
}

function inheritedPathext(env: NodeJS.ProcessEnv): string {
  return (
    environmentValue(env, "PATHEXT") ??
    DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS
  );
}

function shellAssignment(
  token: string,
): { name: string; value: string } | undefined {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(token);
  return match === null ? undefined : { name: match[1]!, value: match[2]! };
}

function envAssignment(
  token: string,
): { name: string; value: string } | undefined {
  const equal = token.indexOf("=");
  return equal <= 0
    ? undefined
    : { name: token.slice(0, equal), value: token.slice(equal + 1) };
}

function isEnvironmentName(name: string): boolean {
  return name !== "" && !name.includes("=");
}

function isEnvironmentVariable(name: string, expected: string): boolean {
  return (
    canonicalEnvironmentName(name) ===
    canonicalEnvironmentName(expected)
  );
}

function environmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const expected = canonicalEnvironmentName(name);
  const key = Object.keys(env).find(
    (candidate) =>
      canonicalEnvironmentName(candidate) === expected &&
      env[candidate] !== undefined,
  );
  return key === undefined ? undefined : env[key];
}

function canonicalEnvironmentName(name: string): string {
  /* c8 ignore next -- each CI operating system exercises its native arm. */
  return process.platform === "win32" ? name.toUpperCase() : name;
}

/**
 * FreeBSD/GNU `env -S` splitting, except environment substitution.
 *
 * A compilation database does not retain the environment that expanded
 * `${NAME}` when it was produced. Such an operand is therefore inconclusive
 * and fails closed. GNU rejects a backslash before literal whitespace while
 * FreeBSD accepts it, and the database does not name the `env` dialect either,
 * so that boundary fails closed too. Every rule the two dialects share can be
 * replayed exactly.
 */
function splitEnvString(input: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  const push = (): void => {
    if (started) tokens.push(current);
    current = "";
    started = false;
  };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quote === undefined && ENV_SPLIT_WHITESPACE.has(character)) {
      push();
      continue;
    }
    if (
      quote === undefined &&
      character === "#" &&
      !started
    ) {
      break;
    }
    if (character === "'" || character === '"') {
      if (quote === undefined) {
        quote = character;
        started = true;
        continue;
      }
      if (quote === character) {
        quote = undefined;
        continue;
      }
    }
    if (character === "$" && quote !== "'") {
      // Only ${NAME} is legal, and its historical value is unavailable.
      return undefined;
    }
    if (character === "\\") {
      const escaped = input[++index];
      if (escaped === undefined) return undefined;
      if (quote === "'" && escaped !== "'" && escaped !== "\\") {
        current += `\\${escaped}`;
        started = true;
        continue;
      }
      if (escaped === "c") {
        if (quote === '"') return undefined;
        break;
      }
      if (escaped === "_") {
        if (quote === '"') {
          current += " ";
          started = true;
        } else {
          push();
        }
        continue;
      }
      const replacement = ENV_SPLIT_ESCAPES[escaped];
      if (replacement === undefined) return undefined;
      current += replacement;
      started = true;
      continue;
    }
    current += character;
    started = true;
  }
  if (quote !== undefined) return undefined;
  push();
  return tokens;
}

function resolveEnvDriver(
  driver: string,
  cwd: string | undefined,
  searchPath: IEnvSearchPath | null | undefined,
  environmentPathext: string | null | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (path.isAbsolute(driver)) return driver;
  if (/[\\/]/.test(driver)) {
    return cwd === undefined ? undefined : path.resolve(cwd, driver);
  }
  if (searchPath === null) return undefined;
  if (searchPath === undefined) return driver;
  const candidates: string[] = [];
  for (const directory of searchPath.value.split(searchPath.delimiter)) {
    const absoluteDirectory =
      directory === ""
        ? cwd
        : path.isAbsolute(directory)
          ? directory
          : cwd === undefined
            ? undefined
            : path.resolve(cwd, directory);
    if (absoluteDirectory === undefined) return undefined;
    for (const spelling of envDriverSpellings(
      driver,
      environmentPathext,
      env,
    )) {
      candidates.push(path.resolve(absoluteDirectory, spelling));
    }
  }
  return (
    candidates.find((candidate) => isSpawnableFile(candidate)) ??
    candidates[0]
  );
}

function envDriverSpellings(
  driver: string,
  environmentPathext: string | null | undefined,
  env: NodeJS.ProcessEnv,
): string[] {
  const configured =
    environmentPathext === undefined
      ? inheritedPathext(env)
      : environmentPathext;
  const windows = windowsEnvDriverSpellings(driver, configured);
  /* c8 ignore next -- each CI operating system exercises its native answer. */
  return process.platform === "win32" ? windows : [driver];
}

/**
 * The Windows spellings implied by one PATHEXT state.
 *
 * Calculated on every platform so the extension grammar is covered
 * deterministically; only choosing whether the host uses it is platform
 * specific. A driver that already carries either a configured extension or a
 * native executable suffix is exact and must never become `driver.com.com`.
 */
function windowsEnvDriverSpellings(
  driver: string,
  configured: string | null,
): string[] {
  if (configured === null) return [driver];
  const extensions = configured
    .split(";")
    .filter((extension) => extension !== "")
    .map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`,
    );
  if (extensions.length === 0) return [driver];
  const normalized = driver.toLowerCase();
  if (
    extensions.some((extension) =>
      normalized.endsWith(extension.toLowerCase()),
    ) ||
    WINDOWS_EXECUTABLE_SUFFIX.test(driver)
  ) {
    return [driver];
  }
  return extensions.map((extension) => `${driver}${extension.toLowerCase()}`);
}

/**
 * The name a launcher list can be matched against.
 *
 * {@link driverLabel} without the case, because `CCACHE.EXE` is `ccache` and a
 * launcher that is not recognised gets published as the compiler that decided
 * the program's semantics.
 */
function programName(token: string): string {
  return driverLabel(token).toLowerCase();
}

/**
 * Split one compile command into tokens.
 *
 * A database is a record of what a shell was given, and nothing in it says
 * which shell. A Windows build records
 * `"C:\Program Files\LLVM\bin\clang.exe" -c a.c`, a Ninja or Make build on
 * POSIX records `'/usr/bin/g++' -c a.cc` or `/opt/my\ compiler -c a.cc`, and
 * splitting any of them on whitespace names a directory.
 *
 * So a backslash escapes only what a backslash is used to escape here — a
 * space, a tab, or a quote, and never another backslash. Before anything else
 * it is a path separator, and treating it as an escape unconditionally turned
 * `C:\Program Files\LLVM` into `C:Program FilesLLVM`, which is exactly the
 * input the quoting exists for.
 */
function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    const next = command[index + 1];
    if (
      character === "\\" &&
      next !== undefined &&
      ESCAPABLE.has(next)
    ) {
      current += next;
      started = true;
      index += 1;
      continue;
    }
    if (quote === undefined && (character === '"' || character === "'")) {
      quote = character;
      started = true;
      continue;
    }
    if (quote === character) {
      quote = undefined;
      continue;
    }
    if (quote === undefined && /\s/.test(character)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * What a backslash can escape here, and what it cannot.
 *
 * Not another backslash. `\\server\share\clang.exe` is a UNC path whose two
 * leading separators are two separators, and consuming the pair as one escaped
 * backslash names a host that does not exist. A POSIX command with a literal
 * backslash in a path is the losing side of that trade, and it is the rarer one
 * by a wide margin in a file whose whole purpose is recording build commands.
 */
const ESCAPABLE = new Set([" ", "\t", '"', "'"]);

const COMPILER_LAUNCHERS = new Set([
  "ccache",
  "sccache",
  "distcc",
  "icecc",
  "icecream",
  "buildcache",
]);

const ENV_LONG_OPTIONS_WITH_OPERAND = new Set([
  "--unset",
  "--chdir",
  "--argv0",
  "--split-string",
]);
const ENV_LONG_OPTIONS_WITHOUT_OPERAND = new Set([
  "--ignore-environment",
  "--null",
  "--debug",
  "--block-signal",
  "--default-signal",
  "--ignore-signal",
  "--list-signal-handling",
  "--help",
  "--version",
]);
const ENV_LONG_OPTIONS_WITH_OPTIONAL_OPERAND = new Set([
  "--block-signal",
  "--default-signal",
  "--ignore-signal",
]);
const ENV_SHORT_OPTIONS_WITH_OPERAND = new Set([
  "u",
  "C",
  "L",
  "U",
  "P",
  "S",
  "a",
]);
const ENV_SPLIT_WHITESPACE = new Set([" ", "\t", "\n", "\v", "\f", "\r"]);
const ENV_SPLIT_ESCAPES: Readonly<Record<string, string>> = {
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "#": "#",
  $: "$",
  '"': '"',
  "'": "'",
  "\\": "\\",
};
const DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS = ".COM;.EXE;.BAT;.CMD";
const WINDOWS_EXECUTABLE_SUFFIX = /\.(?:com|exe|cmd|bat)$/i;

/** A separator no path can contain. */
const SEPARATOR = String.fromCharCode(0);
const COMPILATION_DATABASE_INPUTS: readonly string[] = [
  "compile_commands.json",
  "build/compile_commands.json",
];

const compilationDatabases =
  new BoundedMap<ICompilationDatabaseCommand[]>(64);

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
    command: SCIP_DECODER.command,
    override: SCIP_DECODER.override,
  });
}

function toolVersion(
  root: string,
  env: NodeJS.ProcessEnv,
  command: string,
  override: string,
): toolchainVersion.IObservation {
  return toolchainVersion.observe({
    root,
    env,
    command,
    override,
    args: ["--version"],
  });
}

function compilationDatabase(root: string): string | undefined {
  for (const relative of COMPILATION_DATABASE_INPUTS) {
    const candidate = path.join(root, relative);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function compilationDatabaseInputs(_root: string): string[] {
  // Missing is an input state. A resident fallback must notice the database
  // being created, and a session using build/compile_commands.json must notice
  // a newly created root database taking precedence on the next refresh.
  return [...COMPILATION_DATABASE_INPUTS];
}
